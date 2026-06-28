use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;
use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;

static COM_INIT: Once = Once::new();
static WATCHER_SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// Signal the SMTC watcher thread to exit. Call before `std::process::exit`
/// so the thread leaves the COM MTA cleanly before ExitProcess runs DllMain
/// cleanup — otherwise COM teardown waits for the sleeping thread indefinitely.
pub fn signal_shutdown() {
    WATCHER_SHUTDOWN.store(true, Ordering::Release);
}

#[derive(Debug, Serialize)]
pub struct DesktopTrack {
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
}

type OnUpdateFn = dyn Fn(Option<DesktopTrack>) + Send + Sync + 'static;

struct ActiveSession {
    session: GlobalSystemMediaTransportControlsSession,
    props_token: EventRegistrationToken,
    playback_token: EventRegistrationToken,
    timeline_token: EventRegistrationToken,
}

impl Drop for ActiveSession {
    fn drop(&mut self) {
        let _ = self.session.RemoveMediaPropertiesChanged(self.props_token);
        let _ = self.session.RemovePlaybackInfoChanged(self.playback_token);
        let _ = self
            .session
            .RemoveTimelinePropertiesChanged(self.timeline_token);
    }
}

fn find_tidal_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    let sessions = manager.GetSessions().ok()?;
    let count = sessions.Size().ok()?;
    (0..count).filter_map(|i| sessions.GetAt(i).ok()).find(|s| {
        s.SourceAppUserModelId()
            .map(|id| id.to_string().to_lowercase().contains("tidal"))
            .unwrap_or(false)
    })
}

fn ticks_to_secs(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

fn track_from_session(session: &GlobalSystemMediaTransportControlsSession) -> Option<DesktopTrack> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;

    let title = props.Title().ok()?.to_string();
    if title.is_empty() {
        return None;
    }

    let artist = props
        .Artist()
        .ok()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let album = props
        .AlbumTitle()
        .ok()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    let playback = session.GetPlaybackInfo().ok()?;
    let status = playback.PlaybackStatus().ok()?;
    let state = if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
        "playing"
    } else if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused {
        "paused"
    } else {
        "stopped"
    }
    .to_string();

    let timeline = session.GetTimelineProperties().ok()?;

    // When playing, SMTC position is only updated when Tidal explicitly pushes
    // it (e.g. on seek). Extrapolate forward using LastUpdatedTime so the
    // extension receives a continuously-accurate position on every push.
    let position_secs = match (timeline.Position().ok(), timeline.LastUpdatedTime().ok()) {
        (Some(pos), Some(updated)) if state == "playing" => {
            let ft = unsafe { GetSystemTimeAsFileTime() };
            let now_ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
            let elapsed_ticks = now_ticks.saturating_sub(updated.UniversalTime as u64);
            let secs = ticks_to_secs(pos.Duration) + ticks_to_secs(elapsed_ticks as i64);
            Some(secs.max(0.0))
        }
        (Some(pos), _) => Some(ticks_to_secs(pos.Duration).max(0.0)),
        _ => None,
    };

    let duration_secs = match (timeline.EndTime().ok(), timeline.StartTime().ok()) {
        (Some(end), Some(start)) => {
            let dur = ticks_to_secs(end.Duration - start.Duration);
            if dur > 0.0 {
                Some(dur)
            } else {
                None
            }
        }
        _ => None,
    };

    Some(DesktopTrack {
        title,
        artist,
        album,
        state,
        position_secs,
        duration_secs,
    })
}

/// (Re)subscribe to the current Tidal SMTC session, or unsubscribe if Tidal
/// is no longer running. Pushes the current state immediately via `on_update`.
fn refresh_subscription(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    active: &Arc<Mutex<Option<ActiveSession>>>,
    on_update: &Arc<OnUpdateFn>,
) {
    let tidal = find_tidal_session(manager);
    let mut guard = active.lock().unwrap_or_else(|e| e.into_inner());

    // Drop the previous session subscription before re-subscribing.
    *guard = None;

    let Some(session) = tidal else {
        on_update(None);
        return;
    };

    on_update(track_from_session(&session));

    let props_token = session.MediaPropertiesChanged(&TypedEventHandler::new({
        let f = on_update.clone();
        move |sender: &Option<GlobalSystemMediaTransportControlsSession>, _| {
            if let Some(s) = sender {
                f(track_from_session(s));
            }
            Ok(())
        }
    }));

    let playback_token = session.PlaybackInfoChanged(&TypedEventHandler::new({
        let f = on_update.clone();
        move |sender: &Option<GlobalSystemMediaTransportControlsSession>, _| {
            if let Some(s) = sender {
                f(track_from_session(s));
            }
            Ok(())
        }
    }));

    let timeline_token = session.TimelinePropertiesChanged(&TypedEventHandler::new({
        let f = on_update.clone();
        move |sender: &Option<GlobalSystemMediaTransportControlsSession>, _| {
            if let Some(s) = sender {
                f(track_from_session(s));
            }
            Ok(())
        }
    }));

    match (props_token, playback_token, timeline_token) {
        (Ok(p), Ok(pl), Ok(t)) => {
            *guard = Some(ActiveSession {
                session,
                props_token: p,
                playback_token: pl,
                timeline_token: t,
            });
        }
        // On partial failure, explicitly revoke any handlers that did register.
        // EventRegistrationToken does not revoke on drop, so leaking a token
        // would leave an orphaned handler that fires on every subsequent event.
        (p, pl, t) => {
            if let Ok(tok) = p {
                let _ = session.RemoveMediaPropertiesChanged(tok);
            }
            if let Ok(tok) = pl {
                let _ = session.RemovePlaybackInfoChanged(tok);
            }
            if let Ok(tok) = t {
                let _ = session.RemoveTimelinePropertiesChanged(tok);
            }
            eprintln!("[FreeMiD/smtc] failed to subscribe to session events");
        }
    }
}

/// Query Windows SMTC for a Tidal session. Returns None if Tidal is not
/// running, has no session, or the session data cannot be read.
pub fn query_tidal() -> Option<DesktopTrack> {
    COM_INIT.call_once(|| {
        // S_FALSE (already initialised on this thread) is also acceptable.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    });
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;
    let session = find_tidal_session(&manager)?;
    track_from_session(&session)
}

/// Spawn a background thread that subscribes to SMTC events and calls
/// `on_update` whenever Tidal's media state changes. The first call delivers
/// the current state immediately; subsequent calls fire on track change,
/// play/pause, seek, and when Tidal starts or stops.
pub fn start_watcher(on_update: impl Fn(Option<DesktopTrack>) + Send + Sync + 'static) {
    let on_update: Arc<OnUpdateFn> = Arc::new(on_update);

    std::thread::spawn(move || {
        // COM must be initialized per-thread. MTA allows concurrent WinRT calls
        // from multiple threads, which is required for event callbacks.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.get())
        {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[FreeMiD/smtc] watcher: manager init failed: {e}");
                return;
            }
        };

        let active: Arc<Mutex<Option<ActiveSession>>> = Arc::new(Mutex::new(None));

        let active2 = active.clone();
        let on_update2 = on_update.clone();
        if let Err(e) = manager.SessionsChanged(&TypedEventHandler::new(
            move |mgr: &Option<GlobalSystemMediaTransportControlsSessionManager>, _| {
                if let Some(m) = mgr {
                    refresh_subscription(m, &active2, &on_update2);
                }
                Ok(())
            },
        )) {
            eprintln!("[FreeMiD/smtc] watcher: SessionsChanged subscribe failed: {e}");
        }

        // Subscribe to the current Tidal session (if already running) and push
        // the initial state.
        refresh_subscription(&manager, &active, &on_update);

        // Keep this thread alive so the manager reference and its SessionsChanged
        // subscription remain valid. WinRT event callbacks fire on thread-pool
        // threads, so this thread just needs to stay alive. Poll the shutdown
        // flag so the thread exits promptly when the process is shutting down;
        // this lets COM unregister the MTA thread before ExitProcess runs
        // DllMain cleanup (otherwise COM teardown blocks indefinitely).
        while !WATCHER_SHUTDOWN.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}
