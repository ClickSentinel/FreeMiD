# Privacy Policy

**Project:** FreeMiD  
**Maintainer:** FreeMiD team  
**Effective date:** 2026-05-30  
**Last updated:** 2026-06-27

---

## Summary

FreeMiD is designed to avoid collecting personal data and does not operate analytics or telemetry infrastructure.

Most activity processing runs locally on your machine. FreeMiD may still make outbound requests to GitHub endpoints for version checks and update downloads.

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements.

---

## What data FreeMiD processes

### Processed locally only

FreeMiD reads the following information **only on your local device** to display your Discord Rich Presence:

| Data | Source | Purpose |
| --- | --- | --- |
| Page title, artist, track name | Browser tab DOM / `mediaSession` API | Build the Rich Presence activity payload |
| Playback timestamps (start / end) | Browser tab DOM / `mediaSession` API | Show a progress bar in Discord |
| Album art URL | YouTube / YouTube Music CDN (already loaded by the page) | Display artwork in Discord |
| Currently active tab URL | Chrome `tabs` API | Detect which service is open |
| Local extension settings (`paused`, enabled services, cached latest version) | `chrome.storage.local` | Persist user preferences and update UI state |

This data is not sent to FreeMiD-operated servers.

### Sent to external services

When the **Tidal desktop app** is running on Windows and no Tidal browser tab is open, FreeMiD reads the current track from the Windows System Media Transport Controls (SMTC) and sends the following data to external services to resolve album artwork:

| Data | Sent to | Purpose |
| --- | --- | --- |
| Artist name, track title | MusicBrainz API (`musicbrainz.org`) | Identify the album release associated with the track |
| Release group or release ID (returned by MusicBrainz) | Cover Art Archive (`coverartarchive.org`) | Resolve the album art URL via an HTTP HEAD request |

No account identifiers, IP-attributable tokens, or personally identifiable information beyond the artist name and track title are included in these requests. Resolved art URLs are cached in memory for the current session and are not persisted to disk. This artwork lookup only runs on Windows when Tidal desktop is active; it does not occur when using Tidal via a browser tab.

---

## What FreeMiD does NOT do

- Does **not** create user accounts or profiles
- Does **not** collect analytics, telemetry, or crash reports
- Does **not** send browsing activity metadata to FreeMiD-operated servers
- Stores only minimal local extension settings in `chrome.storage.local`
- Does **not** access browser history beyond the currently active tab
- Does **not** read, store, or transmit Discord credentials or tokens

---

## How data flows

**Browser-based services (YouTube, YouTube Music, Tidal web):**

```text
Browser tab
  └─ Content script reads title / artist / timestamps from the page DOM
       └─ Background service worker receives activity data
            └─ Chrome native messaging pipe (stdin/stdout, local only)
                 └─ FreeMiD native host binary
                      └─ Discord IPC socket (local filesystem)
                           └─ Discord desktop app
```

**Tidal desktop app (Windows only):**

```text
Tidal desktop app
  └─ Windows SMTC API (System Media Transport Controls)
       └─ FreeMiD native host binary (event-driven, no polling)
            └─ Chrome native messaging pipe → Background service worker
                 ├─ MusicBrainz API  (artist + title → release ID)
                 │    └─ Cover Art Archive  (release ID → art URL, HEAD only)
                 └─ Chrome native messaging pipe → native host → Discord IPC socket
```

FreeMiD does not send your activity metadata to FreeMiD-operated servers. Outbound network requests that may occur include GitHub release/version checks and downloads, MusicBrainz and Cover Art Archive requests for Tidal desktop artwork (Windows only), and Discord network traffic handled by the Discord desktop app.

---

## Chrome permissions used

| Permission | Why it is needed |
| --- | --- |
| `tabs` | Detect which tab is active and its URL |
| `scripting` | Inject content scripts into supported pages |
| `alarms` | Keep the background service worker alive |
| `nativeMessaging` | Communicate with the local FreeMiD native host binary |
| `notifications` | Show connection state notifications |
| `storage` | Persist local extension settings |

No permission is used to read data beyond what is described above.

---

## Third-party services

FreeMiD itself operates no servers. When a Rich Presence activity is set, **Discord** receives the activity payload directly via its API. Refer to [Discord's Privacy Policy](https://discord.com/privacy) for how Discord handles activity data.

FreeMiD may contact **GitHub** endpoints (for example `api.github.com` and release asset URLs) for update checks and installer/update downloads. Those requests are handled by your browser/OS network stack and are subject to GitHub policies.

FreeMiD's source code is hosted on **GitHub**. GitHub may collect data when you visit the repository or download a release. Refer to [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) and [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) for details.

When the Tidal desktop feature is active (Windows only, no Tidal browser tab open), FreeMiD contacts two additional services to resolve album artwork:

- **MusicBrainz** (`musicbrainz.org`), operated by the MetaBrainz Foundation — receives the artist name and track title as a search query. Refer to the [MetaBrainz Privacy Policy](https://metabrainz.org/privacy) for details.
- **Cover Art Archive** (`coverartarchive.org`), operated by the Internet Archive — receives an HTTP HEAD request for a release ID returned by MusicBrainz; no track metadata is included. Refer to the [Internet Archive Privacy Policy](https://archive.org/about/terms.php) for details.

---

## Children (COPPA)

FreeMiD is not directed at children under the age of 13. FreeMiD collects no personal data from any user, including children. If you believe a child under 13 has used FreeMiD in a way that has resulted in the collection of their personal data, please contact us — though we have no mechanism by which such data could be collected.

---

## Your rights (GDPR / privacy law)

FreeMiD does not intentionally collect personal data for project-operated analytics or profiling. As a result:

- There is no personal data held about you to access, correct, export, or delete.
- No consent is required because no processing occurs.
- If you have a privacy concern or wish to make a formal request under GDPR, CCPA, or another applicable law, contact us at the address below and we will respond within 30 days.

---

## Changes to this policy

Any updates will be reflected in this file with an updated **Last updated** date and noted in the project's changelog.

---

## Contact

Privacy enquiries: **<privacy@freemid.ca>**  
Bug reports and general questions: [github.com/ClickSentinel/FreeMiD/issues](https://github.com/ClickSentinel/FreeMiD/issues)
