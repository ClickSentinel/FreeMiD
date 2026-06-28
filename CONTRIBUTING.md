# Contributing to FreeMiD

Thanks for helping improve FreeMiD.

## What to contribute

- Bug fixes
- Activity support for more sites
- Native host improvements (macOS, Windows IPC)
- Documentation improvements
- Build and packaging fixes

## Before you open a PR

1. Build the native host: `cargo build --release`
2. Build the extension: `cd extension && npm run build`
3. Run the extension typecheck: `cd extension && npm run typecheck`
4. Run the extension tests: `cd extension && npm run test:run`
5. Run the linter: `cd extension && npx biome check src/`
6. Test the relevant site in Chrome with Discord running

## Code style

- Keep changes small and focused
- Match the surrounding style
- Prefer existing patterns over new abstractions
- Do not introduce extra dependencies unless they solve a real problem

## Adding an activity

Activity scripts live in `extension/src/activities/<name>/index.ts`.

1. Create a new folder for the activity
2. Import `Presence` from `../../presence/Presence`
3. Emit `setActivity()` from an `UpdateData` handler
4. Register the URL pattern in `extension/src/activities/registry.ts`
5. Rebuild (`cargo build --release && cd extension && npm run build`) and verify the presence in Discord

## Native host

The native host lives in `native-host/src/`. It is a small synchronous Rust binary (~400 KB stripped) with three source files:

- `main.rs` — Chrome Native Messaging stdin/stdout loop and Discord IPC connection management
- `discord_ipc.rs` — synchronous cross-platform IPC client for Discord's framed protocol
- `update.rs` — self-update logic: GitHub release fetch, SHA-256 verification, and atomic binary replacement

The binary is built by `cargo build --release` from the workspace root.
The `DISCORD_CLIENT_ID` is injected at compile time by `native-host/build.rs`,
which reads it from `extension/.env`.

## Reporting bugs

Please include:

- Your OS and browser
- Discord client type (desktop, Flatpak, etc.)
- The site you were on
- What you expected to see
- What actually happened
- Relevant logs from `chrome://extensions` → FreeMiD → **service worker** → inspect (check the Console)
