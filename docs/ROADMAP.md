# FreeMiD Roadmap

## Windows support

**Goal:** no-admin install, user-context only.

**Rust (`discord_ipc.rs`):**

- Discord on Windows uses named pipes: `\\.\pipe\discord-ipc-N` (N = 0–9)
- Open with `std::fs::OpenOptions` — no extra crates needed
- Add `#[cfg(target_os = "windows")]` block alongside existing Linux/macOS blocks

**Installer (`install/install.ps1`):**

- Binary → `$env:LOCALAPPDATA\FreeMiD\freemid.exe`
- Manifest JSON → same folder
- Registry (no admin required) → `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.clicksentinel.freemid`
- Also register under `HKCU:\Software\Chromium\...`, `HKCU:\Software\BraveSoftware\...` etc.
- One-liner: `irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.ps1 | iex`

**CI (`release.yml`):**

- Add `windows-latest` to the `build-native` matrix
- Artifact: `freemid-windows-x86_64.exe`
- `install/install.ps1` added to release assets

---

## Supply chain hardening

**GitHub Actions — pin to commit SHAs instead of tags:**

Tags like `actions/checkout@v4` can be silently moved. Replace with pinned SHAs:

| Action | Current | Pinned SHA |
| --- | --- | --- |
| `actions/checkout` | `@v4` | look up on release page |
| `actions/setup-node` | `@v4` | look up |
| `actions/cache` | `@v4` | look up |
| `actions/upload-artifact` | `@v4` | look up |
| `actions/download-artifact` | `@v4` | look up |
| `dtolnay/rust-toolchain` | `@stable` | look up |
| `softprops/action-gh-release` | `@v2` | look up |
| `nicedoc/chrome-webstore-upload-cli` | `@v2` | look up |

Process: go to each action's GitHub releases page, copy the full commit SHA for the desired tag, use `uses: owner/action@<sha> # v4` format.

**Rust — add `cargo audit` to CI:**

```yaml
- name: Security audit
  run: cargo install cargo-audit --locked && cargo audit
```

**npm — already safe:** `npm ci` + committed `package-lock.json` pins all transitive deps. Consider adding `npm audit --audit-level=high` to the extension CI job.
