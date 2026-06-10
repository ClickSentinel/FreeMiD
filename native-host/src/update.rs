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

    // Windows and other architectures: not supported via in-process self-update.
    #[allow(unreachable_code)]
    None
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
        "Automatic updates are not supported on this platform".to_string()
    })?;

    let (latest_api_url, releases_base_url) = resolve_update_sources(overrides);

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

    Ok(())
}

fn resolve_update_sources(overrides: &UpdateSourceOverrides) -> (String, String) {
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

    if latest_url != GITHUB_API_LATEST || releases_base != GITHUB_RELEASES_BASE {
        eprintln!(
            "[FreeMiD] Using updater source override\n  latest: {}\n  releases: {}",
            latest_url, releases_base
        );
    }

    (latest_url, releases_base)
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
