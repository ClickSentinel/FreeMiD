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

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

const GITHUB_API_LATEST: &str =
    "https://api.github.com/repos/ClickSentinel/FreeMiD/releases/latest";
const GITHUB_RELEASES_BASE: &str = "https://github.com/ClickSentinel/FreeMiD/releases/download";

/// Shared HTTP agent — configured once with the OS trust store so TLS
/// revocations are picked up without requiring a host binary update.
fn http_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let tls_config = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        ureq::Agent::config_builder()
            .tls_config(tls_config)
            .build()
            .new_agent()
    })
}

#[derive(Clone, Debug, Default)]
pub struct UpdateSourceOverrides {
    pub latest_url: Option<String>,
    pub releases_base_url: Option<String>,
}

/// Typed error for the update flow.
///
/// Each variant maps to a distinct failure category so callers can distinguish
/// a network failure from a checksum mismatch.
#[derive(Debug, thiserror::Error)]
pub(crate) enum UpdateError {
    /// Self-update is not available on this platform.
    #[error("{0}")]
    UnsupportedPlatform(String),
    /// An update source URL failed validation.
    #[error("{0}")]
    InvalidSource(String),
    /// A network request failed or the response body could not be read.
    #[error("{0}")]
    Network(String),
    /// A downloaded response body exceeded the configured size limit.
    #[error("{0}")]
    ResponseTooLarge(String),
    /// A response body could not be parsed (JSON, UTF-8, or semver).
    #[error("{0}")]
    Parse(String),
    /// The artifact name was not found in the checksums file.
    #[error("{0}")]
    ChecksumNotFound(String),
    /// The downloaded binary's SHA-256 hash did not match the expected value.
    #[error("{0}")]
    ChecksumMismatch(String),
    /// Failed to write, rename, or spawn the applied binary on disk.
    #[error("{0}")]
    Apply(String),
    /// The minisign signature on the downloaded binary was invalid or untrusted.
    #[error("{0}")]
    SignatureInvalid(String),
}

/// Minisign public keys trusted to sign FreeMiD release artifacts.
///
/// Verification succeeds if the signature was produced by any key in this list.
/// Add the new key here before retiring the old one when rotating.
const TRUSTED_KEYS: &[&str] = &["RWRFjV2Q5UtunU61kMdRS0ViRXVmpxdOjI5zjTUbiJ/oS8OG+jCFb8De"];

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

/// Resets `UPDATE_IN_PROGRESS` to `false` on drop, including on thread panic.
///
/// In release builds `panic = "abort"` terminates the process before Drop runs;
/// this guard primarily protects debug builds and tests from leaving the flag set.
struct InProgressGuard;
impl Drop for InProgressGuard {
    fn drop(&mut self) {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Spawn a background thread that checks for and applies a new release.
///
/// `send` is called from the background thread to push `UPDATE_STATUS`
/// messages back to the extension. `write_message` in `main.rs` is
/// thread-safe (Rust's `io::stdout().lock()` is a process-wide mutex).
pub fn run_update(overrides: UpdateSourceOverrides, send: impl Fn(Value) + Send + 'static) {
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        send(json!({
            "type": "UPDATE_STATUS",
            "status": "failed",
            "error": "Update already in progress"
        }));
        return;
    }

    std::thread::spawn(move || {
        let _guard = InProgressGuard;
        if let Err(e) = do_update(&overrides, &send) {
            send(json!({
                "type": "UPDATE_STATUS",
                "status": "failed",
                "error": e.to_string()
            }));
        }
    });
}

fn do_update(overrides: &UpdateSourceOverrides, send: &impl Fn(Value)) -> Result<(), UpdateError> {
    let artifact = artifact_name().ok_or_else(|| {
        UpdateError::UnsupportedPlatform(format!(
            "Automatic updates are not supported on this platform (os={}, arch={}). Supported: linux/x86_64, macos/aarch64, macos/x86_64, windows/x86_64",
            std::env::consts::OS,
            std::env::consts::ARCH,
        ))
    })?;

    let (latest_api_url, releases_base_url) = resolve_update_sources(overrides)?;

    send(json!({ "type": "UPDATE_STATUS", "status": "checking" }));

    // ── Fetch latest release metadata ────────────────────────────────────────
    let user_agent = format!("FreeMiD/{}", env!("CARGO_PKG_VERSION"));
    let mut response = http_agent()
        .get(&latest_api_url)
        .header("User-Agent", &user_agent)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| UpdateError::Network(format!("GitHub API request failed: {e}")))?;

    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| UpdateError::Network(format!("Failed to read GitHub API response: {e}")))?;

    let data: Value = serde_json::from_str(&body)
        .map_err(|e| UpdateError::Parse(format!("Failed to parse GitHub API response: {e}")))?;

    let tag = data["tag_name"]
        .as_str()
        .ok_or_else(|| UpdateError::Parse("GitHub API response missing tag_name".to_string()))?;

    // Strip leading 'v' and enforce strict MAJOR.MINOR.PATCH format.
    let latest_version = tag.trim_start_matches('v');
    if !is_strict_semver(latest_version) {
        return Err(UpdateError::Parse(format!(
            "GitHub API tag_name is not strict semver (expected vMAJOR.MINOR.PATCH): {tag}"
        )));
    }

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

    // ── Download, verify, and apply ─────────────────────────────────────────
    // Stream directly to disk — no full binary in RAM.
    let staged = staged_download_path()?;
    let hex = download_to_staged(&format!("{}/{}", base_url, artifact), &staged, &user_agent)?;

    let checksums = download_string(&format!("{}/checksums.sha256", base_url), &user_agent)?;
    let sig_text = download_string(&format!("{}/{}.minisig", base_url, artifact), &user_agent)?;

    if let Err(e) = verify_minisig(&staged, &sig_text) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }

    if let Err(e) = verify_checksum_hex(&hex, &checksums, artifact) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }

    apply_staged(&staged)?;

    eprintln!("[FreeMiD] Successfully updated to {}", latest_version);

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

fn resolve_update_sources(
    overrides: &UpdateSourceOverrides,
) -> Result<(String, String), UpdateError> {
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

    let kind = if latest_url != GITHUB_API_LATEST || releases_base != GITHUB_RELEASES_BASE {
        "override"
    } else {
        "defaults"
    };
    eprintln!(
        "[FreeMiD] Using updater source {kind}\n  latest: {latest_url}\n  releases: {releases_base}"
    );

    Ok((latest_url, releases_base))
}

fn validate_update_source_url(url: &str, label: &str) -> Result<(), UpdateError> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(UpdateError::InvalidSource(format!(
            "{label} must use http:// or https://, got '{url}'"
        )));
    }
    if lower.starts_with("http://") {
        // Allow plaintext HTTP only for local/dev feeds.
        let local_hosts = ["http://127.0.0.1", "http://localhost", "http://0.0.0.0"];
        if !local_hosts.iter().any(|h| lower.starts_with(h)) {
            return Err(UpdateError::InvalidSource(format!(
                "{label} must use HTTPS for non-local hosts, got '{url}'"
            )));
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

fn is_strict_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| p.parse::<u64>().is_ok())
}

/// Passthrough writer that accumulates a SHA-256 hash as data flows through.
struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
        }
    }
    fn finish_hex(self) -> String {
        hex::encode(self.hasher.finalize())
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Returns the path where the downloaded binary should be staged before apply.
/// Sibling to the running executable so the rename stays on the same filesystem.
fn staged_download_path() -> Result<PathBuf, UpdateError> {
    let current_exe = std::env::current_exe()
        .map_err(|e| UpdateError::Apply(format!("Cannot determine current binary path: {e}")))?;
    let name = current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("freemid")
        .to_owned();
    let mut p = current_exe.clone();
    #[cfg(windows)]
    p.set_file_name(format!("{}.staged-{}.exe", name, std::process::id()));
    #[cfg(not(windows))]
    p.set_file_name(format!("{}.update-{}", name, std::process::id()));
    Ok(p)
}

/// Stream download directly to `dest`, computing SHA-256 on the fly.
/// Returns the hex digest. Peak memory is bounded by the I/O buffer size,
/// not the artifact size.
fn download_to_staged(url: &str, dest: &Path, user_agent: &str) -> Result<String, UpdateError> {
    const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

    let resp = http_agent()
        .get(url)
        .header("User-Agent", user_agent)
        .call()
        .map_err(|e| UpdateError::Network(format!("Download failed ({url}): {e}")))?;

    if let Some(content_length) = resp
        .headers()
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if content_length > MAX_DOWNLOAD_BYTES {
            return Err(UpdateError::ResponseTooLarge(format!(
                "Download too large ({content_length} bytes, max {MAX_DOWNLOAD_BYTES})"
            )));
        }
    }

    let file = std::fs::File::create(dest)
        .map_err(|e| UpdateError::Apply(format!("Cannot create staging file {:?}: {e}", dest)))?;
    let mut hw = HashingWriter::new(BufWriter::new(file));

    let written = std::io::copy(
        &mut resp.into_body().into_reader().take(MAX_DOWNLOAD_BYTES + 1),
        &mut hw,
    )
    .map_err(|e| UpdateError::Network(format!("Failed to write download body: {e}")))?;

    hw.flush()
        .map_err(|e| UpdateError::Apply(format!("Failed to flush staging file: {e}")))?;

    if written > MAX_DOWNLOAD_BYTES {
        let _ = std::fs::remove_file(dest);
        return Err(UpdateError::ResponseTooLarge(format!(
            "Download exceeded max size of {MAX_DOWNLOAD_BYTES} bytes"
        )));
    }

    Ok(hw.finish_hex())
}

fn download_string(url: &str, user_agent: &str) -> Result<String, UpdateError> {
    const MAX_BYTES: u64 = 1024 * 1024; // 1 MiB

    let resp = http_agent()
        .get(url)
        .header("User-Agent", user_agent)
        .call()
        .map_err(|e| UpdateError::Network(format!("Failed to fetch ({url}): {e}")))?;

    let mut buf = Vec::new();
    resp.into_body()
        .into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| UpdateError::Network(format!("Failed to read response body: {e}")))?;

    if buf.len() as u64 > MAX_BYTES {
        return Err(UpdateError::ResponseTooLarge(format!(
            "Response exceeded max size of {MAX_BYTES} bytes ({url})"
        )));
    }

    String::from_utf8(buf)
        .map_err(|e| UpdateError::Parse(format!("Response body is not valid UTF-8: {e}")))
}

/// Find the expected SHA-256 hex string for `artifact` in a `checksums.sha256` file.
fn expected_checksum<'a>(checksums: &'a str, artifact: &str) -> Result<&'a str, UpdateError> {
    checksums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            // Strip leading './' or '*' that some shasum tools emit.
            let name = name.trim_start_matches("./").trim_start_matches('*');
            if name == artifact {
                Some(hash)
            } else {
                None
            }
        })
        .ok_or_else(|| {
            UpdateError::ChecksumNotFound(format!(
                "Checksum not found for '{artifact}' in checksums.sha256"
            ))
        })
}

/// Compare a pre-computed hex digest against the checksums file.
fn verify_checksum_hex(actual: &str, checksums: &str, artifact: &str) -> Result<(), UpdateError> {
    let expected = expected_checksum(checksums, artifact)?.to_ascii_lowercase();
    if actual != expected {
        return Err(UpdateError::ChecksumMismatch(format!(
            "SHA-256 mismatch for '{artifact}'\n  expected: {expected}\n  actual:   {actual}"
        )));
    }
    eprintln!("[FreeMiD] Checksum verified ✓");
    Ok(())
}

/// Verify SHA-256 of raw bytes against a checksums file (used in tests).
#[cfg(test)]
fn verify_sha256(data: &[u8], checksums: &str, artifact: &str) -> Result<(), UpdateError> {
    let actual = hex::encode(Sha256::digest(data));
    verify_checksum_hex(&actual, checksums, artifact)
}

/// Verify a minisign `.minisig` file against the staged binary.
///
/// Accepts any signature produced by a key in `TRUSTED_KEYS`. During key
/// rotation, add the new key to `TRUSTED_KEYS` before retiring the old one so
/// binaries from both key generations can verify the transition release.
fn verify_minisig(staged: &Path, sig_text: &str) -> Result<(), UpdateError> {
    verify_minisig_with_keys(staged, sig_text, TRUSTED_KEYS)
}

fn verify_minisig_with_keys(
    staged: &Path,
    sig_text: &str,
    keys: &[&str],
) -> Result<(), UpdateError> {
    use minisign_verify::{PublicKey, Signature};

    let data = std::fs::read(staged).map_err(|e| {
        UpdateError::SignatureInvalid(format!("Cannot read staged file for verification: {e}"))
    })?;

    let sig = Signature::decode(sig_text)
        .map_err(|e| UpdateError::SignatureInvalid(format!("Cannot parse minisig: {e}")))?;

    for &key_b64 in keys {
        let pk = PublicKey::from_base64(key_b64).map_err(|e| {
            UpdateError::SignatureInvalid(format!("Invalid trusted public key: {e}"))
        })?;
        if pk.verify(&data, &sig, false).is_ok() {
            eprintln!("[FreeMiD] Signature verified ✓");
            return Ok(());
        }
    }

    Err(UpdateError::SignatureInvalid(
        "Signature does not match any trusted key".to_string(),
    ))
}

/// Apply the already-staged binary: chmod + atomic rename (Unix) or
/// launch the stable apply helper (Windows).
fn apply_staged(staged: &Path) -> Result<(), UpdateError> {
    #[cfg(windows)]
    {
        apply_update_windows(staged)
    }

    #[cfg(not(windows))]
    {
        let current_exe = std::env::current_exe().map_err(|e| {
            UpdateError::Apply(format!("Cannot determine current binary path: {e}"))
        })?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| UpdateError::Apply(format!("Failed to chmod staged file: {e}")))?;
        }

        // Atomic rename — on Linux/macOS the running process keeps the old
        // inode; the new binary takes effect on next launch.
        std::fs::rename(staged, &current_exe).map_err(|e| {
            let _ = std::fs::remove_file(staged);
            UpdateError::Apply(format!("Failed to replace binary {:?}: {e}", current_exe))
        })?;

        Ok(())
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const STABLE_UPDATER_EXE_NAME: &str = "freemid-apply.exe";

#[cfg(windows)]
use crate::windows_apply::{
    append_updater_log, try_copy_with_retry, updater_log_path, validate_apply_paths,
};

#[cfg(windows)]
fn apply_update_windows(staged_path: &Path) -> Result<(), UpdateError> {
    let log = updater_log_path();
    append_updater_log(&log, "apply_update_windows: begin");

    let current_exe = std::env::current_exe()
        .map_err(|e| UpdateError::Apply(format!("Cannot determine current binary path: {e}")))?;

    append_updater_log(
        &log,
        &format!(
            "apply_update_windows: staged file at {:?}, target {:?}",
            staged_path, current_exe
        ),
    );

    // Preferred path: launch a stable updater binary that is installed once.
    let stable_updater_path = current_exe
        .parent()
        .map(|p| p.join(STABLE_UPDATER_EXE_NAME))
        .unwrap_or_else(|| PathBuf::from(STABLE_UPDATER_EXE_NAME));

    // Self-heal: if the helper was never installed (e.g. the GUI installer did
    // not ship it), bootstrap it from the running binary. freemid.exe handles
    // `--apply-update` itself, so a copy works as the apply helper — and it must
    // be a separate file regardless, since a running image can't overwrite
    // itself on Windows. This makes the reliable helper path available even on
    // installs that lack it, instead of dropping to the brittle cmd fallback.
    if !stable_updater_path.exists() {
        match std::fs::copy(&current_exe, &stable_updater_path) {
            Ok(_) => append_updater_log(
                &log,
                &format!(
                    "apply_update_windows: bootstrapped stable updater at {:?} from running binary",
                    stable_updater_path
                ),
            ),
            Err(e) => append_updater_log(
                &log,
                &format!(
                    "apply_update_windows: could not bootstrap stable updater at {:?}: {e}",
                    stable_updater_path
                ),
            ),
        }
    }

    append_updater_log(
        &log,
        &format!(
            "apply_update_windows: attempting stable updater {:?}",
            stable_updater_path
        ),
    );
    match std::process::Command::new(&stable_updater_path)
        .arg("--apply-update")
        .arg(&staged_path)
        .arg(&current_exe)
        .arg(std::process::id().to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(_) => {
            append_updater_log(
                &log,
                "apply_update_windows: stable updater launch succeeded",
            );
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            append_updater_log(
                &log,
                &format!(
                "apply_update_windows: stable updater missing at {:?}; falling back to cmd apply",
                stable_updater_path
            ),
            );
        }
        Err(e) => {
            append_updater_log(
                &log,
                &format!(
                    "apply_update_windows: stable updater launch failed: {} (raw_os_error={:?})",
                    e,
                    e.raw_os_error()
                ),
            );
            if e.raw_os_error() == Some(740) {
                append_updater_log(
                    &log,
                    "apply_update_windows: trying cmd fallback after stable updater failure",
                );
                let res = spawn_cmd_apply_update(&staged_path, &current_exe);
                if res.is_err() {
                    let _ = std::fs::remove_file(&staged_path);
                }
                return res;
            }
        }
    }

    append_updater_log(
        &log,
        "apply_update_windows: stable updater unavailable, using cmd fallback",
    );
    let res = spawn_cmd_apply_update(&staged_path, &current_exe);
    if res.is_err() {
        let _ = std::fs::remove_file(&staged_path);
    }
    res
}

#[cfg(windows)]
fn escape_cmd_set_value(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .replace('"', "\"\"")
        .replace('%', "%%")
}

/// Resolve a Windows system tool to its absolute `System32` path, so it is not
/// resolved via the working directory / PATH (binary-planting protection).
#[cfg(windows)]
fn system32_tool(exe: &str) -> PathBuf {
    let system_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| r"C:\Windows".to_string());
    let file = if exe.to_ascii_lowercase().ends_with(".exe") {
        exe.to_string()
    } else {
        format!("{exe}.exe")
    };
    PathBuf::from(system_root).join("System32").join(file)
}

#[cfg(windows)]
fn spawn_cmd_apply_update(
    staged_path: &std::path::Path,
    target_path: &std::path::Path,
) -> Result<(), UpdateError> {
    let staged = escape_cmd_set_value(staged_path);
    let target = escape_cmd_set_value(target_path);
    let raw_log_path = updater_log_path();
    let log_path = escape_cmd_set_value(&raw_log_path);

    // `ping -n 2` rather than `timeout`: the host's stdin is the Chrome
    // native-messaging pipe, which cmd inherits, and `timeout` aborts
    // immediately ("Input redirection is not supported") under a redirected
    // stdin — so it never actually waits between copy attempts, and because the
    // trailing "timed out" log is gated behind its exit code, the failure was
    // also silent. `ping` waits regardless of stdin and returns success.
    let command = format!(
        "set \"S={}\" && set \"T={}\" && set \"L={}\" && for /L %i in (1,1,120) do (copy /Y \"%S%\" \"%T%\" >nul && del /F /Q \"%S%\" >nul && (echo cmd_fallback: copy succeeded>>\"%L%\") && exit /B 0 || ping -n 2 127.0.0.1 >nul) && (echo cmd_fallback: timed out>>\"%L%\" & exit /B 1)",
        staged,
        target,
        log_path,
    );

    append_updater_log(
        &raw_log_path,
        &format!(
            "spawn_cmd_apply_update: launching cmd fallback for staged={:?} target={:?}",
            staged_path, target_path
        ),
    );

    let cmd_exe = system32_tool("cmd");
    let mut builder = std::process::Command::new(&cmd_exe);
    builder
        .arg("/C")
        .arg(command)
        .creation_flags(CREATE_NO_WINDOW);
    // Run from System32 so the bare `ping` in the script resolves to the real
    // tool, not one planted in the host's working directory.
    if let Some(system32_dir) = cmd_exe.parent() {
        builder.current_dir(system32_dir);
    }
    builder
        .spawn()
        .map(|_| ())
        .map_err(|e| UpdateError::Apply(format!("Failed to launch cmd apply fallback: {e}")))
}

pub fn run_apply_update(staged_path: &str, target_path: &str) -> Result<(), UpdateError> {
    #[cfg(not(windows))]
    {
        let _ = (staged_path, target_path);
        Err(UpdateError::UnsupportedPlatform(
            "--apply-update is only supported on Windows".to_string(),
        ))
    }

    #[cfg(windows)]
    {
        let staged = PathBuf::from(staged_path);
        let target = PathBuf::from(target_path);

        validate_apply_paths(&staged, &target).map_err(UpdateError::Apply)?;

        let log = updater_log_path();
        append_updater_log(
            &log,
            &format!(
                "run_apply_update: started with staged={:?} target={:?}",
                staged, target
            ),
        );

        if !staged.exists() {
            append_updater_log(&log, "run_apply_update: staged file missing");
            return Err(UpdateError::Apply(format!(
                "Staged update file does not exist: {:?}",
                staged
            )));
        }

        match try_copy_with_retry(&staged, &target, 300) {
            Ok(()) => {
                append_updater_log(&log, "run_apply_update: copy succeeded and staged removed");
                Ok(())
            }
            Err(e) => {
                append_updater_log(
                    &log,
                    &format!("run_apply_update: timed out, last_err={}", e),
                );
                Err(UpdateError::Apply(e))
            }
        }
    }
}

/// Remove any `<exe>.staged-<pid>.exe` files whose originating process is no longer alive.
/// Called on startup to clean up files orphaned by a host crash mid-update.
#[cfg(windows)]
pub(crate) fn cleanup_staged_files() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = current_exe.parent() else {
        return;
    };
    let exe_name = current_exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("freemid.exe");
    let prefix = format!("{}.staged-", exe_name);

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(&prefix) || !name_str.ends_with(".exe") {
            continue;
        }
        // Strip prefix and trailing ".exe" to isolate the PID digits.
        let inner = &name_str[prefix.len()..name_str.len() - 4];
        let Ok(pid) = inner.parse::<u32>() else {
            continue;
        };
        // Require the file to be older than 10 minutes before deleting — guards
        // against PID reuse causing a fresh staged file to be incorrectly removed.
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| {
                t.elapsed()
                    .map_err(|e| std::io::Error::other(e.to_string()))
            })
            .map(|age| age > Duration::from_secs(600))
            .unwrap_or(false);
        if !is_pid_alive(pid) && old_enough {
            let path = entry.path();
            match std::fs::remove_file(&path) {
                Ok(()) => eprintln!("[FreeMiD] removed orphaned staged file: {:?}", path),
                Err(e) => eprintln!(
                    "[FreeMiD] failed to remove orphaned staged file {:?}: {e}",
                    path
                ),
            }
        }
    }
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: OpenProcess is a straightforward Win32 query — no memory aliasing.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_strict_semver ──────────────────────────────────────────────────────

    #[test]
    fn strict_semver_accepts_valid() {
        assert!(is_strict_semver("0.4.1"));
        assert!(is_strict_semver("1.0.0"));
        assert!(is_strict_semver("10.20.300"));
    }

    #[test]
    fn strict_semver_rejects_invalid() {
        assert!(!is_strict_semver(""));
        assert!(!is_strict_semver("1.0"));
        assert!(!is_strict_semver("1.0.0.0"));
        assert!(!is_strict_semver("v1.0.0")); // leading 'v' must be stripped first
        assert!(!is_strict_semver("1.0.alpha"));
        assert!(!is_strict_semver("1.0.0-rc1"));
    }

    // ── is_newer ─────────────────────────────────────────────────────────────

    #[test]
    fn is_newer_detects_patch_bump() {
        assert!(is_newer("0.4.2", "0.4.1"));
    }

    #[test]
    fn is_newer_detects_minor_bump() {
        assert!(is_newer("0.5.0", "0.4.9"));
    }

    #[test]
    fn is_newer_detects_major_bump() {
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    #[test]
    fn is_newer_same_version_is_not_newer() {
        assert!(!is_newer("0.4.1", "0.4.1"));
    }

    #[test]
    fn is_newer_older_is_not_newer() {
        assert!(!is_newer("0.4.0", "0.4.1"));
        assert!(!is_newer("0.3.99", "0.4.0"));
    }

    // ── verify_sha256 ─────────────────────────────────────────────────────────

    #[test]
    fn verify_sha256_accepts_correct_checksum() {
        let data = b"hello world";
        // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576dc5b4e7e6d8d5e8d
        // Let's compute it properly:
        use sha2::{Digest, Sha256};
        let hash = hex::encode(Sha256::digest(data));
        let checksums = format!("{}  freemid-linux-x86_64\n", hash);
        assert!(verify_sha256(data, &checksums, "freemid-linux-x86_64").is_ok());
    }

    #[test]
    fn verify_sha256_rejects_wrong_checksum() {
        let data = b"hello world";
        let checksums = "0000000000000000000000000000000000000000000000000000000000000000  freemid-linux-x86_64\n";
        assert!(matches!(
            verify_sha256(data, checksums, "freemid-linux-x86_64"),
            Err(UpdateError::ChecksumMismatch(_))
        ));
    }

    #[test]
    fn verify_sha256_rejects_missing_artifact() {
        let data = b"hello";
        let checksums = "abc123  freemid-macos-arm64\n";
        assert!(matches!(
            verify_sha256(data, checksums, "freemid-linux-x86_64"),
            Err(UpdateError::ChecksumNotFound(_))
        ));
    }

    #[test]
    fn verify_sha256_handles_dotslash_prefix() {
        use sha2::{Digest, Sha256};
        let data = b"test";
        let hash = hex::encode(Sha256::digest(data));
        let checksums = format!("{}  ./freemid-linux-x86_64\n", hash);
        assert!(verify_sha256(data, &checksums, "freemid-linux-x86_64").is_ok());
    }

    #[test]
    fn verify_sha256_handles_star_prefix() {
        use sha2::{Digest, Sha256};
        let data = b"test";
        let hash = hex::encode(Sha256::digest(data));
        let checksums = format!("{}  *freemid-linux-x86_64\n", hash);
        assert!(verify_sha256(data, &checksums, "freemid-linux-x86_64").is_ok());
    }

    // ── escape_cmd_set_value (Windows-only) ──────────────────────────────────

    #[cfg(windows)]
    #[test]
    fn escape_cmd_plain_path() {
        use std::path::Path;
        let p = Path::new(r"C:\Users\Alice\AppData\Local\FreeMiD\freemid.exe");
        assert_eq!(
            escape_cmd_set_value(p),
            r"C:\Users\Alice\AppData\Local\FreeMiD\freemid.exe"
        );
    }

    #[cfg(windows)]
    #[test]
    fn escape_cmd_doubles_quotes() {
        use std::path::Path;
        // A double-quote in the path must be doubled so SET doesn't break out
        // of the quoted value.
        let p = Path::new("C:\\bad\"name\\freemid.exe");
        let result = escape_cmd_set_value(p);
        assert!(result.contains("\"\""), "quote must be doubled");
        assert!(
            !result.contains("bad\"n"),
            "raw unescaped quote must not remain"
        );
    }

    #[cfg(windows)]
    #[test]
    fn escape_cmd_doubles_percent() {
        use std::path::Path;
        // A bare % inside a SET value is treated as a variable reference and
        // silently corrupts the path at apply time.
        let p = Path::new(r"C:\Users\100%user\AppData\Local\FreeMiD\freemid.exe");
        let result = escape_cmd_set_value(p);
        assert!(result.contains("%%"), "percent must be doubled");
        assert!(
            !result.contains("%u"),
            "unexpanded %u sequence must not remain"
        );
    }

    #[cfg(windows)]
    #[test]
    fn escape_cmd_doubles_both() {
        use std::path::Path;
        let p = Path::new("C:\\bad\"path\\100%\\freemid.exe");
        let result = escape_cmd_set_value(p);
        assert!(result.contains("\"\""));
        assert!(result.contains("%%"));
    }

    // ── validate_update_source_url ────────────────────────────────────────────

    #[test]
    fn update_url_accepts_https() {
        assert!(validate_update_source_url(
            "https://github.com/ClickSentinel/FreeMiD/releases/latest",
            "download"
        )
        .is_ok());
    }

    #[test]
    fn update_url_rejects_http_for_remote_host() {
        assert!(matches!(
            validate_update_source_url(
                "http://github.com/ClickSentinel/FreeMiD/releases/latest",
                "download"
            ),
            Err(UpdateError::InvalidSource(_))
        ));
    }

    #[test]
    fn update_url_allows_http_localhost() {
        assert!(validate_update_source_url("http://localhost:8787/latest.json", "test").is_ok());
        assert!(validate_update_source_url("http://127.0.0.1:8787/feed", "test").is_ok());
    }

    #[test]
    fn update_url_rejects_non_http_schemes() {
        assert!(matches!(
            validate_update_source_url("ftp://example.com/freemid.exe", "test"),
            Err(UpdateError::InvalidSource(_))
        ));
        assert!(matches!(
            validate_update_source_url("", "test"),
            Err(UpdateError::InvalidSource(_))
        ));
        assert!(matches!(
            validate_update_source_url("not-a-url", "test"),
            Err(UpdateError::InvalidSource(_))
        ));
    }

    // Test vectors: test keypair generated with rsign2, payload is a fixed byte string.
    // These are NOT the production keys — only used to exercise verify_minisig_with_keys.
    const TEST_KEY: &str = "RWTly3sJNp1Mq0ClQYEKXKYPCL2xEMn9a5tr5uivNXdHacrK3GQEALai";
    const TEST_SIG: &str = "untrusted comment: signature from rsign secret key\n\
        RUTly3sJNp1Mq4/7Pvop4vhOzxc7XhSfSkfHAlNkuMSOrd6Cbhm2+h4L/p4yrZXGh6qGsUdc6/UUvccydXtI2D5XdN8hmvnRyAI=\n\
        trusted comment: timestamp:1782730616\tfile:test-payload.bin\tprehashed\n\
        jaFNYod7cXQmDdkFEEKAlKM4NSdnRKObBpBFlyWVbPF4QUp7mBHjStp8LE9QU5rP5GNV+vFIOlf3frzuSN9vAQ==\n";
    const TEST_PAYLOAD: &[u8] = b"freemid test payload";

    #[test]
    fn minisig_accepts_valid_signature() {
        let path = std::env::temp_dir().join("freemid-minisig-test-valid");
        std::fs::write(&path, TEST_PAYLOAD).unwrap();
        verify_minisig_with_keys(&path, TEST_SIG, &[TEST_KEY]).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn minisig_rejects_wrong_key() {
        // Production key — valid format but did not sign this payload.
        const WRONG_KEY: &str = "RWRFjV2Q5UtunU61kMdRS0ViRXVmpxdOjI5zjTUbiJ/oS8OG+jCFb8De";
        let path = std::env::temp_dir().join("freemid-minisig-test-wrongkey");
        std::fs::write(&path, TEST_PAYLOAD).unwrap();
        assert!(matches!(
            verify_minisig_with_keys(&path, TEST_SIG, &[WRONG_KEY]),
            Err(UpdateError::SignatureInvalid(_))
        ));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn minisig_rejects_tampered_payload() {
        let path = std::env::temp_dir().join("freemid-minisig-test-tampered");
        std::fs::write(&path, b"tampered payload").unwrap();
        assert!(matches!(
            verify_minisig_with_keys(&path, TEST_SIG, &[TEST_KEY]),
            Err(UpdateError::SignatureInvalid(_))
        ));
        let _ = std::fs::remove_file(&path);
    }
}
