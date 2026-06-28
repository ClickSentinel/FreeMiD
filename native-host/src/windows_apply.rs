//! Shared helpers used by both the native host and the freemid-apply updater binary.
//!
//! Both binaries need to write to the same updater log and validate the same
//! staged-file naming convention; keeping the logic here avoids divergence.

use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) fn updater_log_path() -> PathBuf {
    let dir = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        PathBuf::from(local_app_data).join("FreeMiD")
    } else {
        PathBuf::from(".")
    };
    let _ = std::fs::create_dir_all(&dir);
    dir.join("updater.log")
}

pub(crate) fn append_updater_log(log_path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(f, "{}", line);
    }
}

/// Validates that `staged` and `target` are in the same directory and have the
/// expected FreeMiD filenames before any copy or rename is attempted.
pub(crate) fn validate_apply_paths(staged: &Path, target: &Path) -> Result<(), String> {
    // Reject relative paths — parent() comparisons are ambiguous without an anchor.
    if !staged.is_absolute() {
        return Err(format!("Staged path must be absolute: {:?}", staged));
    }
    if !target.is_absolute() {
        return Err(format!("Target path must be absolute: {:?}", target));
    }

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

    // Canonicalize parent directories to resolve symlinks and .. components.
    // We canonicalize the parents (not the files themselves) because the staged
    // file may not exist on disk yet when this is called.
    #[cfg(windows)]
    {
        let staged_dir = staged
            .parent()
            .ok_or_else(|| "Staged path has no parent directory".to_string())?;
        let target_dir = target
            .parent()
            .ok_or_else(|| "Target path has no parent directory".to_string())?;
        let staged_canonical = std::fs::canonicalize(staged_dir).map_err(|e| {
            format!("Cannot resolve staged directory {:?}: {}", staged_dir, e)
        })?;
        let target_canonical = std::fs::canonicalize(target_dir).map_err(|e| {
            format!("Cannot resolve target directory {:?}: {}", target_dir, e)
        })?;
        if staged_canonical != target_canonical {
            return Err(format!(
                "Staged and target directories must match (staged={:?}, target={:?})",
                staged_canonical, target_canonical
            ));
        }
    }

    #[cfg(not(windows))]
    if staged.parent() != target.parent() {
        return Err(format!(
            "Staged and target directories must match (staged={:?}, target={:?})",
            staged.parent(),
            target.parent()
        ));
    }

    Ok(())
}

#[cfg(all(test, windows))]
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
