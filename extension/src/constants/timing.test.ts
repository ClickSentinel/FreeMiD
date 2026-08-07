import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_HEARTBEAT_STALE_MS,
  ACTIVITY_TICK_MS,
  DISCORD_MIN_INTERVAL_MS,
  HOST_IDLE_TIMEOUT_MS,
  KEEPALIVE_PERIOD_MINUTES,
  KEEPALIVE_PERIOD_MS,
  METADATA_SETTLE_DELAYS_MS,
  RECONNECT_BUTTON_COOLDOWN_MS,
  SNAPSHOT_SETTLE_MS,
  UPDATE_TIMING,
} from './timing';

describe('timing invariants', () => {
  it('keeps the Discord throttle above the rate-limit floor', () => {
    // Discord allows ~5 SET_ACTIVITY per 20 s and drops the excess. 4 s would
    // be exactly 5 per 20 s with no headroom; anything less is over the limit.
    expect(DISCORD_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(4_000);
    expect(20_000 / DISCORD_MIN_INTERVAL_MS).toBeLessThanOrEqual(5);
  });

  it('keeps the keepalive period inside the usable window', () => {
    // Below Chrome's alarm floor the extra wakeups simply never happen; above
    // the host's idle timeout, healthy hosts get reaped between PINGs.
    expect(KEEPALIVE_PERIOD_MINUTES).toBeGreaterThanOrEqual(0.5);
    expect(KEEPALIVE_PERIOD_MS).toBeLessThan(HOST_IDLE_TIMEOUT_MS);
  });

  it('lets a withheld snapshot be released by a settle refinement', () => {
    // A snapshot held back for a stale field must be re-pushed by a scheduled
    // refinement rather than waiting for the next full tick.
    const lastSettle = Math.max(...METADATA_SETTLE_DELAYS_MS);
    expect(SNAPSHOT_SETTLE_MS).toBeLessThan(lastSettle);
    expect(lastSettle).toBeLessThan(ACTIVITY_TICK_MS);
  });

  it('bounds worst-case track-change latency by tick + throttle', () => {
    // The snapshot gate must never be the dominant term: it is bounded well
    // under the throttle, so deferral is owned by the background alone.
    expect(SNAPSHOT_SETTLE_MS).toBeLessThan(DISCORD_MIN_INTERVAL_MS);
    expect(ACTIVITY_TICK_MS + DISCORD_MIN_INTERVAL_MS).toBeLessThanOrEqual(
      10_000,
    );
  });

  it('gives a content script room to miss a tick before declaring it dead', () => {
    // Below one tick the probe would call a healthy script dead on every
    // navigation, reintroducing exactly the re-injection churn it prevents.
    expect(ACTIVITY_HEARTBEAT_STALE_MS).toBeGreaterThan(ACTIVITY_TICK_MS * 2);
  });

  it('gives Windows at least as long as other platforms at every update stage', () => {
    const { windows, other } = UPDATE_TIMING;
    for (const key of Object.keys(other) as Array<keyof typeof other>) {
      expect(
        windows[key],
        `UPDATE_TIMING.windows.${key} must be >= other.${key}`,
      ).toBeGreaterThanOrEqual(other[key]);
    }
  });

  it('locks the reconnect button for at least the background cooldown', () => {
    // Otherwise the popup re-enables the button while the background is still
    // rejecting requests, and the click silently does nothing.
    expect(RECONNECT_BUTTON_COOLDOWN_MS).toBeGreaterThanOrEqual(
      UPDATE_TIMING.windows.reconnectRequestCooldownMs,
    );
    expect(RECONNECT_BUTTON_COOLDOWN_MS).toBeGreaterThanOrEqual(
      UPDATE_TIMING.other.reconnectRequestCooldownMs,
    );
  });

  it('allows the manual reconnect probe schedule to cover the settle timeout', () => {
    for (const cfg of [UPDATE_TIMING.windows, UPDATE_TIMING.other]) {
      const probeWindow = cfg.manualRetryDelayMs * cfg.manualMaxAttempts;
      expect(probeWindow).toBeLessThanOrEqual(cfg.settleTimeoutMs);
    }
  });
});
