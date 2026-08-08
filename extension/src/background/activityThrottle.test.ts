import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityThrottle, activitySummary } from './activityThrottle';

const INTERVAL = 5_000;

function makeThrottle(sends: object[] = []) {
  const send = vi.fn((activity: object) => {
    sends.push(activity);
    return { ok: true };
  });
  return { throttle: new ActivityThrottle(send, INTERVAL), send, sends };
}

const track = (title: string) => ({ details: title, state: 'by Someone' });

describe('ActivityThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first payload immediately', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('defers a second payload inside the window and flushes it after', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));
    vi.advanceTimersByTime(1_000);

    throttle.push(track('B'));
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL - 1_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ details: 'B' });
  });

  it('coalesces a burst into one send carrying the newest payload', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    for (const t of ['B', 'C', 'D', 'E']) {
      vi.advanceTimersByTime(200);
      throttle.push(track(t));
    }
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ details: 'E' });
  });

  it('keeps the original deadline when a pending payload is replaced', () => {
    // Rescheduling on each update would let a busy page push the flush out
    // indefinitely, which is how a track change ends up never reaching Discord.
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    vi.advanceTimersByTime(1_000);
    throttle.push(track('B')); // arms the timer for the remaining 4 s

    vi.advanceTimersByTime(3_000);
    throttle.push(track('C')); // replaces the payload, must not re-arm

    vi.advanceTimersByTime(1_000); // 5 s since the send — original deadline
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ details: 'C' });
  });

  it('drops a payload identical to the last one sent', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));
    vi.advanceTimersByTime(INTERVAL);

    throttle.push(track('A'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending flush when the payload reverts to the last sent (A->B->A)', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    vi.advanceTimersByTime(500);
    throttle.push(track('B'));
    expect(throttle.hasPending()).toBe(true);

    vi.advanceTimersByTime(500);
    throttle.push(track('A')); // back to what Discord already shows
    expect(throttle.hasPending()).toBe(false);

    vi.advanceTimersByTime(INTERVAL * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not commit dedup state when the send fails', () => {
    // The regression this guards: recording a payload that never left the
    // extension marks it "already sent", so every identical retry after the
    // port recovers is skipped and presence stays stale until the track changes.
    let healthy = false;
    const send = vi.fn(() =>
      healthy ? { ok: true } : { ok: false, error: 'port closed' },
    );
    const throttle = new ActivityThrottle(send, INTERVAL);

    throttle.push(track('A'));
    expect(send).toHaveBeenCalledTimes(1);

    healthy = true;
    vi.advanceTimersByTime(INTERVAL);
    throttle.push(track('A')); // same payload, must be retried not deduped

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not open the rate-limit window on a failed send', () => {
    // A failed send must not count as a send for timing purposes either.
    const send = vi.fn(() => ({ ok: false, error: 'port closed' }));
    const throttle = new ActivityThrottle(send, INTERVAL);

    throttle.push(track('A'));
    throttle.push(track('B'));

    // Both attempts go straight through: nothing has successfully landed, so
    // there is no interval to respect.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('drops a stale pending payload that matches what was sent meanwhile', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    vi.advanceTimersByTime(1_000);
    throttle.push(track('B'));

    vi.advanceTimersByTime(1_000);
    throttle.push(track('A'));
    throttle.push(track('B')); // re-arms toward B

    vi.advanceTimersByTime(INTERVAL);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ details: 'B' });
  });

  it('reset opens the window so the next update is never throttled', () => {
    // A clear or lock handover must not leave the next track waiting.
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    vi.advanceTimersByTime(100);
    throttle.reset();
    throttle.push(track('B'));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reset clears dedup state so an identical payload sends again', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    throttle.reset();
    throttle.push(track('A'));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reset cancels a pending flush', () => {
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));

    vi.advanceTimersByTime(500);
    throttle.push(track('B'));
    throttle.reset();

    vi.advanceTimersByTime(INTERVAL * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('re-sends an unchanged payload after a reset, as a reconnect requires', () => {
    // Discord loses all presence state when it restarts. The activity a page
    // reports has not changed, so only forgetting what we believe was sent can
    // restore it — otherwise a static payload (a long video, rather than a
    // track that will change in a few minutes) stays suppressed indefinitely.
    const { throttle, send } = makeThrottle();
    throttle.push(track('A'));
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(INTERVAL);
    throttle.push(track('A'));
    expect(
      send,
      'unchanged payload is deduped while connected',
    ).toHaveBeenCalledTimes(1);

    throttle.reset();
    throttle.push(track('A'));
    expect(
      send,
      'the same payload must go out again after a reset',
    ).toHaveBeenCalledTimes(2);
  });

  it('never exceeds the Discord rate limit under sustained pressure', () => {
    // The property the whole class exists for.
    const { throttle, send } = makeThrottle();
    for (let i = 0; i < 400; i += 1) {
      throttle.push(track(`T${i}`));
      vi.advanceTimersByTime(50); // 20 s of updates every 50 ms
    }
    vi.advanceTimersByTime(INTERVAL);

    // 20 s at a 5 s floor allows 4 sends, plus the immediate first one.
    expect(send.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('activitySummary', () => {
  it('reduces a payload to the fields worth reading in a trace', () => {
    expect(
      activitySummary({
        details: 'Song',
        state: 'by Artist',
        timestamps: { start: 1_000, end: 1_250 },
        assets: { large_text: 'Album' },
      }),
    ).toEqual({
      details: 'Song',
      state: 'by Artist',
      album: 'Album',
      dur: 250,
    });
  });

  it('omits the duration when timestamps are incomplete', () => {
    // A start without an end makes Discord render a counting-up game timer
    // rather than a progress bar, so the distinction matters in a trace.
    expect(
      activitySummary({ details: 'Song', timestamps: { start: 1 } }),
    ).toMatchObject({ dur: undefined });
  });
});
