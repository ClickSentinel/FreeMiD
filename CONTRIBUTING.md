# Contributing to FreeMiD

Thanks for helping improve FreeMiD.

## What to contribute

- Bug fixes
- Activity support for more sites
- Documentation improvements
- Build and packaging fixes

## Before you open a PR

1. Build the native host: `cargo build --release`
2. Build the extension: `cd extension && npm run build`
3. Run the extension typecheck: `cd extension && npm run typecheck`
4. Test the relevant site in Chrome with Discord running

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
5. Rebuild the extension and verify the presence in Discord

## Reporting bugs

Please include:

- Your OS and browser
- Discord client type (desktop, Flatpak, etc.)
- The site you were on
- What you expected to see
- What actually happened
- Relevant logs or screenshots if available
