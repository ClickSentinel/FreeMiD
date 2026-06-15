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
    use std::path::PathBuf;
    use std::process::Command;

    use native_windows_gui as nwg;
    use sha2::{Digest, Sha256};

    const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
    const ARTIFACT: &str = "freemid-windows-x86_64.exe";
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
        ("Chrome", r"HKCU\Software\Google\Chrome\NativeMessagingHosts"),
        ("Chrome Beta", r"HKCU\Software\Google\Chrome Beta\NativeMessagingHosts"),
        ("Chromium", r"HKCU\Software\Chromium\NativeMessagingHosts"),
        ("Edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
        ("Brave", r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"),
        ("Vivaldi", r"HKCU\Software\Vivaldi\NativeMessagingHosts"),
    ];

    #[derive(Clone)]
    struct CliOptions {
        uninstall: bool,
        silent: bool,
        extension_id: Option<String>,
    }

    fn parse_cli_options() -> CliOptions {
        let mut options = CliOptions {
            uninstall: false,
            silent: false,
            extension_id: None,
        };

        let mut args = std::env::args().skip(1);
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

    fn resolve_extension_id(cli_override: Option<&str>) -> String {
        if let Some(id) = cli_override.filter(|s| !s.trim().is_empty()) {
            return id.trim().to_string();
        }
        if let Ok(id) = std::env::var(EXTENSION_ID_ENV) {
            if !id.trim().is_empty() {
                return id.trim().to_string();
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

        let _ = nwg::init();
        let _ = nwg::Font::set_global_family("Segoe UI");

        match result {
            Ok(()) => {
                nwg::simple_message("FreeMiD Setup", "FreeMiD native host uninstalled.");
            }
            Err(e) => {
                nwg::simple_message(
                    "FreeMiD Setup - Error",
                    &format!(
                        "Uninstall failed. Close any running FreeMiD process and try again.\n\nDetails:\n{}",
                        e
                    ),
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
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", line);
        }
    }

    fn log_step(line: &str) {
        println!("{}", line);
        append_setup_log(line);
    }

    fn run_gui(extension_id: String) -> Result<(), String> {
        nwg::init().map_err(|e| format!("Failed to initialize GUI: {}", e))?;
        nwg::Font::set_global_family("Segoe UI").map_err(|e| format!("Failed to set UI font: {}", e))?;
        append_setup_log(&format!("FreeMiD Setup v{} starting", VERSION));
        let result = run_install(&extension_id, |_| {});
        match result {
            Ok(()) => {
                append_setup_log("Installation complete.");
                nwg::simple_message(
                    "FreeMiD Setup",
                    "Installation complete. Check the FreeMiD browser extension and reload it if needed.",
                );
                Ok(())
            }
            Err(e) => {
                append_setup_log(&format!("Installation failed: {}", e));
                nwg::simple_message(
                    "FreeMiD Setup - Error",
                    &format!(
                        "Install failed. Check your internet connection and verify you can access GitHub Releases.\n\nDetails:\n{}",
                        e
                    ),
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

        log_step("[1/7] Stopping any running FreeMiD process...");
        set_status("Status: Stopping existing FreeMiD process...");
        let _ = hidden_command("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let bin_dst = install_dir.join("freemid.exe");
        let staged_bin_dst = install_dir.join(format!("freemid.exe.install-{}.tmp", std::process::id()));
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));

        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

        let _ = std::fs::remove_file(&staged_bin_dst);

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
                    "freemid.exe is still locked after 5 s. Close any application using it and re-run the installer."
                ));
            }
        }

        let install_result = (|| -> Result<(), String> {
            if let Ok(local_binary) = std::env::var(LOCAL_BINARY_ENV) {
                log_step("[2/7] Installing from local binary...");
                set_status("Status: Installing local binary...");
                log_step(&format!("      From: {}", local_binary));
                std::fs::copy(&local_binary, &staged_bin_dst)
                    .map_err(|e| format!("Failed to copy local binary {}: {}", local_binary, e))?;
                let size_mb = std::fs::metadata(&staged_bin_dst)
                    .map(|m| m.len() as f64 / 1_048_576.0)
                    .unwrap_or(0.0);
                log_step(&format!("      Installed ({:.2} MB)", size_mb));
                log_step("[3/7] Skipping checksum (local binary mode)...");
                set_status("Status: Skipping checksum (local mode)...");
            } else {
                let tag = std::env::var("FREEMID_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string());
                let (download_url, checksums_url) = build_urls(&tag);

                log_step(&format!("[2/7] Downloading {} ...", ARTIFACT));
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

                log_step("[3/7] Verifying SHA256 checksum...");
                set_status("Status: Verifying checksum...");
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
                log_step(&format!("      OK  {}...", &actual[..16]));
            }

            log_step("[4/7] Installing native host binary...");
            set_status("Status: Installing native host binary...");
            if bin_dst.exists() {
                std::fs::remove_file(&bin_dst)
                    .map_err(|e| format!("Failed to replace existing binary {}: {}", bin_dst.display(), e))?;
            }
            std::fs::rename(&staged_bin_dst, &bin_dst)
                .map_err(|e| format!("Failed to install binary to {}: {}", bin_dst.display(), e))?;

            log_step("[5/7] Writing native messaging manifest...");
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

            log_step("[6/7] Registering native messaging host...");
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

            log_step(&format!("      Registered browser targets: {}", registered_names.join(", ")));

            log_step("[7/7] Registering Apps & Features entry...");
            set_status("Status: Registering Apps and Features entry...");
            let setup_dst = install_dir.join(SETUP_EXE_NAME);
            copy_setup_exe(&setup_dst)?;
            register_arp(&install_dir, &bin_dst, &setup_dst)?;

            log_step(&format!("  Binary:     {}", bin_dst.display()));
            log_step(&format!("  Setup:      {}", setup_dst.display()));
            log_step(&format!("  Manifest:   {}", manifest_path.display()));
            log_step(&format!("  Extension:  {}", extension_id));
            log_step(&format!("  ARP Key:    {}", UNINSTALL_KEY));

            set_status("Status: \u{2714} Installed");
            Ok(())
        })();

        if install_result.is_err() {
            let _ = std::fs::remove_file(&staged_bin_dst);
        }

        install_result
    }

    fn run_uninstall<F>(mut set_status: F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        set_status("Status: Starting uninstall...");

        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));
        let bin_dst = install_dir.join("freemid.exe");
        let setup_dst = install_dir.join(SETUP_EXE_NAME);
        let updater_dst = install_dir.join(STABLE_UPDATER_EXE_NAME);
        let updater_log = install_dir.join("updater.log");

        let _ = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
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

        let _ = std::fs::remove_file(&manifest_path);
        let _ = std::fs::remove_file(&bin_dst);
        let _ = std::fs::remove_file(&setup_dst);
        let _ = std::fs::remove_file(&updater_dst);
        let _ = std::fs::remove_file(&updater_log);

        if let Ok(entries) = std::fs::read_dir(&install_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("freemid.exe.staged-") || name.starts_with("freemid.exe.install-") {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }

        if install_dir.exists() {
            let has_remaining = std::fs::read_dir(&install_dir)
                .ok()
                .and_then(|mut it| it.next())
                .is_some();
            if !has_remaining {
                let _ = std::fs::remove_dir(&install_dir);
            }
        }

        set_status("Status: \u{2714} Uninstalled");
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

    fn download_file(url: &str, destination: &PathBuf) -> Result<(), String> {
        let response = ureq::get(url)
            .call()
            .map_err(|e| format!("Download failed from {}: {}", url, e))?;

        let mut reader = response.into_reader();
        let mut file = File::create(destination)
            .map_err(|e| format!("Cannot create {}: {}", destination.display(), e))?;

        std::io::copy(&mut reader, &mut file)
            .map_err(|e| format!("Failed writing {}: {}", destination.display(), e))?;

        Ok(())
    }

    fn download_text(url: &str) -> Result<String, String> {
        let response = ureq::get(url)
            .call()
            .map_err(|e| format!("Download failed from {}: {}", url, e))?;

        let mut reader = response.into_reader();
        let mut content = String::new();
        reader
            .read_to_string(&mut content)
            .map_err(|e| format!("Failed reading {}: {}", url, e))?;

        Ok(content)
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
            std::fs::copy(&setup_src, setup_dst)
                .map_err(|e| format!("Failed to copy setup executable to {}: {}", setup_dst.display(), e))?;
        }

        Ok(())
    }

    fn register_arp(install_dir: &PathBuf, bin_dst: &PathBuf, setup_dst: &PathBuf) -> Result<(), String> {
        let install_location = install_dir.display().to_string();
        let display_icon = bin_dst.display().to_string();
        let uninstall_cmd = format!("\"{}\" --uninstall --silent", setup_dst.display());

        reg_set_named(UNINSTALL_KEY, "DisplayName", "REG_SZ", "FreeMiD")?;
        reg_set_named(UNINSTALL_KEY, "DisplayVersion", "REG_SZ", VERSION)?;
        reg_set_named(UNINSTALL_KEY, "Publisher", "REG_SZ", "ClickSentinel")?;
        reg_set_named(UNINSTALL_KEY, "InstallLocation", "REG_SZ", &install_location)?;
        reg_set_named(UNINSTALL_KEY, "DisplayIcon", "REG_SZ", &display_icon)?;
        reg_set_named(UNINSTALL_KEY, "UninstallString", "REG_SZ", &uninstall_cmd)?;
        reg_set_named(UNINSTALL_KEY, "QuietUninstallString", "REG_SZ", &uninstall_cmd)?;
        reg_set_named(UNINSTALL_KEY, "NoModify", "REG_DWORD", "1")?;
        reg_set_named(UNINSTALL_KEY, "NoRepair", "REG_DWORD", "1")?;

        Ok(())
    }

    fn hidden_command(program: &str) -> Command {
        let mut cmd = Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
}

#[cfg(target_os = "windows")]
fn main() {
    win::run_main();
}