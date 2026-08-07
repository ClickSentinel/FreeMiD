import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearDebugSink,
  DEBUG_MESSAGE_TYPE,
  debugLog,
  isDebugEnabled,
  setDebugEnabled,
  setDebugSink,
} from './log';

afterEach(() => {
  setDebugEnabled(false);
  clearDebugSink();
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

  it('swallows a rejected sendMessage', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('no receiver'));
    mockChrome(sendMessage);
    setDebugEnabled(true);

    expect(() => debugLog('ytmusic', 'track-change')).not.toThrow();
    await Promise.resolve();
  });
});
