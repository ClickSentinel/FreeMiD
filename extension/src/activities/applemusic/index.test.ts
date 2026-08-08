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
let constructedWith: Record<string, unknown> | undefined;

vi.mock('../../presence/Presence', () => {
  class MockPresence {
    constructor(config: Record<string, unknown>) {
      constructedWith = config;
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
  playbackState?: 'playing' | 'paused' | 'none',
  metadata?: Partial<MediaMetadata>,
): void {
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: { playbackState, metadata: metadata ? { ...metadata } : undefined },
  });
}

/** Apple renders both buttons always, hiding whichever is not the next action. */
function setTransport(playing: boolean): void {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="player-bar">
       <span class="playback-play__pause" aria-hidden="${playing ? 'false' : 'true'}"></span>
       <span class="playback-play__play" aria-hidden="${playing ? 'true' : 'false'}"></span>
     </div>`,
  );
}

/** The progress times live in an open shadow root, not the light DOM. */
function setProgress(elapsedIso: string, remainingIso: string): void {
  const host = document.createElement('amp-playback-controls-progress');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <span class="time elapsed" datetime="${elapsedIso}"></span>
    <span class="time remaining" datetime="${remainingIso}"></span>
  `;
}

async function loadModule(): Promise<void> {
  capturedUpdateHandler = undefined;
  await import('./index');
  expect(capturedUpdateHandler).toBeTypeOf('function');
}

describe('Apple Music activity', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    constructedWith = undefined;
    setMediaSession();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    setMediaSession();
  });

  it('uses the shared activity cadence rather than its own', async () => {
    // It previously ran at the 10 s default while YouTube and Tidal used 5 s.
    await loadModule();
    expect(constructedWith?.updateIntervalMs).toBeUndefined();
  });

  it('builds a payload from mediaSession and the shadow-root progress times', async () => {
    setMediaSession('playing', {
      title: 'Track Title',
      artist: 'Artist Name',
      album: 'Album Name',
    } as Partial<MediaMetadata>);
    setTransport(true);
    setProgress('PT30S', 'PT3M30S');

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Artist Name',
        type: 2,
        details: 'Track Title',
        state: 'by Artist Name',
        largeImageText: 'Album Name',
        smallImageKey: 'applemusic-logo-1024',
        smallImageText: 'Apple Music',
      }),
    );

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      startTimestamp?: number;
      endTimestamp?: number;
    };
    // 30 s elapsed + 3:30 remaining = a 4 minute track.
    expect(activity.endTimestamp! - activity.startTimestamp!).toBe(240);
  });

  it('clears presence data when no title can be resolved', async () => {
    setMediaSession('playing');
    setTransport(true);

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('reads playback state from the transport buttons, not mediaSession', async () => {
    // Apple's player leaves playbackState at "none" during active playback, so
    // trusting it would clear presence on every track.
    setMediaSession('none', {
      title: 'Track Title',
      artist: 'Artist Name',
    } as Partial<MediaMetadata>);
    setTransport(true);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalled();
  });

  it('tolerates a transient paused reading before clearing', async () => {
    // The DOM signal is a best-effort read of an unfamiliar site's markup, so a
    // single glitchy tick must not drop presence mid-song.
    setMediaSession('none', {
      title: 'Track Title',
      artist: 'Artist Name',
    } as Partial<MediaMetadata>);
    setTransport(false);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    capturedUpdateHandler?.();
    expect(presenceInstance.clearPresenceData).not.toHaveBeenCalled();

    capturedUpdateHandler?.();
    expect(presenceInstance.clearPresenceData).toHaveBeenCalledTimes(1);
  });

  it('clears once while paused rather than on every tick', async () => {
    setMediaSession('none', {
      title: 'Track Title',
      artist: 'Artist Name',
    } as Partial<MediaMetadata>);
    setTransport(false);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    for (let i = 0; i < 6; i += 1) capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalledTimes(1);
  });

  it('resets the paused streak when playback resumes', async () => {
    setMediaSession('none', {
      title: 'Track Title',
      artist: 'Artist Name',
    } as Partial<MediaMetadata>);
    setTransport(false);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    capturedUpdateHandler?.();

    // Resume before the streak completes — the next pause starts over.
    document.body.innerHTML = '';
    setTransport(true);
    setProgress('PT10S', 'PT2M');
    capturedUpdateHandler?.();

    document.body.innerHTML = '';
    setTransport(false);
    setProgress('PT10S', 'PT2M');
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).not.toHaveBeenCalled();
  });

  it('picks the largest artwork by area, not by array order', async () => {
    // The Media Session spec does not guarantee ordering, even though Apple
    // currently supplies entries ascending.
    setMediaSession('playing', {
      title: 'Track Title',
      artist: 'Artist Name',
      artwork: [
        { src: 'https://mzstatic.com/big.jpg', sizes: '512x512' },
        { src: 'https://mzstatic.com/small.jpg', sizes: '96x96' },
      ],
    } as Partial<MediaMetadata>);
    setTransport(true);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        largeImageKey: 'https://mzstatic.com/big.jpg',
      }),
    );
  });

  it('rejects an artwork src that is not a usable URL', async () => {
    // `src` is fully page-controlled and could be any scheme.
    setMediaSession('playing', {
      title: 'Track Title',
      artist: 'Artist Name',
      artwork: [{ src: 'javascript:alert(1)', sizes: '512x512' }],
    } as Partial<MediaMetadata>);
    setTransport(true);
    setProgress('PT10S', 'PT2M');

    await loadModule();
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      largeImageKey?: string;
    };
    expect(activity.largeImageKey).toBeUndefined();
  });

  it('watches the player bar for aria-hidden toggles', async () => {
    // Play/pause is signalled by an attribute mutation, not a text change.
    await loadModule();

    expect(presenceInstance.watchSelector).toHaveBeenCalledWith(
      '.player-bar',
      expect.anything(),
      expect.objectContaining({
        observeAttributes: true,
        attributeFilter: ['aria-hidden'],
      }),
    );
  });
});
