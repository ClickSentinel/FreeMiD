import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SNAPSHOT_SETTLE_MS } from '../../constants/timing';

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

  it('clears presence data (not the interval) when no title can be resolved', async () => {
    await loadModule();

    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalledOnce();
    expect(presenceInstance.clearActivity).not.toHaveBeenCalled();
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

  it('prefers the player bar over the URL for the video id', async () => {
    // The URL keeps the id of the page you navigated to; the queue moves on
    // without it. Reading the URL first paired the new title with the previous
    // track's artwork, and — because trackId derives from this — hid the track
    // change from the handler entirely.
    window.history.replaceState({}, '', '/watch?v=staleoldid1');
    setMediaSession('playing', { title: 'Current', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <a href="https://music.youtube.com/watch?v=liveNewId01">Current</a>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        largeImageKey: 'https://i.ytimg.com/vi/liveNewId01/mqdefault.jpg',
        largeImageUrl: 'https://music.youtube.com/watch?v=liveNewId01',
      }),
    );
  });

  it('ignores track-list thumbnails on an album page', async () => {
    // An album page renders a #song-image per row. An unscoped selector picked
    // whichever happened to be first in the DOM, and since those re-render on
    // scroll the id changed every tick — nine spurious track changes in 1.6 s.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'Now Playing', artist: 'Artist Name' });
    document.body.innerHTML = `
      <div id="contents">
        <div id="song-image"><img src="https://i.ytimg.com/vi/otherTrack1/mq.jpg" /></div>
        <div id="song-image"><img src="https://i.ytimg.com/vi/otherTrack2/mq.jpg" /></div>
      </div>
      <ytmusic-player-bar>
        <img id="img" src="https://i.ytimg.com/vi/nowPlaying1/mqdefault.jpg" />
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        largeImageKey: 'https://i.ytimg.com/vi/nowPlaying1/mqdefault.jpg',
      }),
    );
  });

  it('falls back to the URL when the player bar has no link yet', async () => {
    // Initial page load: the bar has not rendered, and the URL is all we have.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'Current', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        largeImageKey: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
      }),
    );
  });

  it('sends immediately without waiting for the album to arrive', async () => {
    // The album is only the artwork tooltip. Withholding the whole payload for
    // it used to delay the title and artist by up to 1.5 s on every skip.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'Track Title', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        details: 'Track Title',
        largeImageText: undefined,
      }),
    );
  });

  it('schedules settle refinements on track change, covering auto-advance', async () => {
    // YouTube Music fires no `play` event between queued tracks, so the track
    // change itself has to arm the refinement passes.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.scheduleTrigger.mockClear();

    window.history.replaceState({}, '', '/watch?v=zyxwvutsrqp');
    setMediaSession('playing', { title: 'Second', artist: 'Artist Name' });
    capturedUpdateHandler?.();

    expect(presenceInstance.scheduleTrigger).toHaveBeenCalledWith(300, 1000);
  });

  it('withholds when the video id moves ahead of the title', async () => {
    // Observed live: the player bar swapped its artwork ~600 ms before
    // mediaSession updated the title, so a snapshot taken in between paired
    // the new track's artwork with the previous track's name.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <img id="img" src="https://i.ytimg.com/vi/firstTrack1/mqdefault.jpg" />
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.setActivity.mockClear();

    // Artwork and duration swap together (both are player-bar DOM);
    // mediaSession has not caught up. Only the identity check can catch this.
    const img = document.querySelector('#img') as HTMLImageElement;
    img.src = 'https://i.ytimg.com/vi/secondTrk01/mqdefault.jpg';
    (document.querySelector('.time-info') as HTMLElement).textContent =
      '0:01 / 1:10';
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('sends once the title catches up with the video id', async () => {
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <img id="img" src="https://i.ytimg.com/vi/firstTrack1/mqdefault.jpg" />
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.setActivity.mockClear();

    const img = document.querySelector('#img') as HTMLImageElement;
    img.src = 'https://i.ytimg.com/vi/secondTrk01/mqdefault.jpg';
    (document.querySelector('.time-info') as HTMLElement).textContent =
      '0:01 / 1:10';
    capturedUpdateHandler?.();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();

    setMediaSession('playing', { title: 'Second', artist: 'Artist Name' });
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        details: 'Second',
        largeImageKey: 'https://i.ytimg.com/vi/secondTrk01/mqdefault.jpg',
      }),
    );
  });

  it("withholds a snapshot still carrying the previous track's duration", async () => {
    // The player bar repaints after the title, so the first snapshot of a new
    // track reads the old duration. Sending it would give Discord a
    // wrong-length progress bar for a full throttle interval.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.setActivity.mockClear();

    // New track, but the bar still shows the previous track's 3:00.
    window.history.replaceState({}, '', '/watch?v=zyxwvutsrqp');
    setMediaSession('playing', { title: 'Second', artist: 'Artist Name' });
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('sends as soon as the player bar repaints', async () => {
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.setActivity.mockClear();

    window.history.replaceState({}, '', '/watch?v=zyxwvutsrqp');
    setMediaSession('playing', { title: 'Second', artist: 'Artist Name' });
    capturedUpdateHandler?.();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();

    // Bar catches up — the refinement tick now carries the right duration.
    const timeInfo = document.querySelector('.time-info') as HTMLElement;
    timeInfo.textContent = '0:02 / 4:43';
    capturedUpdateHandler?.();

    const activity = presenceInstance.setActivity.mock.calls[0]?.[0] as {
      startTimestamp?: number;
      endTimestamp?: number;
    };
    expect(activity.endTimestamp! - activity.startTimestamp!).toBe(283);
  });

  it('sends anyway once the settle window expires, stale bar or not', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/watch?v=abcdefghijk');
      setMediaSession('playing', { title: 'First', artist: 'Artist Name' });
      document.body.innerHTML = `
        <ytmusic-player-bar>
          <div class="time-info">0:10 / 3:00</div>
        </ytmusic-player-bar>
        <video class="video-stream"></video>
      `;

      await loadModule();
      capturedUpdateHandler?.();
      presenceInstance.setActivity.mockClear();

      window.history.replaceState({}, '', '/watch?v=zyxwvutsrqp');
      setMediaSession('playing', { title: 'Second', artist: 'Artist Name' });
      capturedUpdateHandler?.();
      expect(presenceInstance.setActivity).not.toHaveBeenCalled();

      // Never stall presence on a bar that never repaints.
      vi.advanceTimersByTime(SNAPSHOT_SETTLE_MS + 1);
      capturedUpdateHandler?.();
      expect(presenceInstance.setActivity).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a genuinely-equal duration after the window rather than stalling', async () => {
    // Two consecutive tracks can legitimately share a duration, which is
    // indistinguishable from a stale bar. The cost must stay bounded.
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/watch?v=abcdefghijk');
      setMediaSession('playing', { title: 'First', artist: 'A' });
      document.body.innerHTML = `
        <ytmusic-player-bar>
          <div class="time-info">0:10 / 3:00</div>
        </ytmusic-player-bar>
        <video class="video-stream"></video>
      `;

      await loadModule();
      capturedUpdateHandler?.();
      presenceInstance.setActivity.mockClear();

      window.history.replaceState({}, '', '/watch?v=zyxwvutsrqp');
      setMediaSession('playing', { title: 'Second', artist: 'A' });
      capturedUpdateHandler?.();
      expect(presenceInstance.setActivity).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SNAPSHOT_SETTLE_MS + 1);
      capturedUpdateHandler?.();

      expect(presenceInstance.setActivity).toHaveBeenCalledWith(
        expect.objectContaining({ details: 'Second' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not withhold repeat ticks on a settled track', async () => {
    // Once a track is settled its duration equals what we last sent, which
    // must not be mistaken for a bar that has not repainted.
    window.history.replaceState({}, '', '/watch?v=abcdefghijk');
    setMediaSession('playing', { title: 'Track', artist: 'A' });
    document.body.innerHTML = `
      <ytmusic-player-bar>
        <div class="time-info">0:10 / 3:00</div>
      </ytmusic-player-bar>
      <video class="video-stream"></video>
    `;

    await loadModule();
    capturedUpdateHandler?.();
    presenceInstance.setActivity.mockClear();

    capturedUpdateHandler?.();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledTimes(2);
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
