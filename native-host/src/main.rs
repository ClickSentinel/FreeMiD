#![deny(clippy::all)]
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
mod update;
#[cfg(windows)]
mod smtc;
#[cfg(windows)]
mod windows_apply;

use discord_ipc::{Activity, DiscordIpc, IpcError};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::CreateMutexW;

const MAX_INBOUND_BYTES: u32 = 1024 * 1024;
// Keep above extension keepalive cadence (~24s) while reclaiming stale hosts quickly.
const HOST_IDLE_TIMEOUT_MS: u64 = 45_000;
#[cfg(windows)]
const SINGLE_INSTANCE_MUTEX_NAME: &str = "Local\\FreeMiD.NativeHost";
#[cfg(windows)]
const SINGLE_INSTANCE_RETRY_COUNT: u32 = 3;
#[cfg(windows)]
const SINGLE_INSTANCE_RETRY_DELAY_MS: u64 = 750;

static LAST_MESSAGE_MS: AtomicU64 = AtomicU64::new(0);

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `--apply-update <staged> <target> [old-pid]`: accept the optional trailing
    // pid (>= 4 args) so a copy of this binary works as the apply helper, matching
    // the dedicated freemid-apply. The pid is advisory and ignored here.
    if args.len() >= 4 && args[1] == "--apply-update" {
        if let Err(e) = update::run_apply_update(&args[2], &args[3]) {
            eprintln!("[FreeMiD] update helper failed: {}", e);
            std::process::exit(1);
        }
        return;
    }

    eprintln!(
        "[FreeMiD] native host v{} starting",
        env!("CARGO_PKG_VERSION")
    );

    #[cfg(windows)]
    update::cleanup_staged_files();

    #[cfg(windows)]
    let _single_instance_guard = match acquire_single_instance_guard_with_grace() {
        Ok(guard) => guard,
        Err(e) => {
            eprintln!("[FreeMiD] single-instance guard failed: {}", e);
            std::process::exit(0);
        }
    };

    LAST_MESSAGE_MS.store(now_unix_ms(), Ordering::Relaxed);
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(10));
        let last = LAST_MESSAGE_MS.load(Ordering::Relaxed);
        let now = now_unix_ms();
        if last > 0 && now.saturating_sub(last) > HOST_IDLE_TIMEOUT_MS {
            eprintln!(
                "[FreeMiD] idle timeout reached ({} ms); exiting",
                HOST_IDLE_TIMEOUT_MS
            );
            std::process::exit(0);
        }
    });

    let ipc: Mutex<Option<DiscordIpc>> = Mutex::new(None);

    // Eagerly try to connect to Discord IPC. Don't send STATUS yet — Chrome's
    // native-messaging pipe may not be ready to relay it, causing the message
    // to be silently dropped. The popup polls via PING instead.
    if let Err(e) = ensure_connected(&mut ipc.lock().unwrap_or_else(|e| e.into_inner())) {
        eprintln!("[FreeMiD] initial Discord connect failed: {}", e);
    } else {
        eprintln!("[FreeMiD] Discord IPC connected at startup");
    }

    loop {
        match read_message() {
            Ok(None) => {
                // stdin closed — Chrome disconnected.
                eprintln!("[FreeMiD] stdin EOF — exiting cleanly");
                return;
            }
            Ok(Some(msg)) => {
                LAST_MESSAGE_MS.store(now_unix_ms(), Ordering::Relaxed);
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

#[cfg(windows)]
struct SingleInstanceGuard {
    handle: HANDLE,
}

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(windows)]
fn try_acquire_single_instance_guard() -> Result<SingleInstanceGuard, String> {
    let mut name_w: Vec<u16> = SINGLE_INSTANCE_MUTEX_NAME.encode_utf16().collect();
    name_w.push(0);

    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name_w.as_ptr()) };

    if handle.is_null() {
        return Err(format!("CreateMutexW failed with error {}", unsafe {
            GetLastError()
        }));
    }

    let err = unsafe { GetLastError() };
    if err == ERROR_ALREADY_EXISTS {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err("another host instance is already running".to_string());
    }

    Ok(SingleInstanceGuard { handle })
}

#[cfg(windows)]
fn acquire_single_instance_guard_with_grace() -> Result<SingleInstanceGuard, String> {
    for attempt in 0..SINGLE_INSTANCE_RETRY_COUNT {
        match try_acquire_single_instance_guard() {
            Ok(guard) => {
                if attempt > 0 {
                    eprintln!(
                        "[FreeMiD] single-instance mutex acquired after {} retries",
                        attempt
                    );
                }
                return Ok(guard);
            }
            Err(e) if e.contains("already running") => {
                if attempt + 1 == SINGLE_INSTANCE_RETRY_COUNT {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(SINGLE_INSTANCE_RETRY_DELAY_MS));
            }
            Err(e) => return Err(e),
        }
    }

    Err("failed to acquire single-instance mutex".to_string())
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
    let value: Value =
        serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(value))
}

pub(crate) fn write_message(value: &Value) {
    let data = match serde_json::to_vec(value) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[FreeMiD] failed to serialize outbound message: {}", e);
            return;
        }
    };
    let len = u32::try_from(data.len())
        .expect("serialized message length exceeds u32::MAX")
        .to_le_bytes();
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    if let Err(e) = lock
        .write_all(&len)
        .and_then(|()| lock.write_all(&data))
        .and_then(|()| lock.flush())
    {
        eprintln!("[FreeMiD] failed to write outbound message: {}", e);
    }
}

fn send_status(connected: bool, error: Option<&str>) {
    let mut payload = json!({
        "type": "STATUS",
        "connected": connected,
        "version": env!("CARGO_PKG_VERSION"),
        "selfUpdateSupported": update::self_update_supported(),
        "runtimeOs": std::env::consts::OS,
        "runtimeArch": std::env::consts::ARCH,
    });
    if let Ok(path) = std::env::current_exe() {
        payload["binaryPath"] = Value::String(path.display().to_string());
    }
    if let Some(e) = error {
        payload["error"] = Value::String(e.to_string());
    }
    write_message(&payload);
}

// ── IPC connection management ──────────────────────────────────────────────────

fn ensure_connected(
    slot: &mut std::sync::MutexGuard<'_, Option<DiscordIpc>>,
) -> Result<(), IpcError> {
    if slot.is_some() {
        return Ok(());
    }
    let ipc = DiscordIpc::connect_and_handshake()?;
    **slot = Some(ipc);
    eprintln!("[FreeMiD] Discord IPC connected");
    Ok(())
}

fn is_transient_ipc_error(err: &IpcError) -> bool {
    match err {
        IpcError::Io(e) => matches!(
            e.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
        ),
        _ => false,
    }
}

/// Run `f` on the live IPC, reconnecting once on failure.
fn with_reconnect<F>(ipc: &Mutex<Option<DiscordIpc>>, mut f: F) -> Result<(), IpcError>
where
    F: FnMut(&mut DiscordIpc) -> Result<(), IpcError>,
{
    let mut guard = ipc.lock().unwrap_or_else(|e| e.into_inner());
    ensure_connected(&mut guard)?;

    // First attempt
    let c = guard
        .as_mut()
        .expect("IPC slot is Some after ensure_connected");
    let first_err = match f(c) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };

    if is_transient_ipc_error(&first_err) {
        eprintln!(
            "[FreeMiD] IPC transient error ({}); keeping current connection and retrying on next tick",
            first_err
        );
        return Ok(());
    }

    eprintln!(
        "[FreeMiD] IPC call failed ({}) — dropping & reconnecting",
        first_err
    );
    *guard = None;
    ensure_connected(&mut guard)?;
    f(guard
        .as_mut()
        .expect("IPC slot is Some after ensure_connected"))
}

// ── Message dispatch ───────────────────────────────────────────────────────────

fn handle_message(msg: &Value, ipc: &Mutex<Option<DiscordIpc>>) -> Result<(), String> {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "PING" => {
            // Attempt to (re)connect to Discord IPC if we're not already connected.
            // This means opening the popup always triggers a fresh connect attempt,
            // so the status dot updates correctly without waiting for the next
            // SET_ACTIVITY call.
            {
                let mut guard = ipc.lock().unwrap_or_else(|e| e.into_inner());
                if guard.is_none() {
                    if let Err(e) = ensure_connected(&mut guard) {
                        eprintln!("[FreeMiD] PING: Discord reconnect failed: {}", e);
                    }
                }
            }
            let connected = ipc.lock().unwrap_or_else(|e| e.into_inner()).is_some();
            send_status(connected, None);
            Ok(())
        }
        "UPDATE" => {
            let overrides = update::UpdateSourceOverrides {
                latest_url: msg
                    .get("latestUrl")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                releases_base_url: msg
                    .get("releasesBaseUrl")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            };
            update::run_update(overrides, |v| write_message(&v));
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
        #[cfg(windows)]
        "GET_DESKTOP_MEDIA" => {
            let app = msg.get("app").and_then(Value::as_str).unwrap_or("");
            let track = if app == "tidal" {
                smtc::query_tidal()
            } else {
                None
            };
            write_message(&json!({
                "type": "DESKTOP_MEDIA",
                "app": app,
                "track": track,
            }));
            Ok(())
        }
        other => Err(format!("unknown message type: {}", other)),
    }
}
