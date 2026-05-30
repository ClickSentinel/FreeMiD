//! Read DISCORD_CLIENT_ID from extension/.env at build time
//! and inject it as a compile-time env var.

use std::fs;
use std::path::Path;

fn main() {
    let env_path = Path::new("../extension/.env");
    println!("cargo:rerun-if-changed=../extension/.env");
    println!("cargo:rerun-if-env-changed=DISCORD_CLIENT_ID");

    // Allow override from the build environment.
    if let Ok(v) = std::env::var("DISCORD_CLIENT_ID") {
        if !v.is_empty() {
            println!("cargo:rustc-env=DISCORD_CLIENT_ID={}", v);
            return;
        }
    }

    if let Ok(content) = fs::read_to_string(env_path) {
        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(value) = line.strip_prefix("VITE_DISCORD_CLIENT_ID=") {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    println!("cargo:rustc-env=DISCORD_CLIENT_ID={}", value);
                    return;
                }
            }
        }
    }

    println!(
        "cargo:warning=DISCORD_CLIENT_ID not found (looked in env and {}); host will refuse to handshake.",
        env_path.display()
    );
}
