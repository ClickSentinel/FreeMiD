//! Discord IPC client (synchronous, cross-platform).
//!
//! Connects to Discord's local IPC socket and speaks the standard framed
//! protocol:  u32 LE opcode | u32 LE length | UTF-8 JSON payload
//!
//! Platform socket locations:
//!   Linux  — `$XDG_RUNTIME_DIR/discord-ipc-N` (also Flatpak paths)
//!   macOS  — `$TMPDIR/discord-ipc-N`
//!   Windows — `\\.\pipe\discord-ipc-N`
//!
//! No async runtime — single connection, blocking I/O is fine.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::PathBuf;

const OPCODE_HANDSHAKE: u32 = 0;
const OPCODE_FRAME: u32 = 1;
const OPCODE_CLOSE: u32 = 2;
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
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed).to_string()
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
            IpcError::SocketNotFound => {
                write!(f, "Discord IPC socket not found — is Discord running?")
            }
            IpcError::Io(e) => write!(f, "IO error: {}", e),
            IpcError::Protocol(s) => write!(f, "Discord IPC protocol error: {}", s),
            IpcError::Json(e) => write!(f, "JSON error: {}", e),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<io::Error> for IpcError {
    fn from(e: io::Error) -> Self {
        IpcError::Io(e)
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(e: serde_json::Error) -> Self {
        IpcError::Json(e)
    }
}

pub type IpcResult<T> = Result<T, IpcError>;

// ── Platform stream abstraction ────────────────────────────────────────────────

/// Wraps the platform-specific IPC stream in a uniform Read+Write handle.
/// On Unix this is a UnixStream; on Windows a named pipe opened as a File.
enum IpcStream {
    #[cfg(unix)]
    Unix(UnixStream),
    #[cfg(windows)]
    NamedPipe(std::fs::File),
}

impl Read for IpcStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            IpcStream::Unix(s) => s.read(buf),
            #[cfg(windows)]
            IpcStream::NamedPipe(f) => f.read(buf),
        }
    }
}

impl Write for IpcStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            IpcStream::Unix(s) => s.write(buf),
            #[cfg(windows)]
            IpcStream::NamedPipe(f) => f.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            IpcStream::Unix(s) => s.flush(),
            #[cfg(windows)]
            IpcStream::NamedPipe(f) => f.flush(),
        }
    }
}

// ── Socket / pipe discovery ────────────────────────────────────────────────────

fn open_ipc_stream() -> Option<IpcStream> {
    // ── Linux ──────────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        let mut bases: Vec<PathBuf> = Vec::new();
        if let Ok(r) = std::env::var("XDG_RUNTIME_DIR") {
            let r = PathBuf::from(r);
            // Flatpak Discord places the socket under app/<app-id>/
            bases.push(r.join("app").join("com.discordapp.Discord"));
            bases.push(r.join("app").join("com.discordapp.DiscordCanary"));
            bases.push(r.join("app").join("com.discordapp.DiscordPTB"));
            bases.push(r);
        }
        // Allow /tmp search only when explicitly opted in
        // (avoids TOCTOU with world-writable directories).
        if std::env::var("FREEMID_ALLOW_TMP_IPC").as_deref() == Ok("1") {
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
                if let Ok(s) = UnixStream::connect(&path) {
                    return Some(IpcStream::Unix(s));
                }
            }
        }
    }

    // ── macOS ──────────────────────────────────────────────────────────────
    // Discord on macOS places the socket in $TMPDIR (set by launchd,
    // e.g. /var/folders/xx/.../T/). Fall back to /tmp if unset.
    #[cfg(target_os = "macos")]
    {
        let tmpdir = std::env::var("TMPDIR")
            .or_else(|_| std::env::var("TMP"))
            .or_else(|_| std::env::var("TEMP"))
            .unwrap_or_else(|_| "/tmp".to_string());
        for base in &[tmpdir.as_str(), "/tmp"] {
            for n in 0u8..10 {
                let path = PathBuf::from(base).join(format!("discord-ipc-{}", n));
                if let Ok(s) = UnixStream::connect(&path) {
                    return Some(IpcStream::Unix(s));
                }
            }
        }
    }

    // ── Windows ────────────────────────────────────────────────────────────
    // Discord on Windows uses named pipes: \\.\pipe\discord-ipc-N
    // Open with read+write access using standard File I/O (no extra crates).
    #[cfg(windows)]
    {
        use std::fs::OpenOptions;
        for n in 0u8..10 {
            let path = format!("\\\\.\\pipe\\discord-ipc-{}", n);
            if let Ok(f) = OpenOptions::new().read(true).write(true).open(&path) {
                return Some(IpcStream::NamedPipe(f));
            }
        }
    }

    None
}

// ── IPC client ─────────────────────────────────────────────────────────────────

pub struct DiscordIpc {
    stream: IpcStream,
}

impl DiscordIpc {
    /// Connect to the Discord IPC socket/pipe and complete the handshake.
    pub fn connect_and_handshake() -> IpcResult<Self> {
        if CLIENT_ID.is_empty() {
            return Err(IpcError::Protocol(
                "DISCORD_CLIENT_ID was not set at build time".into(),
            ));
        }
        let stream = open_ipc_stream().ok_or(IpcError::SocketNotFound)?;

        // Set I/O timeouts on Unix (named pipes on Windows don't support
        // set_read_timeout via std::fs::File — they respect the pipe's
        // own timeout configured by Discord, which is fine).
        #[cfg(unix)]
        {
            let IpcStream::Unix(ref s) = stream;
            s.set_read_timeout(Some(Duration::from_secs(5)))?;
            s.set_write_timeout(Some(Duration::from_secs(5)))?;
        }
        // Suppress unused-import warning on Windows where Duration isn't used.
        #[cfg(windows)]
        let _ = Duration::from_secs(0);

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
        header[4..].copy_from_slice(
            &u32::try_from(data.len())
                .expect("IPC frame length exceeds u32::MAX")
                .to_le_bytes(),
        );
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
                OPCODE_CLOSE => {
                    return Err(IpcError::Protocol(
                        "Discord closed the connection during handshake".into(),
                    ));
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

    /// Consume frames until the Discord RPC ack (`OPCODE_FRAME`) arrives.
    ///
    /// Discord may send `OPCODE_PING` frames before the ack. Consuming only
    /// one frame without checking the opcode would desync the socket if a ping
    /// arrives first — all subsequent sends would read the wrong ack. Pings
    /// are replied to in-place; close frames and errors break the loop.
    fn drain_ack(&mut self) {
        loop {
            match self.recv_frame() {
                Ok((OPCODE_FRAME, ref resp)) => {
                    if resp["evt"] == "ERROR" {
                        let code = resp["data"]["code"].as_i64().unwrap_or(-1);
                        let msg = resp["data"]["message"].as_str().unwrap_or("unknown");
                        eprintln!(
                            "[FreeMiD/discord] IPC error in ack (code {}): {}",
                            code, msg
                        );
                    }
                    break;
                }
                Ok((OPCODE_PING, payload)) => {
                    let _ = self.send_frame(OPCODE_PONG, &payload);
                }
                // OPCODE_CLOSE or any error: stop draining. The broken socket
                // will be detected on the next send_frame call and trigger a
                // reconnect via with_reconnect in main.rs.
                Ok(_) | Err(_) => break,
            }
        }
    }

    fn send_set_activity(&mut self, activity: &Value) -> IpcResult<()> {
        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": nonce(),
        });
        self.send_frame(OPCODE_FRAME, &payload)?;
        self.drain_ack();
        Ok(())
    }

    pub fn set_activity(&mut self, activity: &Activity) -> IpcResult<()> {
        self.send_set_activity(&serde_json::to_value(activity)?)
    }

    pub fn clear_activity(&mut self) -> IpcResult<()> {
        self.send_set_activity(&Value::Null)
    }
}
