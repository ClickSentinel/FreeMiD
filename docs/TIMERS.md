# Timers, Intervals & Latency Budget

Every timer in FreeMiD, what it guards, and how they compose into the
end-to-end latency between "the song changed" and "Discord shows it".

**All extension timing values live in
[`extension/src/constants/timing.ts`](../extension/src/constants/timing.ts).**
Nothing else should define one. The relationships between them are asserted in
`timing.test.ts` (and `test/timing-drift.test.ts` for the Rust mirror), so
changing a value there tells you what else has to move.

---

## The one rule

**Only the background service worker defers a presence update.**

Activity content scripts push their best current snapshot as soon as they have
one and never hold anything back waiting for a field to arrive. The background's
throttle is the single rate limiter in the pipeline.

This matters because the two layers run in different JavaScript contexts and
cannot see each other's state. When both deferred, their waits *serialized* — a
1.5 s metadata wait in the content script followed by a 5 s throttle in the
background cost 6.5 s. With deferral owned in one place they overlap, and the
cost is just the throttle.

The one exception is deliberately bounded: an activity may hold a snapshot that
would be *wrong* rather than merely incomplete (see `SNAPSHOT_SETTLE_MS`).
The fields identifying a track update independently and any can move first —
observed live, the video id led the title by ~600 ms in one trace and trailed
it by ~1.4 s in another, while the duration lagged both by ~250 ms — and sending
it does double damage, because the bad send consumes the throttle budget and
strands the correction behind a full interval. Measured on a real trace: 5.0 s
of a wrong-length Discord progress bar, twice in a row.

A *missing* field never justifies withholding. The album name also arrives late,
but it is only the artwork tooltip, so it rides along on a later refinement
instead of holding the title back.

---

## 1. Content script (activity) layer

Runs inside the page, one instance per injected tab.

| Timer | Constant | Value | Purpose |
| --- | --- | --- | --- |
| UpdateData tick | `ACTIVITY_TICK_MS` | `5 s` | Backstop poll — **all four activities**, no overrides. |
| Settle refinements | `METADATA_SETTLE_DELAYS_MS` | `300 ms`, `1000 ms` | Re-read and re-push after a track change or `play`. 300 ms for `mediaSession.metadata`, 1 s for the player-bar duration. |
| Transition hold | `TRACK_TRANSITION_HOLD_MS` | `600 ms` | How long a track change may read as not-playing before that counts as a pause. |
| Snapshot settle | `SNAPSHOT_SETTLE_MS` | `400 ms` | Max time an activity may withhold a snapshot carrying a field that is *wrong*, not merely missing. |
| `watchSelector` observer | — | event-driven | Primary track-change signal. Re-attaches when the observed node is replaced. |
| Liveness heartbeat | `ACTIVITY_HEARTBEAT_STALE_MS` | `15 s` (3 ticks) | Stamped each tick on `globalThis`; the background probes it before re-injecting. |

### Re-injection and the liveness probe

Chrome reports `status: 'complete'` for an SPA's history navigations, not just
document loads — a trace showed 15 injections in six minutes of navigating
YouTube Music. Each one builds a fresh module scope, which resets `lastTrackId`
and the previous-duration bookkeeping, firing a spurious `track-change` and
disabling the stale-snapshot guard for that pass.

Rather than guess which `complete` events replaced the page, the background
probes it: activities stamp `__freemid_last_tick` every tick, and an orphaned
script stops ticking at Presence's context check, so a stale stamp means dead.
A leftover marker from a reloaded extension cannot produce a false positive.
The probe fails toward injecting — a tab without presence is worse than a
redundant injection.

### Per-activity event wiring

| Activity | `play` | `pause` | Other | Observer target |
| --- | --- | --- | --- | --- |
| youtubemusic | settle | immediate | `loadedmetadata` + **on track change** | player-bar title |
| youtube | settle | immediate | `loadedmetadata` | title + player bar |
| tidal | settle | immediate | — | `[data-test="footer-track-title"]` |
| applemusic | immediate | immediate | — | `.player-bar` (attributes) |

YouTube Music arms the settle refinements **from the update handler on track
change**, not only from `play`. Its `<video>` element never pauses between
queued tracks, so auto-advance fires no `play` event at all — without that path,
the only signal would be the observer.

### `watchSelector` re-attachment

The body-level `MutationObserver` runs for the whole life of the activity, not
just until the element first appears. SPAs like YouTube Music re-render the
player bar and replace the observed node; the observer was previously left
watching a detached element and silently stopped reporting track changes,
leaving the 10 s tick as the only update path. That was the main source of
"sometimes it updates instantly, sometimes it takes ages".

The body observer's callback runs on every `childList` mutation in the page, so
it short-circuits on `observed?.isConnected` before doing a selector query.

### `PlaybackAnchor`

[PlaybackAnchor.ts](../extension/src/utils/PlaybackAnchor.ts) holds no timer —
it converts a scraped position into wall-clock Discord `start`/`end` stamps.

- Re-anchors on `trackKey` change, or on **> 3 s** drift from expected (a seek).
- Shifts the anchor forward by the paused duration on resume.
- `current === undefined` skips the drift check rather than re-anchoring to 0.

---

## 2. Background service worker

| Constant | Value | Purpose |
| --- | --- | --- |
| `DISCORD_MIN_INTERVAL_MS` | `5 s` | The only rate limiter. Discord allows ~5 `SET_ACTIVITY` per 20 s and *drops* the excess; 5 s gives 4 per 20 s. |
| `POPUP_BROADCAST_DEBOUNCE_MS` | `1.1 s` | Collapses the settle refinements into one popup update. Cosmetic — never gates Discord. |
| `KEEPALIVE_PERIOD_MINUTES` | `0.5` (= 30 s) | PING to keep the port healthy. Chrome clamps periodic alarms to a 30 s floor, so this is the fastest available. |
| `APPLY_VERIFY_INTERVAL_MS` | `1 s` | Host-version poll while verifying an applied update. |
| `UPDATE_CHECK_*_MINUTES` | 2 delay / 1440 period | Daily GitHub release check. |
| `HOST_VERSION_CHECK_PERIOD_MINUTES` | `30` | Non-Windows quiet reconnect to pick up an externally-installed host. |

`UPDATE_TIMING` holds the per-platform update/reconnect schedule. Windows gets
consistently longer windows at every stage — the binary swap goes through
`freemid-apply.exe` and Chrome is slower to relaunch the host:

| Field | Windows | Other |
| --- | --- | --- |
| `applyVerifyTimeoutMs` | 130 s | 30 s |
| `updateRequestTimeoutMs` | 12 s | 8 s |
| `postUpdateReconnectDelayMs` | 5 s | 150 ms |
| `disconnectReconnectDelayMs` | 5 s | 400 ms |
| `reconnectRequestCooldownMs` | 15 s | 8 s |
| `settleTimeoutMs` | 12 s | 4 s |
| `manualRetryDelayMs` × `manualMaxAttempts` | 700 ms × 12 | 300 ms × 6 |

### The throttle state machine

`setActivity()` in [background/index.ts](../extension/src/background/index.ts):

1. Reject if `paused`, the site toggle is off, or another source holds
   `presenceHolder`.
2. **Dedup** — byte-identical to `lastSentActivityJson` *and* sent within
   `PRESENCE_RESEND_INTERVAL_MS` → drop, and cancel any pending flush (the
   A→B→A case). Past that window the payload is re-sent even unchanged:
   nothing reports that Discord has dropped our presence — it restarts, the
   host restarts, another RPC client writes over the same application — so the
   belief has to expire rather than be trusted indefinitely. A static payload
   (a long video, not a track that changes in minutes) would otherwise stay
   suppressed for as long as it plays. The re-send rides on an update rather
   than a timer, so the one-minute bound holds while an activity is still
   pushing — which is the only time there is presence to restore.
3. **Throttle** — inside the 5 s window → stash in `pendingActivityPayload` and
   arm the flush timer for the remainder. An already-armed timer is *not*
   rescheduled; its payload is replaced, so it fires at its original time.
4. Otherwise send immediately.

Dedup state is committed **only when the send succeeds**. `sendToHost()` returns
false on a broken port; recording the payload anyway would mark something that
never arrived as "already sent", so every identical retry after the port
recovered would be skipped and presence would stay stale until the track
changed.

`cancelPendingActivityFlush()` resets `lastActivitySentAt = 0`, so a clear or
lock release opens the window immediately — the first update after a
pause/resume or track release is never throttled.

### Service-worker teardown

`pendingActivityFlushTimer` is a plain `setTimeout`. It neither keeps an MV3
worker alive nor survives its teardown, so a queued update can be lost if the
worker dies inside the throttle window.

This is recovered rather than prevented. A content script `sendMessage` wakes a
suspended worker, and the restarted worker has `lastSentActivityJson === null`,
so the next tick is never deduped and always sends. `ACTIVITY_TICK_MS` bounds
that recovery at 5 s — equal to the throttle it replaces, which is why
persisting the pending payload to `chrome.storage.session` was not worth the
extra state. In practice the window barely opens: the content script messages
every 5 s, and each one resets the worker's ~30 s idle timer.

---

## 3. Popup

| Constant | Value | Purpose |
| --- | --- | --- |
| `POPUP_UPTIME_TICK_MS` | `10 s` | "Connected for" label. |
| `POPUP_TIMELINE_TICK_MS` | `1 s` | Song progress bar. |
| `POPUP_RECONNECT_POLL_MS` | `700 ms` | Status poll while a manual reconnect is in flight. |
| `RECONNECT_UI_GRACE_MS` | `15 s` | Window where a disconnect is expected, not an error. |
| `RECONNECT_BUTTON_COOLDOWN_MS` | `15 s` | Button lockout. Must be ≥ the background's cooldown or the button re-enables while requests are still rejected. |
| `DISCORD_CHECK_DELAY_MS` | `10 s` | Delay before the "Discord not found" panel. Override: `VITE_DISCORD_CHECK_DELAY_MS`. |
| `HOST_CHECK_DELAY_MS` | `2 s` | Delay before the "native host not installed" panel. |

---

## 4. Native host (Rust)

| Timer | Location | Value | Purpose |
| --- | --- | --- | --- |
| `HOST_IDLE_TIMEOUT_MS` | [main.rs:44](../native-host/src/main.rs#L44) | `45 s`, checked on a `10 s` loop | Backstop if Chrome leaks the process. Effective exit window 45–55 s. Reset by every inbound message, so the 30 s keepalive holds it open. |
| Discord IPC r/w timeout | [discord_ipc.rs:272](../native-host/src/discord_ipc.rs#L272) | `5 s` | Unix socket only; Windows pipes use Discord's own timeout. |
| SMTC shutdown poll | [smtc.rs:368](../native-host/src/smtc.rs#L368) | `100 ms` | Keeps the COM MTA thread alive. |
| `wait_for_shutdown` | [smtc.rs:33](../native-host/src/smtc.rs#L33) | `600 ms` | Bounded wait for the MTA thread before `ExitProcess`. |
| SMTC session reads | [smtc.rs:70, 318](../native-host/src/smtc.rs#L70) | `5 s` | Bound async WinRT property reads. |

`HOST_IDLE_TIMEOUT_MS` is mirrored in `constants/timing.ts` so the keepalive can
be checked against it. `test/timing-drift.test.ts` parses the Rust source and
fails if the two diverge.

---

## 5. End-to-end latency: YouTube Music track change

```text
track changes in page
      │
      ├─ (a) title MutationObserver fires .....................  ~0 ms
      │      re-attaches if the node was replaced
      │
      ├─ (b) track change arms settle refinements ............. 300 ms / 1000 ms
      │      (covers auto-advance, which fires no `play`)
      │
      └─ (c) backstop: next UpdateData tick ..................  ≤ 5 000 ms
                    │
                    ▼
      player bar repainted? (duration vs previous track) ..... ≤   400 ms
                    │
                    ▼
      background setActivity() → dedup → throttle ............ ≤ 5 000 ms
                    │
                    ▼
      native host → Discord IPC .............................. ~tens of ms
```

**Typical** (observer live, throttle window open): well under 100 ms.
**Worst** (observer missed the change, throttle just consumed): ~10.4 s.

The album name is no longer in this path at all. It arrives with the 300 ms
refinement and is coalesced by the throttle; it is only the artwork tooltip, and
withholding the title and artist for it was costing up to 1.5 s on every skip.

### What used to make this variable

Three conditions stacked, and only the third remains:

1. ~~The observer silently detached on SPA re-render~~ — fixed by re-attachment.
2. ~~The album gate blocked the send for up to 1.5 s~~ — removed; the throttle
   already enforces the rate limit, so the gate only added latency.
3. **Where the change lands in the 5 s throttle window.** A skip 4.9 s after the
   last send is nearly free; one 0.1 s after pays almost the full 5 s. This is
   inherent to respecting Discord's rate limit.

---

## Debugging a live trace

Settings → **Debug logging** → enable, then reload any music tab so its content
script picks up the flag. Reproduce, then **Copy log** or **Download**.

Entries from the page, the service worker and the popup land in one ordered
buffer owned by the background, persisted to `chrome.storage.local` so a
service-worker teardown mid-trace does not lose it. Off by default; when
disabled each call site costs one boolean check.

Instrumented today: the background throttle path and the content-script
timer/observer paths. A healthy track change reads roughly:

```text
+0.000s  ytmusic   track-change        {"trackId":"...","album":null}
+0.001s  presence  schedule-trigger    {"delays":[300,1000]}
+0.002s  presence  set-activity        {"details":"New Song","album":null}
+0.003s  bg        recv                {"siteId":"youtubemusic",...}
+0.004s  bg        sent                {"details":"New Song","dur":214}
+0.304s  presence  tick                {"source":"settle:300ms"}
+0.305s  presence  set-activity        {"details":"New Song","album":"The Album"}
+0.306s  bg        throttle-defer      {"inMs":4698,"replacedPending":false}
+5.004s  bg        flush
+5.005s  bg        sent                {"album":"The Album",...}
```

What to look for when a skip felt slow:

| Line | Means |
| --- | --- |
| `observer-attach` | The observed node was present when the activity injected. |
| `observer-attach-late` | It only rendered afterwards; the body watcher picked it up. |
| `observer-reattach` | A live node was swapped out — the SPA re-render that used to kill track detection silently. |
| `tick {"source":"interval"}` as the *first* line of a track change | The observer missed it; the 5 s backstop caught it instead. |
| `throttle-defer` with a large `inMs` | Working as designed — Discord's rate limit, not a bug. |
| `snapshot-withheld` `{reason:"identity"}` | The video id and the title disagree — one moved first. |
| `snapshot-withheld` `{reason:"duration"}` | The player bar had not repainted. Both bounded by `SNAPSHOT_SETTLE_MS`. |
| the same `trackId` under two different titles | The video id is trailing playback — see the source-order note in `getVideoId()`. |
| repeated `inject` / `observer-attach` | The activity script was re-injected; module state resets, so a spurious `track-change` follows. |
| `inject-skipped` | A completed navigation left the existing script alive — the re-injection it would have caused was avoided. |
| `send-failed` | The native messaging port broke. Dedup state is *not* committed, so the retry will go out. |
| `dedup-skip {"cancelledPendingFlush":true}` | An A→B→A payload flip cancelled a queued update. |
| `worker-start` mid-trace | The service worker was torn down and restarted. |

## Invariants

Asserted in `timing.test.ts` — see the test for the authoritative list.

- `DISCORD_MIN_INTERVAL_MS` ≥ 4 s. Discord drops, not queues, the excess.
- Keepalive ≥ Chrome's 30 s alarm floor and < the host's 45 s idle timeout.
- `SNAPSHOT_SETTLE_MS` < the last settle delay < `ACTIVITY_TICK_MS`, so a
  withheld tick is always followed by a scheduled refinement rather than
  waiting for the next full tick.
- `SNAPSHOT_SETTLE_MS` < `DISCORD_MIN_INTERVAL_MS` — the content script's one
  remaining wait must never dominate the background's.
- Windows ≥ other at every `UPDATE_TIMING` stage.
- The popup's reconnect lockout ≥ the background's reconnect cooldown.
- The manual reconnect probe schedule fits inside its settle timeout.
- `PlaybackAnchor`'s 3 s drift threshold stays above worst-case scrape jitter,
  or normal playback re-anchors continuously and the progress bar stutters.
