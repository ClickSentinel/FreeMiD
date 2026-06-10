# FreeMiD 0.4.0 Release Checklist

## Scope

- Release version: `0.4.0`
- Branch: `features/auto-update`

## Version Sync

- Workspace version in `Cargo.toml` set to `4.0.0`.
- Synced files via `scripts/sync-version.sh`:
  - `extension/package.json`
  - `extension/public/manifest.json`
  - `installer/freemid-setup.manifest`

## Build And Test Validation

Run from repository root:

```bash
bash scripts/sync-version.sh --check
cargo check -p freemid --bins
cargo check -p freemid-installer
cd extension
npm run typecheck
npm run test:run
npm run build
```

Expected:

- `Version consistency OK: 0.4.0`
- Rust checks pass for native host and installer.
- Extension typecheck, tests, and build pass.

## Release Artifacts

Confirm these artifacts are produced by CI for the release tag:

- `freemid-linux-x86_64`
- `freemid-macos-arm64`
- `freemid-macos-x86_64`
- `freemid-windows-x86_64.exe`
- `freemid-apply-windows-x86_64.exe`
- `freemid-setup.exe`
- `checksums.sha256`

## Smoke Tests

- Native host install works from release assets.
- Popup can reconnect host from disconnected state.
- Windows self-update path:
  - Update reaches apply/reconnect state.
  - Host version advances after reconnect.
- Close/reopen popup cannot bypass reconnect cooldown.

## Final Pre-Tag Checks

- `git status --short` only contains intended release changes.
- Release notes call out reconnect/update hardening and Windows apply helper behavior.
- Tag to publish: `v4.0.0`.
