use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

use crate::discord_ipc::{Activity, DiscordIpc};

const MAX_ACTIVITY_TEXT_LEN: usize = 512;
const MAX_ACTIVITY_URL_LEN: usize = 2048;
const MAX_BUTTON_LABEL_LEN: usize = 64;
const MAX_BUTTONS: usize = 2;

/// Run the WebSocket server and the Discord IPC manager.
/// Binds to `bind_addr` (always 127.0.0.1) and relays activity updates
/// received from browser extension clients to the local Discord desktop client.
pub async fn run(bind_addr: &str, discord_status_tx: watch::Sender<bool>) {
    // watch channel: any extension connection can write the current activity;
    // the Discord manager task reads it whenever it changes.
    let (activity_tx, activity_rx) = watch::channel::<Option<Activity>>(None);
    let activity_tx = Arc::new(activity_tx);

    // Spawn the task that maintains the Discord IPC connection
    tokio::spawn(discord_manager(activity_rx, discord_status_tx));

    let listener = TcpListener::bind(bind_addr)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind WebSocket server on {}: {}", bind_addr, e));

    log::info!("FreeMiD WebSocket server listening on ws://{}", bind_addr);

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                log::info!("Extension client connected from {}", addr);
                let tx = Arc::clone(&activity_tx);
                tokio::spawn(handle_client(stream, tx));
            }
            Err(e) => log::error!("TCP accept error: {}", e),
        }
    }
}

/// Keeps a Discord IPC connection alive. When the activity watch channel
/// changes, immediately pushes the update to Discord. Reconnects automatically
/// if Discord is restarted.
async fn discord_manager(
    mut activity_rx: watch::Receiver<Option<Activity>>,
    status_tx: watch::Sender<bool>,
) {
    loop {
        log::info!("Connecting to Discord IPC...");

        let mut ipc = match DiscordIpc::connect().await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("{} — retrying in 5 s", e);
                let _ = status_tx.send(false);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        match ipc.handshake().await {
            Err(e) => {
                log::error!("Discord handshake failed: {} — retrying in 5 s", e);
                let _ = status_tx.send(false);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            Ok(()) => {
                let _ = status_tx.send(true);

                // Push any currently-active activity immediately after connecting
                // (drop the borrow guard before .await so the future stays Send)
                let initial_activity = activity_rx.borrow().clone();
                if let Some(activity) = initial_activity {
                    if let Err(e) = ipc.set_activity(&activity).await {
                        log::error!("Initial set_activity failed: {}", e);
                        let _ = status_tx.send(false);
                        continue;
                    }
                }

                // Watch for changes and forward them
                loop {
                    // Wait until the activity value changes
                    if activity_rx.changed().await.is_err() {
                        // Sender dropped — time to shut down
                        return;
                    }

                    let current = activity_rx.borrow().clone();
                    let result = match current {
                        Some(ref activity) => {
                            log::debug!(
                                "Pushing activity: {}",
                                activity.details.as_deref().unwrap_or("(no details)")
                            );
                            ipc.set_activity(activity).await
                        }
                        None => {
                            log::debug!("Clearing activity");
                            ipc.clear_activity().await
                        }
                    };

                    if let Err(e) = result {
                        log::warn!("Discord IPC write failed: {} — reconnecting", e);
                        let _ = status_tx.send(false);
                        break; // outer loop will reconnect
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Handle one browser-extension WebSocket connection.
async fn handle_client(stream: TcpStream, activity_tx: Arc<watch::Sender<Option<Activity>>>) {
    // Only accept connections from browser extension origins as a basic
    // security measure. Localhost-only binding already limits exposure,
    // but origin validation adds defence-in-depth.
    let ws = match accept_validated(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::warn!("WebSocket handshake rejected: {}", e);
            return;
        }
    };

    let (mut write, mut read) = ws.split();

    // Greet the extension so it knows the host version
    let hello = json!({
        "type": "CONNECTED",
        "version": env!("CARGO_PKG_VERSION")
    });
    let _ = write
        .send(Message::Text(hello.to_string()))
        .await;

    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                handle_message(&text, &activity_tx);
            }
            Ok(Message::Close(_)) | Err(_) => {
                log::info!("Extension client disconnected — clearing activity");
                // Clear activity when extension goes away so the Discord
                // status doesn't linger indefinitely (PreMiD's 20-minute
                // paywall behaviour — we do it instantly, for free).
                let _ = activity_tx.send(None);
                break;
            }
            Ok(Message::Ping(data)) => {
                let _ = write.send(Message::Pong(data)).await;
            }
            _ => {}
        }
    }
}

fn handle_message(text: &str, activity_tx: &watch::Sender<Option<Activity>>) {
    let msg: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("Invalid JSON from extension: {}", e);
            return;
        }
    };

    match msg["type"].as_str().unwrap_or("") {
        "SET_ACTIVITY" => {
            match serde_json::from_value::<Activity>(msg["activity"].clone()) {
                Ok(activity) => {
                    if let Err(e) = validate_activity(&activity) {
                        log::warn!("Rejected activity payload: {}", e);
                        return;
                    }
                    log::debug!(
                        "SET_ACTIVITY: {}",
                        activity.details.as_deref().unwrap_or("(no details)")
                    );
                    let _ = activity_tx.send(Some(activity));
                }
                Err(e) => log::warn!("Malformed activity payload: {}", e),
            }
        }
        "CLEAR_ACTIVITY" => {
            log::debug!("CLEAR_ACTIVITY received");
            let _ = activity_tx.send(None);
        }
        other => log::warn!("Unknown message type from extension: {:?}", other),
    }
}

fn validate_activity(activity: &Activity) -> Result<()> {
    fn check_len(value: Option<&str>, max: usize, field: &str) -> Result<()> {
        if let Some(v) = value {
            if v.len() > max {
                return Err(anyhow!("{} exceeds {} bytes", field, max));
            }
        }
        Ok(())
    }

    check_len(activity.name.as_deref(), MAX_ACTIVITY_TEXT_LEN, "name")?;
    check_len(activity.details.as_deref(), MAX_ACTIVITY_TEXT_LEN, "details")?;
    check_len(activity.state.as_deref(), MAX_ACTIVITY_TEXT_LEN, "state")?;
    check_len(
        activity.application_id.as_deref(),
        MAX_ACTIVITY_TEXT_LEN,
        "application_id",
    )?;

    if let Some(assets) = &activity.assets {
        check_len(
            assets.large_image.as_deref(),
            MAX_ACTIVITY_URL_LEN,
            "assets.large_image",
        )?;
        check_len(
            assets.large_text.as_deref(),
            MAX_ACTIVITY_TEXT_LEN,
            "assets.large_text",
        )?;
        check_len(
            assets.large_url.as_deref(),
            MAX_ACTIVITY_URL_LEN,
            "assets.large_url",
        )?;
        check_len(
            assets.small_image.as_deref(),
            MAX_ACTIVITY_URL_LEN,
            "assets.small_image",
        )?;
        check_len(
            assets.small_text.as_deref(),
            MAX_ACTIVITY_TEXT_LEN,
            "assets.small_text",
        )?;
        check_len(
            assets.small_url.as_deref(),
            MAX_ACTIVITY_URL_LEN,
            "assets.small_url",
        )?;
    }

    if let Some(buttons) = &activity.buttons {
        if buttons.len() > MAX_BUTTONS {
            return Err(anyhow!("buttons exceeds {}", MAX_BUTTONS));
        }
        for (idx, button) in buttons.iter().enumerate() {
            check_len(
                Some(button.label.as_str()),
                MAX_BUTTON_LABEL_LEN,
                &format!("buttons[{}].label", idx),
            )?;
            check_len(
                Some(button.url.as_str()),
                MAX_ACTIVITY_URL_LEN,
                &format!("buttons[{}].url", idx),
            )?;
        }
    }

    if let Some(ts) = &activity.timestamps {
        if let (Some(start), Some(end)) = (ts.start, ts.end) {
            if end < start {
                return Err(anyhow!("timestamps.end is earlier than timestamps.start"));
            }
        }
    }

    Ok(())
}

/// Accept a WebSocket connection, validating that the Origin header looks like
/// a browser extension. Rejects anything that isn't `chrome-extension://` or
/// `moz-extension://`.
async fn accept_validated(
    stream: TcpStream,
) -> Result<tokio_tungstenite::WebSocketStream<TcpStream>> {
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};

    let ws = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, resp: Response| {
        let origin = req
            .headers()
            .get("Origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        let allow_empty_origin = cfg!(debug_assertions)
            || std::env::var("FREEMID_ALLOW_EMPTY_ORIGIN").as_deref() == Ok("1");

        let allowed = (allow_empty_origin && origin.is_empty())
            || origin.starts_with("chrome-extension://")
            || origin.starts_with("moz-extension://")
            || origin.starts_with("safari-web-extension://");

        if !allowed {
            log::warn!("Rejected WebSocket connection from origin: {}", origin);
            // Return a 403; tokio-tungstenite will close the connection.
            let mut err_resp = HttpResponse::<Option<String>>::new(None);
            *err_resp.status_mut() = StatusCode::FORBIDDEN;
            return Err(err_resp);
        }

        Ok(resp)
    })
    .await?;

    Ok(ws)
}
