use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const OPCODE_HANDSHAKE: u32 = 0;
const OPCODE_FRAME: u32 = 1;
// pub const OPCODE_CLOSE: u32 = 2;
const MAX_IPC_FRAME_SIZE: usize = 1024 * 1024;

/// Register a free Discord application at https://discord.com/developers/applications
/// Enable "Rich Presence" under the app settings and paste the Application ID here.
pub const CLIENT_ID: &str = "DISCORD_CLIENT_ID_REMOVED";

fn nonce() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .to_string()
}

// ── Shared activity types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Activity {
    /// Overrides the app name shown in "Listening to X" / "Playing X"
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

// ── Platform-specific IPC implementation ──────────────────────────────────────

#[cfg(unix)]
pub mod ipc {
    use super::*;
    use tokio::net::UnixStream;

    fn find_socket() -> Option<std::path::PathBuf> {
        let runtime = std::env::var("XDG_RUNTIME_DIR").ok();
        let allow_tmp_ipc = std::env::var("FREEMID_ALLOW_TMP_IPC").as_deref() == Ok("1");

        // Collect base directories to search, including Flatpak sandboxed paths.
        let mut bases: Vec<std::path::PathBuf> = Vec::new();
        if let Some(ref r) = runtime {
            let r = std::path::PathBuf::from(r);
            // Flatpak Discord puts the socket under app/<app-id>/
            bases.push(r.join("app").join("com.discordapp.Discord"));
            bases.push(r.join("app").join("com.discordapp.DiscordCanary"));
            bases.push(r.join("app").join("com.discordapp.DiscordPTB"));
            bases.push(r.clone());
        }

        if allow_tmp_ipc {
            log::warn!("FREEMID_ALLOW_TMP_IPC=1 set: enabling insecure temporary-directory IPC socket lookup");
            for extra in &[
                std::env::var("TMPDIR").ok(),
                std::env::var("TMP").ok(),
                std::env::var("TEMP").ok(),
                Some("/tmp".into()),
            ] {
                if let Some(p) = extra {
                    bases.push(std::path::PathBuf::from(p));
                }
            }
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

    pub struct DiscordIpc {
        stream: UnixStream,
    }

    impl DiscordIpc {
        pub async fn connect() -> Result<Self> {
            let path = find_socket()
                .ok_or_else(|| anyhow!("Discord IPC socket not found — is Discord running?"))?;
            let stream = UnixStream::connect(&path).await?;
            log::debug!("Connected to Discord IPC at {}", path.display());
            Ok(Self { stream })
        }

        pub async fn send_frame(&mut self, opcode: u32, payload: &Value) -> Result<()> {
            let data = serde_json::to_vec(payload)?;
            let mut header = [0u8; 8];
            header[..4].copy_from_slice(&opcode.to_le_bytes());
            header[4..].copy_from_slice(&(data.len() as u32).to_le_bytes());
            self.stream.write_all(&header).await?;
            self.stream.write_all(&data).await?;
            Ok(())
        }

        pub async fn recv_frame(&mut self) -> Result<(u32, Value)> {
            let mut header = [0u8; 8];
            self.stream.read_exact(&mut header).await?;
            let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
            let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
            if length > MAX_IPC_FRAME_SIZE {
                return Err(anyhow!("Discord IPC frame too large: {} bytes", length));
            }
            if length == 0 {
                return Ok((opcode, Value::Null));
            }
            let mut data = vec![0u8; length];
            self.stream.read_exact(&mut data).await?;
            let value: Value = serde_json::from_slice(&data)?;
            Ok((opcode, value))
        }

        pub async fn handshake(&mut self) -> Result<()> {
            self.send_frame(
                OPCODE_HANDSHAKE,
                &json!({ "v": 1, "client_id": super::CLIENT_ID }),
            )
            .await?;

            // Read frames until we receive READY (Discord may send a PING first)
            loop {
                let (opcode, resp) = self.recv_frame().await?;
                match opcode {
                    OPCODE_FRAME => {
                        if resp["evt"] == "READY" {
                            log::info!(
                                "Discord IPC ready (user: {})",
                                resp["data"]["user"]["username"]
                                    .as_str()
                                    .unwrap_or("unknown")
                            );
                            return Ok(());
                        }
                        if resp["evt"] == "ERROR" {
                            return Err(anyhow!("Discord IPC error: {}", resp["data"]["message"]));
                        }
                    }
                    3 => {
                        // PING — reply with PONG
                        self.send_frame(4, &resp).await?;
                    }
                    op => {
                        log::warn!("Unexpected opcode {} during handshake: {}", op, resp);
                    }
                }
            }
        }

        pub async fn set_activity(&mut self, activity: &Activity) -> Result<()> {
            let payload = json!({
                "cmd": "SET_ACTIVITY",
                "args": {
                    "pid": std::process::id(),
                    "activity": activity
                },
                "nonce": super::nonce()
            });
            log::debug!("SET_ACTIVITY payload: {}", serde_json::to_string(&payload).unwrap_or_default());
            self.send_frame(OPCODE_FRAME, &payload).await?;
            // Drain response so the socket buffer stays clear
            match self.recv_frame().await {
                Ok((_, resp)) => log::debug!("SET_ACTIVITY response: {}", resp),
                Err(e) => log::warn!("SET_ACTIVITY no response: {}", e),
            }
            Ok(())
        }

        pub async fn clear_activity(&mut self) -> Result<()> {
            let payload = json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": null },
                "nonce": super::nonce()
            });
            self.send_frame(OPCODE_FRAME, &payload).await?;
            let _ = self.recv_frame().await;
            Ok(())
        }
    }
}

#[cfg(windows)]
pub mod ipc {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub struct DiscordIpc {
        pipe: tokio::net::windows::named_pipe::NamedPipeClient,
    }

    impl DiscordIpc {
        pub async fn connect() -> Result<Self> {
            for n in 0u8..10 {
                let path = format!(r"\\.\pipe\discord-ipc-{}", n);
                match ClientOptions::new().open(&path) {
                    Ok(pipe) => {
                        log::debug!("Connected to Discord IPC at {}", path);
                        return Ok(Self { pipe });
                    }
                    Err(_) => continue,
                }
            }
            Err(anyhow!("Discord IPC pipe not found — is Discord running?"))
        }

        pub async fn send_frame(&mut self, opcode: u32, payload: &Value) -> Result<()> {
            let data = serde_json::to_vec(payload)?;
            let mut header = [0u8; 8];
            header[..4].copy_from_slice(&opcode.to_le_bytes());
            header[4..].copy_from_slice(&(data.len() as u32).to_le_bytes());
            self.pipe.write_all(&header).await?;
            self.pipe.write_all(&data).await?;
            Ok(())
        }

        pub async fn recv_frame(&mut self) -> Result<(u32, Value)> {
            let mut header = [0u8; 8];
            self.pipe.read_exact(&mut header).await?;
            let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
            let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
            if length > MAX_IPC_FRAME_SIZE {
                return Err(anyhow!("Discord IPC frame too large: {} bytes", length));
            }
            if length == 0 {
                return Ok((opcode, Value::Null));
            }
            let mut data = vec![0u8; length];
            self.pipe.read_exact(&mut data).await?;
            let value: Value = serde_json::from_slice(&data)?;
            Ok((opcode, value))
        }

        pub async fn handshake(&mut self) -> Result<()> {
            self.send_frame(
                OPCODE_HANDSHAKE,
                &json!({ "v": 1, "client_id": super::CLIENT_ID }),
            )
            .await?;
            loop {
                let (opcode, resp) = self.recv_frame().await?;
                match opcode {
                    OPCODE_FRAME => {
                        if resp["evt"] == "READY" {
                            log::info!("Discord IPC ready");
                            return Ok(());
                        }
                        if resp["evt"] == "ERROR" {
                            return Err(anyhow!("Discord IPC error: {}", resp["data"]["message"]));
                        }
                    }
                    3 => { self.send_frame(4, &resp).await?; }
                    _ => {}
                }
            }
        }

        pub async fn set_activity(&mut self, activity: &Activity) -> Result<()> {
            let payload = json!({
                "cmd": "SET_ACTIVITY",
                "args": {
                    "pid": std::process::id(),
                    "activity": activity
                },
                "nonce": super::nonce()
            });
            self.send_frame(OPCODE_FRAME, &payload).await?;
            let _ = self.recv_frame().await;
            Ok(())
        }

        pub async fn clear_activity(&mut self) -> Result<()> {
            let payload = json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": null },
                "nonce": super::nonce()
            });
            self.send_frame(OPCODE_FRAME, &payload).await?;
            let _ = self.recv_frame().await;
            Ok(())
        }
    }
}

pub use ipc::DiscordIpc;
