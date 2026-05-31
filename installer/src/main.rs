// FreeMiD Windows Installer
//
// Double-click freemid-setup.exe to:
//   1. Stop any running FreeMiD process (so the file isn't locked)
//   2. Download the latest freemid-windows-x86_64.exe from GitHub Releases
//   3. Verify the SHA256 checksum
//   4. Install to %LOCALAPPDATA%\FreeMiD\freemid.exe
//   5. Write the native messaging manifest JSON
//   6. Register the host in Chrome and Edge (HKCU, no admin required)
//
// To use a custom extension ID:
//   set FREEMID_EXTENSION_ID=yourextensionid && freemid-setup.exe
//
// To install a specific release tag:
//   set FREEMID_RELEASE_TAG=v0.3.0 && freemid-setup.exe

#![cfg(target_os = "windows")]

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::Command;

const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
const ARTIFACT: &str = "freemid-windows-x86_64.exe";
const HOST_NAME: &str = "com.clicksentinel.freemid";
const DEFAULT_EXTENSION_ID: &str = "hkhbfipnjmaaookghalliomoejfagppi";
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    println!("FreeMiD Setup  v{}", VERSION);
    println!("{}", "-".repeat(38));
    println!();

    match run() {
        Ok(()) => {
            println!();
            println!("Installation complete. Restart Chrome or Edge to activate.");
        }
        Err(e) => {
            eprintln!();
            eprintln!("ERROR: {}", e);
            eprintln!();
            eprintln!("If this is a permissions error, try running as administrator.");
        }
    }

    pause();
}

fn run() -> Result<(), String> {
    let extension_id = std::env::var("FREEMID_EXTENSION_ID")
        .unwrap_or_else(|_| DEFAULT_EXTENSION_ID.to_string());

    // ── Step 1: Kill any running freemid.exe so the file isn't locked ─────
    println!("[1/5] Stopping any running FreeMiD process...");
    // taskkill exits non-zero if the process isn't running — that's fine.
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "freemid.exe", "/T"])
        .output();

    // ── Step 2: Determine install path ────────────────────────────────────
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
    let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
    let bin_dst = install_dir.join("freemid.exe");
    let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));

    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Cannot create install directory: {}", e))?;

    // ── Step 3: Download binary ───────────────────────────────────────────
    let tag = std::env::var("FREEMID_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string());
    let (download_url, checksums_url) = build_urls(&tag);

    println!("[2/5] Downloading {} ...", ARTIFACT);
    println!("      From: {}", download_url);
    ps_run(&format!(
        "Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
        download_url,
        bin_dst.display()
    ))?;

    let size_mb = std::fs::metadata(&bin_dst)
        .map(|m| m.len() as f64 / 1_048_576.0)
        .unwrap_or(0.0);
    println!("      Downloaded ({:.2} MB)", size_mb);

    // ── Step 4: Verify SHA256 ─────────────────────────────────────────────
    println!("[3/5] Verifying SHA256 checksum...");
    let checksums_raw = ps_output(&format!(
        "(Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content",
        checksums_url
    ))?;

    let expected = checksums_raw
        .lines()
        .find(|l| l.trim_end().ends_with(ARTIFACT))
        .and_then(|l| l.split_whitespace().next())
        .ok_or_else(|| format!("Entry for {} not found in checksums.sha256", ARTIFACT))?
        .to_lowercase();

    let actual = ps_output(&format!(
        "(Get-FileHash '{}' -Algorithm SHA256).Hash.ToLower()",
        bin_dst.display()
    ))?;
    let actual = actual.trim().to_lowercase();

    if actual != expected {
        let _ = std::fs::remove_file(&bin_dst);
        return Err(format!(
            "Checksum mismatch!\n  Expected: {}\n  Actual:   {}",
            expected, actual
        ));
    }
    println!("      OK  {}...", &actual[..16]);

    // ── Step 5: Write manifest JSON ───────────────────────────────────────
    println!("[4/5] Writing native messaging manifest...");

    // JSON requires forward-slashes or escaped backslashes.
    let bin_path_json = bin_dst.display().to_string().replace('\\', "\\\\");

    let manifest = format!(
        r#"{{
  "name": "{host}",
  "description": "FreeMiD native messaging host",
  "path": "{path}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://{ext_id}/"
  ]
}}"#,
        host = HOST_NAME,
        path = bin_path_json,
        ext_id = extension_id,
    );

    std::fs::write(&manifest_path, &manifest)
        .map_err(|e| format!("Cannot write manifest: {}", e))?;

    // ── Step 6: Register in Chrome and Edge (HKCU, no admin needed) ───────
    println!("[5/5] Registering native messaging host...");
    let manifest_str = manifest_path.display().to_string();

    for (name, parent) in [
        ("Chrome", r"HKCU\Software\Google\Chrome\NativeMessagingHosts"),
        ("Edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
    ] {
        let key = format!("{}\\{}", parent, HOST_NAME);
        match reg_set(&key, &manifest_str) {
            Ok(()) => println!("      Registered for {}", name),
            Err(e) => println!("      Warning ({}): {}", name, e),
        }
    }

    println!();
    println!("  Binary:     {}", bin_dst.display());
    println!("  Manifest:   {}", manifest_path.display());
    println!("  Extension:  {}", extension_id);

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_urls(tag: &str) -> (String, String) {
    let base = if tag == "latest" {
        format!(
            "https://github.com/{}/releases/latest/download/{}",
            GITHUB_REPO, ARTIFACT
        )
    } else {
        format!(
            "https://github.com/{}/releases/download/{}/{}",
            GITHUB_REPO, tag, ARTIFACT
        )
    };
    let checksums = base.replace(ARTIFACT, "checksums.sha256");
    (base, checksums)
}

/// Run a PowerShell command; return Err on non-zero exit.
fn ps_run(cmd: &str) -> Result<(), String> {
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", cmd])
        .status()
        .map_err(|e| format!("Failed to spawn PowerShell: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("PowerShell command failed (exit {:?})", status.code()))
    }
}

/// Run a PowerShell command and return its stdout.
fn ps_output(cmd: &str) -> Result<String, String> {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", cmd])
        .output()
        .map_err(|e| format!("Failed to spawn PowerShell: {}", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "PowerShell error: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Write a REG_SZ default value under the given HKCU key (no admin required).
fn reg_set(key: &str, value: &str) -> Result<(), String> {
    let status = Command::new("reg")
        .args(["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"])
        .status()
        .map_err(|e| format!("Failed to spawn reg.exe: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("reg add failed for key: {}", key))
    }
}

fn pause() {
    print!("\nPress Enter to exit...");
    let _ = io::stdout().flush();
    let mut buf = [0u8; 1];
    let _ = io::stdin().read(&mut buf);
}
