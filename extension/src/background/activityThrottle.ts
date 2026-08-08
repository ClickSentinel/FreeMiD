/**
 * Rate limiter for presence updates reaching Discord.
 *
 * This is the only place in the pipeline that defers an update — activities
 * push their best current snapshot and never hold anything back (see
 * docs/TIMERS.md). Extracted from the service worker so the state machine can
 * be exercised directly; the worker's module body has import-time side effects
 * (native port, listeners, alarms) that make it untestable in place.
 */

import { DISCORD_MIN_INTERVAL_MS } from '../constants/timing';
import { debugLog } from '../debug/log';

/** Outcome of handing a payload to the native host. */
export interface SendResult {
  ok: boolean;
  error?: string;
}

export type SendActivity = (activity: object) => SendResult;

/** Compact, JSON-safe view of a payload for the debug log. */
export function activitySummary(activity: object): Record<string, unknown> {
  const a = activity as {
    details?: string;
    state?: string;
    timestamps?: { start?: number; end?: number };
    assets?: { large_text?: string };
  };
  return {
    details: a.details,
    state: a.state,
    album: a.assets?.large_text,
    dur:
      a.timestamps?.start !== undefined && a.timestamps?.end !== undefined
        ? a.timestamps.end - a.timestamps.start
        : undefined,
  };
}

export class ActivityThrottle {
  private lastSentJson: string | null = null;
  private lastSentAt = 0;
  private pendingPayload: object | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: SendActivity,
    private readonly minIntervalMs: number = DISCORD_MIN_INTERVAL_MS,
  ) {}

  /** Offer a payload. It is sent now, coalesced into a pending flush, or dropped. */
  push(activity: object): void {
    const json = JSON.stringify(activity);

    // Nothing changed since the last successful send. If a flush is pending
    // with a different payload and we have just returned to the previously-sent
    // state (A -> B -> A), that flush would deliver stale data — drop it too.
    if (json === this.lastSentJson) {
      debugLog('bg', 'dedup-skip', {
        cancelledPendingFlush: this.pendingTimer !== null,
      });
      this.clearPending();
      return;
    }

    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed < this.minIntervalMs) {
      const inMs = this.minIntervalMs - elapsed;
      this.pendingPayload = activity;
      debugLog('bg', 'throttle-defer', {
        inMs,
        replacedPending: this.pendingTimer !== null,
      });
      // An armed timer keeps its original deadline; only its payload is
      // replaced. Rescheduling on every update would let a busy page push the
      // flush out indefinitely.
      if (this.pendingTimer === null) {
        this.pendingTimer = setTimeout(() => this.flush(), inMs);
      }
      return;
    }

    this.clearPending();
    this.deliver(activity, json);
  }

  /**
   * Forget everything, and open the rate-limit window.
   *
   * Called when presence is cleared or the lock released, so the first update
   * after a pause/resume or a track handover is never throttled.
   */
  reset(): void {
    this.clearPending();
    this.lastSentJson = null;
    this.lastSentAt = 0;
  }

  /** Whether a deferred payload is currently waiting. Exposed for tests. */
  hasPending(): boolean {
    return this.pendingTimer !== null;
  }

  private flush(): void {
    this.pendingTimer = null;
    const activity = this.pendingPayload;
    this.pendingPayload = null;
    if (activity === null) return;

    const json = JSON.stringify(activity);
    if (json === this.lastSentJson) {
      debugLog('bg', 'flush-deduped');
      return;
    }

    debugLog('bg', 'flush');
    this.deliver(activity, json);
  }

  private deliver(activity: object, json: string): void {
    const result = this.send(activity);
    if (!result.ok) {
      // Record nothing. Committing dedup state for a payload that never left
      // the extension would mark it "already sent", so every identical retry
      // after the port recovered would be skipped and presence would stay
      // stale until the track changed.
      debugLog('bg', 'send-failed', { error: result.error });
      return;
    }
    this.lastSentAt = Date.now();
    this.lastSentJson = json;
    debugLog('bg', 'sent', activitySummary(activity));
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingPayload = null;
  }
}
