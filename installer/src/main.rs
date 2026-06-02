// FreeMiD Windows Installer
//
// Double-click freemid-setup.exe to open a small Windows GUI with install and
// uninstall actions.
//
// To use a custom extension ID:
//   set FREEMID_EXTENSION_ID=yourextensionid && freemid-setup.exe
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
    use std::path::PathBuf;
    use std::process::Command;

    use native_windows_gui as nwg;

    const GITHUB_REPO: &str = "ClickSentinel/FreeMiD";
    const ARTIFACT: &str = "freemid-windows-x86_64.exe";
    const HOST_NAME: &str = "com.clicksentinel.freemid";
    const DEFAULT_EXTENSION_ID: &str = "gaonohfjfpdlfapccfaanenfcojfknli";
    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const LOCAL_BINARY_ENV: &str = "FREEMID_BINARY";
    const UNINSTALL_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeMiD";
    const README_URL: &str = "https://github.com/ClickSentinel/FreeMiD#installation";

    pub fn run_main() {
        if let Err(e) = run_gui() {
            eprintln!("ERROR: {}", e);
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
                    let extension_id = std::env::var("FREEMID_EXTENSION_ID")
                        .unwrap_or_else(|_| DEFAULT_EXTENSION_ID.to_string());
                    let result = run_install(&extension_id);
                    match result {
                        Ok(()) => nwg::simple_message(
                            "FreeMiD Setup",
                            "Installation complete. Restart Chrome or Edge to activate.",
                        ),
                        Err(e) => nwg::simple_message("FreeMiD Setup - Error", &e),
                    }
                    let mut ui = ui_events.borrow_mut();
                    ui.status.set_text("Ready");
                }
                E::OnButtonClick if handle == uninstall_handle => {
                    let result = run_uninstall();
                    match result {
                        Ok(()) => nwg::simple_message(
                            "FreeMiD Setup",
                            "FreeMiD native host uninstalled.",
                        ),
                        Err(e) => nwg::simple_message("FreeMiD Setup - Error", &e),
                    }
                    let mut ui = ui_events.borrow_mut();
                    ui.status.set_text("Ready");
                }
                E::OnButtonClick if handle == docs_handle => {
                    open_docs();
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
            let mut install_button = nwg::Button::default();
            let mut uninstall_button = nwg::Button::default();
            let mut docs_button = nwg::Button::default();

            nwg::Window::builder()
                .size((420, 210))
                .position((300, 300))
                .title(&format!("FreeMiD Setup v{}", VERSION))
                .flags(nwg::WindowFlags::MAIN_WINDOW | nwg::WindowFlags::VISIBLE)
                .build(&mut window)?;

            nwg::Label::builder()
                .text("Choose what you want to do with FreeMiD.")
                .parent(&window)
                .position((16, 16))
                .size((388, 24))
                .build(&mut title)?;

            nwg::Label::builder()
                .text("Ready")
                .parent(&window)
                .position((16, 48))
                .size((388, 24))
                .build(&mut status)?;

            nwg::Button::builder()
                .text("Install or Update")
                .parent(&window)
                .position((16, 92))
                .size((120, 36))
                .build(&mut install_button)?;

            nwg::Button::builder()
                .text("Uninstall")
                .parent(&window)
                .position((148, 92))
                .size((120, 36))
                .build(&mut uninstall_button)?;

            nwg::Button::builder()
                .text("Troubleshooting")
                .parent(&window)
                .position((280, 92))
                .size((120, 36))
                .build(&mut docs_button)?;

            Ok(Self {
                window,
                title,
                status,
                install_button,
                uninstall_button,
                docs_button,
                evt_handler: None,
            })
        }
    }

    fn run_install(extension_id: &str) -> Result<(), String> {
        set_status("Installing...");

        println!("FreeMiD Setup  v{}", VERSION);
        println!("{}", "-".repeat(38));
        println!();

        println!("[1/5] Stopping any running FreeMiD process...");
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
            println!("      From: {}", local_binary);
            std::fs::copy(&local_binary, &bin_dst)
                .map_err(|e| format!("Failed to copy local binary {}: {}", local_binary, e))?;
            let size_mb = std::fs::metadata(&bin_dst)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            println!("      Installed ({:.2} MB)", size_mb);
            println!("[3/6] Skipping checksum (local binary mode)...");
        } else {
            let tag = std::env::var("FREEMID_RELEASE_TAG").unwrap_or_else(|_| "latest".to_string());
            let (download_url, checksums_url) = build_urls(&tag);

            println!("[2/6] Downloading {} ...", ARTIFACT);
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

            println!("[3/6] Verifying SHA256 checksum...");
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
        }

        println!("[4/6] Writing native messaging manifest...");
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
        let manifest_str = manifest_path.display().to_string();
        for (name, parent) in [
            ("Chrome", r"HKCU\Software\Google\Chrome\NativeMessagingHosts"),
            ("Edge", r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts"),
        ] {
            let key = format!(r"{}\{}", parent, HOST_NAME);
            match reg_set(&key, &manifest_str) {
                Ok(()) => println!("      Registered for {}", name),
                Err(e) => println!("      Warning ({}): {}", name, e),
            }
        }

        println!("[6/6] Registering Apps & Features entry...");
        register_arp(&install_dir, &bin_dst)?;

        println!();
        println!("  Binary:     {}", bin_dst.display());
        println!("  Manifest:   {}", manifest_path.display());
        println!("  Extension:  {}", extension_id);
        println!("  ARP Key:    {}", UNINSTALL_KEY);

        set_status("Ready");
        Ok(())
    }

    fn run_uninstall() -> Result<(), String> {
        set_status("Uninstalling...");

        let local_app_data = std::env::var("LOCALAPPDATA")
            .map_err(|_| "%LOCALAPPDATA% not set".to_string())?;
        let install_dir = PathBuf::from(local_app_data).join("FreeMiD");
        let manifest_path = install_dir.join(format!("{}.json", HOST_NAME));
        let bin_dst = install_dir.join("freemid.exe");

        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "freemid.exe", "/T"])
            .output();

        for key in [
            UNINSTALL_KEY.to_string(),
            r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.clicksentinel.freemid".to_string(),
            r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.clicksentinel.freemid".to_string(),
        ] {
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

        set_status("Ready");
        Ok(())
    }

    fn open_docs() {
        let _ = Command::new("cmd")
            .args(["/C", "start", "", README_URL])
            .status();
    }

    fn set_status(status: &str) {
        let _ = status;
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

    fn reg_set_named(key: &str, name: &str, typ: &str, value: &str) -> Result<(), String> {
        let status = Command::new("reg")
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
        let status = Command::new("reg")
            .args(["delete", key, "/f"])
            .status()
            .map_err(|e| format!("Failed to spawn reg.exe: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("reg delete failed for key: {}", key))
        }
    }

    fn register_arp(install_dir: &PathBuf, bin_dst: &PathBuf) -> Result<(), String> {
        let install_location = install_dir.display().to_string();
        let display_icon = bin_dst.display().to_string();
        let uninstall_cmd = format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://github.com/{}/releases/latest/download/uninstall.ps1 | iex\"",
            GITHUB_REPO
        );

        reg_set_named(UNINSTALL_KEY, "DisplayName", "REG_SZ", "FreeMiD")?;
        reg_set_named(UNINSTALL_KEY, "DisplayVersion", "REG_SZ", VERSION)?;
        reg_set_named(UNINSTALL_KEY, "Publisher", "REG_SZ", "ClickSentinel")?;
        reg_set_named(UNINSTALL_KEY, "InstallLocation", "REG_SZ", &install_location)?;
        reg_set_named(UNINSTALL_KEY, "DisplayIcon", "REG_SZ", &display_icon)?;
        reg_set_named(UNINSTALL_KEY, "UninstallString", "REG_SZ", &uninstall_cmd)?;
        reg_set_named(UNINSTALL_KEY, "NoModify", "REG_DWORD", "1")?;
        reg_set_named(UNINSTALL_KEY, "NoRepair", "REG_DWORD", "1")?;

        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn main() {
    win::run_main();
}