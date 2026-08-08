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

function setMediaSession(
  playbackState?: MediaSessionPlaybackState,
  metadata?: Partial<MediaMetadata>,
): void {
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: { playbackState, metadata: metadata ? { ...metadata } : undefined },
  });
}

/**
 * SoundCloud concatenates a visually-hidden accessibility label into the same
 * node as the visible value, so the fixtures reproduce that exactly — it is the
 * trap this activity has to survive.
 */
function setPlayerBar({
  permalink = '/artist/track',
  elapsed = 'Current time: 2 seconds0:02',
  duration = 'Duration: 1 minute 4 seconds1:04',
  playing = true,
}: {
  permalink?: string | null;
  elapsed?: string;
  duration?: string;
  playing?: boolean;
} = {}): void {
  document.body.innerHTML = `
    <div class="playControls">
      <button class="playControls__play ${playing ? 'playing' : ''}"
              aria-label="${playing ? 'Pause' : 'Play'} current"></button>
      <div class="playbackTimeline">
        <span class="playbackTimeline__timePassed">${elapsed}</span>
        <span class="playbackTimeline__duration">${duration}</span>
      </div>
      <div class="playbackSoundBadge">
        ${
          permalink === null
            ? ''
            : `<a class="playbackSoundBadge__titleLink" href="${permalink}">Current track: NameName</a>`
        }
      </div>
    </div>`;
}

async function loadModule(): Promise<void> {
  capturedUpdateHandler = undefined;
  await import('./index');
  expect(capturedUpdateHandler).toBeTypeOf('function');
}

describe('SoundCloud activity', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    setMediaSession();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    setMediaSession();
  });

  it('builds a payload from mediaSession and the player-bar clocks', async () => {
    setMediaSession('playing', {
      title: 'palm',
      artist: 'Lucas Gillingham',
      album: '',
      artwork: [
        { src: 'https://i1.sndcdn.com/small.jpg', sizes: '50x50' },
        { src: 'https://i1.sndcdn.com/large.jpg', sizes: '500x500' },
      ],
    } as Partial<MediaMetadata>);
    setPlayerBar({ permalink: '/atriumscrolls/palm' });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Lucas Gillingham',
        type: 2,
        details: 'palm',
        state: 'by Lucas Gillingham',
        largeImageKey: 'https://i1.sndcdn.com/large.jpg',
        largeImageUrl: 'https://soundcloud.com/atriumscrolls/palm',
        smallImageKey: 'soundcloud-logo-1024',
        smallImageText: 'SoundCloud',
        buttons: [
          {
            label: 'Listen on SoundCloud',
            url: 'https://soundcloud.com/atriumscrolls/palm',
          },
        ],
      }),
    );
  });

  it('reads the clock past the accessibility label glued to it', async () => {
    // textContent is "Duration: 1 minute 4 seconds1:04" — a naive trim() would
    // parse nonsense and the progress bar would be wrong or absent.
    setMediaSession('playing', {
      title: 'palm',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({
      elapsed: 'Current time: 2 seconds0:02',
      duration: 'Duration: 1 minute 4 seconds1:04',
    });

    await loadModule();
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      startTimestamp?: number;
      endTimestamp?: number;
    };
    expect(activity.endTimestamp! - activity.startTimestamp!).toBe(64);
  });

  it('handles hour-long clocks', async () => {
    setMediaSession('playing', {
      title: 'Mix',
      artist: 'DJ',
    } as Partial<MediaMetadata>);
    setPlayerBar({
      elapsed: 'Current time: 5 seconds0:05',
      duration: 'Duration: 1 hour 2 minutes 3 seconds1:02:03',
    });

    await loadModule();
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      startTimestamp?: number;
      endTimestamp?: number;
    };
    expect(activity.endTimestamp! - activity.startTimestamp!).toBe(3723);
  });

  it('treats an empty album as absent rather than showing a blank tooltip', async () => {
    setMediaSession('playing', {
      title: 'palm',
      artist: 'Artist',
      album: '',
    } as Partial<MediaMetadata>);
    setPlayerBar();

    await loadModule();
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      largeImageText?: string;
    };
    expect(activity.largeImageText).toBeUndefined();
  });

  it('clears presence data when nothing is playing', async () => {
    setMediaSession('none');
    setPlayerBar({ playing: false });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('falls back to the transport button when playbackState is unset', async () => {
    setMediaSession(undefined, {
      title: 'palm',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({ playing: true });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalled();
  });

  it('clears presence on the pause transition without stopping updates', async () => {
    setMediaSession('playing', {
      title: 'palm',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({ playing: true });

    await loadModule();
    capturedUpdateHandler?.();

    setMediaSession('paused', {
      title: 'palm',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalledTimes(1);
    expect(presenceInstance.clearActivity).not.toHaveBeenCalled();
  });

  it('schedules settle refinements on a track change', async () => {
    setMediaSession('playing', {
      title: 'First',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({ permalink: '/artist/first' });

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.scheduleTrigger.mockClear();

    setMediaSession('playing', {
      title: 'Second',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({ permalink: '/artist/second' });
    capturedUpdateHandler?.();

    expect(presenceInstance.scheduleTrigger).toHaveBeenCalledWith(300, 1000);
  });

  it('still reports when the permalink is missing', async () => {
    // Identity falls back to title/artist so presence survives a badge that has
    // not rendered its link yet.
    setMediaSession('playing', {
      title: 'palm',
      artist: 'Artist',
    } as Partial<MediaMetadata>);
    setPlayerBar({ permalink: null });

    await loadModule();
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      details?: string;
      buttons?: unknown;
    };
    expect(activity.details).toBe('palm');
    expect(activity.buttons).toBeUndefined();
  });

  it('watches the badge for track changes and the button for play state', async () => {
    // Watching the whole control bar would fire every second, because the
    // timeline text ticks; these two targets are the quiet ones.
    await loadModule();

    const targets = presenceInstance.watchSelector.mock.calls.map((c) => c[0]);
    expect(targets).toContain('.playbackSoundBadge');
    expect(targets).toContain('.playControls__play');
    expect(targets).not.toContain('.playControls');
  });
});
