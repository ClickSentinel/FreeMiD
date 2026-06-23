# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

FreeMiD is a free, open-source Discord Rich Presence bridge for web browsing. It has two main components:

1. **Chrome extension** (TypeScript/Vite) — detects media activity on supported sites, sends presence data to the background service worker
2. **Native host** (Rust) — a small binary Chrome spawns on demand that bridges Chrome's native messaging protocol to Discord's local IPC socket

The extension cannot open Unix sockets directly, so the native host is what actually talks to Discord.

## Workspace layout

```text
Cargo.toml              # workspace root (members: native-host, installer)
native-host/            # Rust binary: freemid + freemid-apply (Windows updater helper)
installer/              # Rust binary: freemid-setup.exe (Windows GUI installer)
extension/              # Chrome MV3 extension (TypeScript + Vite)
  src/
    background/index.ts # Service worker: manages native port, tab injection, update flow
    presence/Presence.ts# API class used by all activities
    activities/         # One subdirectory per supported site (youtube, youtubemusic, tidal)
    constants/          # Shared asset keys, storage keys, GitHub repo reference
    utils/              # parseClock and other small helpers
install/                # install.sh / install.ps1 / uninstall scripts
scripts/                # build-activities.mjs, local-update-e2e.sh, sync-version.sh
docs/                   # Architecture docs and release checklists
```

## Build commands

### Native host (Rust)

```bash
cargo build --release          # produces target/release/freemid (and freemid-apply on Windows)
cargo test                     # run all Rust tests
cargo clippy -- -D warnings    # lint
```

The native host reads `DISCORD_CLIENT_ID` at **compile time** from the environment (used in `discord_ipc.rs`). For CI this is set to a placeholder; for production builds it is set during the release workflow.

### Extension (TypeScript)

```bash
cd extension
npm ci                  # install deps
npm run build           # vite build + build-activities.mjs → extension/dist/
npm run dev             # watch mode
npm run typecheck       # tsc --noEmit
npm run test            # vitest (watch)
npm run test:run        # vitest run (single pass, used in CI)
```

The extension requires `extension/.env` with at minimum:

```text
VITE_DISCORD_CLIENT_ID=your_discord_app_id
```

Optional overrides for local updater E2E testing:

```text
VITE_UPDATE_LATEST_URL=http://127.0.0.1:8787/latest.json
VITE_UPDATE_RELEASES_BASE=http://127.0.0.1:8787
VITE_DISCORD_CHECK_DELAY_MS=10000
VITE_WINDOWS_SETUP_URL=http://127.0.0.1:8787/freemid-setup.exe
```

### Version consistency

All versions must stay in sync across `Cargo.toml` (workspace), `extension/package.json`, and the installer. CI enforces this:

```bash
bash scripts/sync-version.sh --check   # verify all versions match
bash scripts/sync-version.sh 0.4.2     # bump all to a new version
```

CI also checks that the default extension ID in `install/install.sh`, `install/install.ps1`, and `installer/src/main.rs` are all identical.

## Architecture: how the pieces connect

**Data flow (content → Discord):**

1. An activity content script (e.g. `src/activities/youtubemusic/index.ts`) runs inside the page. It constructs a `Presence` instance, registers an `UpdateData` handler (called every ~10 s), and calls `presence.setActivity()`.
2. `Presence.setActivity()` sends a `FREEMID_SET_ACTIVITY` message to the background service worker via `chrome.runtime.sendMessage`.
3. The background service worker (`background/index.ts`) receives it and calls `sendToHost({ type: "SET_ACTIVITY", activity })` over the native messaging port.
4. The Rust native host (`native-host/src/main.rs`) receives this on stdin, deserializes it, and calls `DiscordIpc::set_activity()`.
5. The native host talks to Discord's local IPC socket (Unix socket on Linux/macOS, named pipe on Windows).

**Message protocol (extension ↔ native host):**

- Chrome native messaging framing: `u32 LE length | UTF-8 JSON`
- Extension → host: `{ type: "PING" }`, `{ type: "SET_ACTIVITY", activity: {...} }`, `{ type: "CLEAR_ACTIVITY" }`, `{ type: "UPDATE", latestUrl?, releasesBaseUrl? }`
- Host → extension: `{ type: "STATUS", connected: bool, version, selfUpdateSupported, runtimeOs, runtimeArch, binaryPath, error? }`, `{ type: "UPDATE_STATUS", status, version?, error? }`

**Activity injection:** The background service worker listens to `chrome.tabs.onUpdated` and `chrome.tabs.onActivated`. When a tab navigates to a URL matching an entry in `extension/src/activities/registry.ts`, the background injects the corresponding `dist/activities/<id>/index.js` via `chrome.scripting.executeScript`. Each activity is a self-contained IIFE bundle (not code-split with the rest of the extension) — this is why activities are built separately via `scripts/build-activities.mjs` rather than through the main Vite rollup entry points.

**Native host lifecycle:** Chrome spawns the host on first `connectNative()` and kills it when the extension disconnects or Chrome closes. The host has a 45 s idle timeout (resets on each message) as a safety backstop. On Windows, a single-instance named mutex (`Local\FreeMiD.NativeHost`) prevents duplicate host processes during reconnect races.

**Self-update flow:** The popup triggers an update by sending `RUN_HOST_UPDATE` to the background, which forwards `{ type: "UPDATE" }` to the native host. The native host spawns a background thread that downloads and SHA-256-verifies the new binary from GitHub Releases, then atomically replaces itself on disk (Linux/macOS: rename; Windows: stages to `.staged-<pid>.exe` and delegates to `freemid-apply.exe` or a cmd fallback). The extension then reconnects to pick up the new binary.

## Adding a new activity

1. Create `extension/src/activities/<name>/index.ts` — import `Presence` from `../../presence/Presence`, construct with `VITE_DISCORD_CLIENT_ID`, register an `UpdateData` handler, call `presence.setActivity()`.
2. Register the URL match patterns in `extension/src/activities/registry.ts` under `ACTIVITY_REGISTRY`.
3. `npm run build` in `extension/` compiles it to a self-contained IIFE at `dist/activities/<name>/index.js`.

## Local E2E updater testing

```bash
bash ./scripts/local-update-e2e.sh start   # build candidate, serve local feed, rebuild extension with overrides
bash ./scripts/local-update-e2e.sh status
bash ./scripts/local-update-e2e.sh stop
```

See `docs/E2E-UPDATER-TESTING.md` and `docs/NATIVE-HOST-UPDATER-ARCHITECTURE.md` for full details.

## Platform notes

- **Discord Snap** on Linux: not supported — Snap strict confinement isolates the IPC socket.
- **Windows updater**: uses `freemid-apply.exe` (a stable helper binary installed alongside `freemid.exe`) to avoid file-lock races when replacing a running binary. Falls back to a `cmd.exe` loop if the helper is missing.
- **macOS/Linux**: atomic `rename()` replaces the binary in-place; the running process holds the old inode and is unaffected until Chrome reconnects.

## Environment variables (runtime)

These are undocumented dev/debug flags not exposed in normal usage:

| Variable | Effect |
|----------|--------|
| `FREEMID_ALLOW_TMP_IPC=1` | On Linux, also search `$TMPDIR`, `$TMP`, `$TEMP`, and `/tmp` for the Discord IPC socket. Disabled by default because `/tmp` is world-writable (TOCTOU risk). Useful when Discord writes its socket to `/tmp` rather than `$XDG_RUNTIME_DIR`. |
| `FREEMID_UPDATE_LATEST_URL` | Override the GitHub API URL used to fetch the latest release metadata. |
| `FREEMID_UPDATE_RELEASES_BASE` | Override the base URL used to download release artifacts. |
