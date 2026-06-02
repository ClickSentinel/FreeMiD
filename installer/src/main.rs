// FreeMiD Windows Installer
//
// Double-click freemid-setup.exe to open a small Windows GUI with install and
// uninstall actions.
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
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    use native_windows_gui as nwg;
    use sha2::{Digest, Sha256};

    const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
    const ARTIFACT: &str = "freemid-windows-x86_64.exe";
    const HOST_NAME: &str = "com.clicksentinel.freemid";
    const DEFAULT_EXTENSION_ID: &str = "gaonohfjfpdlfapccfaanenfcojfknli";
    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const LOCAL_BINARY_ENV: &str = "FREEMID_BINARY";
    const SETUP_EXE_NAME: &str = "freemid-setup.exe";
    const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMiD";
    const LATEST_SETUP_URL: &str = "https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-setup.exe";
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const BROWSER_HOST_PARENTS: [(&str, &str); 6] = [
        ("Chrome", r"HKCU\Software\Google\Chrome\NativeMessagingHosts"),
        ("Chrome Beta", r"HKCU\Software\Google\Chrome Beta\NativeMessagingHosts"),
        ("Chromium", r"HKCU\Software\Chromium\NativeMessagingHosts"),
        ("Edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
        ("Brave", r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"),
        ("Vivaldi", r"HKCU\Software\Vivaldi\NativeMessagingHosts"),
    ];

    #[derive(Copy, Clone)]
    struct CliOptions {
        uninstall: bool,
        silent: bool,
    }

    fn parse_cli_options() -> CliOptions {
        let mut options = CliOptions {
            uninstall: false,
            silent: false,
        };

        for arg in std::env::args().skip(1) {
            if arg.eq_ignore_ascii_case("--uninstall") {
                options.uninstall = true;
            } else if arg.eq_ignore_ascii_case("--silent") {
                options.silent = true;
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

        if let Err(e) = run_gui() {
            eprintln!("ERROR: {}", e);
        }
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

    fn run_gui() -> Result<(), String> {
        nwg::init().map_err(|e| format!("Failed to initialize GUI: {}", e))?;
        nwg::Font::set_global_family("Segoe UI").map_err(|e| format!("Failed to set UI font: {}", e))?;

        let ui = Ui::build().map_err(|e| format!("Failed to build UI: {}", e))?;
        let install_handle = ui.install_button.handle.clone();
        let uninstall_handle = ui.uninstall_button.handle.clone();
        let docs_handle = ui.docs_button.handle.clone();
        let window_handle = ui.window.handle.clone();

        let ui = std::rc::Rc::new(std::cell::RefCell::new(ui));
        let ui_events = std::rc::Rc::clone(&ui);

        let evt_handler = nwg::full_bind_event_handler(&window_handle, move |evt, _evt_data, handle| {
            use nwg::Event as E;

            match evt {
                E::OnWindowClose => {
                    nwg::stop_thread_dispatch();
                }
                E::OnButtonClick if handle == install_handle => {
                    let result = run_install(DEFAULT_EXTENSION_ID, |msg| {
                        let mut ui = ui_events.borrow_mut();
                        ui.status.set_text(msg);
                    });
                    match result {
                        Ok(()) => {
                            nwg::simple_message(
                                "FreeMiD Setup",
                                "Installation complete. Make sure the FreeMiD extension is installed and enabled. If the host is not detected right away, reload the extension page or restart the browser.",
                            );
                            let mut ui = ui_events.borrow_mut();
                            ui.status.set_text("Status: \u{2714} Installed");
                        }
                        Err(e) => {
                            nwg::simple_message(
                                "FreeMiD Setup - Error",
                                &format!(
                                    "Install failed. Check your internet connection and verify you can access GitHub Releases.\n\nDetails:\n{}",
                                    e
                                ),
                            );
                            let mut ui = ui_events.borrow_mut();
                            ui.status.set_text("Status: Failed");
                        }
                    }
                }
                E::OnButtonClick if handle == uninstall_handle => {
                    let result = run_uninstall(|msg| {
                        let mut ui = ui_events.borrow_mut();
                        ui.status.set_text(msg);
                    });
                    match result {
                        Ok(()) => {
                            nwg::simple_message(
                                "FreeMiD Setup",
                                "FreeMiD native host uninstalled.",
                            );
                            let mut ui = ui_events.borrow_mut();
                            ui.status.set_text("Status: \u{2714} Uninstalled");
                        }
                        Err(e) => {
                            nwg::simple_message(
                                "FreeMiD Setup - Error",
                                &format!(
                                    "Uninstall failed. Close any running FreeMiD process and try again.\n\nDetails:\n{}",
                                    e
                                ),
                            );
                            let mut ui = ui_events.borrow_mut();
                            ui.status.set_text("Status: Failed");
                        }
                    }
                }
                E::OnButtonClick if handle == docs_handle => {
                    open_latest_setup();
                }
                _ => {}
            }
        });

        ui.borrow_mut().evt_handler = Some(evt_handler);
        nwg::dispatch_thread_events();
        Ok(())
    }

    struct Ui {
        window: nwg::Window,
        title: nwg::Label,
        status: nwg::Label,
        note: nwg::Label,
        install_button: nwg::Button,
        uninstall_button: nwg::Button,
        docs_button: nwg::Button,
        evt_handler: Option<nwg::EventHandler>,
    }

    impl Ui {
        fn build() -> Result<Self, nwg::NwgError> {
            let mut window = nwg::Window::default();
            let mut title = nwg::Label::default();
            let mut status = nwg::Label::default();
            let mut note = nwg::Label::default();
            let mut install_button = nwg::Button::default();
            let mut uninstall_button = nwg::Button::default();
            let mut docs_button = nwg::Button::default();

            nwg::Window::builder()
                .size((420, 260))
                .position((300, 300))
                .title(&format!("FreeMiD Setup v{}", VERSION))
                .flags(nwg::WindowFlags::MAIN_WINDOW | nwg::WindowFlags::VISIBLE)
                .build(&mut window)?;

            nwg::Label::builder()
                .text("Install or manage FreeMiD on this device.")
                .parent(&window)
                .position((16, 16))
                .size((388, 24))
                .build(&mut title)?;

            nwg::Label::builder()
                .text("Setup installs the approved Chrome Web Store extension host configuration.")
                .parent(&window)
                .position((16, 42))
                .size((388, 24))
                .build(&mut note)?;

            nwg::Label::builder()
                .text("Status: Ready")
                .parent(&window)
                .position((16, 76))
                .size((388, 24))
                .build(&mut status)?;

            nwg::Button::builder()
                .text("Install or Update")
                .parent(&window)
                .position((16, 108))
                .size((388, 40))
                .build(&mut install_button)?;

            nwg::Button::builder()
                .text("Uninstall")
                .parent(&window)
                .position((16, 160))
                .size((188, 34))
                .build(&mut uninstall_button)?;

            nwg::Button::builder()
                .text("Get Latest Setup")
                .parent(&window)
                .position((216, 160))
                .size((188, 34))
                .build(&mut docs_button)?;

            Ok(Self {
                window,
                title,
                status,
                note,
                install_button,
                uninstall_button,
                docs_button,
                evt_handler: None,
            })
        }
    }

    fn run_install<F>(extension_id: &str, mut set_status: F) -> Result<(), String>
    where
        F: FnMut(&str),
    {
        set_status("Status: Starting installation...");

        println!("FreeMiD Setup  v{}", VERSION);
        println!("{}", "-".repeat(38));
        println!();

        println!("[1/5] Stopping any running FreeMiD process...");
        set_status("Status: Stopping existing FreeMiD process...");
        let _ = hidden_command("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let bin_dst = install_dir.join("freemid.exe");
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));

        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Cannot create install directory: {}", e))?;

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

        if let Ok(local_binary) = std::env::var(LOCAL_BINARY_ENV) {
            println!("[2/6] Installing from local binary...");
            set_status("Status: Installing local binary...");
            println!("      From: {}", local_binary);
            std::fs::copy(&local_binary, &bin_dst)
                .map_err(|e| format!("Failed to copy local binary {}: {}", local_binary, e))?;
            let size_mb = std::fs::metadata(&bin_dst)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            println!("      Installed ({:.2} MB)", size_mb);
            println!("[3/6] Skipping checksum (local binary mode)...");
            set_status("Status: Skipping checksum (local mode)...");
        } else {
            let tag = std::env::var("FREEMID_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string());
            let (download_url, checksums_url) = build_urls(&tag);

            println!("[2/6] Downloading {} ...", ARTIFACT);
            set_status("Status: Downloading native host...");
            println!("      From: {}", download_url);
            download_file(&download_url, &bin_dst)?;

            let size_mb = std::fs::metadata(&bin_dst)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            println!("      Downloaded ({:.2} MB)", size_mb);

            println!("[3/6] Verifying SHA256 checksum...");
            set_status("Status: Verifying checksum...");
            let checksums_raw = download_text(&checksums_url)?;
            let expected = extract_checksum(&checksums_raw, ARTIFACT)?;
            let actual = file_sha256_hex(&bin_dst)?;

            if actual != expected {
                let _ = std::fs::remove_file(&bin_dst);
                return Err(format!(
                    "Checksum mismatch!\n  Expected: {}\n  Actual:   {}",
                    expected, actual
                ));
            }
            println!("      OK  {}...", &actual[..16]);
        }

        println!("[4/6] Writing native messaging manifest...");
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

        println!("[5/6] Registering native messaging host...");
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
                    println!("      Registered for {}", name);
                }
                Err(e) => println!("      Warning ({}): {}", name, e),
            }
        }

        if registered_count == 0 {
            return Err(
                "Could not register FreeMiD for any supported Chromium browser. Install or launch Chrome, Edge, Brave, Chromium, or Vivaldi and run Setup again."
                    .to_string(),
            );
        }

        println!("      Registered browser targets: {}", registered_names.join(", "));

        println!("[6/6] Registering Apps & Features entry...");
        set_status("Status: Registering Apps and Features entry...");
        let setup_dst = install_dir.join(SETUP_EXE_NAME);
        copy_setup_exe(&setup_dst)?;
        register_arp(&install_dir, &bin_dst, &setup_dst)?;

        println!();
        println!("  Binary:     {}", bin_dst.display());
        println!("  Setup:      {}", setup_dst.display());
        println!("  Manifest:   {}", manifest_path.display());
        println!("  Extension:  {}", extension_id);
        println!("  ARP Key:    {}", UNINSTALL_KEY);

        set_status("Status: \u{2714} Installed");
        Ok(())
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

    fn open_latest_setup() {
        let _ = hidden_command("cmd")
            .args(["/C", "start", "", LATEST_SETUP_URL])
            .status();
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