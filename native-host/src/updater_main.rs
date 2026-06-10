#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
fn append_windows_updater_log(line: &str) {
    let mut path = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let mut p = PathBuf::from(local_app_data);
        p.push("FreeMiD");
        let _ = std::fs::create_dir_all(&p);
        p
    } else {
        PathBuf::from(".")
    };
    path.push("updater.log");

    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

#[cfg(windows)]
fn run_apply_update(staged_path: &str, target_path: &str) -> Result<(), String> {
    let staged = PathBuf::from(staged_path);
    let target = PathBuf::from(target_path);

    append_windows_updater_log(&format!(
        "freemid-updater: started staged={:?} target={:?}",
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
                append_windows_updater_log("freemid-updater: copy succeeded and staged removed");
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
            eprintln!("Usage: freemid-updater --apply-update <staged-path> <target-path> [old-pid]");
            std::process::exit(2);
        }

        if let Err(e) = run_apply_update(&args[2], &args[3]) {
            append_windows_updater_log(&format!("freemid-updater: failed: {}", e));
            eprintln!("[FreeMiD Updater] {}", e);
            std::process::exit(1);
        }
    }
}
