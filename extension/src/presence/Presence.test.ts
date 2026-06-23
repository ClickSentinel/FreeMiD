import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Presence } from './Presence';

type ChromeSendMessage = ReturnType<typeof vi.fn>;

function mockChrome(sendMessage: ChromeSendMessage, withId = true): void {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        id: withId ? 'test-extension' : undefined,
        sendMessage,
      },
    },
  });
}

describe('Presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).__freemid_presence_interval;
  });

  it('maps activity payload fields to the runtime message shape', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const presence = new Presence({ clientId: 'client-123' });
    presence.setActivity({
      name: 'YouTube',
      type: 3,
      details: 'Video title',
      state: 'By Channel',
      startTimestamp: 10,
      endTimestamp: 20,
      largeImageKey: 'large-key',
      largeImageText: 'Large text',
      largeImageUrl: 'https://example.com/video',
      smallImageKey: 'small-key',
      smallImageText: 'Small text',
      smallImageUrl: 'https://example.com/logo',
      buttons: [{ label: 'Open', url: 'https://example.com' }],
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'FREEMID_SET_ACTIVITY',
      data: {
        application_id: 'client-123',
        name: 'YouTube',
        type: 3,
        details: 'Video title',
        state: 'By Channel',
        timestamps: { start: 10, end: 20 },
        assets: {
          large_image: 'large-key',
          large_text: 'Large text',
          large_url: 'https://example.com/video',
          small_image: 'small-key',
          small_text: 'Small text',
          small_url: 'https://example.com/logo',
        },
        buttons: [{ label: 'Open', url: 'https://example.com' }],
      },
    });
  });

  it('does not send activity when the extension context is invalid', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage, false);

    const presence = new Presence({ clientId: 'client-123' });
    presence.setActivity({ details: 'Ignored' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('clears the previous interval when a second instance registers UpdateData', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const first = new Presence({ clientId: 'client-123', updateInterval: 1 });
    first.on('UpdateData', firstCallback);
    expect(firstCallback).toHaveBeenCalledTimes(1);

    const second = new Presence({ clientId: 'client-123', updateInterval: 1 });
    second.on('UpdateData', secondCallback);
    expect(secondCallback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);

    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledTimes(2);
  });

  it('clearActivity stops future update ticks and sends a clear message', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const callback = vi.fn();
    const presence = new Presence({
      clientId: 'client-123',
      updateInterval: 1,
    });

    presence.on('UpdateData', callback);
    expect(callback).toHaveBeenCalledTimes(1);

    presence.clearActivity();
    vi.advanceTimersByTime(1000);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'FREEMID_CLEAR_ACTIVITY',
    });
  });
});
