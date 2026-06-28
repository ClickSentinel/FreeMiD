# FreeMiD

[![CI](https://github.com/ClickSentinel/FreeMiD/actions/workflows/ci.yml/badge.svg)](https://github.com/ClickSentinel/FreeMiD/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ClickSentinel/FreeMiD)](https://github.com/ClickSentinel/FreeMiD/releases/latest)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/gaonohfjfpdlfapccfaanenfcojfknli)](https://chromewebstore.google.com/detail/freemid/gaonohfjfpdlfapccfaanenfcojfknli)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

A fully free, open-source Discord Rich Presence bridge for web browsing — no subscription, no paywalled features, no telemetry.

---

## Installation

### Default stable path

1. Install extension from Chrome Web Store:
  [FreeMiD on Chrome Web Store](https://chromewebstore.google.com/detail/freemid/gaonohfjfpdlfapccfaanenfcojfknli)
2. Install the native host:

**Linux / macOS:**

```bash
curl -sSL https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.sh | bash
```

**Windows — graphical installer (recommended):**

Download `freemid-setup.exe` from [Releases](https://github.com/ClickSentinel/FreeMiD/releases) and double-click it. It will:

- Stop any running FreeMiD process
- Download and verify the native host binary
- Install to `%LOCALAPPDATA%\FreeMiD\freemid.exe`
- Register the native messaging host for Chrome and Edge

No admin rights required.

**Windows — command line:**

```powershell
# Run in PowerShell (no admin required)
irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.ps1 | iex
```

| Platform | Binary location | Manifest registration |
| --- | --- | --- |
| Linux | `~/.local/bin/freemid` | `~/.config/<browser>/NativeMessagingHosts/` |
| macOS | `~/.local/bin/freemid` | `~/Library/Application Support/<browser>/NativeMessagingHosts/` |
| Windows | `%LOCALAPPDATA%\FreeMiD\freemid.exe` | `HKCU\Software\<browser>\NativeMessagingHosts\` |

1. Reload extension:
  Open `chrome://extensions` and click Reload on FreeMiD.
2. Verify:
  Open YouTube, YouTube Music, or TIDAL, then confirm the FreeMiD toolbar dot is green.

### Local build

1. Build extension and native host from source using [Building from source](#building-from-source).
2. Load `extension/dist` via `chrome://extensions` → **Load unpacked**.
3. Install the native host with your unpacked extension ID:

   **Linux / macOS:**

   ```bash
   ./install/install.sh --extension-id <your-extension-id>
   ```

   **Windows:**

   ```powershell
   .\install\install.ps1 -ExtensionId <your-extension-id>
   ```

4. Reload extension and verify presence updates.

### End-to-end updater testing without a public release

See [docs/UPDATER.md](docs/UPDATER.md) for architecture details and the full dev testing guide.

Quick start:

```bash
./scripts/local-update-e2e.sh start   # build candidate, serve local feed, rebuild extension
./scripts/local-update-e2e.sh status
./scripts/local-update-e2e.sh stop
```

---

## Features

- Live Rich Presence for YouTube Music, YouTube, and TIDAL
- Progress bar for music (start + end timestamps via Discord's Listening activity type)
- Album art pulled from source URLs, with stable Discord asset keys for service icons
- "Listen" buttons linking to the current track when available
- Instant status clear on tab close or navigation away
- No account, no cloud, no telemetry

---

## How it works

FreeMiD has two parts that work together:

```text
YouTube / YouTube Music / TIDAL tab
  └─ Content script (JS, injected by Chrome)
  reads title / artist / timestamps from page metadata (mediaSession and DOM)
         └─ Background service worker (JS, runs in Chrome)
              └─ Native messaging port (Chrome-managed stdin/stdout pipe)
                   └─ freemid native host (Rust binary, ~400 KB)
                        └─ Discord IPC socket (Unix socket on disk)
                             └─ Discord desktop app
```

**Why a native host?** Discord's IPC protocol uses a local Unix socket (`$XDG_RUNTIME_DIR/discord-ipc-0` on Linux, `$TMPDIR/discord-ipc-0` on macOS). Browsers cannot open Unix sockets directly, so a small native binary bridges the gap. Chrome spawns it on demand and kills it when Chrome closes — you never have to manage it yourself.

> **Metadata sources:** YouTube Music primarily uses `navigator.mediaSession`; TIDAL web relies on stable player DOM selectors for title/artist/timestamps; TIDAL desktop (Windows) uses the Windows System Media Transport Controls (SMTC). No external API calls are made for track metadata (title, artist, timestamps) — those come directly from the page. Album art is looked up via MusicBrainz and Cover Art Archive.

### Native host lifecycle (Chrome)

- Chrome starts the native host only when the extension opens a native messaging connection.
- The host stays alive while that connection is open.
- If the extension disconnects, reloads, or its MV3 service worker is suspended, Chrome closes the pipe and the host exits.
- On the next reconnect, Chrome launches the host again automatically.
- When Chrome closes, native host processes it started are also terminated.

---

## Platform support

| Platform | Native host | Status |
| --- | --- | --- |
| Linux (x86_64) | `freemid-linux-x86_64` | ✅ Supported |
| macOS (Apple Silicon) | `freemid-macos-arm64` | ✅ Supported |
| macOS (Intel) | `freemid-macos-x86_64` | ✅ Supported |
| Windows | `freemid-setup.exe` / `freemid-windows-x86_64.exe` / `freemid-apply-windows-x86_64.exe` | ✅ Supported |

### Native host updater notes

Linux/macOS apply updates in-place after checksum verification.

Windows uses a two-process apply model:

1. `freemid.exe` downloads and stages the new host binary.
2. `freemid.exe` launches stable helper `freemid-apply.exe`.
3. Helper replaces installed `%LOCALAPPDATA%\FreeMiD\freemid.exe` and removes staged file.
4. Extension reconnects and verifies host version advancement.

This keeps updates in user context and avoids in-process file lock races.

### Discord install method compatibility

FreeMiD uses Discord's IPC socket for Rich Presence. Compatibility depends on how Discord is installed:

| Discord install | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Native package (`.deb`, `.rpm`, official installer) | ✅ Works | ✅ Works | ✅ Works |
| [Flatpak](https://flathub.org/apps/com.discordapp.Discord) | ✅ Works | N/A | N/A |
| [Snap](https://snapcraft.io/discord) | ❌ Not supported* | N/A | N/A |

\* Discord snap uses strict confinement, which isolates the IPC socket from the host system. The native host cannot access the socket.

---

## Uninstall

### Remove native host

**Linux / macOS:**

```bash
curl -sSL https://github.com/ClickSentinel/FreeMiD/releases/latest/download/uninstall.sh | bash
```

**Windows (recommended):**

Use Apps and Features uninstall for FreeMiD. This runs local Setup uninstall mode.

**Windows (PowerShell fallback):**

```powershell
irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/uninstall.ps1 | iex
```

The uninstall scripts remove:

- Native host binary
- Native messaging manifest
- Browser native messaging registration entries

### Remove extension

Open `chrome://extensions`, find FreeMiD, and click **Remove**.

---

## Building from source

### Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Rust + Cargo | stable | [rustup.rs](https://rustup.rs) |
| Node.js | ≥ 18 | For the extension only |
| Discord desktop | any | Must be running to test |
| Chrome or Chromium | any | Any Chromium-based browser |

### Build

```bash
git clone https://github.com/ClickSentinel/FreeMiD
cd FreeMiD

# 1. Set your Discord Application ID (create one at discord.com/developers/applications)
echo "VITE_DISCORD_CLIENT_ID=your_app_id_here" > extension/.env

# 2. Build the native host
cargo build --release          # output: target/release/freemid

# On Windows, make sure any running freemid-setup.exe is closed before rebuilding,
# otherwise Cargo cannot replace target/release/freemid-setup.exe.

# 3. Build the extension
cd extension && npm install && npm run build && cd ..
# output: extension/dist/

# 4. Install
./install/install.sh --extension-id <your-extension-id>

# 5. Load extension/dist/ as an unpacked extension in chrome://extensions
```

---

## Adding an activity

Activities live in `extension/src/activities/<name>/index.ts`. Each one:

1. Imports `Presence` from `../../presence/Presence`
2. Calls `presence.setActivity(data)` in a `presence.on('UpdateData', …)` handler

```ts
import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: 'YOUR_DISCORD_APP_ID' });

presence.on('UpdateData', () => {
  presence.setActivity({
    details: 'Page title',
    state: 'Some subtitle',
    startTimestamp: Math.floor(Date.now() / 1000),
    largeImageKey: 'https://example.com/art.jpg',
    largeImageText: 'Tooltip',
    buttons: [{ label: 'Open', url: 'https://example.com' }],
  });
});
```

Then register the URL pattern in `extension/src/activities/registry.ts`:

```ts
mysite: {
  id: 'mysite',
  name: 'My Site',
  matches: ['*://mysite.com/*'],
},
```

`npm run build` compiles each activity to a self-contained IIFE bundle in `dist/activities/`.

---

## Activity fields

| Field | Type | Description |
| --- | --- | --- |
| `details` | `string` | First line below the app name (song title, video title, etc.) |
| `state` | `string` | Second line (artist, channel, etc.) |
| `startTimestamp` | `number` | Unix seconds. With `endTimestamp`, Discord renders a progress bar |
| `endTimestamp` | `number` | Unix seconds |
| `largeImageKey` | `string` | Full `https://` URL or Discord-uploaded asset key |
| `largeImageText` | `string` | Tooltip on the large image |
| `smallImageKey` | `string` | Full `https://` URL or Discord-uploaded asset key |
| `smallImageText` | `string` | Tooltip on the small image |
| `buttons` | `{label, url}[]` | Up to 2 buttons (only visible to other users) |
| `applicationId` | `string` | Override the Discord application for this activity |

> **Timestamps:** Both `startTimestamp` and `endTimestamp` must be set to get the graphical progress bar. Setting only `startTimestamp` shows an elapsed counter instead.

---

## Supported services

| Service | Status | Notes |
| --- | --- | --- |
| YouTube Music | ✅ | Title, artist, album art, progress bar, song link button |
| YouTube | ✅ | Video title, channel name |
| TIDAL (web) | ✅ | Track title, artist, album art, progress bar, track link button |
| TIDAL (desktop) | ✅ Windows only | Track title, artist, album art, progress bar — via Windows SMTC; no link button |

---

## Open source

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)

---

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
