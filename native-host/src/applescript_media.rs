use crate::desktop_track::DesktopTrack;
use std::process::Command;

/// Field separator used in the osascript reply. AppleScript emits it via
/// `ASCII character 31`, a control character that can't appear in track
/// metadata, so title/artist/album text can't be mistaken for a boundary.
const FIELD_SEP: char = '\u{1F}';

const NOT_RUNNING: &str = "__FREEMID_NOT_RUNNING__";

/// `tell application "Music"` launches Music.app if it isn't already running,
/// which we don't want just because the extension polled for desktop media.
/// `application "Music" is running` is a plain AppleScript predicate that
/// doesn't launch anything, so the real query is gated behind it.
const SCRIPT: &str = r#"
set sep to (ASCII character 31)
if application "Music" is running then
    tell application "Music"
        if player state is stopped then
            return "stopped"
        end if
        set trackName to name of current track
        set trackArtist to artist of current track
        set trackAlbum to album of current track
        set statePart to (player state as string)
        set posPart to (player position as string)
        set durPart to (duration of current track as string)
        return statePart & sep & trackName & sep & trackArtist & sep & trackAlbum & sep & posPart & sep & durPart
    end tell
else
    return "__FREEMID_NOT_RUNNING__"
end if
"#;

fn parse_f64(s: &str) -> Option<f64> {
    let s = s.trim();
    // AppleScript's `as string` coercion for reals can use the system
    // locale's decimal separator (',' on many non-US locales). Try the
    // literal value first so well-formed US-locale output is never touched;
    // only fall back to a comma-as-decimal-point reinterpretation if the
    // first parse fails.
    s.parse::<f64>()
        .ok()
        .or_else(|| s.replace(',', ".").parse::<f64>().ok())
}

fn track_from_output(output: &str) -> Option<DesktopTrack> {
    let output = output.trim();
    if output.is_empty() || output == NOT_RUNNING {
        return None;
    }
    if output == "stopped" {
        return Some(DesktopTrack {
            title: String::new(),
            artist: String::new(),
            album: None,
            state: "stopped".to_string(),
            position_secs: None,
            duration_secs: None,
        });
    }

    let mut fields = output.split(FIELD_SEP);
    let state = fields.next()?.to_string();
    let title = fields.next()?.to_string();
    let artist = fields.next()?.to_string();
    let album = fields.next().filter(|a| !a.is_empty()).map(str::to_string);
    let position_secs = fields.next().and_then(parse_f64);
    let duration_secs = fields.next().and_then(parse_f64);

    Some(DesktopTrack {
        title,
        artist,
        album,
        state,
        position_secs,
        duration_secs,
    })
}

/// Query Apple Music via AppleScript (`osascript`). This is a one-shot,
/// polling-only query — unlike Windows SMTC there is no push/subscribe
/// mechanism, so callers (the extension's `GET_DESKTOP_MEDIA` requests) are
/// responsible for re-polling at whatever cadence they need. Only the
/// `applemusic` app id is supported; other ids return `None`.
pub fn query_desktop_media(app_id: &str) -> Option<DesktopTrack> {
    if app_id != "applemusic" {
        return None;
    }
    let output = Command::new("osascript")
        .arg("-e")
        .arg(SCRIPT)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    track_from_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_playing_track() {
        let line = format!(
            "playing{sep}Konnichiwa{sep}Skepta{sep}Konnichiwa{sep}12.5{sep}210",
            sep = FIELD_SEP
        );
        let track = track_from_output(&line).expect("track");
        assert_eq!(track.state, "playing");
        assert_eq!(track.title, "Konnichiwa");
        assert_eq!(track.artist, "Skepta");
        assert_eq!(track.album.as_deref(), Some("Konnichiwa"));
        assert_eq!(track.position_secs, Some(12.5));
        assert_eq!(track.duration_secs, Some(210.0));
    }

    #[test]
    fn treats_missing_album_as_none() {
        let line = format!(
            "paused{sep}Title{sep}Artist{sep}{sep}1{sep}2",
            sep = FIELD_SEP
        );
        let track = track_from_output(&line).expect("track");
        assert_eq!(track.album, None);
    }

    #[test]
    fn handles_comma_decimal_locale() {
        let line = format!(
            "playing{sep}T{sep}A{sep}Al{sep}12,5{sep}210,0",
            sep = FIELD_SEP
        );
        let track = track_from_output(&line).expect("track");
        assert_eq!(track.position_secs, Some(12.5));
        assert_eq!(track.duration_secs, Some(210.0));
    }

    #[test]
    fn stopped_state_has_no_metadata() {
        let track = track_from_output("stopped").expect("track");
        assert_eq!(track.state, "stopped");
        assert_eq!(track.title, "");
    }

    #[test]
    fn not_running_returns_none() {
        assert!(track_from_output(NOT_RUNNING).is_none());
        assert!(track_from_output("").is_none());
    }

    #[test]
    fn ignores_unknown_app_id() {
        assert!(query_desktop_media("tidal").is_none());
    }
}
