// FreeMiD Windows Installer
//
// Double-click freemid-setup.exe to install the FreeMiD native messaging host.
// Re-running is safe — kills the running process first so the file is never locked.
//
// To use a custom extension ID:
//   set FREEMID_EXTENSION_ID=yourextensionid && freemid-setup.exe
//
// To install a specific release tag:
//   set FREEMID_RELEASE_TAG=v0.3.1 && freemid-setup.exe

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("freemid-setup is a Windows-only installer.");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
mod win {
    use std::io::{self, Read, Write};
    use std::path::PathBuf;
    use std::process::Command;

    const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
    const ARTIFACT: &str = "freemid-windows-x86_64.exe";
    const HOST_NAME: &str = "com.clicksentinel.freemid";
    const DEFAULT_EXTENSION_ID: &str = "hkhbfipnjmaaookghalliomoejfagppi";
    const VERSION: &str = env!("CARGO_PKG_VERSION");

    pub fn run_main() {
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
            }
        }

        pause();
    }

    fn run() -> Result<(), String> {
        let extension_id = std::env::var("FREEMID_EXTENSION_ID")
            .unwrap_or_else(|_| DEFAULT_EXTENSION_ID.to_string());

        println!("[1/5] Stopping any running FreeMiD process...");
        // taskkill exits non-zero if the process is not running — that is fine.
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let bin_dst = install_dir.join("freemid.exe");
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));

        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

        // Wait up to 5 s for freemid.exe to release its file handle.
        if bin_dst.exists() {
            let mut unlocked = false;
            for _ in 0..10 {
                if std::fs::OpenOptions::new().write(true).open(&bin_dst).is_ok() {
                    unlocked = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            if !unlocked {
                return Err(format!(
                    "freemid.exe is still locked after 5 s. \
                     Close any application using it and re-run the installer."
                ));
            }
        }

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

        println!("[3/5] Verifying SHA256 checksum...");
        // .Content is byte[] on PS5 when Content-Type is octet-stream; decode explicitly.
        let checksums_raw = ps_output(&format!(
            "[System.Text.Encoding]::UTF8.GetString((Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content)",
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

        println!("[4/5] Writing native messaging manifest...");
        let bin_path_json = bin_dst.display().to_string().replace('\\', "\\\\");
        let manifest = format!(
            "{{\n  \"name\": \"{host}\",\n  \"description\": \"FreeMiD native messaging host\",\n  \"path\": \"{path}\",\n  \"type\": \"stdio\",\n  \"allowed_origins\": [\n    \"chrome-extension://{ext_id}/\"\n  ]\n}}",
            host = HOST_NAME,
            path = bin_path_json,
            ext_id = extension_id,
        );
        std::fs::write(&manifest_path, &manifest)
            .map_err(|e| format!("Cannot write manifest: {}", e))?;

        println!("[5/5] Registering native messaging host...");
        let manifest_str = manifest_path.display().to_string();
        for (name, parent) in [
            ("Chrome", r"HKCU\Software\Google\Chrome\NativeMessagingHosts"),
            ("Edge",   r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
        ] {
            let key = format!(r"{}\{}", parent, HOST_NAME);
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
}

#[cfg(target_os = "windows")]
fn main() {
    win::run_main();
}
