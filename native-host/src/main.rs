//! FreeMiD — Chrome Native Messaging Host
//!
//! Chrome spawns this binary when the extension calls
//! `chrome.runtime.connectNative('com.clicksentinel.freemid')`.
//!
//! Protocol on stdin/stdout (per Chrome native-messaging spec):
//!     u32 LE length | UTF-8 JSON payload
//! Each message is independent; we keep one persistent Discord IPC connection
//! for the lifetime of this process.
//!
//! Logs go to stderr (Chrome forwards them to the extension's process logs).
//!
//! Wire protocol between extension and host:
//!   ext → host  { "type": "PING" }
//!   ext → host  { "type": "SET_ACTIVITY", "activity": { ... } }
//!   ext → host  { "type": "CLEAR_ACTIVITY" }
//!   host → ext  { "type": "STATUS", "connected": bool, "error"?: string }

mod discord_ipc;

use discord_ipc::{Activity, DiscordIpc, IpcError};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::Mutex;

const MAX_INBOUND_BYTES: u32 = 1024 * 1024;

fn main() {
    eprintln!("[FreeMiD] native host v{} starting", env!("CARGO_PKG_VERSION"));

    let ipc: Mutex<Option<DiscordIpc>> = Mutex::new(None);

    // Eagerly try to connect so the first STATUS we emit is accurate.
    let initial_connected = match ensure_connected(&mut ipc.lock().unwrap()) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[FreeMiD] initial Discord connect failed: {}", e);
            false
        }
    };
    send_status(initial_connected, None);

    loop {
        match read_message() {
            Ok(None) => {
                // stdin closed — Chrome disconnected.
                eprintln!("[FreeMiD] stdin EOF — exiting cleanly");
                return;
            }
            Ok(Some(msg)) => {
                if let Err(e) = handle_message(&msg, &ipc) {
                    eprintln!("[FreeMiD] error handling message: {}", e);
                }
            }
            Err(e) => {
                eprintln!("[FreeMiD] read error: {} — exiting", e);
                return;
            }
        }
    }
}

// ── Native-messaging framing ───────────────────────────────────────────────────

fn read_message() -> io::Result<Option<Value>> {
    let mut len_buf = [0u8; 4];
    match io::stdin().read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf);
    if len == 0 {
        return Ok(Some(Value::Null));
    }
    if len > MAX_INBOUND_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("inbound message too large: {} bytes", len),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    io::stdin().read_exact(&mut buf)?;
    let value: Value = serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(value))
}

fn write_message(value: &Value) {
    let data = match serde_json::to_vec(value) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[FreeMiD] failed to serialize outbound message: {}", e);
            return;
        }
    };
    let len = (data.len() as u32).to_le_bytes();
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if let Err(e) = lock.write_all(&len).and_then(|()| lock.write_all(&data)).and_then(|()| lock.flush()) {
        eprintln!("[FreeMiD] failed to write outbound message: {}", e);
    }
}

fn send_status(connected: bool, error: Option<&str>) {
    let mut payload = json!({ "type": "STATUS", "connected": connected });
    if let Some(e) = error {
        payload["error"] = Value::String(e.to_string());
    }
    write_message(&payload);
}

// ── IPC connection management ──────────────────────────────────────────────────

fn ensure_connected(slot: &mut std::sync::MutexGuard<'_, Option<DiscordIpc>>) -> Result<(), IpcError> {
    if slot.is_some() {
        return Ok(());
    }
    let ipc = DiscordIpc::connect_and_handshake()?;
    **slot = Some(ipc);
    eprintln!("[FreeMiD] Discord IPC connected");
    Ok(())
}

/// Run `f` on the live IPC, reconnecting once on failure.
fn with_reconnect<F>(ipc: &Mutex<Option<DiscordIpc>>, mut f: F) -> Result<(), IpcError>
where
    F: FnMut(&mut DiscordIpc) -> Result<(), IpcError>,
{
    let mut guard = ipc.lock().unwrap();
    ensure_connected(&mut guard)?;

    // First attempt
    let first_err = match guard.as_mut().unwrap() {
        c => match f(c) {
            Ok(()) => return Ok(()),
            Err(e) => e,
        },
    };
    eprintln!("[FreeMiD] IPC call failed ({}) — dropping & reconnecting", first_err);
    *guard = None;
    ensure_connected(&mut guard)?;
    f(guard.as_mut().unwrap())
}

// ── Message dispatch ───────────────────────────────────────────────────────────

fn handle_message(msg: &Value, ipc: &Mutex<Option<DiscordIpc>>) -> Result<(), String> {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "PING" => {
            let connected = ipc.lock().unwrap().is_some();
            send_status(connected, None);
            Ok(())
        }
        "SET_ACTIVITY" => {
            let activity_value = msg.get("activity").cloned().unwrap_or(Value::Null);
            let activity: Activity = serde_json::from_value(activity_value)
                .map_err(|e| format!("invalid activity: {}", e))?;
            match with_reconnect(ipc, |c| c.set_activity(&activity)) {
                Ok(()) => send_status(true, None),
                Err(e) => {
                    eprintln!("[FreeMiD] SET_ACTIVITY failed: {}", e);
                    send_status(false, Some(&e.to_string()));
                }
            }
            Ok(())
        }
        "CLEAR_ACTIVITY" => {
            match with_reconnect(ipc, |c| c.clear_activity()) {
                Ok(()) => send_status(true, None),
                Err(e) => {
                    eprintln!("[FreeMiD] CLEAR_ACTIVITY failed: {}", e);
                    send_status(false, Some(&e.to_string()));
                }
            }
            Ok(())
        }
        other => Err(format!("unknown message type: {}", other)),
    }
}
