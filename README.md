# FreeMiD

A fully free, open-source Discord Rich Presence bridge for web browsing — no subscription, no paywalled features, no telemetry.

---

## Features

- Live Rich Presence for YouTube Music and YouTube
- Progress bar for music (start + end timestamps via Discord's Listening activity type)
- Album art pulled directly from YouTube's image CDN — no asset uploads required
- "Listen on YT Music" button linking to the current song
- Instant status clear on tab close or navigation away
- No account, no cloud, no telemetry

---

## How it works

FreeMiD has two parts that work together:

```text
YouTube / YouTube Music tab
  └─ Content script (JS, injected by Chrome)
       reads title / artist / timestamps from mediaSession API
         └─ Background service worker (JS, runs in Chrome)
              └─ Native messaging port (Chrome-managed stdin/stdout pipe)
                   └─ freemid native host (Rust binary, ~400 KB)
                        └─ Discord IPC socket (Unix socket on disk)
                             └─ Discord desktop app
```

**Why a native host?** Discord's IPC protocol uses a local Unix socket (`$XDG_RUNTIME_DIR/discord-ipc-0` on Linux, `$TMPDIR/discord-ipc-0` on macOS). Browsers cannot open Unix sockets directly, so a small native binary bridges the gap. Chrome spawns it on demand and kills it when Chrome closes — you never have to manage it yourself.

> **mediaSession** is a standard browser API (`navigator.mediaSession`) that YouTube and YouTube Music populate with track metadata. The extension reads only what the browser already exposes — it does not scrape the DOM or make additional network requests.

---

## Platform support

| Platform | Native host | Status |
| --- | --- | --- |
| Linux (x86_64) | `freemid-linux-x86_64` | ✅ Supported |
| macOS (Apple Silicon) | `freemid-macos-arm64` | ✅ Supported |
| macOS (Intel) | `freemid-macos-x86_64` | ✅ Supported |
| Windows | — | 🗓 Planned |

---

## Installation

### Step 1 — Load the extension

1. Download `freemid-extension.zip` from [Releases](https://github.com/ClickSentinel/FreeMiD/releases) and unzip it
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the unzipped folder
5. Note the extension ID shown on the card (you'll need it in step 3)

### Step 2 — Install the native host

Download the binary for your platform from [Releases](https://github.com/ClickSentinel/FreeMiD/releases) and put it somewhere accessible, then run the installer:

```bash
# Linux / macOS
chmod +x install.sh
./install.sh --extension-id <your-extension-id>
```

The installer:
- Copies the binary to `~/.local/bin/freemid`
- Writes a Native Messaging manifest to every Chromium-family browser config directory it finds on your machine

> **macOS:** The installer targets `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (and Chromium, Brave, Vivaldi equivalents).

### Step 3 — Restart your browser

Chrome caches native messaging manifests at startup. A full restart (not just extension reload) is required after installation.

### Step 4 — Verify

Click the FreeMiD icon in your toolbar. The dot should turn **green** within a few seconds if Discord desktop is running. Open YouTube or YouTube Music — your status will appear in Discord.

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

---

## Open source

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Privacy Policy](PRIVACY.md)

---

## License

GPL-3.0 — see [LICENSE](LICENSE).
