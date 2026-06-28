// FreeMiD Windows Installer
//
// Double-click freemid-setup.exe to open a small Windows GUI that starts
// installation immediately and displays progress.
//
// To uninstall from command line quietly:
//   freemid-setup.exe --uninstall --silent
//
// To install a specific release tag:
//   set FREEMID_RELEASE_TAG=v0.3.1 && freemid-setup.exe

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("freemid-setup is a Windows-only installer.");
    std::process::exit(1);
}

#[cfg(target_os = "windows")]
mod win {
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    use sha2::{Digest, Sha256};

    fn message_box(title: &str, text: &str, is_error: bool) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK,
        };
        let title_w: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
        let text_w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let flags = MB_OK | if is_error { MB_ICONERROR } else { MB_ICONINFORMATION };
        // SAFETY: title_w and text_w are valid null-terminated UTF-16 strings; 0 is a valid null HWND.
        unsafe { MessageBoxW(0, text_w.as_ptr(), title_w.as_ptr(), flags) };
    }

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

    const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
    const ARTIFACT: &str = "freemid-windows-x86_64.exe";
    const APPLY_ARTIFACT: &str = "freemid-apply-windows-x86_64.exe";
    const HOST_NAME: &str = "com.clicksentinel.freemid";
    const DEFAULT_EXTENSION_ID: &str = "gaonohfjfpdlfapccfaanenfcojfknli";
    const EXTENSION_ID_ENV: &str = "FREEMID_EXTENSION_ID";
    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const LOCAL_BINARY_ENV: &str = "FREEMID_BINARY";
    const SETUP_EXE_NAME: &str = "freemid-setup.exe";
    const STABLE_UPDATER_EXE_NAME: &str = "freemid-apply.exe";
    const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMiD";
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const BROWSER_HOST_PARENTS: [(&str, &str); 6] = [
        (
            "Chrome",
            r"HKCU\Software\Google\Chrome\NativeMessagingHosts",
        ),
        (
            "Chrome Beta",
            r"HKCU\Software\Google\Chrome Beta\NativeMessagingHosts",
        ),
        ("Chromium", r"HKCU\Software\Chromium\NativeMessagingHosts"),
        ("Edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
        (
            "Brave",
            r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        ),
        ("Vivaldi", r"HKCU\Software\Vivaldi\NativeMessagingHosts"),
    ];

    #[derive(Clone)]
    struct CliOptions {
        uninstall: bool,
        silent: bool,
        extension_id: Option<String>,
    }

    fn parse_cli_options() -> CliOptions {
        parse_cli_options_from(std::env::args().skip(1))
    }

    fn parse_cli_options_from(args: impl Iterator<Item = String>) -> CliOptions {
        let mut options = CliOptions {
            uninstall: false,
            silent: false,
            extension_id: None,
        };

        let mut args = args.peekable();
        while let Some(arg) = args.next() {
            if arg.eq_ignore_ascii_case("--uninstall") {
                options.uninstall = true;
            } else if arg.eq_ignore_ascii_case("--silent") {
                options.silent = true;
            } else if arg.eq_ignore_ascii_case("--extension-id") {
                match args.next() {
                    Some(v) if !v.trim().is_empty() && !v.starts_with("--") => {
                        options.extension_id = Some(v);
                    }
                    _ => {
                        eprintln!("--extension-id requires a non-empty value");
                        std::process::exit(2);
                    }
                }
            } else if let Some(value) = arg.strip_prefix("--extension-id=") {
                options.extension_id = Some(value.to_string());
            }
        }

        options
    }

    pub fn run_main() {
        let cli = parse_cli_options();
        if cli.uninstall {
            run_cli_uninstall(cli.silent);
            return;
        }

        let selected_extension_id = resolve_extension_id(cli.extension_id.as_deref());

        if let Err(e) = run_gui(selected_extension_id) {
            eprintln!("ERROR: {}", e);
        }
    }

    /// A Chrome/Chromium extension ID is exactly 32 characters, each in `a`–`p`
    /// (a base-16 re-encoding of the public-key hash). Enforcing this before the
    /// value is interpolated into the native-messaging manifest JSON prevents a
    /// malformed `--extension-id`/`FREEMID_EXTENSION_ID` from corrupting or
    /// injecting into the manifest's `allowed_origins`.
    fn is_valid_extension_id(id: &str) -> bool {
        id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
    }

    fn resolve_extension_id(cli_override: Option<&str>) -> String {
        if let Some(id) = cli_override.map(str::trim).filter(|s| !s.is_empty()) {
            if !is_valid_extension_id(id) {
                eprintln!("--extension-id must be 32 characters in the range a-p");
                std::process::exit(2);
            }
            return id.to_string();
        }
        if let Ok(raw) = std::env::var(EXTENSION_ID_ENV) {
            let id = raw.trim();
            if !id.is_empty() {
                if !is_valid_extension_id(id) {
                    eprintln!(
                        "{} must be 32 characters in the range a-p",
                        EXTENSION_ID_ENV
                    );
                    std::process::exit(2);
                }
                return id.to_string();
            }
        }
        DEFAULT_EXTENSION_ID.to_string()
    }

    fn run_cli_uninstall(silent: bool) {
        let result = run_uninstall(|_| {});

        if silent {
            if result.is_err() {
                std::process::exit(1);
            }
            return;
        }

        match result {
            Ok(()) => {
                message_box("FreeMiD Setup", "FreeMiD native host uninstalled.", false);
            }
            Err(e) => {
                message_box(
                    "FreeMiD Setup - Error",
                    &format!(
                        "Uninstall failed. Close any running FreeMiD process and try again.\n\nDetails:\n{}",
                        e
                    ),
                    true,
                );
                std::process::exit(1);
            }
        }
    }

    fn installer_log_path() -> PathBuf {
        let mut path = if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let mut p = PathBuf::from(local_app_data);
            p.push("FreeMiD");
            let _ = std::fs::create_dir_all(&p);
            p
        } else {
            PathBuf::from(".")
        };
        path.push("setup.log");
        path
    }

    fn append_setup_log(line: &str) {
        let path = installer_log_path();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{}", line);
        }
    }

    fn log_step(line: &str) {
        println!("{}", line);
        append_setup_log(line);
    }

    fn run_gui(extension_id: String) -> Result<(), String> {
        append_setup_log(&format!("FreeMiD Setup v{} starting", VERSION));
        let result = run_install(&extension_id, |_| {});
        match result {
            Ok(()) => {
                append_setup_log("Installation complete.");
                message_box(
                    "FreeMiD Setup",
                    "Installation complete. Check the FreeMiD browser extension and reload it if needed.",
                    false,
                );
                Ok(())
            }
            Err(e) => {
                append_setup_log(&format!("Installation failed: {}", e));
                message_box(
                    "FreeMiD Setup - Error",
                    &format!(
                        "Install failed. Check your internet connection and verify you can access GitHub Releases.\n\nDetails:\n{}",
                        e
                    ),
                    true,
                );
                Err(e)
            }
        }
    }

    fn run_install<F>(extension_id: &str, mut set_status: F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        set_status("Status: Starting installation...");
        log_step("Status: Starting installation...");

        log_step(&format!("FreeMiD Setup  v{}", VERSION));
        log_step(&"-".repeat(38));

        log_step("[1/8] Stopping any running FreeMiD process...");
        set_status("Status: Stopping existing FreeMiD process...");
        let _ = hidden_command("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        let local_app_data =
            std::env::var("LOCALAPPDATA").map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let bin_dst = install_dir.join("freemid.exe");
        let staged_bin_dst =
            install_dir.join(format!("freemid.exe.install-{}.tmp", std::process::id()));
        let apply_dst = install_dir.join(STABLE_UPDATER_EXE_NAME);
        let staged_apply_dst = install_dir.join(format!(
            "freemid-apply.exe.install-{}.tmp",
            std::process::id()
        ));
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));

        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

        let _ = std::fs::remove_file(&staged_bin_dst);
        let _ = std::fs::remove_file(&staged_apply_dst);

        if bin_dst.exists() {
            let mut unlocked = false;
            for _ in 0..10 {
                if std::fs::OpenOptions::new()
                    .write(true)
                    .open(&bin_dst)
                    .is_ok()
                {
                    unlocked = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            if !unlocked {
                return Err(format!(
                    "freemid.exe is still locked after 5 s. Close any application using it and re-run the installer."
                ));
            }
        }

        let install_result = (|| -> Result<(), String> {
            if let Ok(local_binary) = std::env::var(LOCAL_BINARY_ENV) {
                log_step("[2/8] Installing from local binary...");
                set_status("Status: Installing local binary...");
                log_step(&format!("      From: {}", local_binary));
                std::fs::copy(&local_binary, &staged_bin_dst)
                    .map_err(|e| format!("Failed to copy local binary {}: {}", local_binary, e))?;
                let size_mb = std::fs::metadata(&staged_bin_dst)
                    .map(|m| m.len() as f64 / 1_048_576.0)
                    .unwrap_or(0.0);
                log_step(&format!("      Installed ({:.2} MB)", size_mb));
                log_step("[3/8] Skipping checksum (local binary mode)...");
                set_status("Status: Skipping checksum (local mode)...");
            } else {
                let tag =
                    std::env::var("FREEMID_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string());
                let (download_url, checksums_url, apply_url) = build_urls(&tag);

                log_step(&format!("[2/8] Downloading {} ...", ARTIFACT));
                set_status("Status: Downloading native host...");
                log_step(&format!("      From: {}", download_url));
                if let Err(e) = download_file(&download_url, &staged_bin_dst) {
                    let _ = std::fs::remove_file(&staged_bin_dst);
                    return Err(e);
                }
                let size_mb = std::fs::metadata(&staged_bin_dst)
                    .map(|m| m.len() as f64 / 1_048_576.0)
                    .unwrap_or(0.0);
                log_step(&format!("      Downloaded ({:.2} MB)", size_mb));

                log_step(&format!("      Downloading {} ...", APPLY_ARTIFACT));
                set_status("Status: Downloading apply helper...");
                log_step(&format!("      From: {}", apply_url));
                if let Err(e) = download_file(&apply_url, &staged_apply_dst) {
                    let _ = std::fs::remove_file(&staged_apply_dst);
                    return Err(e);
                }
                let apply_size_mb = std::fs::metadata(&staged_apply_dst)
                    .map(|m| m.len() as f64 / 1_048_576.0)
                    .unwrap_or(0.0);
                log_step(&format!("      Downloaded ({:.2} MB)", apply_size_mb));

                log_step("[3/8] Verifying SHA256 checksums...");
                set_status("Status: Verifying checksums...");
                let checksums_raw = download_text(&checksums_url)?;

                let expected = extract_checksum(&checksums_raw, ARTIFACT)?;
                let actual = file_sha256_hex(&staged_bin_dst)?;
                if actual != expected {
                    let _ = std::fs::remove_file(&staged_bin_dst);
                    return Err(format!(
                        "Checksum mismatch!\n  Expected: {}\n  Actual:   {}",
                        expected, actual
                    ));
                }
                log_step(&format!("      OK  {}... (native host)", &actual[..16]));

                let expected_apply = extract_checksum(&checksums_raw, APPLY_ARTIFACT)?;
                let actual_apply = file_sha256_hex(&staged_apply_dst)?;
                if actual_apply != expected_apply {
                    let _ = std::fs::remove_file(&staged_apply_dst);
                    return Err(format!(
                        "Apply helper checksum mismatch!\n  Expected: {}\n  Actual:   {}",
                        expected_apply, actual_apply
                    ));
                }
                log_step(&format!(
                    "      OK  {}... (apply helper)",
                    &actual_apply[..16]
                ));
            }

            log_step("[4/8] Installing native host binary...");
            set_status("Status: Installing native host binary...");
            if bin_dst.exists() {
                std::fs::remove_file(&bin_dst).map_err(|e| {
                    format!(
                        "Failed to replace existing binary {}: {}",
                        bin_dst.display(),
                        e
                    )
                })?;
            }
            std::fs::rename(&staged_bin_dst, &bin_dst)
                .map_err(|e| format!("Failed to install binary to {}: {}", bin_dst.display(), e))?;

            log_step("[5/8] Installing apply helper...");
            set_status("Status: Installing apply helper...");
            if staged_apply_dst.exists() {
                // download mode: staged binary was downloaded and verified
                if apply_dst.exists() {
                    std::fs::remove_file(&apply_dst).map_err(|e| {
                        format!(
                            "Failed to replace existing apply helper {}: {}",
                            apply_dst.display(),
                            e
                        )
                    })?;
                }
                std::fs::rename(&staged_apply_dst, &apply_dst).map_err(|e| {
                    format!(
                        "Failed to install apply helper to {}: {}",
                        apply_dst.display(),
                        e
                    )
                })?;
            } else {
                // local binary mode: copy the freshly installed host as apply helper
                std::fs::copy(&bin_dst, &apply_dst).map_err(|e| {
                    format!(
                        "Failed to copy apply helper from {}: {}",
                        bin_dst.display(),
                        e
                    )
                })?;
            }

            log_step("[6/8] Writing native messaging manifest...");
            set_status("Status: Writing native messaging manifest...");
            let bin_path_json = bin_dst.display().to_string().replace('\\', "\\\\");
            let manifest = format!(
                "{{\n  \"name\": \"{host}\",\n  \"description\": \"FreeMiD native messaging host\",\n  \"path\": \"{path}\",\n  \"type\": \"stdio\",\n  \"allowed_origins\": [\n    \"chrome-extension://{ext_id}/\"\n  ]\n}}",
                host = HOST_NAME,
                path = bin_path_json,
                ext_id = extension_id,
            );
            std::fs::write(&manifest_path, &manifest)
                .map_err(|e| format!("Cannot write manifest: {}", e))?;

            log_step("[7/8] Registering native messaging host...");
            set_status("Status: Registering browser host entries...");
            let manifest_str = manifest_path.display().to_string();
            let mut registered_count = 0usize;
            let mut registered_names = Vec::new();
            for (name, parent) in BROWSER_HOST_PARENTS {
                let key = format!(r"{}\{}", parent, HOST_NAME);
                match reg_set(&key, &manifest_str) {
                    Ok(()) => {
                        registered_count += 1;
                        registered_names.push(name);
                        log_step(&format!("      Registered for {}", name));
                    }
                    Err(e) => log_step(&format!("      Warning ({}): {}", name, e)),
                }
            }

            if registered_count == 0 {
                return Err(
                    "Could not register FreeMiD for any supported Chromium browser. Install or launch Chrome, Edge, Brave, Chromium, or Vivaldi and run Setup again."
                        .to_string(),
                );
            }

            log_step(&format!(
                "      Registered browser targets: {}",
                registered_names.join(", ")
            ));

            log_step("[8/8] Registering Apps & Features entry...");
            set_status("Status: Registering Apps and Features entry...");
            let setup_dst = install_dir.join(SETUP_EXE_NAME);
            copy_setup_exe(&setup_dst)?;
            register_arp(&install_dir, &bin_dst, &setup_dst)?;

            log_step(&format!("  Binary:     {}", bin_dst.display()));
            log_step(&format!("  Apply:      {}", apply_dst.display()));
            log_step(&format!("  Setup:      {}", setup_dst.display()));
            log_step(&format!("  Manifest:   {}", manifest_path.display()));
            log_step(&format!("  Extension:  {}", extension_id));
            log_step(&format!("  ARP Key:    {}", UNINSTALL_KEY));

            set_status("Status: \u{2714} Installed");
            Ok(())
        })();

        if install_result.is_err() {
            let _ = std::fs::remove_file(&staged_bin_dst);
            let _ = std::fs::remove_file(&staged_apply_dst);
        }

        install_result
    }

    fn run_uninstall<F>(mut set_status: F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        set_status("Status: Starting uninstall...");

        let local_app_data =
            std::env::var("LOCALAPPDATA").map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));
        let bin_dst = install_dir.join("freemid.exe");
        let setup_dst = install_dir.join(SETUP_EXE_NAME);
        let updater_dst = install_dir.join(STABLE_UPDATER_EXE_NAME);
        let updater_log = install_dir.join("updater.log");

        let _ = hidden_command("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        set_status("Status: Removing registry entries...");
        let mut uninstall_keys = vec![UNINSTALL_KEY.to_string()];
        uninstall_keys.extend(
            BROWSER_HOST_PARENTS
                .iter()
                .map(|(_, parent)| format!(r"{}\{}", parent, HOST_NAME)),
        );

        for key in uninstall_keys {
            let _ = reg_delete(&key);
        }

        // Derive the installer log path directly rather than via
        // installer_log_path(), which would re-create install_dir as a side effect.
        let setup_log = install_dir.join("setup.log");

        let _ = std::fs::remove_file(&manifest_path);
        let _ = std::fs::remove_file(&bin_dst);
        let _ = std::fs::remove_file(&setup_dst);
        let _ = std::fs::remove_file(&updater_dst);
        let _ = std::fs::remove_file(&updater_log);
        let _ = std::fs::remove_file(&setup_log);

        if let Ok(entries) = std::fs::read_dir(&install_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("freemid.exe.staged-")
                        || name.starts_with("freemid.exe.install-")
                    {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }

        // Remove the install directory. When uninstall runs from Add/Remove
        // Programs the running process *is* `install_dir\freemid-setup.exe`, and
        // Windows will not let a running image delete itself — so the directory
        // is not yet empty and remove_dir fails. Hand the final delete to a
        // detached cmd.exe that retries until this process exits.
        if install_dir.exists() && std::fs::remove_dir(&install_dir).is_err() {
            schedule_deferred_cleanup(&setup_dst, &install_dir);
        }

        set_status("Status: \u{2714} Uninstalled");
        Ok(())
    }

    fn build_urls(tag: &str) -> (String, String, String) {
        let dir = if tag == "latest" {
            format!(
                "https://github.com/{}/releases/latest/download",
                GITHUB_REPO
            )
        } else {
            format!(
                "https://github.com/{}/releases/download/{}",
                GITHUB_REPO, tag
            )
        };
        (
            format!("{}/{}", dir, ARTIFACT),
            format!("{}/checksums.sha256", dir),
            format!("{}/{}", dir, APPLY_ARTIFACT),
        )
    }

    // Mirror the native host's update caps so a compromised or misbehaving
    // release feed cannot exhaust disk/memory during install.
    const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
    const MAX_CHECKSUMS_BYTES: u64 = 1024 * 1024;

    fn download_file(url: &str, destination: &PathBuf) -> Result<(), String> {
        let response = http_agent()
            .get(url)
            .call()
            .map_err(|e| format!("Download failed from {}: {}", url, e))?;

        if let Some(content_length) = response
            .headers()
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
        {
            if content_length > MAX_DOWNLOAD_BYTES {
                return Err(format!(
                    "Download too large ({} bytes, max {})",
                    content_length, MAX_DOWNLOAD_BYTES
                ));
            }
        }

        let mut reader = response.into_body().into_reader().take(MAX_DOWNLOAD_BYTES + 1);
        let mut file = File::create(destination)
            .map_err(|e| format!("Cannot create {}: {}", destination.display(), e))?;

        let written = std::io::copy(&mut reader, &mut file)
            .map_err(|e| format!("Failed writing {}: {}", destination.display(), e))?;

        if written > MAX_DOWNLOAD_BYTES {
            let _ = std::fs::remove_file(destination);
            return Err(format!(
                "Download exceeded max size of {} bytes",
                MAX_DOWNLOAD_BYTES
            ));
        }

        Ok(())
    }

    fn download_text(url: &str) -> Result<String, String> {
        let response = http_agent()
            .get(url)
            .call()
            .map_err(|e| format!("Download failed from {}: {}", url, e))?;

        let mut reader = response.into_body().into_reader().take(MAX_CHECKSUMS_BYTES + 1);
        let mut buf = Vec::new();
        reader
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed reading {}: {}", url, e))?;

        if buf.len() as u64 > MAX_CHECKSUMS_BYTES {
            return Err(format!(
                "Checksums file exceeded max size of {} bytes",
                MAX_CHECKSUMS_BYTES
            ));
        }

        String::from_utf8(buf).map_err(|e| format!("Checksums file is not valid UTF-8: {}", e))
    }

    fn extract_checksum(checksums_raw: &str, artifact: &str) -> Result<String, String> {
        let mut preview = Vec::new();

        for raw_line in checksums_raw.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }

            if preview.len() < 5 {
                preview.push(line.to_string());
            }

            let mut parts = line.split_whitespace();
            let Some(hash) = parts.next() else {
                continue;
            };
            let Some(file) = parts.next() else {
                continue;
            };

            if file == artifact || file == format!("*{}", artifact) {
                return Ok(hash.to_ascii_lowercase());
            }
        }

        let preview_str = if preview.is_empty() {
            "<empty checksums file>".to_string()
        } else {
            preview.join("\n")
        };

        Err(format!(
            "Entry for {} not found in checksums.sha256. First entries:\n{}",
            artifact, preview_str
        ))
    }

    fn file_sha256_hex(path: &PathBuf) -> Result<String, String> {
        let mut file = File::open(path)
            .map_err(|e| format!("Cannot open {} for checksum: {}", path.display(), e))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];

        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|e| format!("Cannot read {} for checksum: {}", path.display(), e))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }

        Ok(format!("{:x}", hasher.finalize()))
    }

    fn reg_set(key: &str, value: &str) -> Result<(), String> {
        let status = hidden_command("reg")
            .args(["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"])
            .status()
            .map_err(|e| format!("Failed to spawn reg.exe: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg add failed for key: {}", key))
        }
    }

    fn reg_set_named(key: &str, name: &str, typ: &str, value: &str) -> Result<(), String> {
        let status = hidden_command("reg")
            .args(["add", key, "/v", name, "/t", typ, "/d", value, "/f"])
            .status()
            .map_err(|e| format!("Failed to spawn reg.exe: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg add failed for key {} value {}", key, name))
        }
    }

    fn reg_delete(key: &str) -> Result<(), String> {
        let status = hidden_command("reg")
            .args(["delete", key, "/f"])
            .status()
            .map_err(|e| format!("Failed to spawn reg.exe: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg delete failed for key: {}", key))
        }
    }

    fn copy_setup_exe(setup_dst: &PathBuf) -> Result<(), String> {
        let setup_src = std::env::current_exe()
            .map_err(|e| format!("Cannot resolve setup executable path: {}", e))?;

        if setup_src != *setup_dst {
            std::fs::copy(&setup_src, setup_dst).map_err(|e| {
                format!(
                    "Failed to copy setup executable to {}: {}",
                    setup_dst.display(),
                    e
                )
            })?;
        }

        Ok(())
    }

    fn register_arp(
        install_dir: &PathBuf,
        bin_dst: &PathBuf,
        setup_dst: &PathBuf,
    ) -> Result<(), String> {
        let install_location = install_dir.display().to_string();
        let display_icon = bin_dst.display().to_string();
        let uninstall_cmd = format!("\"{}\" --uninstall --silent", setup_dst.display());

        reg_set_named(UNINSTALL_KEY, "DisplayName", "REG_SZ", "FreeMiD")?;
        reg_set_named(UNINSTALL_KEY, "DisplayVersion", "REG_SZ", VERSION)?;
        reg_set_named(UNINSTALL_KEY, "Publisher", "REG_SZ", "ClickSentinel")?;
        reg_set_named(
            UNINSTALL_KEY,
            "InstallLocation",
            "REG_SZ",
            &install_location,
        )?;
        reg_set_named(UNINSTALL_KEY, "DisplayIcon", "REG_SZ", &display_icon)?;
        reg_set_named(UNINSTALL_KEY, "UninstallString", "REG_SZ", &uninstall_cmd)?;
        reg_set_named(
            UNINSTALL_KEY,
            "QuietUninstallString",
            "REG_SZ",
            &uninstall_cmd,
        )?;
        reg_set_named(UNINSTALL_KEY, "NoModify", "REG_DWORD", "1")?;
        reg_set_named(UNINSTALL_KEY, "NoRepair", "REG_DWORD", "1")?;

        Ok(())
    }

    /// Resolve a Windows system tool to its absolute `System32` path.
    ///
    /// `CreateProcessW` (used by `Command::new`) searches the application
    /// directory and the current directory before `System32`, so launching
    /// `reg`/`taskkill` by bare name lets an attacker-planted `reg.exe` in the
    /// directory the installer was run from execute instead. Anchoring to
    /// `%SystemRoot%\System32` removes that search entirely.
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

    fn hidden_command(program: &str) -> Command {
        let mut cmd = Command::new(system32_tool(program));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// Escape a string for embedding inside a double-quoted `cmd.exe` argument.
    /// In cmd.exe, a literal `"` inside a double-quoted segment must be doubled.
    fn escape_cmd_quoted_arg(s: &str) -> String {
        s.replace('"', "\"\"")
    }

    /// Build the `cmd.exe` command that finishes uninstall after this process
    /// exits: retry deleting the (self-locked) setup executable until it is gone,
    /// then remove the now-empty install directory. The `for /L` retry loop gives
    /// the user time to dismiss the completion dialog before the lock releases.
    fn deferred_cleanup_command(setup: &str, dir: &str) -> String {
        let setup = escape_cmd_quoted_arg(setup);
        let dir = escape_cmd_quoted_arg(dir);
        format!(
            "for /L %i in (1,1,30) do (del /f /q \"{setup}\" >nul 2>nul & if not exist \"{setup}\" (rmdir /q \"{dir}\" >nul 2>nul & exit /B 0) else (ping 127.0.0.1 -n 2 >nul))"
        )
    }

    /// Spawn a detached `cmd.exe` to delete the installer's own executable and
    /// the install directory once this process releases its file lock on exit.
    fn schedule_deferred_cleanup(setup_dst: &Path, install_dir: &Path) {
        let command = deferred_cleanup_command(
            &setup_dst.display().to_string(),
            &install_dir.display().to_string(),
        );
        let cmd_path = system32_tool("cmd");
        let mut process = Command::new(&cmd_path);
        process
            .args(["/C", &command])
            .creation_flags(CREATE_NO_WINDOW);
        // Run from System32 so the bare `ping` in the script resolves to the real
        // tool rather than one planted in the directory the installer was launched
        // from (cmd searches the working directory before PATH).
        if let Some(system32_dir) = cmd_path.parent() {
            process.current_dir(system32_dir);
        }
        // spawn (not output) so the child outlives us and can delete this exe.
        let _ = process.spawn();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn default_extension_id_is_well_formed() {
            assert!(is_valid_extension_id(DEFAULT_EXTENSION_ID));
        }

        #[test]
        fn rejects_malformed_extension_ids() {
            assert!(!is_valid_extension_id(""), "empty");
            assert!(!is_valid_extension_id("abc"), "too short");
            assert!(!is_valid_extension_id(&"a".repeat(33)), "too long");
            assert!(
                !is_valid_extension_id(&"z".repeat(32)),
                "'z' is outside a-p"
            );
            assert!(!is_valid_extension_id(&"A".repeat(32)), "uppercase");
            assert!(
                !is_valid_extension_id(&format!("{}9", "a".repeat(31))),
                "contains a digit"
            );
            // A JSON-breaking payload must be rejected before it can reach the manifest.
            assert!(!is_valid_extension_id("a\"]}, \"evil\": \"x"));
        }

        #[test]
        fn system32_tool_anchors_and_appends_exe() {
            let reg = system32_tool("reg");
            assert!(reg.ends_with(r"System32\reg.exe"));
            // An explicit .exe must not be doubled.
            let taskkill = system32_tool("taskkill.exe");
            assert!(taskkill.ends_with(r"System32\taskkill.exe"));
            // The directory must be absolute, not a bare tool name.
            assert!(reg.is_absolute());
        }

        #[test]
        fn deferred_cleanup_command_targets_both_paths() {
            let setup = r"C:\Users\me\AppData\Local\FreeMiD\freemid-setup.exe";
            let dir = r"C:\Users\me\AppData\Local\FreeMiD";
            let cmd = deferred_cleanup_command(setup, dir);
            // Deletes the self-locked exe and removes the directory, quoted.
            assert!(cmd.contains(&format!("del /f /q \"{setup}\"")));
            assert!(cmd.contains(&format!("rmdir /q \"{dir}\"")));
            // Retries (so the user can dismiss the dialog) rather than deleting once.
            assert!(cmd.contains("for /L %i in (1,1,30)"));
            assert!(cmd.contains("if not exist"));
            assert!(cmd.contains("exit /B 0"));
        }

        // ── parse_cli_options_from ────────────────────────────────────────────

        fn args(v: &[&str]) -> impl Iterator<Item = String> + '_ {
            v.iter().map(|s| s.to_string())
        }

        #[test]
        fn cli_defaults_when_empty() {
            let opts = parse_cli_options_from(args(&[]));
            assert!(!opts.uninstall);
            assert!(!opts.silent);
            assert!(opts.extension_id.is_none());
        }

        #[test]
        fn cli_uninstall_and_silent() {
            let opts = parse_cli_options_from(args(&["--uninstall", "--silent"]));
            assert!(opts.uninstall);
            assert!(opts.silent);
        }

        #[test]
        fn cli_extension_id_space_separated() {
            let id = "a".repeat(32);
            let opts = parse_cli_options_from(args(&["--extension-id", &id]));
            assert_eq!(opts.extension_id.as_deref(), Some(id.as_str()));
        }

        #[test]
        fn cli_extension_id_equals_form() {
            let id = "b".repeat(32);
            let arg = format!("--extension-id={id}");
            let opts = parse_cli_options_from(args(&[&arg]));
            assert_eq!(opts.extension_id.as_deref(), Some(id.as_str()));
        }

        #[test]
        fn cli_case_insensitive_flags() {
            let opts = parse_cli_options_from(args(&["--UNINSTALL", "--Silent"]));
            assert!(opts.uninstall);
            assert!(opts.silent);
        }

        // ── extract_checksum ──────────────────────────────────────────────────

        #[test]
        fn checksum_finds_artifact() {
            let raw = "abc123  freemid-windows-x86_64.exe\ndef456  freemid-linux-x86_64\n";
            assert_eq!(
                extract_checksum(raw, "freemid-windows-x86_64.exe").unwrap(),
                "abc123"
            );
        }

        #[test]
        fn checksum_handles_star_prefix() {
            let raw = "abc123  *freemid-windows-x86_64.exe\n";
            assert_eq!(
                extract_checksum(raw, "freemid-windows-x86_64.exe").unwrap(),
                "abc123"
            );
        }

        #[test]
        fn checksum_lowercases_hash() {
            let raw = "ABCDEF  freemid-windows-x86_64.exe\n";
            assert_eq!(
                extract_checksum(raw, "freemid-windows-x86_64.exe").unwrap(),
                "abcdef"
            );
        }

        #[test]
        fn checksum_skips_blank_lines() {
            let raw = "\n\nabc123  freemid-windows-x86_64.exe\n\n";
            assert_eq!(
                extract_checksum(raw, "freemid-windows-x86_64.exe").unwrap(),
                "abc123"
            );
        }

        #[test]
        fn checksum_errors_on_missing_artifact() {
            let raw = "abc123  freemid-linux-x86_64\n";
            assert!(extract_checksum(raw, "freemid-windows-x86_64.exe").is_err());
        }

        #[test]
        fn checksum_errors_on_empty_file() {
            assert!(extract_checksum("", "freemid-windows-x86_64.exe").is_err());
        }

        // ── build_urls ────────────────────────────────────────────────────────

        #[test]
        fn build_urls_latest() {
            let (dl, cs, apply) = build_urls("latest");
            assert_eq!(
                dl,
                "https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-windows-x86_64.exe"
            );
            assert_eq!(
                cs,
                "https://github.com/ClickSentinel/FreeMiD/releases/latest/download/checksums.sha256"
            );
            assert_eq!(
                apply,
                "https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-apply-windows-x86_64.exe"
            );
        }

        #[test]
        fn build_urls_specific_tag() {
            let (dl, cs, apply) = build_urls("v0.4.2");
            assert_eq!(
                dl,
                "https://github.com/ClickSentinel/FreeMiD/releases/download/v0.4.2/freemid-windows-x86_64.exe"
            );
            assert_eq!(
                cs,
                "https://github.com/ClickSentinel/FreeMiD/releases/download/v0.4.2/checksums.sha256"
            );
            assert_eq!(
                apply,
                "https://github.com/ClickSentinel/FreeMiD/releases/download/v0.4.2/freemid-apply-windows-x86_64.exe"
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    win::run_main();
}
