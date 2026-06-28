import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PresenceInstance = {
  on: ReturnType<typeof vi.fn>;
  setActivity: ReturnType<typeof vi.fn>;
  clearActivity: ReturnType<typeof vi.fn>;
  clearPresenceData: ReturnType<typeof vi.fn>;
  triggerUpdate: ReturnType<typeof vi.fn>;
  scheduleTrigger: ReturnType<typeof vi.fn>;
  freshSignal: ReturnType<typeof vi.fn>;
  watchSelector: ReturnType<typeof vi.fn>;
};

let capturedUpdateHandler: (() => void) | undefined;
let presenceInstance: PresenceInstance;

vi.mock('../../presence/Presence', () => {
  class MockPresence {
    constructor() {
      presenceInstance = this as unknown as PresenceInstance;
    }

    on = vi.fn((event: string, callback: () => void) => {
      if (event === 'UpdateData') capturedUpdateHandler = callback;
    });

    setActivity = vi.fn();
    clearActivity = vi.fn();
    clearPresenceData = vi.fn();
    triggerUpdate = vi.fn();
    scheduleTrigger = vi.fn();
    freshSignal = vi.fn(() => new AbortController().signal);
    watchSelector = vi.fn();
  }

  return { Presence: MockPresence };
});

function setMediaSessionState(
  playbackState?: 'playing' | 'paused',
  metadata?: MediaMetadataInit,
): void {
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: playbackState
      ? {
          playbackState,
          metadata: metadata ? { ...metadata } : undefined,
        }
      : undefined,
  });
}

async function loadModule(): Promise<void> {
  capturedUpdateHandler = undefined;
  await import('./index');
  expect(capturedUpdateHandler).toBeTypeOf('function');
}

describe('TIDAL activity', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    setMediaSessionState();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    setMediaSessionState();
  });

  it('clears presence when no track title is present', async () => {
    await loadModule();

    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalledOnce();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('builds a TIDAL listening payload with timestamps, artwork, and track link', async () => {
    setMediaSessionState('playing');
    document.body.innerHTML = `
      <div data-test="footer-player">
        <div data-test="footer-track-title"><a href="/browse/track/123">Dream Song</a></div>
        <a href="/artist/999">Artist Name</a>
        <a href="/album/555">Album Name</a>
      </div>
      <div data-test="current-time"><time>1:15</time></div>
      <div data-test="duration"><time>4:00</time></div>
      <div data-test="current-media-imagery"><img src="/images/art.jpg"></div>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: expect.any(String),
        name: 'Artist Name',
        type: 2,
        details: 'Dream Song',
        state: 'by Artist Name',
        largeImageKey: `${window.location.origin}/images/art.jpg`,
        largeImageText: 'Album Name',
        largeImageUrl: `${window.location.origin}/browse/track/123`,
        smallImageKey: 'tidal-logo-1024',
        smallImageText: 'TIDAL',
        buttons: [
          {
            label: 'Listen on TIDAL',
            url: `${window.location.origin}/browse/track/123`,
          },
        ],
      }),
    );

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      startTimestamp?: number;
      endTimestamp?: number;
    };
    expect(activity.endTimestamp! - activity.startTimestamp!).toBe(240);
  });

  it('clears after two consecutive paused ticks', async () => {
    setMediaSessionState('playing');
    document.body.innerHTML = `
      <div data-test="footer-player">
        <div data-test="footer-track-title"><a href="/browse/track/123">Dream Song</a></div>
        <a href="/artist/999">Artist Name</a>
      </div>
      <div data-test="current-time"><time>0:15</time></div>
      <div data-test="duration"><time>4:00</time></div>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    setMediaSessionState('paused');
    capturedUpdateHandler?.();
    expect(presenceInstance.clearPresenceData).not.toHaveBeenCalled();

    capturedUpdateHandler?.();
    expect(presenceInstance.clearPresenceData).toHaveBeenCalledOnce();
  });
});
