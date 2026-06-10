# Windows Installer and Uninstaller Plan

This is the canonical Windows installer planning and release-readiness doc. It supersedes the prior standalone readiness draft to avoid drift.

## Goals

1. Ship a dead-simple Windows GUI installer experience.
2. Provide a matching dead-simple uninstall experience.
3. Keep installation non-admin (HKCU + LOCALAPPDATA).
4. Ensure release artifacts and checksums are always in sync.
5. Ensure all installers use the production extension ID by default.

## Current Gaps

1. Release assets must include both host and apply helper binaries for deterministic in-app update behavior.
2. Windows install can fail if `checksums.sha256` does not contain all required Windows artifact lines.
3. Uninstall is script-only (`uninstall.ps1`) and not exposed as a GUI workflow.
4. Extension ID consistency must be validated across all installer entrypoints on every release.

## Phase 1: Make Release Artifacts Reliable (First)

1. Update `.github/workflows/release.yml` to build and upload `freemid-setup.exe` from the `installer` crate.
2. Include `freemid-setup.exe` in release assets uploaded by `softprops/action-gh-release`.
3. Generate `checksums.sha256` from the final release file set and include all expected artifacts:
   - `freemid-windows-x86_64.exe`
   - `freemid-apply-windows-x86_64.exe`
   - `freemid-setup.exe`
   - existing Linux/macOS binaries
   - `freemid-extension.zip`
4. Add a release validation step that fails if `checksums.sha256` is missing any required filenames.
5. Add a post-release smoke test job that downloads `install.ps1` + `checksums.sha256` and verifies the artifact lookup succeeds for Windows.

## Phase 2: Unify and Harden Installer Defaults

1. Keep production extension ID default in all installer paths:
   - `install/install.ps1`
   - `install/install.sh`
   - `installer/src/main.rs`
2. Add a CI check script that asserts these defaults are identical.
3. Add an install script runtime warning when non-default extension ID is used (for clarity, not failure).
4. Improve checksum parser robustness in PowerShell installer:
   - normalize line endings
   - tolerate extra whitespace
   - fail with explicit diagnostics showing artifact name and first lines of checksum file
5. Keep checksum mismatch behavior strict (delete downloaded binary and exit non-zero).

## Phase 3: GUI Installer UX (Dead Simple)

1. Convert `freemid-setup.exe` to true GUI mode (`windows_subsystem = "windows"`).
2. Implement one lightweight window with these actions:
   - Install or Update
   - Uninstall
   - Open troubleshooting docs
3. Display simple progress states:
   - Stopping existing process
   - Downloading
   - Verifying checksum
   - Registering host
   - Complete or failed
4. Show actionable error dialogs with copyable details.
5. Keep advanced options hidden by default:
   - release tag override

## Phase 4: GUI Uninstaller Support

1. Add uninstall execution path to Rust installer binary (same logic as `uninstall.ps1`).
2. Ensure uninstall removes:
   - browser host registry entries (HKCU)
   - manifest
   - `freemid.exe` (unless user chooses keep-binary)
3. Add confirmation dialog and completion status.
4. Preserve script uninstall for automation and fallback.

## Phase 5: Windows App Lifecycle Integration

1. Register in Apps and Features (ARP) under HKCU:
   - DisplayName
   - DisplayVersion
   - Publisher
   - UninstallString (pointing to local setup uninstaller mode, no remote script fetch)
2. Add Start Menu shortcuts:
   - FreeMiD Setup
   - Uninstall FreeMiD
3. Optional: add file version metadata and code signing preparation notes.

## Safety Hardening Steps (Current Priority)

1. Make Apps and Features uninstall local and deterministic.
   - Set `UninstallString` to local `freemid-setup.exe --uninstall`.
   - Do not use remote `irm ... | iex` in ARP uninstall path.
2. Add explicit installer CLI uninstall mode.
   - Ensure `freemid-setup.exe --uninstall` runs the same uninstall logic as GUI uninstall.
   - Use `--silent` for ARP-triggered uninstall flows.
3. Remove installer runtime dependency on PowerShell for download and hashing.
   - Replace PowerShell `Invoke-WebRequest` and `Get-FileHash` with native Rust HTTP + SHA256.
4. Fail install when browser host registration did not succeed for any target browser.
   - Keep per-browser warnings for diagnostics but return a user-visible install failure on zero successful registrations.

Status in this branch:

- Step 1 implemented: ARP uninstall now targets local setup uninstall mode.
- Step 2 implemented: `--uninstall` mode and `--silent` mode added to setup executable.
- Step 3 implemented: setup now uses native Rust HTTP and SHA256 for download/checksum verification.
- Step 4 implemented: setup fails install when browser host registration succeeds for zero target browsers.

## Phase 6: Docs and Extension UX Alignment

1. Update README to match actual published files and exact install paths.
2. Update popup Update and Uninstall behavior on Windows:
   - prefer GUI setup executable when available
   - fallback to script URLs when not available
3. Add troubleshooting section for checksum/artifact mismatch.
4. Update installer completion copy to avoid browser restart requirement and instead guide users to open chrome://extensions and reload the extension.

## Validation Checklist (Release Gate)

1. `install.ps1` succeeds on clean Windows profile.
2. `freemid-setup.exe` install succeeds on clean Windows profile.
3. GUI uninstall removes all expected artifacts and registry keys.
4. `checksums.sha256` contains all required release files.
5. Default extension ID is identical across all installer entrypoints.
6. Reinstall over existing version works without admin rights.
7. Reload-the-extension guidance appears after successful install.

## Release Readiness Notes (Current)

1. Setup defaults to the production extension ID in the current GUI install flow.
   - Chrome Web Store listing: <https://chromewebstore.google.com/detail/freemid/gaonohfjfpdlfapccfaanenfcojfknli>
2. Popup `Open Setup` is a download flow: browser opens the release URL and user runs the downloaded EXE.
3. Apps and Features uninstall is local and deterministic via `freemid-setup.exe --uninstall --silent`.
4. Setup downloads host artifacts from GitHub Releases at install time and requires network reachability.
5. Unsigned EXE trust prompts are expected until code signing is introduced.
6. In-app host updates on Windows depend on local `freemid-apply.exe` being installed alongside `freemid.exe`.

## Pre-Tag Checklist (Windows)

- [ ] Clean Windows 11 install from GitHub release on Chrome
- [ ] Clean Windows 11 install from GitHub release on Edge
- [ ] Clean Windows 11 install from GitHub release on Brave
- [ ] Clean Windows 11 install from GitHub release on Chromium
- [ ] Clean Windows 11 install from GitHub release on Vivaldi
- [ ] Clean Windows 11 install from Chrome Web Store package using the default extension ID
- [ ] Verify manifest `allowed_origins` value matches the extension ID in use
- [ ] Popup `Open Setup` update flow tested from an installed extension
- [ ] Popup uninstall flow tested from an installed extension
- [ ] Apps and Features uninstall tested while online
- [ ] Browser warning and SmartScreen behavior captured with screenshots
- [ ] Release notes include reload-first guidance and setup-download wording

## Delivery Sequence

1. PR 1: release artifact and checksum reliability (Phase 1).
2. PR 2: default consistency checks + script hardening (Phase 2).
3. PR 3: GUI installer shell + install flow (Phase 3).
4. PR 4: GUI uninstall + ARP integration (Phases 4 and 5).
5. PR 5: docs and popup polish (Phase 6).

## Owner Notes

1. Keep all Windows paths under `%LOCALAPPDATA%\\FreeMiD`.
2. Keep registry writes under `HKCU` only.
3. Keep `uninstall.ps1` as permanent fallback even after GUI uninstall is shipped.
4. Keep checksum verification mandatory for downloaded binaries.
5. Do not require browser restart in installer messaging; guide extension install/enable actions instead.
