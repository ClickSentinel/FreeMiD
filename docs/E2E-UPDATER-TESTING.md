# FreeMiD E2E Updater Testing

## Purpose

This document defines the end-to-end (E2E) update test process for FreeMiD during development, without requiring a public release for Linux/macOS host self-update validation.

It also defines the current Windows test strategy based on the setup-first architecture.

## Current Update Architecture

1. Linux/macOS native host update:

- Triggered from popup `Update` button.
- Extension sends `UPDATE` to native host.
- Host downloads artifact and checksum, verifies SHA-256, replaces binary, then reconnects.

1. Windows update path:

- Popup does not run in-process host self-update.
- Popup `Setup` opens the setup executable URL.
- Setup performs install/update and host registration.

## Test Goals

1. Confirm update decision logic is correct (only when candidate is newer).
2. Confirm status transitions are correct (`checking -> downloading -> reconnecting -> done`).
3. Confirm host version refreshes dynamically after apply (without extension reload).
4. Confirm failure paths produce actionable UI states.
5. Confirm Windows setup flow remains reliable and extension reconnects to updated host.

## Version Rules (Critical)

1. Baseline installed host version must be lower than candidate feed version.
2. Baseline and candidate must both come from code that already includes the `UPDATE` handler.
3. If versions are equal, updater will correctly report up-to-date and do nothing.

## Linux/macOS E2E (Primary Path)

### One-time setup

1. Use your unpacked extension ID (from `chrome://extensions`).
2. Ensure extension is loaded from `extension/dist`.

### Baseline install (older)

1. Set workspace version to baseline (example `0.3.13`) in `Cargo.toml`.
2. Sync project versions:

```bash
./scripts/sync-version.sh
```

1. Build and install baseline host:

```bash
cargo build --release -p freemid
./install/install.sh --binary ./target/release/freemid --extension-id "<your-extension-id>"
```

### Candidate/feed build (newer)

1. Set workspace version to candidate (example `0.3.14` or `0.4.0`) in `Cargo.toml`.
2. Sync versions:

```bash
./scripts/sync-version.sh
```

1. Start local E2E lane:

```bash
./scripts/local-update-e2e.sh start
```

This does all of the following:

1. Builds candidate host.
2. Creates local feed + checksum in `/tmp/freemid-feed`.
3. Runs local feed server on `127.0.0.1:8787`.
4. Builds extension with dev update overrides.

### Execute test

1. Reload extension in `chrome://extensions`.
2. Open popup.
3. Click `Update`.
4. Validate expected behavior:

- Progress states appear.
- Host reconnects.
- Host version advances to candidate version.
- Update control clears/hides after success.

### Troubleshooting checks

1. Confirm current lane status:

```bash
./scripts/local-update-e2e.sh status
```

1. Confirm feed tag is newer than installed host version.
2. Confirm extension was reloaded after `local-update-e2e.sh start`.
3. If popup opens install guidance instead of running update, baseline host may be below self-update minimum for that build.

### Failure-path tests (recommended)

1. Checksum mismatch: corrupt `checksums.sha256` entry.
2. Missing artifact: remove platform binary from feed tag directory.
3. Network failure: stop local feed server during update.
4. Reconnect lag: verify UI eventually confirms host version or shows retry after timeout.

## Windows E2E Strategy (Current)

Windows is setup-first, not in-process host self-update.

### What to validate on Windows now

1. Popup update button behavior:

- Shows `Setup`.
- Opens setup download URL.

1. Setup install/update correctness:

- Updates `%LOCALAPPDATA%\FreeMiD\freemid.exe`.
- Preserves/uses correct extension ID registration.
- Extension reconnects and reports updated host version.

1. Uninstall correctness:

- `freemid-setup.exe --uninstall --silent` path succeeds.
- Host registration and binaries are removed as expected.

### Windows local/dev test flow (without publishing a new release)

1. Build local host candidate and local setup.
2. Install baseline host locally (older updater-capable build) with your extension ID.
3. Run local setup manually (not from popup) to perform update/install validation.
4. Reload extension and verify host version/status in popup.

### Windows setup-button E2E using dev override

Use a dev setup URL override so popup `Setup` opens your test artifact URL instead of GitHub latest.

1. Host a test setup executable URL reachable by your Windows machine, for example:

- local LAN server URL
- private release artifact URL
- file server URL

1. Easiest option: host directly from the Windows VM itself.

```powershell
mkdir C:\freemid-feed -Force
copy .\freemid-setup.exe C:\freemid-feed\freemid-setup.exe
cd C:\freemid-feed
py -m http.server 8787
```

If browser and extension run inside the same VM, use `http://127.0.0.1:8787/freemid-setup.exe`.
If they run outside the VM, use `http://<vm-ip>:8787/freemid-setup.exe` and allow firewall access.

1. Set extension build env:

```powershell
$env:VITE_WINDOWS_SETUP_URL = "http://<host>:<port>/freemid-setup.exe"
cd extension
npm run build
```

1. Reload unpacked extension, click popup `Setup`, and verify browser opens your override URL.

1. Run setup from that URL and validate:

- install/update succeeds
- host reconnects in popup
- host version reflects expected value

Notes:

- If `VITE_WINDOWS_SETUP_URL` is unset or invalid, popup falls back to GitHub latest setup URL.
- For Linux/macOS dev builds, `scripts/local-update-e2e.sh` can pass through `FREEMID_WINDOWS_SETUP_URL` to embed the same override in the built extension.

## CI and Regression Gate

Before merge, run:

```bash
cd extension && npm run typecheck && npm run test:run && npm run build
cd .. && cargo check -p freemid && cargo check -p freemid-installer
```

## Quick Checklist

1. Baseline < candidate.
2. Both builds contain updater code.
3. Extension reloaded after dev build changes.
4. Local feed running for Linux/macOS path.
5. Windows validated via setup-first flow.
