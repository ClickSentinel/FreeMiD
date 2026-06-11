# FreeMiD 0.4.0 Update Plan

## Goal

Ship a low-friction native-host update experience with clear fallback behavior for legacy installs and robust validation across Linux/macOS/Windows and store/unpacked extension IDs.

## Scope (0.4.0)

1. In-app host update UX for supported hosts (Linux/macOS/Windows self-update-capable host versions).
2. Automatic host reconnect/apply after successful download.
3. Inline update control near host version (no large banner-first UX).
4. Legacy-host fallback path that avoids raw script downloads and routes users to install guidance.
5. Custom extension ID compatibility for Windows setup/install paths.
6. Comprehensive automated tests for update decision and state behavior.
7. Extension update check track (store installs): trigger check from popup/background and surface status clearly.

## Compatibility Matrix

1. Linux/macOS + host >= self-update baseline:

- Update button triggers in-process host update.
- UI transitions: checking -> downloading -> reconnecting -> done.
- Host version should refresh without extension reload.

1. Linux/macOS + host < self-update baseline:

- Update action enters bootstrap fallback (manual one-time install path).
- After bootstrap, in-app updates are available.

1. Windows:

- In-app update path uses stable helper (`freemid-apply.exe`) to apply staged host binary.
- Setup fallback remains available for unsupported/legacy host states.

1. Unpacked/dev extension IDs:

- Installer/setup must preserve provided extension ID in native messaging registration.
- No forced fallback to default store extension ID when user supplied one.

1. Extension package update (separate from native host):

- Store-installed extension: can request update check, but cannot force-install arbitrary builds.
- Unpacked extension: update check API path is not applicable; reload/build workflow remains manual.

## Key Risks

1. Stale host port callbacks overriding fresh reconnect state.
2. Cached latest version producing incorrect update labels.
3. Legacy hosts receiving unsupported in-process update command.
4. Windows setup defaulting to store extension ID and breaking unpacked builds.
5. Retry shown too early while reconnect/apply still in progress.
6. Confusion between native-host update state and extension package update state.
7. Assuming update-check request guarantees immediate extension update application.

## Acceptance Criteria

1. Update control appears inline beside host version and is stateful.
2. Spinner appears while checking/downloading/reconnecting.
3. Retry only appears after reconnect/apply timeout failure.
4. Successful update clears action once host version catches up.
5. Legacy host path gives a clear bootstrap action (not raw script download page).
6. Windows setup supports custom extension IDs via CLI/env override.
7. No extension reload required to observe host version advancement after successful update.
8. If extension update check is surfaced, wording clearly distinguishes "check requested" from "updated now".

## Test Plan

### Automated

1. Extension unit tests (Vitest):

- Version comparison and baseline selection behavior.
- Update-available decision against stale/latest/manifest versions.
- Legacy host gating behavior.
- Popup update-control state rendering behavior.
- Extension-update status rendering behavior (store vs unpacked path handling).

1. Build/type checks:

- `npm run typecheck`
- `npm run test:run`
- `npm run build`
- `cargo check -p freemid`
- `cargo check -p freemid-installer`

### Manual smoke matrix

1. Linux/macOS self-update-capable host:

- Trigger update from popup.
- Verify host version refreshes without extension reload.

1. Linux/macOS legacy host:

- Trigger update from popup.
- Verify bootstrap fallback guidance opens and messaging is clear.

1. Windows in-app apply path:

- Trigger update path from popup.
- Verify helper launch, reconnect behavior, and host version advancement.

1. Windows setup fallback path:

- Trigger fallback flow from popup when manual install is required.
- Verify setup path still works and preserves extension ID registration.

1. Unpacked extension ID:

- Install/update using custom extension ID.
- Confirm native messaging registration keeps that ID.

1. Store extension update check path:

- Trigger extension update check from UI.
- Verify user sees deterministic status text for "checking", "update available", and "no update" outcomes.

1. Unpacked extension behavior:

- Trigger extension update affordance and verify it clearly explains manual reload/build path.

## Rollout Notes

1. Treat as a behaviorally significant release (`0.4.0`).
2. Release notes must include:

- one-time bootstrap expectation for legacy hosts
- supported auto-update paths by platform (including Windows helper apply path)
- custom extension ID setup notes for dev/unpacked installs
- extension package update limits (store-controlled rollout; unpacked manual reload)

## Current Progress

1. Inline update control implemented in popup UI.
2. Reconnecting state added with delayed failure-to-retry transition.
3. Legacy fallback no longer opens raw `install.sh` download.
4. Background version/update policy helper coverage expanded.
5. Windows installer custom extension ID support added via `--extension-id` and `FREEMID_EXTENSION_ID`.
6. Windows in-app updater scaffolded with stable helper binary `freemid-apply.exe`.

## Extension Update Track (New)

1. Add optional extension update-check action in background service worker (store-only behavior).
2. Add popup affordance and concise messaging that does not imply forced immediate update.
3. Keep extension update messaging separate from native host update controls to avoid mixed-state confusion.
4. For unpacked/dev installs, provide explicit manual path guidance (`npm run build` + reload in `chrome://extensions`).
