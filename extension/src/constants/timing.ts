/**
 * Single source of truth for every timing constant in the extension.
 *
 * All values are milliseconds unless the name says otherwise. Several of these
 * are load-bearing against external limits (Discord's rate limiter, Chrome's
 * MV3 alarm floor, the native host's idle timeout) — timing.test.ts asserts the
 * relationships between them, so change a value there and the test will tell
 * you what else has to move.
 *
 * See docs/TIMERS.md for the full latency budget and rationale.
 */

// ── Content script (activity) layer ──────────────────────────────────────────

/**
 * How often every activity's UpdateData handler runs.
 *
 * This is a backstop, not the primary update path — track changes are meant to
 * be caught by the player-bar MutationObserver (Presence.watchSelector). It
 * also bounds recovery when the MV3 service worker is torn down mid-throttle:
 * a message from a content script wakes the worker, and because the worker's
 * dedup state does not survive suspension, the next tick always re-sends.
 */
export const ACTIVITY_TICK_MS = 5_000;

/**
 * How long a content script's heartbeat may go unstamped before the background
 * treats it as dead and re-injects.
 *
 * Three ticks: tolerant of a missed tick or a busy page, but short enough that
 * a genuinely dead script is replaced promptly.
 */
export const ACTIVITY_HEARTBEAT_STALE_MS = 3 * ACTIVITY_TICK_MS;

/**
 * Delays after a track change (or `play` event) at which the activity re-reads
 * the page and pushes a refined payload.
 *
 * `mediaSession.metadata` settles ~300 ms in; the player-bar time-info (which
 * carries the track duration) takes closer to 1 s. Both refinements are sent
 * as normal updates — the background coalesces them, so a slow-arriving album
 * name never delays the title and artist.
 */
export const METADATA_SETTLE_DELAYS_MS = [300, 1_000] as const;

/**
 * How long an activity may withhold a snapshot whose scraped fields have not
 * all caught up with a track change.
 *
 * The player bar repaints ~250 ms after the title does, so a snapshot taken the
 * instant the title changes still carries the *previous* track's duration.
 * Sending it gives Discord a progress bar of the wrong length — and because
 * that send consumes the throttle budget, the correction is then stuck behind
 * DISCORD_MIN_INTERVAL_MS, leaving the wrong bar up for a full 5 s.
 *
 * Withholding for a moment is the cheaper error: 250 ms of the previous track
 * is imperceptible, 5 s of a wrong progress bar is not.
 *
 * Only fields that are *wrong* justify this — never merely missing ones. The
 * album name arrives late too, but it is just the artwork tooltip, so it rides
 * along on a later refinement instead of holding the title back.
 *
 * Must stay below the last METADATA_SETTLE_DELAYS_MS entry so a withheld tick
 * is always followed by a scheduled refinement rather than the next full tick.
 */
export const SNAPSHOT_SETTLE_MS = 400;

/**
 * How long a track change may read as not-playing before that counts as a pause.
 *
 * Players report not-playing for a moment while the next track loads. Clearing
 * there tears presence down and rebuilds it, which Discord shows as a flicker
 * rather than a track updating in place.
 *
 * Bounded on both sides. Above the ~335 ms a transition was measured to take,
 * with margin; and below the last METADATA_SETTLE_DELAYS_MS entry, so the
 * refinement that fires after a track change is guaranteed to land outside the
 * window and clear a track that really is paused. Without that lower bound the
 * next check would be a full ACTIVITY_TICK_MS away.
 */
export const TRACK_TRANSITION_HOLD_MS = 600;

// ── Background service worker ────────────────────────────────────────────────

/**
 * Minimum gap between SET_ACTIVITY calls reaching Discord.
 *
 * Discord rate-limits presence updates to roughly 5 per 20 s and *drops* the
 * excess rather than queueing it. 5 s gives us 4 per 20 s with headroom.
 * This is the only rate limiter in the pipeline — activities send freely and
 * the background coalesces.
 */
export const DISCORD_MIN_INTERVAL_MS = 5_000;

/**
 * How long an unchanged payload stays deduped before being sent again.
 *
 * Dedup assumes Discord still shows what we last sent, and nothing tells us
 * when that stops being true: Discord restarting, the host restarting, or
 * another RPC client writing presence for the same application all leave the
 * belief stale with no event to react to. A static payload — a long video
 * rather than a track that will change in a few minutes — then stays
 * suppressed indefinitely.
 *
 * Re-sending on a slow cycle bounds recovery from any of those at one minute.
 * Against Discord's ~5 per 20 s that costs effectively nothing.
 *
 * The bound holds only while an activity is still pushing, since a re-send is
 * triggered by an update rather than by a timer. Nothing reporting means there
 * is no presence to restore, so that is the right scope — but it is not an
 * unconditional guarantee.
 */
export const PRESENCE_RESEND_INTERVAL_MS = 60_000;

/**
 * Debounce before telling the popup that the visible track changed, so the
 * settle refinements above collapse into one UI update instead of three.
 * Purely cosmetic — it never delays what reaches Discord.
 */
export const POPUP_BROADCAST_DEBOUNCE_MS = 1_100;

/**
 * Keepalive PING period, in minutes, as passed to chrome.alarms.create.
 *
 * 0.5 is Chrome's floor for periodic alarms (since Chrome 120; it was 1 minute
 * before that). Requesting less does not fire faster — it is silently clamped —
 * so this is written as the real period rather than an aspirational one.
 */
export const KEEPALIVE_PERIOD_MINUTES = 0.5;
export const KEEPALIVE_PERIOD_MS = KEEPALIVE_PERIOD_MINUTES * 60_000;

/**
 * The native host's idle timeout (native-host/src/main.rs HOST_IDLE_TIMEOUT_MS).
 * Mirrored here so the keepalive period can be checked against it; the test
 * parses the Rust source to make sure this copy has not drifted.
 */
export const HOST_IDLE_TIMEOUT_MS = 45_000;

// ── Update / reconnect flow ──────────────────────────────────────────────────

/**
 * Windows needs consistently longer windows here: the binary swap goes through
 * a helper process (freemid-apply.exe) and Chrome is slower to relaunch the
 * host, so every stage of the update handshake is given more room.
 */
export const UPDATE_TIMING = {
  windows: {
    applyVerifyTimeoutMs: 130_000,
    updateRequestTimeoutMs: 12_000,
    postUpdateReconnectDelayMs: 5_000,
    disconnectReconnectDelayMs: 5_000,
    reconnectRequestCooldownMs: 15_000,
    settleTimeoutMs: 12_000,
    manualRetryDelayMs: 700,
    manualMaxAttempts: 12,
  },
  other: {
    applyVerifyTimeoutMs: 30_000,
    updateRequestTimeoutMs: 8_000,
    postUpdateReconnectDelayMs: 150,
    disconnectReconnectDelayMs: 400,
    reconnectRequestCooldownMs: 8_000,
    settleTimeoutMs: 4_000,
    manualRetryDelayMs: 300,
    manualMaxAttempts: 6,
  },
} as const;

/** How often to re-check the host version while verifying an applied update. */
export const APPLY_VERIFY_INTERVAL_MS = 1_000;

/** Daily GitHub latest-release check. */
export const UPDATE_CHECK_DELAY_MINUTES = 2;
export const UPDATE_CHECK_PERIOD_MINUTES = 1_440;

/** Non-Windows: periodic quiet reconnect to pick up an externally-installed host. */
export const HOST_VERSION_CHECK_PERIOD_MINUTES = 30;

// ── Debug logging ────────────────────────────────────────────────────────────

/**
 * Debounce before persisting the debug ring buffer to chrome.storage.local.
 * Long enough to batch a burst of entries, short enough that a service-worker
 * teardown right after an interesting event still captures it.
 */
export const DEBUG_FLUSH_DEBOUNCE_MS = 1_000;

// ── Popup ────────────────────────────────────────────────────────────────────

/** Re-render of the "connected for" label. */
export const POPUP_UPTIME_TICK_MS = 10_000;
/** Song progress bar advance. */
export const POPUP_TIMELINE_TICK_MS = 1_000;
/** Status poll cadence while a manual reconnect is in flight. */
export const POPUP_RECONNECT_POLL_MS = 700;
/** Window during which a disconnect is treated as expected, not an error. */
export const RECONNECT_UI_GRACE_MS = 15_000;
/** Reconnect button lockout after a click. */
export const RECONNECT_BUTTON_COOLDOWN_MS = 15_000;
/** Delay before revealing the "Discord not found" help panel. */
export const DISCORD_CHECK_DELAY_MS = 10_000;
/** Delay before revealing the "native host not installed" help panel. */
export const HOST_CHECK_DELAY_MS = 2_000;
