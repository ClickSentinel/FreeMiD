fn main() {
    println!("cargo:rerun-if-changed=freemid-setup.manifest");
    println!("cargo:rerun-if-changed=freemid-setup.rc");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        let _ = embed_resource::compile("freemid-setup.rc", embed_resource::NONE);
    }
}
