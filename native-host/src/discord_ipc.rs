//! Discord IPC client (synchronous, Linux Unix-socket only).
//!
//! Connects to Discord's local IPC socket (`$XDG_RUNTIME_DIR/discord-ipc-N`,
//! also searches Flatpak app-sandboxed locations) and speaks the standard
//! framed protocol:
//!     u32 LE opcode | u32 LE length | UTF-8 JSON payload
//!
//! No async runtime — single connection, blocking I/O is fine.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OPCODE_HANDSHAKE: u32 = 0;
const OPCODE_FRAME: u32 = 1;
const OPCODE_PING: u32 = 3;
const OPCODE_PONG: u32 = 4;
const MAX_IPC_FRAME_SIZE: usize = 1024 * 1024;

/// Default Discord Application ID. Substituted at build time from the
/// `DISCORD_CLIENT_ID` env var (see `build.rs`). Falls back to empty string
/// if not set, in which case the host will refuse to handshake and log clearly.
pub const CLIENT_ID: &str = match option_env!("DISCORD_CLIENT_ID") {
    Some(s) => s,
    None => "",
};

fn nonce() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

// ── Activity types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Activity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 0=Playing  2=Listening  3=Watching  5=Competing
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub activity_type: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamps: Option<Timestamps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<Assets>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buttons: Option<Vec<Button>>,
    /// Override the Discord application used for this activity.
    /// Allows per-activity custom artwork uploaded to its own app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timestamps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub large_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub small_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Button {
    pub label: String,
    pub url: String,
}

// ── Errors ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum IpcError {
    SocketNotFound,
    Io(io::Error),
    Protocol(String),
    Json(serde_json::Error),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::SocketNotFound => write!(f, "Discord IPC socket not found — is Discord running?"),
            IpcError::Io(e) => write!(f, "IO error: {}", e),
            IpcError::Protocol(s) => write!(f, "Discord IPC protocol error: {}", s),
            IpcError::Json(e) => write!(f, "JSON error: {}", e),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<io::Error> for IpcError {
    fn from(e: io::Error) -> Self { IpcError::Io(e) }
}

impl From<serde_json::Error> for IpcError {
    fn from(e: serde_json::Error) -> Self { IpcError::Json(e) }
}

pub type IpcResult<T> = Result<T, IpcError>;

// ── Socket discovery ───────────────────────────────────────────────────────────

fn find_socket() -> Option<PathBuf> {
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok();
    let allow_tmp_ipc = std::env::var("FREEMID_ALLOW_TMP_IPC").as_deref() == Ok("1");

    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(ref r) = runtime {
        let r = PathBuf::from(r);
        // Flatpak Discord places the socket under app/<app-id>/
        bases.push(r.join("app").join("com.discordapp.Discord"));
        bases.push(r.join("app").join("com.discordapp.DiscordCanary"));
        bases.push(r.join("app").join("com.discordapp.DiscordPTB"));
        bases.push(r);
    }

    if allow_tmp_ipc {
        for var in &["TMPDIR", "TMP", "TEMP"] {
            if let Ok(v) = std::env::var(var) {
                bases.push(PathBuf::from(v));
            }
        }
        bases.push(PathBuf::from("/tmp"));
    }

    for base in &bases {
        for n in 0u8..10 {
            let path = base.join(format!("discord-ipc-{}", n));
            if path.exists() {
                return Some(path);
            }
        }
    }
    None
}

// ── IPC client ─────────────────────────────────────────────────────────────────

pub struct DiscordIpc {
    stream: UnixStream,
}

impl DiscordIpc {
    /// Connect to the Discord IPC socket and complete the handshake.
    pub fn connect_and_handshake() -> IpcResult<Self> {
        if CLIENT_ID.is_empty() {
            return Err(IpcError::Protocol(
                "DISCORD_CLIENT_ID was not set at build time".into(),
            ));
        }
        let path = find_socket().ok_or(IpcError::SocketNotFound)?;
        let stream = UnixStream::connect(&path)?;
        // Reasonable read timeout so we don't hang forever if Discord misbehaves.
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;

        let mut ipc = Self { stream };
        ipc.handshake()?;
        Ok(ipc)
    }

    fn send_frame(&mut self, opcode: u32, payload: &Value) -> IpcResult<()> {
        let data = serde_json::to_vec(payload)?;
        if data.len() > MAX_IPC_FRAME_SIZE {
            return Err(IpcError::Protocol(format!(
                "outgoing frame too large: {} bytes",
                data.len()
            )));
        }
        let mut header = [0u8; 8];
        header[..4].copy_from_slice(&opcode.to_le_bytes());
        header[4..].copy_from_slice(&(data.len() as u32).to_le_bytes());
        self.stream.write_all(&header)?;
        self.stream.write_all(&data)?;
        Ok(())
    }

    fn recv_frame(&mut self) -> IpcResult<(u32, Value)> {
        let mut header = [0u8; 8];
        self.stream.read_exact(&mut header)?;
        let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
        let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
        if length > MAX_IPC_FRAME_SIZE {
            return Err(IpcError::Protocol(format!(
                "incoming frame too large: {} bytes",
                length
            )));
        }
        if length == 0 {
            return Ok((opcode, Value::Null));
        }
        let mut data = vec![0u8; length];
        self.stream.read_exact(&mut data)?;
        let value: Value = serde_json::from_slice(&data)?;
        Ok((opcode, value))
    }

    fn handshake(&mut self) -> IpcResult<()> {
        self.send_frame(OPCODE_HANDSHAKE, &json!({ "v": 1, "client_id": CLIENT_ID }))?;

        // Read frames until we get a READY (Discord may send a PING first).
        loop {
            let (opcode, resp) = self.recv_frame()?;
            match opcode {
                OPCODE_FRAME => {
                    if resp["evt"] == "READY" {
                        return Ok(());
                    }
                    if resp["evt"] == "ERROR" {
                        return Err(IpcError::Protocol(format!(
                            "Discord rejected handshake: {}",
                            resp["data"]["message"]
                        )));
                    }
                }
                OPCODE_PING => {
                    self.send_frame(OPCODE_PONG, &resp)?;
                }
                op => {
                    return Err(IpcError::Protocol(format!(
                        "unexpected opcode {} during handshake",
                        op
                    )));
                }
            }
        }
    }

    pub fn set_activity(&mut self, activity: &Activity) -> IpcResult<()> {
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": nonce(),
        });
        self.send_frame(OPCODE_FRAME, &payload)?;
        // Drain the ack so the socket buffer doesn't grow.
        let _ = self.recv_frame();
        Ok(())
    }

    pub fn clear_activity(&mut self) -> IpcResult<()> {
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": Value::Null },
            "nonce": nonce(),
        });
        self.send_frame(OPCODE_FRAME, &payload)?;
        let _ = self.recv_frame();
        Ok(())
    }
}
