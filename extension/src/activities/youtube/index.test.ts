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

  return {
    Presence: MockPresence,
  };
});

function setLocation(url: string): void {
  window.history.replaceState({}, '', url);
}

async function loadModule(): Promise<void> {
  capturedUpdateHandler = undefined;
  await import('./index');
  expect(capturedUpdateHandler).toBeTypeOf('function');
}

describe('YouTube activity', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    setLocation('/');
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clears presence outside video pages', async () => {
    await loadModule();

    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('prefers channel icon, preserves canonical video URL, and joins channel names', async () => {
    setLocation('/watch?v=abcdefghijk&list=foo');
    document.title = 'Fallback Title - YouTube';
    document.body.innerHTML = `
      <h1 class="style-scope ytd-video-primary-info-renderer">Rusty Arbor Press - Restoration</h1>
      <div id="channel-name"><a>my mechanics</a></div>
      <ytd-watch-metadata>
        <div id="owner">
          <a href="/another-channel">Rusty Crew</a>
          <div id="avatar">
            <img
              id="img"
              src="https://yt3.googleusercontent.com/ytc/example=s88-c-k-c0x00ffffff-no-rj"
              srcset="https://yt3.googleusercontent.com/ytc/example=s88-c-k-c0x00ffffff-no-rj 1x, https://yt3.googleusercontent.com/ytc/example=s176-c-k-c0x00ffffff-no-rj 2x"
            />
          </div>
        </div>
      </ytd-watch-metadata>
      <video class="html5-main-video"></video>
    `;

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'duration', {
      configurable: true,
      get: () => 180,
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 45,
    });

    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: { playbackState: 'playing' },
    });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'YouTube',
        details: 'Rusty Arbor Press - Restoration',
        state: 'By my mechanics, Rusty Crew',
        largeImageKey:
          'https://yt3.googleusercontent.com/ytc/example=s800-c-k-c0x00ffffff-no-rj',
        largeImageText: 'my mechanics, Rusty Crew',
        largeImageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        smallImageKey: 'youtube-logo-1024',
        smallImageText: 'YouTube',
        buttons: [
          {
            label: 'Watch on YouTube',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
          },
        ],
      }),
    );
  });

  it('clears presence when video is paused', async () => {
    setLocation('/watch?v=abcdefghijk');
    document.title = 'Fallback Title - YouTube';
    document.head.innerHTML =
      '<meta property="og:image" content="https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg">';
    document.body.innerHTML = `
      <h1 class="style-scope ytd-video-primary-info-renderer">Fallback Video</h1>
      <div id="channel-name"><a>Solo Channel</a></div>
      <video class="html5-main-video"></video>
    `;

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(video, 'duration', {
      configurable: true,
      get: () => 0,
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 0,
    });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('treats shorts pages as video pages', async () => {
    setLocation('/shorts/abcdefghijk');
    document.title = 'Short Clip - YouTube';
    document.body.innerHTML = `
      <h1 class="style-scope ytd-video-primary-info-renderer">Short Clip</h1>
      <div id="channel-name"><a>Creator One</a></div>
      <video class="html5-main-video"></video>
    `;

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'duration', {
      configurable: true,
      get: () => 120,
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 12,
    });

    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: { playbackState: 'playing' },
    });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.setActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        details: 'Short Clip',
        state: 'By Creator One',
        largeImageUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        buttons: [
          {
            label: 'Watch on YouTube',
            url: 'https://www.youtube.com/watch?v=abcdefghijk',
          },
        ],
      }),
    );
  });

  it('clears presence when mediaSession says paused even if video element looks playing', async () => {
    setLocation('/watch?v=abcdefghijk');
    document.title = 'Session-Controlled Video - YouTube';
    document.body.innerHTML = `
      <h1 class="style-scope ytd-video-primary-info-renderer">Session-Controlled Video</h1>
      <div id="channel-name"><a>Session Channel</a></div>
      <video class="html5-main-video"></video>
    `;

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'ended', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => 4,
    });
    Object.defineProperty(video, 'duration', {
      configurable: true,
      get: () => 120,
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 12,
    });

    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: { playbackState: 'paused' },
    });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });

  it('uses YouTube play button label fallback when mediaSession is unavailable', async () => {
    setLocation('/watch?v=abcdefghijk');
    document.title = 'Button-Controlled Video - YouTube';
    document.body.innerHTML = `
      <h1 class="style-scope ytd-video-primary-info-renderer">Button-Controlled Video</h1>
      <div id="channel-name"><a>Button Channel</a></div>
      <button class="ytp-play-button" aria-label="Play (k)"></button>
      <video class="html5-main-video"></video>
    `;

    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'ended', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => 0,
    });

    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: undefined,
    });

    await loadModule();
    capturedUpdateHandler?.();

    expect(presenceInstance.clearPresenceData).toHaveBeenCalled();
    expect(presenceInstance.setActivity).not.toHaveBeenCalled();
  });
});
