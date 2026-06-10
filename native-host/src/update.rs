//! Self-update for the FreeMiD native host.
//!
//! Triggered by a `{ "type": "UPDATE" }` message from the Chrome extension.
//! Downloads the correct platform binary from GitHub Releases, verifies its
//! SHA-256 checksum, then atomically replaces the running binary on disk.
//! The currently-running process continues unaffected; the new binary takes
//! effect the next time Chrome spawns the host (i.e. after the extension
//! reconnects the native-messaging port).
//!
//! Progress is reported back to the caller via a `send` closure that writes
//! `UPDATE_STATUS` JSON messages to the extension.

use hex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

const GITHUB_API_LATEST: &str =
    "https://api.github.com/repos/ClickSentinel/FreeMiD/releases/latest";
const GITHUB_RELEASES_BASE: &str =
    "https://github.com/ClickSentinel/FreeMiD/releases/download";

#[derive(Clone, Debug, Default)]
pub struct UpdateSourceOverrides {
    pub latest_url: Option<String>,
    pub releases_base_url: Option<String>,
}

/// Platform-specific artifact filename, or `None` if self-update is unsupported.
fn artifact_name() -> Option<&'static str> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some("freemid-linux-x86_64");

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some("freemid-macos-arm64");

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Some("freemid-macos-x86_64");

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some("freemid-windows-x86_64.exe");

    // Other architectures: not supported via in-process self-update.
    #[allow(unreachable_code)]
    None
}

pub fn self_update_supported() -> bool {
    artifact_name().is_some()
}

/// Spawn a background thread that checks for and applies a new release.
///
/// `send` is called from the background thread to push `UPDATE_STATUS`
/// messages back to the extension. `write_message` in `main.rs` is
/// thread-safe (Rust's `io::stdout().lock()` is a process-wide mutex).
pub fn run_update(
    overrides: UpdateSourceOverrides,
    send: impl Fn(Value) + Send + 'static,
) {
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        send(json!({
            "type": "UPDATE_STATUS",
            "status": "failed",
            "error": "Update already in progress"
        }));
        return;
    }

    std::thread::spawn(move || {
        let result = do_update(&overrides, &send);
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            send(json!({
                "type": "UPDATE_STATUS",
                "status": "failed",
                "error": e
            }));
        }
    });
}

fn do_update(
    overrides: &UpdateSourceOverrides,
    send: &impl Fn(Value),
) -> Result<(), String> {
    let artifact = artifact_name().ok_or_else(|| {
        format!(
            "Automatic updates are not supported on this platform (os={}, arch={}). Supported: linux/x86_64, macos/aarch64, macos/x86_64, windows/x86_64",
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    })?;

    let (latest_api_url, releases_base_url) = resolve_update_sources(overrides)?;

    send(json!({ "type": "UPDATE_STATUS", "status": "checking" }));

    // ── Fetch latest release metadata ────────────────────────────────────────
    let user_agent = format!("FreeMiD/{}", env!("CARGO_PKG_VERSION"));
    let response = ureq::get(&latest_api_url)
        .set("User-Agent", &user_agent)
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let body = response
        .into_string()
        .map_err(|e| format!("Failed to read GitHub API response: {e}"))?;

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;

    let tag = data["tag_name"]
        .as_str()
        .ok_or_else(|| "GitHub API response missing tag_name".to_string())?;

    // Strip leading 'v' for semver comparison.
    let latest_version = tag.trim_start_matches('v');

    if !is_newer(latest_version, env!("CARGO_PKG_VERSION")) {
        send(json!({ "type": "UPDATE_STATUS", "status": "up_to_date" }));
        return Ok(());
    }

    eprintln!(
        "[FreeMiD] Update available: {} → {}",
        env!("CARGO_PKG_VERSION"),
        latest_version
    );

    send(json!({
        "type": "UPDATE_STATUS",
        "status": "downloading",
        "version": latest_version
    }));

    let base_url = format!("{}/{}", releases_base_url, tag);

    // ── Download and verify the binary ──────────────────────────────────────
    let binary_bytes = download_bytes(&format!("{}/{}", base_url, artifact), &user_agent)?;
    let checksums = download_string(
        &format!("{}/checksums.sha256", base_url),
        &user_agent,
    )?;

    verify_sha256(&binary_bytes, &checksums, artifact)?;

    // ── Atomically replace the running binary ────────────────────────────────
    apply_update(&binary_bytes)?;

    eprintln!(
        "[FreeMiD] Successfully updated to {}",
        latest_version
    );

    send(json!({
        "type": "UPDATE_STATUS",
        "status": "success",
        "version": latest_version
    }));

    #[cfg(windows)]
    {
        // The helper now owns replacing the host binary on disk.
        // Exit so Chrome can reconnect and launch the updated executable.
        std::thread::sleep(Duration::from_millis(120));
        std::process::exit(0);
    }

    #[cfg(not(windows))]
    {
        Ok(())
    }

}

fn resolve_update_sources(overrides: &UpdateSourceOverrides) -> Result<(String, String), String> {
    let env_latest_url = std::env::var("FREEMID_UPDATE_LATEST_URL").ok();
    let env_releases_base = std::env::var("FREEMID_UPDATE_RELEASES_BASE").ok();

    let latest_url = overrides
        .latest_url
        .as_deref()
        .or(env_latest_url.as_deref())
        .unwrap_or(GITHUB_API_LATEST)
        .to_string();

    let releases_base = overrides
        .releases_base_url
        .as_deref()
        .or(env_releases_base.as_deref())
        .unwrap_or(GITHUB_RELEASES_BASE)
        .trim_end_matches('/')
        .to_string();

    validate_update_source_url(&latest_url, "latest API")?;
    validate_update_source_url(&releases_base, "releases base")?;

    if latest_url != GITHUB_API_LATEST || releases_base != GITHUB_RELEASES_BASE {
        eprintln!(
            "[FreeMiD] Using updater source override\n  latest: {}\n  releases: {}",
            latest_url, releases_base
        );
    } else {
        eprintln!(
            "[FreeMiD] Using updater source defaults\n  latest: {}\n  releases: {}",
            latest_url, releases_base
        );
    }

    Ok((latest_url, releases_base))
}

fn validate_update_source_url(url: &str, label: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!(
            "{label} must use http:// or https://, got '{url}'"
        ));
    }
    if lower.starts_with("http://") {
        // Allow plaintext HTTP only for local/dev feeds.
        let local_hosts = ["http://127.0.0.1", "http://localhost", "http://0.0.0.0"];
        if !local_hosts.iter().any(|h| lower.starts_with(h)) {
            return Err(format!(
                "{label} must use HTTPS for non-local hosts, got '{url}'"
            ));
        }
    }
    Ok(())
}

fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| {
        let parts: Vec<u64> = v.split('.').filter_map(|p| p.parse().ok()).collect();
        [
            parts.first().copied().unwrap_or(0),
            parts.get(1).copied().unwrap_or(0),
            parts.get(2).copied().unwrap_or(0),
        ]
    };
    parse(latest) > parse(current)
}

fn download_bytes(url: &str, user_agent: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .set("User-Agent", user_agent)
        .call()
        .map_err(|e| format!("Download failed ({url}): {e}"))?;

    let content_length: usize = resp
        .header("Content-Length")
        .and_then(|h| h.parse().ok())
        .unwrap_or(10 * 1024 * 1024); // default 10 MB

    let mut buf = Vec::with_capacity(content_length);
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read download body: {e}"))?;

    Ok(buf)
}

fn download_string(url: &str, user_agent: &str) -> Result<String, String> {
    let resp = ureq::get(url)
        .set("User-Agent", user_agent)
        .call()
        .map_err(|e| format!("Failed to fetch checksums ({url}): {e}"))?;

    resp.into_string()
        .map_err(|e| format!("Failed to read checksums body: {e}"))
}

fn verify_sha256(data: &[u8], checksums: &str, artifact: &str) -> Result<(), String> {
    let expected = checksums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            // Strip leading './' or '*' that some shasum tools emit.
            let name = name.trim_start_matches("./").trim_start_matches('*');
            if name == artifact {
                Some(hash.to_ascii_lowercase())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("Checksum not found for '{artifact}' in checksums.sha256"))?;

    let mut hasher = Sha256::new();
    hasher.update(data);
    let actual = hex::encode(hasher.finalize());

    if actual != expected {
        return Err(format!(
            "SHA-256 mismatch for '{artifact}'\n  expected: {expected}\n  actual:   {actual}"
        ));
    }

    eprintln!("[FreeMiD] Checksum verified ✓");
    Ok(())
}

fn apply_update(data: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_update_windows(data)
    }

    #[cfg(not(windows))]
    {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Cannot determine current binary path: {e}"))?;

        // Write to a sibling temp file on the same filesystem to allow atomic rename.
        let tmp_path: PathBuf = {
            let mut p = current_exe.clone();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("freemid")
                .to_owned();
            p.set_file_name(format!("{}.update-{}", name, std::process::id()));
            p
        };

        // Write binary data.
        {
            let mut f = std::fs::File::create(&tmp_path)
                .map_err(|e| format!("Cannot create temp file {:?}: {e}", tmp_path))?;
            f.write_all(data)
                .map_err(|e| format!("Failed to write temp file: {e}"))?;
            f.flush()
                .map_err(|e| format!("Failed to flush temp file: {e}"))?;
        }

        // Set executable bit on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to chmod temp file: {e}"))?;
        }

        // Atomic rename — on Linux/macOS this is safe even while the old binary
        // is mapped into memory; the running process keeps the old inode.
        std::fs::rename(&tmp_path, &current_exe).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("Failed to replace binary {:?}: {e}", current_exe)
        })?;

        Ok(())
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const STABLE_UPDATER_EXE_NAME: &str = "freemid-apply.exe";

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
fn windows_updater_log_path() -> PathBuf {
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

#[cfg(windows)]
fn apply_update_windows(data: &[u8]) -> Result<(), String> {
    append_windows_updater_log("apply_update_windows: begin");

    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Cannot determine current binary path: {e}"))?;

    let staged_path: PathBuf = {
        let mut p = current_exe.clone();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("freemid.exe")
            .to_owned();
        p.set_file_name(format!("{}.staged-{}.exe", name, std::process::id()));
        p
    };

    let helper_path: PathBuf = {
        let mut p = current_exe.clone();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("freemid.exe")
            .to_owned();
        p.set_file_name(format!("{}.apply-helper-{}.exe", name, std::process::id()));
        p
    };

    {
        let mut f = std::fs::File::create(&staged_path)
            .map_err(|e| format!("Cannot create staged file {:?}: {e}", staged_path))?;
        f.write_all(data)
            .map_err(|e| format!("Failed to write staged file: {e}"))?;
        f.flush()
            .map_err(|e| format!("Failed to flush staged file: {e}"))?;
    }

    append_windows_updater_log(&format!(
        "apply_update_windows: staged file at {:?}, target {:?}",
        staged_path, current_exe
    ));

    // Preferred path: launch a stable updater binary that is installed once.
    let stable_updater_path = current_exe
        .parent()
        .map(|p| p.join(STABLE_UPDATER_EXE_NAME))
        .unwrap_or_else(|| PathBuf::from(STABLE_UPDATER_EXE_NAME));

    if stable_updater_path.exists() {
        append_windows_updater_log(&format!(
            "apply_update_windows: attempting stable updater {:?}",
            stable_updater_path
        ));
        match std::process::Command::new(&stable_updater_path)
            .arg("--apply-update")
            .arg(&staged_path)
            .arg(&current_exe)
            .arg(std::process::id().to_string())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(_) => {
                append_windows_updater_log("apply_update_windows: stable updater launch succeeded");
                return Ok(());
            }
            Err(e) => {
                append_windows_updater_log(&format!(
                    "apply_update_windows: stable updater launch failed: {} (raw_os_error={:?})",
                    e,
                    e.raw_os_error()
                ));

                if e.raw_os_error() == Some(740) {
                    append_windows_updater_log("apply_update_windows: trying cmd fallback after stable updater failure");
                    return spawn_cmd_apply_update(&staged_path, &current_exe)
                        .map_err(|fallback_err| format!(
                            "Failed to launch stable updater: {e}; cmd fallback failed: {fallback_err}"
                        ));
                }
            }
        }
    } else {
        append_windows_updater_log(&format!(
            "apply_update_windows: stable updater missing at {:?}; falling back to legacy helper",
            stable_updater_path
        ));
    }

    std::fs::copy(&current_exe, &helper_path)
        .map_err(|e| format!("Cannot create updater helper {:?}: {e}", helper_path))?;

    let spawn_result = std::process::Command::new(&helper_path)
        .arg("--apply-update")
        .arg(&staged_path)
        .arg(&current_exe)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    if let Err(e) = spawn_result {
        append_windows_updater_log(&format!(
            "apply_update_windows: helper launch failed: {} (raw_os_error={:?})",
            e,
            e.raw_os_error()
        ));

        // Some Windows environments can reject launching a copied executable
        // with ERROR_ELEVATION_REQUIRED (740). Fallback to cmd-based apply.
        if e.raw_os_error() == Some(740) {
            let _ = std::fs::remove_file(&helper_path);
            append_windows_updater_log("apply_update_windows: trying cmd fallback");
            return spawn_cmd_apply_update(&staged_path, &current_exe)
                .map_err(|fallback_err| format!(
                    "Failed to launch updater helper: {e}; cmd fallback failed: {fallback_err}"
                ));
        }

        let _ = std::fs::remove_file(&staged_path);
        let _ = std::fs::remove_file(&helper_path);
        return Err(format!("Failed to launch updater helper: {e}"));
    }

    append_windows_updater_log("apply_update_windows: helper launch succeeded");

    Ok(())
}

#[cfg(windows)]
fn escape_cmd_set_value(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('"', "\"\"")
}

#[cfg(windows)]
fn spawn_cmd_apply_update(staged_path: &std::path::Path, target_path: &std::path::Path) -> Result<(), String> {
    let staged = escape_cmd_set_value(staged_path);
    let target = escape_cmd_set_value(target_path);
    let log_path = escape_cmd_set_value(&windows_updater_log_path());

    let command = format!(
        "set \"S={}\" && set \"T={}\" && set \"L={}\" && for /L %i in (1,1,120) do (copy /Y \"%S%\" \"%T%\" >nul && del /F /Q \"%S%\" >nul && (echo cmd_fallback: copy succeeded>>\"%L%\") && exit /B 0 || timeout /T 1 /NOBREAK >nul) && (echo cmd_fallback: timed out>>\"%L%\" & exit /B 1)",
        staged,
        target,
        log_path,
    );

    append_windows_updater_log(&format!(
        "spawn_cmd_apply_update: launching cmd fallback for staged={:?} target={:?}",
        staged_path, target_path
    ));

    std::process::Command::new("cmd.exe")
        .arg("/C")
        .arg(command)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch cmd apply fallback: {e}"))
}

#[cfg(windows)]
fn validate_apply_paths(staged: &Path, target: &Path) -> Result<(), String> {
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
            "Staged and target directories must match"
        ));
    }

    Ok(())
}

pub fn run_apply_update(staged_path: &str, target_path: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (staged_path, target_path);
        return Err("--apply-update is only supported on Windows".to_string());
    }

    #[cfg(windows)]
    {
        let staged = PathBuf::from(staged_path);
        let target = PathBuf::from(target_path);

        validate_apply_paths(&staged, &target)?;

        append_windows_updater_log(&format!(
            "run_apply_update: started with staged={:?} target={:?}",
            staged, target
        ));

        if !staged.exists() {
            append_windows_updater_log("run_apply_update: staged file missing");
            return Err(format!("Staged update file does not exist: {:?}", staged));
        }

        let mut last_err: Option<String> = None;
        for _ in 0..300 {
            match std::fs::copy(&staged, &target) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&staged);
                    append_windows_updater_log("run_apply_update: copy succeeded and staged removed");
                    return Ok(());
                }
                Err(e) => {
                    last_err = Some(e.to_string());
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }

        append_windows_updater_log(&format!(
            "run_apply_update: timed out, last_err={}",
            last_err.clone().unwrap_or_else(|| "unknown error".to_string())
        ));

        Err(format!(
            "Timed out applying update to {:?}: {}",
            target,
            last_err.unwrap_or_else(|| "unknown error".to_string())
        ))
    }
}
