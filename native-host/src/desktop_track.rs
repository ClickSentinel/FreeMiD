use serde::Serialize;

/// Snapshot of a desktop app's now-playing state, reported by whichever
/// platform-specific backend is active (Windows SMTC, macOS AppleScript).
/// Unconstructed on platforms with no desktop-media backend (e.g. Linux).
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
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
