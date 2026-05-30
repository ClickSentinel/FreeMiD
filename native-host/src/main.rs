mod discord_ipc;
mod ws_server;

use anyhow::Result;
use tokio::sync::watch;

const WS_ADDR: &str = "127.0.0.1:3005";

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("FreeMiD v{} starting", env!("CARGO_PKG_VERSION"));
    log::info!("WebSocket bridge: ws://{}", WS_ADDR);

    // Channel the async runtime uses to tell the tray whether Discord is connected
    let (discord_status_tx, discord_status_rx) = watch::channel(false);

    // Spawn tokio runtime on a background thread so main stays free for the
    // tray event loop (which MUST run on the OS main thread).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    std::thread::spawn(move || {
        rt.block_on(ws_server::run(WS_ADDR, discord_status_tx));
    });

    // ── System tray ──────────────────────────────────────────────────────────

    #[cfg(feature = "tray")]
    run_tray(discord_status_rx);

    // ── Headless / no-tray fallback ──────────────────────────────────────────

    #[cfg(not(feature = "tray"))]
    {
        log::info!("Running headless. Press Ctrl+C to exit.");
        std::thread::park(); // block the main thread indefinitely
    }

    Ok(())
}

// ── Tray implementation (feature = "tray") ────────────────────────────────────

#[cfg(feature = "tray")]
fn run_tray(mut status_rx: watch::Receiver<bool>) {
    use tray_icon::{
        menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
        TrayIconBuilder,
    };
    use winit::event_loop::{ControlFlow, EventLoopBuilder};

    // GTK must be initialized before any tray/menu calls on Linux.
    gtk::init().expect("Failed to initialize GTK");

    let event_loop = EventLoopBuilder::new().build().expect("Failed to create event loop");

    // Menu items
    let status_item = MenuItem::new("FreeMiD — connecting…", false, None);
    let quit_item = MenuItem::new("Quit FreeMiD", true, None);

    let menu = Menu::new();
    menu.append_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ])
    .unwrap();

    let _tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("FreeMiD")
        .with_icon(make_icon())
        .build()
        .unwrap();

    event_loop.run(move |_event, elwt| {
        // Pump the GTK main loop so tray menus render on Linux/X11/Wayland.
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }

        elwt.set_control_flow(ControlFlow::Wait);

        // Update tooltip / menu text when Discord connection status changes
        if status_rx.has_changed().unwrap_or(false) {
            let connected = *status_rx.borrow_and_update();
            let label = if connected {
                "FreeMiD — Discord connected ✓"
            } else {
                "FreeMiD — waiting for Discord…"
            };
            let _ = status_item.set_text(label);
        }

        // Handle menu events
        if let Ok(ev) = MenuEvent::receiver().try_recv() {
            if ev.id == quit_item.id() {
                log::info!("Quit requested from tray");
                elwt.exit();
            }
        }
    }).ok();
}

/// Build a simple 16×16 circle icon in Discord blurple (#5865F2).
#[cfg(feature = "tray")]
fn make_icon() -> tray_icon::Icon {
    const W: u32 = 16;
    const H: u32 = 16;
    let mut rgba = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            let dx = x as f32 - 7.5;
            let dy = y as f32 - 7.5;
            if dx * dx + dy * dy <= 49.0 {
                rgba.extend_from_slice(&[88, 101, 242, 255]); // blurple
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]); // transparent
            }
        }
    }
    tray_icon::Icon::from_rgba(rgba, W, H).expect("Failed to create tray icon")
}
