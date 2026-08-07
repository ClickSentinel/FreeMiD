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

    const first = new Presence({
      clientId: 'client-123',
      updateIntervalMs: 1_000,
    });
    first.on('UpdateData', firstCallback);
    expect(firstCallback).toHaveBeenCalledTimes(1);

    const second = new Presence({
      clientId: 'client-123',
      updateIntervalMs: 1_000,
    });
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
      updateIntervalMs: 1_000,
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

describe('Presence.scheduleTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).__freemid_presence_interval;
    delete (globalThis as Record<string, unknown>).__freemid_events_abort;
  });

  it('fires triggerUpdate after the given delay', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    callback.mockClear();

    presence.scheduleTrigger(200);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('fires once per delay when called with multiple delays', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    callback.mockClear();

    presence.scheduleTrigger(300, 1000);
    vi.advanceTimersByTime(300);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(700);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('cancels pending timers when called again before they fire', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    callback.mockClear();

    // First play event — timers at 300 ms and 1000 ms
    presence.scheduleTrigger(300, 1000);

    // Second play event at 100 ms — should cancel the first pair
    vi.advanceTimersByTime(100);
    presence.scheduleTrigger(300, 1000);

    // Advance to 400 ms (100 + 300): only the second 300 ms timer fires
    vi.advanceTimersByTime(300);
    expect(callback).toHaveBeenCalledTimes(1);

    // Advance to 1100 ms (100 + 1000): only the second 1000 ms timer fires
    vi.advanceTimersByTime(700);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('freshSignal cancels any pending scheduleTrigger timers', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockChrome(sendMessage);

    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    callback.mockClear();

    presence.scheduleTrigger(300);
    // Re-injection: freshSignal should cancel the pending timer
    presence.freshSignal();

    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('Presence.watchSelector', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    document.body.innerHTML = '';
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).__freemid_presence_interval;
    delete (globalThis as Record<string, unknown>).__freemid_events_abort;
  });

  function setup(): { presence: Presence; callback: ReturnType<typeof vi.fn> } {
    mockChrome(vi.fn().mockResolvedValue(undefined));
    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    presence.watchSelector('.title', presence.freshSignal());
    callback.mockClear();
    return { presence, callback };
  }

  it('reports mutations on a node present at attach time', async () => {
    document.body.innerHTML =
      '<div id="bar"><span class="title">A</span></div>';
    const { presence, callback } = setup();

    (document.querySelector('.title') as HTMLElement).textContent = 'B';
    await flush();

    expect(callback).toHaveBeenCalled();
    presence.clearActivity();
  });

  it('re-attaches when the observed node is replaced by an SPA re-render', async () => {
    document.body.innerHTML =
      '<div id="bar"><span class="title">A</span></div>';
    const { presence, callback } = setup();

    // YouTube Music rebuilds the player bar: the observed node is discarded
    // and a fresh one takes its place.
    (document.getElementById('bar') as HTMLElement).innerHTML =
      '<span class="title">B</span>';
    await flush();
    expect(callback).toHaveBeenCalled();
    callback.mockClear();

    // The replacement must now be the observed node — without re-attachment
    // this mutation goes unreported and presence stalls until the next tick.
    (document.querySelector('.title') as HTMLElement).textContent = 'C';
    await flush();
    expect(callback).toHaveBeenCalled();
    presence.clearActivity();
  });

  it('attaches to a node that only appears after the activity loads', async () => {
    document.body.innerHTML = '<div id="bar"></div>';
    const { presence, callback } = setup();

    (document.getElementById('bar') as HTMLElement).innerHTML =
      '<span class="title">A</span>';
    await flush();
    callback.mockClear();

    (document.querySelector('.title') as HTMLElement).textContent = 'B';
    await flush();
    expect(callback).toHaveBeenCalled();
    presence.clearActivity();
  });

  it('stops observing once the signal is aborted', async () => {
    document.body.innerHTML =
      '<div id="bar"><span class="title">A</span></div>';
    mockChrome(vi.fn().mockResolvedValue(undefined));
    const presence = new Presence({
      clientId: 'test',
      updateIntervalMs: 60_000,
    });
    const callback = vi.fn();
    presence.on('UpdateData', callback);
    presence.watchSelector('.title', presence.freshSignal());
    callback.mockClear();

    // Re-injection aborts the previous signal.
    presence.freshSignal();

    (document.getElementById('bar') as HTMLElement).innerHTML =
      '<span class="title">B</span>';
    await flush();
    (document.querySelector('.title') as HTMLElement).textContent = 'C';
    await flush();

    expect(callback).not.toHaveBeenCalled();
    presence.clearActivity();
  });
});

describe('Presence.freshSignal', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__freemid_events_abort;
  });

  it('returns a signal that is not yet aborted', () => {
    const presence = new Presence({ clientId: 'client-123' });
    const signal = presence.freshSignal();
    expect(signal.aborted).toBe(false);
  });

  it('aborts the previous signal when called again', () => {
    const presence = new Presence({ clientId: 'client-123' });
    const first = presence.freshSignal();
    presence.freshSignal();
    expect(first.aborted).toBe(true);
  });

  it('the new signal returned by the second call is not aborted', () => {
    const presence = new Presence({ clientId: 'client-123' });
    presence.freshSignal();
    const second = presence.freshSignal();
    expect(second.aborted).toBe(false);
  });

  it('aborts a signal stored by a different Presence instance (shared globalThis key)', () => {
    const first = new Presence({ clientId: 'client-123' });
    const second = new Presence({ clientId: 'client-456' });
    const signal = first.freshSignal();
    second.freshSignal();
    expect(signal.aborted).toBe(true);
  });
});
