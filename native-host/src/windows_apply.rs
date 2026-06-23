//! Shared helpers used by both the native host and the freemid-apply updater binary.
//!
//! Both binaries need to write to the same updater log and validate the same
//! staged-file naming convention; keeping the logic here avoids divergence.

use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) fn updater_log_path() -> PathBuf {
    let mut path = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let mut p = PathBuf::from(local_app_data);
        p.push("FreeMiD");
        let _ = std::fs::create_dir_all(&p);
        p
    } else {
        PathBuf::from(".")
    };
    path.push("updater.log");
    path
}

pub(crate) fn append_updater_log(line: &str) {
    let path = updater_log_path();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{}", line);
    }
}

/// Validates that `staged` and `target` are in the same directory and have the
/// expected FreeMiD filenames before any copy or rename is attempted.
pub(crate) fn validate_apply_paths(staged: &Path, target: &Path) -> Result<(), String> {
    let target_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if target_name != "freemid.exe" {
        return Err(format!(
            "Unexpected target binary name: {:?}",
            target.file_name().unwrap_or_default()
        ));
    }

    let staged_name = staged
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !staged_name.starts_with("freemid.exe.staged-") || !staged_name.ends_with(".exe") {
        return Err(format!(
            "Unexpected staged file name: {:?}",
            staged.file_name().unwrap_or_default()
        ));
    }

    if staged.parent() != target.parent() {
        return Err(format!(
            "Staged and target directories must match (staged={:?}, target={:?})",
            staged.parent(),
            target.parent()
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn staged(name: &str) -> std::path::PathBuf {
        Path::new(r"C:\Users\test\AppData\Local\FreeMiD").join(name)
    }

    fn target() -> std::path::PathBuf {
        Path::new(r"C:\Users\test\AppData\Local\FreeMiD").join("freemid.exe")
    }

    #[test]
    fn validate_accepts_valid_paths() {
        let s = staged("freemid.exe.staged-1234.exe");
        assert!(validate_apply_paths(&s, &target()).is_ok());
    }

    #[test]
    fn validate_rejects_wrong_target_name() {
        let s = staged("freemid.exe.staged-1234.exe");
        let t = Path::new(r"C:\Users\test\AppData\Local\FreeMiD").join("other.exe");
        let err = validate_apply_paths(&s, &t).unwrap_err();
        assert!(err.contains("Unexpected target binary name"));
    }

    #[test]
    fn validate_rejects_wrong_staged_name() {
        let s = staged("freemid.exe.tmp");
        let err = validate_apply_paths(&s, &target()).unwrap_err();
        assert!(err.contains("Unexpected staged file name"));
    }

    #[test]
    fn validate_rejects_different_directories() {
        let s = Path::new(r"C:\Temp").join("freemid.exe.staged-1234.exe");
        let err = validate_apply_paths(&s, &target()).unwrap_err();
        assert!(err.contains("directories must match"));
    }
}
