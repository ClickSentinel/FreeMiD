# Timers, Intervals & Latency Budget

Every timer in FreeMiD, what it guards, and how they compose into the
end-to-end latency between "the song changed" and "Discord shows it".

Read this before changing any interval — several of them are load-bearing
against Discord's rate limit or Chrome's MV3 service-worker lifecycle.

---

## 1. Content script (activity) layer

Runs inside the page, one instance per injected tab.

| Timer | Location | Value | Purpose |
| --- | --- | --- | --- |
| `UpdateData` tick | [Presence.ts:115](../extension/src/presence/Presence.ts#L115) | **10 s default** | Regular poll of page state. Overridden to **5 s** by YouTube and Tidal; YouTube Music and Apple Music use the 10 s default. |
| `scheduleTrigger` | [Presence.ts:178-183](../extension/src/presence/Presence.ts#L178-L183) | YTM: `300 ms, 1000 ms`<br>YouTube/Tidal: `300 ms` | Fired on the `play` event to let `mediaSession.metadata` (300 ms) and the player-bar time-info (1000 ms) settle. Cancels any previously scheduled triggers so rapid skips don't interleave. |
| `watchSelector` MutationObserver | [Presence.ts:218-249](../extension/src/presence/Presence.ts#L218-L249) | event-driven | Immediate track-change detection by observing the player-bar title node. |
| `albumPollTimer` | [youtubemusic/index.ts:201](../extension/src/activities/youtubemusic/index.ts#L201) | `50 ms` poll, `1500 ms` hard cutoff | Waits for `mediaSession.metadata.album` to populate. **Blocks `setActivity()` entirely while it runs** (early `return` at line 213). |

### Per-activity event wiring

| Activity | Interval | `play` | `pause` | Other DOM events | Observer target |
| --- | --- | --- | --- | --- | --- |
| youtubemusic | 10 s | `scheduleTrigger(300, 1000)` | immediate | — | player-bar title |
| youtube | 5 s | `scheduleTrigger(300)` | immediate | `loadedmetadata` | title + player bar |
| tidal | 5 s | `scheduleTrigger(300)` | immediate | — | `[data-test="footer-track-title"]` |
| applemusic | 10 s | immediate | immediate | — | `.player-bar` (attributes) |

Note that **YouTube Music is the only activity with no `loadedmetadata`
listener**, and it is one of two on the slower 10 s tick.

### `PlaybackAnchor`

[PlaybackAnchor.ts](../extension/src/utils/PlaybackAnchor.ts) holds no timer of
its own — it converts a scraped position into wall-clock Discord
`start`/`end` timestamps.

- Re-anchors when `trackKey` changes, or when observed position drifts **> 3 s**
  from expected (a seek).
- Shifts the anchor forward by the paused duration on resume.
- `current === undefined` skips the drift check rather than re-anchoring to 0.

---

## 2. Background service worker

| Timer / constant | Value | Purpose |
| --- | --- | --- |
| `DISCORD_MIN_INTERVAL_MS` | `5000 ms` | Minimum gap between `SET_ACTIVITY` calls (4 per 20 s, safely under Discord's ~5 per 20 s limit). Excess updates are coalesced into a single trailing flush. |
| `activityBroadcastTimer` | `1100 ms` | Debounces the **popup** status broadcast on a title change so the 300 ms and 1000 ms triggers collapse into one UI update. Same-track updates broadcast immediately. Does not affect Discord. |
| `freemid-keepalive` alarm | `periodInMinutes: 0.4` → **effectively 30 s** | PINGs the host to keep the port healthy and the worker alive. Chrome clamps periodic alarms to a 30 s floor, so the requested 24 s is not what actually runs. |
| `freemid-update-check` alarm | 2 min delay, then 1440 min | Daily GitHub latest-release check. |
| `freemid-host-version-check` alarm | 30 min | Non-Windows only: quiet reconnect to pick up an externally-installed host binary. |
| `APPLY_VERIFY_INTERVAL_MS` | `1000 ms` | Poll the host version after an update until it matches the target. |
| `APPLY_VERIFY_TIMEOUT_MS` | `130 s` Win / `30 s` other | Give-up deadline for the above. |
| `UPDATE_REQUEST_TIMEOUT_MS` | `12 s` Win / `8 s` other | Host must acknowledge `UPDATE` within this or the flow fails with manual-install guidance. |
| `POST_UPDATE_RECONNECT_DELAY_MS` | `5 s` Win / `150 ms` other | Delay before reconnecting so Chrome respawns the replaced binary. |
| `DISCONNECT_RECONNECT_DELAY_MS` | `5 s` Win / `400 ms` other | Delay before reconnecting after a disconnect during an in-flight update. |
| `RECONNECT_REQUEST_COOLDOWN_MS` | `15 s` Win / `8 s` other | Rate-limits user-initiated reconnects. |
| `settleTimeoutMs` | `12 s` Win / `4 s` other | How long a reconnect attempt may stay "in progress" before being finalized. |
| `manualRetryDelayMs` × `manualMaxAttempts` | `700 ms × 12` Win / `300 ms × 6` other | Reconnect probe schedule (≈8.4 s Win / ≈1.8 s other of total probing). |

### The throttle state machine

`setActivity()` ([background/index.ts:808](../extension/src/background/index.ts#L808)):

1. Reject if `paused`, the site toggle is off, or another source holds
   `presenceHolder`.
2. **Dedup** — if the payload is byte-identical to `lastSentActivityJson`,
   drop it, and cancel any pending flush (the A→B→A case).
3. **Throttle** — if `< 5 s` since `lastActivitySentAt`, stash the payload in
   `pendingActivityPayload` and arm `pendingActivityFlushTimer` for the
   remainder. An already-armed timer is *not* rescheduled; its payload is
   simply replaced, so the flush fires at its originally scheduled time.
4. Otherwise send immediately.

`cancelPendingActivityFlush()` resets `lastActivitySentAt = 0`, so a clear or
lock release opens the throttle window immediately — the first update after a
pause/resume or track release is never throttled.

---

## 3. Popup

| Timer | Value | Purpose |
| --- | --- | --- |
| `uptimeInterval` | `10 s` | Re-renders the "connected for" label. |
| `timelineInterval` | `1 s` | Advances the song progress bar. |
| `reconnectPollTimer` | `700 ms` | Polls status while a manual reconnect is in flight. |
| `RECONNECT_UI_GRACE_MS` | `15 s` | Window during which a disconnect is treated as expected rather than an error. |
| `RECONNECT_BUTTON_COOLDOWN_MS` | `15 s` | Button lockout after a reconnect click. |
| `DISCORD_CHECK_DELAY_MS` | `10 s` (override: `VITE_DISCORD_CHECK_DELAY_MS`) | Delay before revealing the "Discord not found" help panel. |
| `HOST_CHECK_DELAY_MS` | `2 s` | Delay before revealing the "native host not installed" help panel. |

---

## 4. Native host (Rust)

| Timer | Location | Value | Purpose |
| --- | --- | --- | --- |
| `HOST_IDLE_TIMEOUT_MS` | [main.rs:44](../native-host/src/main.rs#L44) | `45 s`, checked on a `10 s` loop | Safety backstop if Chrome leaks the process. Effective exit window is 45–55 s. Reset on every inbound message, so the 30 s keepalive PING holds it open. |
| Discord IPC read/write timeout | [discord_ipc.rs:272-273](../native-host/src/discord_ipc.rs#L272-L273) | `5 s` | Unix socket only. Windows named pipes use Discord's own pipe timeout. |
| SMTC watcher shutdown poll | [smtc.rs:368](../native-host/src/smtc.rs#L368) | `100 ms` | Keeps the COM MTA thread alive; polls the shutdown flag. |
| `wait_for_shutdown` | [smtc.rs:33](../native-host/src/smtc.rs#L33) | `600 ms` | Bounded wait for the watcher thread to leave the MTA before `ExitProcess`. |
| SMTC session-read deadlines | [smtc.rs:70, 318](../native-host/src/smtc.rs#L70) | `5 s` | Bound async WinRT session/property reads. |

The keepalive interaction matters: the host's 45 s idle timeout is sized
against the extension's 30 s keepalive PING. Raising the keepalive period above
45 s would start killing healthy hosts.

---

## 5. End-to-end latency budget: YouTube Music track change

This is the path a "Next" press or an auto-advance takes.

```
track changes in page
      │
      ├─ (a) title MutationObserver fires ......................  ~0 ms
      │      └─ but only if the observed node is still the live one
      │
      ├─ (b) no `play` event on auto-advance ................... scheduleTrigger(300,1000) does NOT run
      │
      └─ (c) otherwise: next UpdateData tick .................. up to 10 000 ms
                    │
                    ▼
      album gate: mediaSession.metadata.album not yet set
      → early return, 50 ms poll until album or cutoff ......... up to  1 500 ms
                    │
                    ▼
      background setActivity()
      → dedup, then 5 s throttle .............................. up to  5 000 ms
                    │
                    ▼
      sendToHost → native host → Discord IPC .................. ~ tens of ms
```

**Best case** (observer alive, album already populated, throttle window open):
well under 100 ms.

**Worst case** (observer detached, album slow, throttle just consumed):
10 000 + 1 500 + 5 000 ≈ **16.5 s**.

And if the MV3 service worker is torn down between the throttle deferral and
the flush, `pendingActivityFlushTimer` dies with it — the queued update is lost
entirely and nothing is sent until the next content-script tick produces a
payload again.

### Why the same skip can be fast once and slow the next time

The variance comes from three independent conditions, not from any single
timer:

1. **Whether the title MutationObserver is still attached.** `watchSelector`
   binds to whichever node matches at injection time and never re-attaches if
   that node is later replaced. Once detached, (a) is gone and every update
   waits for (c).
2. **Where the change lands in the 5 s throttle window.** A skip 4.9 s after
   the last send is nearly free; one 0.1 s after pays almost the full 5 s.
3. **Whether the scraped payload momentarily reverts.** `trackId` prefers
   `videoId` (from the URL, updates immediately) while title/artist/album come
   from `mediaSession` (updates later). During that gap the payload can flip
   back to the previously-sent value, which cancels the pending flush at
   [index.ts:893-900](../extension/src/background/index.ts#L893-L900) and
   restarts the wait on the next tick.

---

## Invariants to preserve when changing these

- `DISCORD_MIN_INTERVAL_MS` must stay ≥ 4 s. Discord rate-limits
  `SET_ACTIVITY` to roughly 5 per 20 s and drops — not queues — the excess.
- The keepalive alarm period must stay below `HOST_IDLE_TIMEOUT_MS` (45 s),
  and cannot go below Chrome's 30 s alarm floor. The usable range is 30–45 s.
- The album cutoff (1500 ms) must stay above the `scheduleTrigger` 1000 ms
  mark, or the gate can reopen after the settle trigger has already fired.
- `PlaybackAnchor`'s 3 s drift threshold must stay above the worst-case
  scrape jitter, or normal playback will re-anchor continuously and Discord's
  progress bar will visibly stutter.
