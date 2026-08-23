import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetDebugForTest,
  DEBUG_MESSAGE_TYPE,
  type DebugEntry,
  debugLog,
  isDebugEnabled,
  setDebugEnabled,
  setDebugSink,
} from './log';

afterEach(() => {
  __resetDebugForTest();
  delete (globalThis as Record<string, unknown>).chrome;
});

function mockChrome(sendMessage: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { runtime: { id: 'test', sendMessage } },
  });
}

describe('debugLog', () => {
  it('does nothing while disabled', () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebugEnabled(false);

    debugLog('bg', 'sent');

    expect(sink).not.toHaveBeenCalled();
    expect(isDebugEnabled()).toBe(false);
  });

  it('delivers to a local sink when one is installed', () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebugEnabled(true);

    debugLog('bg', 'throttle-defer', { inMs: 4200 });

    expect(sink).toHaveBeenCalledTimes(1);
    const entry = sink.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      scope: 'bg',
      event: 'throttle-defer',
      data: { inMs: 4200 },
    });
    expect(typeof entry.t).toBe('number');
  });

  it('omits the data key entirely when no data is given', () => {
    const sink = vi.fn();
    setDebugSink(sink);
    setDebugEnabled(true);

    debugLog('presence', 'tick');

    expect(sink.mock.calls[0]?.[0]).not.toHaveProperty('data');
  });

  it('forwards over runtime messaging when there is no local sink', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);
    setDebugEnabled(true);

    debugLog('ytmusic', 'track-change');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DEBUG_MESSAGE_TYPE,
        entry: expect.objectContaining({
          scope: 'ytmusic',
          event: 'track-change',
        }),
      }),
    );
  });

  it('never throws when the extension context has been invalidated', () => {
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated');
    });
    mockChrome(sendMessage);
    setDebugEnabled(true);

    // A logging call must never be able to break presence.
    expect(() => debugLog('ytmusic', 'track-change')).not.toThrow();
  });

  it('holds entries recorded before the flag resolves, then releases them', () => {
    // Activities wire up observers synchronously at injection, before the
    // storage read settles. Those entries describe the setup we most want to
    // inspect, so they must not be dropped for arriving early.
    const sink = vi.fn();
    setDebugSink(sink);

    debugLog('presence', 'observer-attach');
    expect(sink).not.toHaveBeenCalled();

    setDebugEnabled(true);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      scope: 'presence',
      event: 'observer-attach',
    });
  });

  it('preserves original timestamps when releasing held entries', () => {
    const sink = vi.fn();
    setDebugSink(sink);

    const before = Date.now();
    debugLog('presence', 'observer-attach');
    const after = Date.now();

    setDebugEnabled(true);

    // A released entry must carry when it happened, not when it was released.
    const released = sink.mock.calls[0]?.[0] as DebugEntry;
    expect(released.t).toBeGreaterThanOrEqual(before);
    expect(released.t).toBeLessThanOrEqual(after);
  });

  it('discards held entries when the flag resolves to off', () => {
    const sink = vi.fn();
    setDebugSink(sink);

    debugLog('presence', 'observer-attach');
    setDebugEnabled(false);

    expect(sink).not.toHaveBeenCalled();
  });

  it('bounds the pre-init queue so a context that never resolves cannot leak', () => {
    const sink = vi.fn();
    setDebugSink(sink);

    for (let i = 0; i < 500; i += 1) debugLog('presence', 'tick', { i });
    setDebugEnabled(true);

    expect(sink.mock.calls.length).toBeLessThanOrEqual(50);
    expect(sink.mock.calls.length).toBeGreaterThan(0);
  });

  it('swallows a rejected sendMessage', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('no receiver'));
    mockChrome(sendMessage);
    setDebugEnabled(true);

    expect(() => debugLog('ytmusic', 'track-change')).not.toThrow();
    await Promise.resolve();
  });
});
