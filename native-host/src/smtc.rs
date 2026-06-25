use serde::Serialize;
use std::sync::Once;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

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

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()?
        .get()
        .ok()?;

    let sessions = manager.GetSessions().ok()?;
    let count = sessions.Size().ok()?;

    let session = (0..count)
        .filter_map(|i| sessions.GetAt(i).ok())
        .find(|s| {
            s.SourceAppUserModelId()
                .map(|id| id.to_string().to_lowercase().contains("tidal"))
                .unwrap_or(false)
        })?;

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

    // TimeSpan.Duration is in 100-nanosecond intervals.
    let to_secs = |ts: windows::Foundation::TimeSpan| ts.Duration as f64 / 10_000_000.0;

    let timeline = session.GetTimelineProperties().ok()?;
    let position_secs = timeline.Position().ok().map(to_secs);
    let duration_secs = match (timeline.EndTime().ok(), timeline.StartTime().ok()) {
        (Some(end), Some(start)) => {
            let dur = (end.Duration - start.Duration) as f64 / 10_000_000.0;
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
