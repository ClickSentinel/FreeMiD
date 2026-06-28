# Native Host Updater

## Architecture

### High-level flow

1. Background sends `{ type: "UPDATE" }` to native host (with optional source overrides).
2. Native host downloads candidate artifact and `checksums.sha256`.
3. Native host verifies SHA-256 before any apply action.
4. Native host applies update per-platform.
5. Background reconnects native port and verifies host version has advanced.

### Update source resolution

Priority order in native host updater:

1. Message overrides from extension (`latestUrl`, `releasesBaseUrl`).
2. Host environment variables (`FREEMID_UPDATE_LATEST_URL`, `FREEMID_UPDATE_RELEASES_BASE`).
3. GitHub defaults (`https://api.github.com/repos/ClickSentinel/FreeMiD/releases/latest`, `https://github.com/ClickSentinel/FreeMiD/releases/download`).

### Windows two-process apply

Windows update apply is intentionally two-process to avoid file-lock races:

1. `freemid.exe` stages `freemid.exe.staged-<pid>.exe` next to installed host.
2. `freemid.exe` launches `freemid-apply.exe --apply-update <staged> <target> <pid>`.
3. `freemid.exe` exits to release the file lock.
4. `freemid-apply.exe` retries copy to target until success/timeout.
5. Extension reconnects and validates reported host version.

Operation stays in user context under `%LOCALAPPDATA%\FreeMiD` — no elevation required.

### Windows installed files

- `%LOCALAPPDATA%\FreeMiD\freemid.exe`
- `%LOCALAPPDATA%\FreeMiD\freemid-apply.exe`
- `%LOCALAPPDATA%\FreeMiD\com.clicksentinel.freemid.json`
- `%LOCALAPPDATA%\FreeMiD\updater.log` (best-effort diagnostics)

### Windows release artifacts

- `freemid-windows-x86_64.exe` (host)
- `freemid-apply-windows-x86_64.exe` (stable apply helper)
- `freemid-setup.exe` (installer)
- `checksums.sha256`

### STATUS diagnostics surface

Native host `STATUS` includes:

- `version`
- `capabilities` — string array of supported features (e.g. `["self-update"]`); extension reads this to feature-gate without version comparisons
- `selfUpdateSupported` — legacy boolean, kept for older extension compatibility
- `runtimeOs`, `runtimeArch`, `binaryPath`

### Failure behavior

| Condition | Result |
| --- | --- |
| Host below update capability minimum | Extension returns `manualInstall` |
| Unsupported platform/arch | `failed` status with platform details |
| Windows apply launch failure | Fallback path attempted; diagnostics in `updater.log` |
| Reconnect/apply timeout | Extension exposes retry state with actionable error |

### Security

- All downloaded binaries are checksum-verified before apply.
- Install/update paths stay under `%LOCALAPPDATA%\FreeMiD` (no admin required).
- Native messaging registration stays under `HKCU` browser keys.

---

## E2E Testing

### Quick start

```bash
./scripts/local-update-e2e.sh start   # build candidate, serve local feed, rebuild extension
./scripts/local-update-e2e.sh status
./scripts/local-update-e2e.sh stop
```

### Version rules

- Baseline installed host must be **older** than the candidate feed version.
- Both builds must contain the `UPDATE` handler.
- Equal versions → updater reports `up_to_date` and does nothing.

### Linux/macOS E2E

1. Set workspace version to baseline (e.g. `0.3.13`) in `Cargo.toml`, then sync:

   ```bash
   ./scripts/sync-version.sh
   cargo build --release -p freemid
   ./install/install.sh --binary ./target/release/freemid --extension-id "<your-extension-id>"
   ```

2. Set workspace version to candidate (e.g. `0.3.14`), then start local lane:

   ```bash
   ./scripts/sync-version.sh
   ./scripts/local-update-e2e.sh start
   ```

   This builds the candidate host, creates a local feed + checksum in `/tmp/freemid-feed`, runs a feed server on `127.0.0.1:8787`, and rebuilds the extension with dev update overrides.

3. Reload extension in `chrome://extensions`, open popup, click **Update**.

4. Validate:
   - Progress states appear (`checking → downloading → reconnecting → success`).
   - Host version advances to candidate version.
   - Update control clears after success.

### Windows E2E

1. Build and install baseline host:

   ```powershell
   cargo build --release -p freemid --bins
   cd install
   .\install.ps1 -Binary ..\target\release\freemid.exe -ExtensionId <your-extension-id>
   ```

2. Build candidate, trigger update from popup, validate reconnect and version advance.

3. Verify apply helper artifacts:

   ```powershell
   Get-Content "$env:LOCALAPPDATA\FreeMiD\updater.log" -Tail 100
   Get-FileHash "$env:LOCALAPPDATA\FreeMiD\freemid.exe" -Algorithm SHA256
   ```

### Failure-path tests

- **Checksum mismatch**: corrupt `checksums.sha256` entry.
- **Missing artifact**: remove platform binary from feed tag directory.
- **Network failure**: stop local feed server mid-update.
- **Reconnect lag**: verify UI eventually confirms host version or shows retry.

### CI gate

```bash
cd extension && npm run typecheck && npm run test:run && npm run build
cd .. && cargo test && cargo clippy -- -D warnings
```
