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

Tags can be silently moved. Pin the exact actions currently referenced in `.github/workflows/release.yml`.

Process:

1. Read each `uses:` reference in `.github/workflows/release.yml`.
2. Find the corresponding release commit SHA in that action's upstream repository.
3. Replace tag-based references with `uses: owner/action@<sha> # <tag>` format.
4. Keep the trailing comment to preserve human-readable intent during reviews.

**Rust — add `cargo audit` to CI:**

```yaml
- name: Security audit
  run: cargo install cargo-audit --locked && cargo audit
```

**npm — already safe:** `npm ci` + committed `package-lock.json` pins all transitive deps. Consider adding `npm audit --audit-level=high` to the extension CI job.
