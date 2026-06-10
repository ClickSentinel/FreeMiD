# FreeMiD

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
2. Load `extension/dist` via `chrome://extensions` -> **Load unpacked**.
3. Install the native host with your unpacked extension ID:

```bash
./install/install.sh --extension-id <your-extension-id>
```

or on Windows PowerShell:

```powershell
irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.ps1 | iex -ExtensionId <your-extension-id>
```

1. Reload extension and verify presence updates.

### End-to-end updater testing without a public release

Detailed dev guide: `docs/E2E-UPDATER-TESTING.md`

Best/easiest path: run a local update feed and point only your local extension build at it.

Quick start (single command):

bash ./scripts/local-update-e2e.sh start

This command builds the candidate native host, prepares a local release feed, starts a local HTTP server, and rebuilds the extension with updater override URLs.

Useful companion commands:

- bash ./scripts/local-update-e2e.sh status
- bash ./scripts/local-update-e2e.sh stop

1. Build two host binaries.

- baseline (installed): current version (e.g. `0.3.x`)
- candidate (update): newer version (e.g. `0.4.0`)

1. Prepare local feed files.

```bash
mkdir -p /tmp/freemid-feed/v0.4.0
cp target/release/freemid /tmp/freemid-feed/v0.4.0/freemid-linux-x86_64
(cd /tmp/freemid-feed/v0.4.0 && sha256sum freemid-linux-x86_64 > checksums.sha256)
cat > /tmp/freemid-feed/latest.json <<'JSON'
{ "tag_name": "v0.4.0" }
JSON
python3 -m http.server 8787 --directory /tmp/freemid-feed
```

1. Configure extension dev build to use local feed in `extension/.env`.

```bash
VITE_DISCORD_CLIENT_ID=your_app_id_here
VITE_UPDATE_LATEST_URL=http://127.0.0.1:8787/latest.json
VITE_UPDATE_RELEASES_BASE=http://127.0.0.1:8787
VITE_DISCORD_CHECK_DELAY_MS=10000
VITE_WINDOWS_SETUP_URL=http://127.0.0.1:8787/freemid-setup.exe
```

Windows VM quick host option:

```powershell
mkdir C:\freemid-feed -Force
copy .\freemid-setup.exe C:\freemid-feed\freemid-setup.exe
cd C:\freemid-feed
py -m http.server 8787
```

1. Build and load unpacked extension.

```bash
cd extension
npm run build
```

1. Install baseline native host and trigger update from popup.

Notes:

- Production defaults are unchanged; overrides are only used when provided.
- Native host also supports runtime env overrides: `FREEMID_UPDATE_LATEST_URL` and `FREEMID_UPDATE_RELEASES_BASE`.
- Verify full flow: checking -> downloading -> success -> reconnect/apply.
- Failure tests are easy: corrupt `checksums.sha256`, remove artifact file, or stop local server.

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

> **Metadata sources:** YouTube Music primarily uses `navigator.mediaSession`; TIDAL relies on stable player DOM selectors for title/artist/timestamps. No additional API calls are made by the extension for track metadata.

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
| Windows | `freemid-setup.exe` / `freemid-windows-x86_64.exe` | ✅ Supported |

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
| TIDAL | ✅ | Track title, artist, album art, progress bar, track link button |

---

## Open source

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)

---

## License

GPL-3.0 — see [LICENSE](LICENSE).
