import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PresenceInstance = {
  on: ReturnType<typeof vi.fn>;
  setActivity: ReturnType<typeof vi.fn>;
  clearActivity: ReturnType<typeof vi.fn>;
  clearPresenceData: ReturnType<typeof vi.fn>;
  triggerUpdate: ReturnType<typeof vi.fn>;
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
    freshSignal = vi.fn(() => new AbortController().signal);
    watchSelector = vi.fn();
  }

  return { Presence: MockPresence };
});

function setMediaSession(
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

describe('YouTube Music activity', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    setMediaSession();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    setMediaSession();
  });

  it('clears activity when no title can be resolved', async () => {
    await loadModule();

    capturedUpdateHandler?.();

    expect(presenceInstance.clearActivity).toHaveBeenCalledOnce();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('uses mediaSession metadata and player bar timing to build payload', async () => {
    window.history.replaceState({}, '', '/watch?v=abcdefghijk&list=foo');
    setMediaSession('playing', {
      title: 'Track Title',
      artist: 'Artist Name',
      album: 'Album Name',
    });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">1:30 / 4:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Artist Name',
        type: 2,
        details: 'Track Title',
        state: 'by Artist Name',
        largeImageKey: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
        largeImageText: 'Album Name',
        largeImageUrl: 'https://music.youtube.com/watch?v=abcdefghijk',
        smallImageKey: 'ytmusic-logo-1024',
        smallImageText: 'YouTube Music',
        buttons: [
          {
            label: 'Listen on YT Music',
            url: 'https://music.youtube.com/watch?v=abcdefghijk',
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

  it('clears presence data on pause transition without stopping updates', async () => {
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', {
      title: 'Track Title',
      artist: 'Artist Name',
    });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:45 / 4:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    setMediaSession('paused', {
      title: 'Track Title',
      artist: 'Artist Name',
    });
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalledOnce();
    expect(presenceInstance.clearActivity).not.toHaveBeenCalledTimes(2);
  });
});
