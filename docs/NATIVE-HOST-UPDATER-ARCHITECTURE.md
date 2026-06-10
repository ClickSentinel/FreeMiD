# Native Host Updater Architecture

## Goal

Provide a reliable, non-admin native host update path on Linux, macOS, and Windows.

## High-Level Flow

1. Popup sends `RUN_HOST_UPDATE` to extension background.
2. Background sends `UPDATE` to native host (with optional source overrides).
3. Native host downloads candidate artifact and `checksums.sha256`.
4. Native host verifies SHA-256 before any apply action.
5. Native host applies update per-platform (Linux/macOS in-place replace; Windows stages `freemid.exe` and launches `freemid-apply.exe`).
6. Background reconnects native port and verifies host version has advanced.

## Update Source Resolution

Source selection priority in native host updater:

1. Message overrides from extension (`latestUrl`, `releasesBaseUrl`).
2. Host environment variables (`FREEMID_UPDATE_LATEST_URL`, `FREEMID_UPDATE_RELEASES_BASE`).
3. GitHub defaults (`https://api.github.com/repos/ClickSentinel/FreeMiD/releases/latest`, `https://github.com/ClickSentinel/FreeMiD/releases/download`).

## Windows Strategy

Windows update apply is intentionally two-process:

1. `freemid.exe` stages `freemid.exe.staged-<pid>.exe` next to installed host.
2. `freemid.exe` launches `freemid-apply.exe --apply-update <staged> <target> <pid>`.
3. `freemid.exe` exits so file lock can be released.
4. `freemid-apply.exe` retries copy to target until success/timeout.
5. Extension reconnects and validates reported host version.

Rationale:

- Avoid in-process self-replace races on Windows.
- Keep operation in user context under `%LOCALAPPDATA%\FreeMiD`.
- Reduce UAC/elevation friction compared to launching ad-hoc copied helper executables.

## Installed Windows Files

- `%LOCALAPPDATA%\FreeMiD\freemid.exe`
- `%LOCALAPPDATA%\FreeMiD\freemid-apply.exe`
- `%LOCALAPPDATA%\FreeMiD\com.clicksentinel.freemid.json` (manifest path varies by host name)
- `%LOCALAPPDATA%\FreeMiD\updater.log` (best-effort local updater diagnostics)

## Release Artifacts (Windows)

- `freemid-windows-x86_64.exe` (host)
- `freemid-apply-windows-x86_64.exe` (stable apply helper)
- `freemid-setup.exe` (installer)
- `checksums.sha256`

## Status/Diagnostics Surface

Native host `STATUS` includes:

- `version`
- `selfUpdateSupported`
- `runtimeOs`
- `runtimeArch`
- `binaryPath`

These fields are surfaced by extension `GET_STATUS` for runtime verification.

## Failure Behavior

1. Host below update capability minimum -> extension returns `manualInstall`.
2. Unsupported platform/arch -> updater sends failed status with explicit platform details.
3. Windows apply launch failure -> attempts fallback path and records diagnostics in `updater.log`.
4. Reconnect/apply timeout -> extension exposes retry state with actionable error.

## Security Notes

1. All downloaded binaries are checksum-verified before apply.
2. Windows install/update paths stay under `%LOCALAPPDATA%\FreeMiD` (no admin required path).
3. Native messaging registration remains under `HKCU` browser keys.
