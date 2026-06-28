#![deny(clippy::all)]

#[cfg(windows)]
mod windows_apply;

#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
use windows_apply::{append_updater_log, updater_log_path, validate_apply_paths};

#[cfg(windows)]
fn run_apply_update(staged_path: &str, target_path: &str) -> Result<(), String> {
    use std::path::PathBuf;

    let staged = PathBuf::from(staged_path);
    let target = PathBuf::from(target_path);

    validate_apply_paths(&staged, &target)?;

    let log = updater_log_path();
    append_updater_log(&log, &format!(
        "freemid-apply: started staged={:?} target={:?}",
        staged, target
    ));

    if !staged.exists() {
        return Err(format!("Staged update file does not exist: {:?}", staged));
    }

    let mut last_err: Option<String> = None;
    for _ in 0..600 {
        match std::fs::copy(&staged, &target) {
            Ok(_) => {
                let _ = std::fs::remove_file(&staged);
                append_updater_log(&log, "freemid-apply: copy succeeded and staged removed");
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e.to_string());
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }

    Err(format!(
        "Timed out applying update to {:?}: {}",
        target,
        last_err.unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("[FreeMiD Updater] Windows-only binary");
        std::process::exit(1);
    }

    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() < 4 || args[1] != "--apply-update" {
            eprintln!("Usage: freemid-apply --apply-update <staged-path> <target-path> [old-pid]");
            std::process::exit(2);
        }

        if let Err(e) = run_apply_update(&args[2], &args[3]) {
            append_updater_log(&updater_log_path(), &format!("freemid-apply: failed: {}", e));
            eprintln!("[FreeMiD Updater] {}", e);
            std::process::exit(1);
        }
    }
}
