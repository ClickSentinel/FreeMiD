# Privacy Policy

**Project:** FreeMiD  
**Maintainer:** FreeMiD team  
**Effective date:** 2026-05-30  
**Last updated:** 2026-05-30

---

## Summary

FreeMiD collects **no personal data**. Everything runs locally on your machine.

---

## What data FreeMiD processes

FreeMiD reads the following information **only on your local device** to display your Discord Rich Presence:

| Data | Source | Purpose |
| --- | --- | --- |
| Page title, artist, track name | Browser tab DOM / `mediaSession` API | Build the Rich Presence activity payload |
| Playback timestamps (start / end) | Browser tab DOM / `mediaSession` API | Show a progress bar in Discord |
| Album art URL | YouTube / YouTube Music CDN (already loaded by the page) | Display artwork in Discord |
| Currently active tab URL | Chrome `tabs` API | Detect which service is open |

None of this data is transmitted to FreeMiD, the FreeMiD team, or any third-party server.

---

## What FreeMiD does NOT do

- Does **not** create user accounts or profiles
- Does **not** collect analytics, telemetry, or crash reports
- Does **not** transmit data to any remote server
- Does **not** store any data beyond the current browser session
- Does **not** access browser history beyond the currently active tab
- Does **not** read, store, or transmit Discord credentials or tokens

---

## How data flows locally

```text
Browser tab (YouTube Music, YouTube, Twitch, Netflix)
  └─ Content script reads title / artist / timestamps from the page
       └─ Background service worker receives activity data
            └─ HTTPS POST to Discord API (discord.com) — sets Rich Presence
```

The only outbound network request FreeMiD makes is the Rich Presence update sent directly to Discord's API on your behalf. No data passes through any FreeMiD-operated server. Album art is served directly from YouTube's CDN to Discord using the same URLs the page already loaded — FreeMiD does not proxy or cache these.

---

## Chrome permissions used

| Permission | Why it is needed |
| --- | --- |
| `tabs` | Detect which tab is active and its URL |
| `scripting` | Inject content scripts into supported pages |
| `storage` | Persist user settings (e.g. enabled/disabled services) locally in the browser |
| `identity` | Initiate the Discord OAuth2 login flow to authorise Rich Presence updates |

No permission is used to read data beyond what is described above.

---

## Third-party services

FreeMiD itself operates no servers. When a Rich Presence activity is set, **Discord** receives the activity payload directly via its API. Refer to [Discord's Privacy Policy](https://discord.com/privacy) for how Discord handles activity data.

---

## Children (COPPA)

FreeMiD is not directed at children under the age of 13. FreeMiD collects no personal data from any user, including children. If you believe a child under 13 has used FreeMiD in a way that has resulted in the collection of their personal data, please contact us — though we have no mechanism by which such data could be collected.

---

## Your rights (GDPR / privacy law)

FreeMiD does not collect, store, or process personal data. As a result:

- There is no personal data held about you to access, correct, export, or delete.
- No consent is required because no processing occurs.
- If you have a privacy concern or wish to make a formal request under GDPR, CCPA, or another applicable law, contact us at the address below and we will respond within 30 days.

---

## Changes to this policy

Because FreeMiD collects no data, this policy is unlikely to change materially. Any updates will be reflected in this file with an updated **Last updated** date and noted in the project's changelog. The canonical version of this policy is published at **<https://freemid.ca/privacy>** (placeholder — will be live at launch).

---

## Contact

Privacy enquiries: **<privacy@freemid.ca>** (placeholder — will be live at launch)  
Bug reports and general questions: [github.com/ClickSentinel/FreeMiD/issues](https://github.com/ClickSentinel/FreeMiD/issues)
