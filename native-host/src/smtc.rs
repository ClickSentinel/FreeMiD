use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once, OnceLock};
use std::time::Duration;
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus, MediaPropertiesChangedEventArgs,
    PlaybackInfoChangedEventArgs, TimelinePropertiesChangedEventArgs,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows_future::{AsyncStatus, IAsyncOperation};

static COM_INIT: Once = Once::new();
static WATCHER_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static WATCHER_DONE: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();

fn watcher_done_pair() -> &'static (Mutex<bool>, Condvar) {
    WATCHER_DONE.get_or_init(|| (Mutex::new(false), Condvar::new()))
}

/// Signal the SMTC watcher thread to exit. Call before `std::process::exit`
/// so the thread leaves the COM MTA cleanly before ExitProcess runs DllMain
/// cleanup — otherwise COM teardown waits for the sleeping thread indefinitely.
pub fn signal_shutdown() {
    WATCHER_SHUTDOWN.store(true, Ordering::Release);
}

/// Block until the watcher thread confirms it has exited, or until `timeout`
/// elapses. Returns true if the thread exited cleanly within the timeout.
pub fn wait_for_shutdown(timeout: Duration) -> bool {
    let (lock, cvar) = watcher_done_pair();
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let result = cvar
        .wait_timeout_while(guard, timeout, |done| !*done)
        .unwrap_or_else(|e| e.into_inner());
    *result.0
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

type OnUpdateFn = dyn Fn(&str, Option<DesktopTrack>) + Send + Sync + 'static;

struct ActiveSession {
    session: GlobalSystemMediaTransportControlsSession,
    props_token: i64,
    playback_token: i64,
    timeline_token: i64,
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

/// Poll an `IAsyncOperation` until it leaves the `Started` state or a 5-second
/// deadline elapses. Returns `None` on timeout or if any WinRT call fails.
fn spin_wait<T, R>(
    op: IAsyncOperation<T>,
    get_results: impl Fn(&IAsyncOperation<T>) -> windows::core::Result<R>,
) -> Option<R>
where
    T: windows::core::RuntimeType + 'static,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let status = op.Status().ok()?;
        if status == AsyncStatus::Started {
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::yield_now();
        } else {
            break get_results(&op).ok();
        }
    }
}

/// Known desktop apps we can find via SMTC: (app id used in the extension
/// protocol, lowercase substring to match against SourceAppUserModelId).
///
/// NEEDS VERIFICATION: the Apple Music entry's needle is a best-effort guess,
/// not confirmed against a real installation. Verify by temporarily logging
/// `SourceAppUserModelId` for all sessions in `find_session` with Apple Music
/// running on Windows, then adjust this string if it doesn't match.
const KNOWN_APPS: &[(&str, &str)] = &[("tidal", "tidal"), ("applemusic", "applemusic")];

fn find_session(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    needle: &str,
) -> Option<GlobalSystemMediaTransportControlsSession> {
    let sessions = manager.GetSessions().ok()?;
    let count = sessions.Size().ok()?;
    (0..count).filter_map(|i| sessions.GetAt(i).ok()).find(|s| {
        s.SourceAppUserModelId()
            .map(|id| id.to_string().to_lowercase().contains(needle))
            .unwrap_or(false)
    })
}

fn ticks_to_secs(ticks: u64) -> f64 {
    ticks as f64 / 10_000_000.0
}

fn track_from_session(
    session: &GlobalSystemMediaTransportControlsSession,
) -> Option<DesktopTrack> {
    let props = spin_wait(session.TryGetMediaPropertiesAsync().ok()?, |op| {
        op.GetResults()
    })?;

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

    // When playing, SMTC position is only updated when the app explicitly
    // pushes it (e.g. on seek). Extrapolate forward using LastUpdatedTime so
    // the extension receives a continuously-accurate position on every push.
    let position_secs = match (timeline.Position().ok(), timeline.LastUpdatedTime().ok()) {
        (Some(pos), Some(updated)) if state == "playing" => {
            let ft = unsafe { GetSystemTimeAsFileTime() };
            let now_ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
            let elapsed_ticks = now_ticks.saturating_sub(updated.UniversalTime as u64);
            let secs = ticks_to_secs(pos.Duration.max(0) as u64) + ticks_to_secs(elapsed_ticks);
            Some(secs.max(0.0))
        }
        (Some(pos), _) => Some(ticks_to_secs(pos.Duration.max(0) as u64).max(0.0)),
        _ => None,
    };

    let duration_secs = match (timeline.EndTime().ok(), timeline.StartTime().ok()) {
        (Some(end), Some(start)) => {
            let dur = ticks_to_secs(end.Duration.saturating_sub(start.Duration).max(0) as u64);
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

fn make_session_handler<TArgs: windows::core::RuntimeType + 'static>(
    app_id: &'static str,
    f: Arc<OnUpdateFn>,
) -> TypedEventHandler<GlobalSystemMediaTransportControlsSession, TArgs> {
    TypedEventHandler::new(
        move |sender: windows::core::Ref<GlobalSystemMediaTransportControlsSession>, _| {
            if let Some(s) = sender.as_ref() {
                f(app_id, track_from_session(s));
            }
            Ok(())
        },
    )
}

/// (Re)subscribe to each known app's current SMTC session, or unsubscribe any
/// that are no longer running. Pushes each app's current state immediately
/// via `on_update`.
fn refresh_subscriptions(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
    active: &Arc<Mutex<HashMap<&'static str, ActiveSession>>>,
    on_update: &Arc<OnUpdateFn>,
) {
    for &(app_id, needle) in KNOWN_APPS {
        // Hold one guard across this app's whole find+subscribe+store
        // sequence. Two separate lock/unlock cycles here previously left an
        // unguarded window in which a concurrent refresh (e.g. this initial
        // call racing a SessionsChanged event fired from a WinRT threadpool
        // thread) could interleave for the same app_id — registering
        // duplicate live handlers on the same session, or delivering a
        // stale on_update after a fresher one. A single guard per app
        // restores the serialization the old single-app code had.
        let mut guard = active.lock().unwrap_or_else(|e| e.into_inner());

        let Some(session) = find_session(manager, needle) else {
            let had_session = guard.remove(app_id).is_some();
            drop(guard);
            if had_session {
                on_update(app_id, None);
            }
            continue;
        };

        // SessionsChanged fires for any app's session lifecycle, not just
        // this one — skip the teardown/resubscribe (and the blocking
        // property fetch below) when this app's session hasn't actually
        // changed. The already-registered MediaPropertiesChanged/
        // PlaybackInfoChanged/TimelinePropertiesChanged handlers remain the
        // source of truth for real state changes within an unchanged session.
        if guard.get(app_id).is_some_and(|active| active.session == session) {
            drop(guard);
            continue;
        }

        guard.remove(app_id);

        on_update(app_id, track_from_session(&session));

        let props_token = session.MediaPropertiesChanged(&make_session_handler::<
            MediaPropertiesChangedEventArgs,
        >(app_id, on_update.clone()));
        let playback_token = session.PlaybackInfoChanged(&make_session_handler::<
            PlaybackInfoChangedEventArgs,
        >(app_id, on_update.clone()));
        let timeline_token = session.TimelinePropertiesChanged(&make_session_handler::<
            TimelinePropertiesChangedEventArgs,
        >(app_id, on_update.clone()));

        match (props_token, playback_token, timeline_token) {
            (Ok(p), Ok(pl), Ok(t)) => {
                guard.insert(
                    app_id,
                    ActiveSession {
                        session,
                        props_token: p,
                        playback_token: pl,
                        timeline_token: t,
                    },
                );
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
                eprintln!("[FreeMiD/smtc] failed to subscribe to session events for {app_id}");
            }
        }
    }
}

/// Query Windows SMTC for a known app's session (see `KNOWN_APPS`). Returns
/// None if the app is not running, has no session, or the session data
/// cannot be read.
pub fn query_desktop_media(app_id: &str) -> Option<DesktopTrack> {
    COM_INIT.call_once(|| {
        // S_FALSE (already initialised on this thread) is also acceptable.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    });
    let needle = KNOWN_APPS
        .iter()
        .find(|(id, _)| *id == app_id)
        .map(|(_, needle)| *needle)?;
    let manager = spin_wait(
        GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?,
        |op| op.GetResults(),
    )?;
    let session = find_session(&manager, needle)?;
    track_from_session(&session)
}

/// Spawn a background thread that subscribes to SMTC events and calls
/// `on_update(app_id, track)` whenever a known app's (see `KNOWN_APPS`) media
/// state changes. The first call delivers each app's current state
/// immediately; subsequent calls fire on track change, play/pause, seek, and
/// when an app starts or stops.
pub fn start_watcher(on_update: impl Fn(&str, Option<DesktopTrack>) + Send + Sync + 'static) {
    let on_update: Arc<OnUpdateFn> = Arc::new(on_update);

    std::thread::spawn(move || {
        // COM must be initialized per-thread. MTA allows concurrent WinRT calls
        // from multiple threads, which is required for event callbacks.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match op.Status() {
                        Ok(s) if s == AsyncStatus::Started => {
                            if std::time::Instant::now() >= deadline {
                                return Err(windows::core::Error::from(
                                    windows::core::HRESULT(0x800705B4u32 as i32), // ERROR_TIMEOUT
                                ));
                            }
                            std::thread::yield_now();
                        }
                        Ok(_) => return op.GetResults(),
                        Err(e) => return Err(e),
                    }
                }
            }) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[FreeMiD/smtc] watcher: manager init failed: {e}");
                return;
            }
        };

        let active: Arc<Mutex<HashMap<&'static str, ActiveSession>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let active2 = active.clone();
        let on_update2 = on_update.clone();
        if let Err(e) = manager.SessionsChanged(&TypedEventHandler::new(
            move |mgr: windows::core::Ref<GlobalSystemMediaTransportControlsSessionManager>, _| {
                if let Some(m) = mgr.as_ref() {
                    refresh_subscriptions(m, &active2, &on_update2);
                }
                Ok(())
            },
        )) {
            eprintln!("[FreeMiD/smtc] watcher: SessionsChanged subscribe failed: {e}");
        }

        // Subscribe to each known app's current session (if already running)
        // and push the initial state.
        refresh_subscriptions(&manager, &active, &on_update);

        // Keep this thread alive so the manager reference and its SessionsChanged
        // subscription remain valid. WinRT event callbacks fire on thread-pool
        // threads, so this thread just needs to stay alive. Poll the shutdown
        // flag so the thread exits promptly when the process is shutting down;
        // this lets COM unregister the MTA thread before ExitProcess runs
        // DllMain cleanup (otherwise COM teardown blocks indefinitely).
        while !WATCHER_SHUTDOWN.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(100));
        }

        // Notify exit_cleanly that this thread has exited the COM MTA.
        let (lock, cvar) = watcher_done_pair();
        let mut done = lock.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        cvar.notify_all();
    });
}
