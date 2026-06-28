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
npx biome check src/   # lint + format check (run before PR)
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
- Host → extension: `{ type: "STATUS", connected: bool, version, capabilities: string[], selfUpdateSupported, runtimeOs, runtimeArch, binaryPath, error? }`, `{ type: "UPDATE_STATUS", status, version?, error? }`

**Activity injection:** The background service worker listens to `chrome.tabs.onUpdated` and `chrome.tabs.onActivated`. When a tab navigates to a URL matching an entry in `extension/src/activities/registry.ts`, the background injects the corresponding `dist/activities/<id>/index.js` via `chrome.scripting.executeScript`. Each activity is a self-contained IIFE bundle (not code-split with the rest of the extension) — this is why activities are built separately via `scripts/build-activities.mjs` rather than through the main Vite rollup entry points.

**Native host lifecycle:** Chrome spawns the host on first `connectNative()` and kills it when the extension disconnects or Chrome closes. The host has a 45 s idle timeout (resets on each message) as a safety backstop. On Windows, a single-instance named mutex (`Local\FreeMiD.NativeHost`) prevents duplicate host processes during reconnect races.

**Self-update flow:** Updates are triggered two ways: (1) manually — the popup sends `RUN_HOST_UPDATE` to the background; (2) automatically — `maybeAutoUpdate()` fires after a version check or when presence is released (no song playing), if a newer version is available and no update is already in progress. Both paths call `triggerHostUpdate()`, which sends `{ type: "UPDATE" }` to the native host. The native host spawns a background thread that downloads and SHA-256-verifies the new binary from GitHub Releases, then atomically replaces itself on disk (Linux/macOS: rename; Windows: stages to `.staged-<pid>.exe` and delegates to `freemid-apply.exe` or a cmd fallback). The extension then reconnects to pick up the new binary.

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

See `docs/UPDATER.md` for architecture details and E2E testing procedures.

## Platform notes

- **Discord Snap** on Linux: not supported — Snap strict confinement isolates the IPC socket.
- **Windows updater**: uses `freemid-apply.exe` (a stable helper binary installed alongside `freemid.exe`) to avoid file-lock races when replacing a running binary. Falls back to a `cmd.exe` loop if the helper is missing.
- **macOS/Linux**: atomic `rename()` replaces the binary in-place; the running process holds the old inode and is unaffected until Chrome reconnects.

## Environment variables (runtime)

These are undocumented dev/debug flags not exposed in normal usage:

| Variable | Effect |
| --- | --- |
| `FREEMID_ALLOW_TMP_IPC=1` | On Linux, also search `$TMPDIR`, `$TMP`, `$TEMP`, and `/tmp` for the Discord IPC socket. Disabled by default because `/tmp` is world-writable (TOCTOU risk). Useful when Discord writes its socket to `/tmp` rather than `$XDG_RUNTIME_DIR`. |
| `FREEMID_UPDATE_LATEST_URL` | Override the GitHub API URL used to fetch the latest release metadata. |
| `FREEMID_UPDATE_RELEASES_BASE` | Override the base URL used to download release artifacts. |

<!-- rtk-instructions v2 -->
## RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:

```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)

```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)

```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)

```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)

```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)

```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)

```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)

```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)

```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)

```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands

```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
| ---------- | ---------- | ----------------- |
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->