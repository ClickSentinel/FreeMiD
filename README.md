# FreeMiD

A fully free, open-source Discord Rich Presence bridge for web browsing — no subscription, no paywalled features.

---

## Features

- Live Rich Presence for YouTube Music and YouTube
- Graphical progress bar for music (start + end timestamps via Discord's Listening activity type)
- Album art pulled directly from YouTube's image CDN — no asset uploads required
- "Listen on YT Music" button linking to the current song
- Instant status clear on tab close or navigation away
- No account, no cloud, no telemetry

---

## Architecture

```text
Browser Extension (Chrome MV3)
  └─ Content script injected per matching tab
       └─ Reads title / artist / timestamps via the browser's mediaSession API
            └─ Background service worker relays activity to Discord's API
```

> **mediaSession** is a standard browser API (`navigator.mediaSession`) that YouTube and YouTube Music populate with track metadata. The extension reads only what the browser already exposes — it does not scrape the DOM or make any additional network requests.

---

## Installation

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Discord desktop client | Must be running. |
| Chrome or Chromium | Any Chromium-based browser works. |
| Node.js ≥ 18 | Only needed if building from source. |

### Load the extension

1. Download the latest `freemid-extension.zip` from [Releases](https://github.com/ClickSentinel/FreeMiD/releases)
2. Unzip it
3. Open `chrome://extensions`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select the unzipped folder

---

## Building from source

```bash
git clone https://github.com/ClickSentinel/FreeMiD
cd FreeMiD/extension
cp .env.example .env          # then fill in your Discord Application ID
npm install
npm run build
# Output: extension/dist/
```

---

## Adding an activity

Activities live in `extension/src/activities/<name>/index.ts`. Each file:

1. Imports and instantiates `Presence` from `../../presence/Presence`
2. Registers an `UpdateData` handler via `presence.on('UpdateData', () => { ... })`
3. Calls `presence.setActivity(data)` or `presence.clearActivity()` each tick

```ts
import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: 'YOUR_DISCORD_APP_ID' });

presence.on('UpdateData', () => {
  presence.setActivity({
    name: 'My Site',
    type: 2,             // 0=Playing  2=Listening  3=Watching
    details: 'Page title',
    state: 'Some state',
    startTimestamp: Math.floor(Date.now() / 1000),
    largeImageKey: 'https://example.com/art.jpg',
    largeImageText: 'Tooltip text',
  });
});
```

Then register the URL pattern in `extension/src/activities/registry.ts`:

```ts
mysite: {
  id: 'mysite',
  matches: ['*://mysite.com/*'],
  script: 'activities/mysite/index.js',
},
```

The build step (`npm run build`) compiles each activity to a self-contained IIFE bundle in `dist/activities/`.

---

## PresenceData fields

| Field | Type | Description |
| --- | --- | --- |
| `applicationId` | `string` | Discord App ID. Defaults to the `clientId` passed to `Presence`. |
| `name` | `string` | Overrides the "Listening to **X**" label. |
| `type` | `0\|2\|3\|5` | Activity type: Playing / Listening / Watching / Competing. |
| `details` | `string` | First line below the app name (song title, video title, etc.). |
| `state` | `string` | Second line (artist, channel name, etc.). |
| `startTimestamp` | `number` | Unix seconds. With `endTimestamp` set, Discord renders a graphical progress bar. |
| `endTimestamp` | `number` | Unix seconds. |
| `largeImageKey` | `string` | Full `https://` URL or uploaded asset key. |
| `largeImageText` | `string` | Tooltip on the large image. |
| `largeImageUrl` | `string` | URL opened when clicking the large image. |
| `smallImageKey` | `string` | Full `https://` URL or uploaded asset key. |
| `smallImageText` | `string` | Tooltip on the small image. |
| `smallImageUrl` | `string` | URL opened when clicking the small image. |
| `buttons` | `{label, url}[]` | Up to 2 buttons. Only visible to other users. |

> **Note:** Discord timestamps use Unix **seconds**, not milliseconds. Both `startTimestamp` and `endTimestamp` must be set to get the graphical progress bar — setting only `startTimestamp` shows an elapsed text counter instead.

---

## Supported services

| Service | Status | Notes |
| --- | --- | --- |
| YouTube Music | ✅ | Title, artist, album, art, progress bar, song link |
| YouTube | ✅ | Video title, channel |
| Twitch | ✅ | Stream title, game |
| Netflix | ✅ | Show/movie title |

---

## Open Source

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

---

## License

GPL-3.0 — see [LICENSE](LICENSE).
