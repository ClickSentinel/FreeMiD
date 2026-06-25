use serde::Serialize;
use std::sync::Once;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime;

static COM_INIT: Once = Once::new();

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

/// Query Windows SMTC for a Tidal session. Returns None if Tidal is not
/// running, has no session, or the session data cannot be read.
pub fn query_tidal() -> Option<DesktopTrack> {
    COM_INIT.call_once(|| {
        // S_FALSE (already initialised on this thread) is also acceptable.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    });

    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(op) => match op.get() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[FreeMiD/smtc] RequestAsync().get() failed: {}", e);
                return None;
            }
        },
        Err(e) => {
            eprintln!("[FreeMiD/smtc] RequestAsync() failed: {}", e);
            return None;
        }
    };

    let sessions = match manager.GetSessions() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[FreeMiD/smtc] GetSessions() failed: {}", e);
            return None;
        }
    };
    let count = sessions.Size().ok()?;

    let session = (0..count)
        .filter_map(|i| sessions.GetAt(i).ok())
        .find(|s| {
            let id = s
                .SourceAppUserModelId()
                .map(|h| h.to_string())
                .unwrap_or_default();
            id.to_lowercase().contains("tidal")
        })?;

    let props = match session.TryGetMediaPropertiesAsync() {
        Ok(op) => match op.get() {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[FreeMiD/smtc] TryGetMediaPropertiesAsync().get() failed: {}", e);
                return None;
            }
        },
        Err(e) => {
            eprintln!("[FreeMiD/smtc] TryGetMediaPropertiesAsync() failed: {}", e);
            return None;
        }
    };

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

    // TimeSpan.Duration is in 100-nanosecond intervals.
    let ticks_to_secs = |ticks: i64| ticks as f64 / 10_000_000.0;

    let timeline = session.GetTimelineProperties().ok()?;

    // When playing, SMTC position is only updated when Tidal explicitly pushes
    // it (e.g. on seek). Extrapolate forward using LastUpdatedTime so the
    // extension receives a continuously-accurate position on every poll.
    let position_secs = match (timeline.Position().ok(), timeline.LastUpdatedTime().ok()) {
        (Some(pos), Some(updated)) if state == "playing" => {
            let ft = unsafe { GetSystemTimeAsFileTime() };
            let now_ticks =
                ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
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
            if dur > 0.0 { Some(dur) } else { None }
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
