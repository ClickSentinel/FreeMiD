import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: import.meta.env.VITE_DISCORD_CLIENT_ID });

let activeTrackId: string | undefined;
let playbackAnchorStart: number | undefined;
let pausedAtWallClock: number | undefined;
let lastPausedState: boolean | undefined;

function parseClock(text: string): number | undefined {
  const parts = text.trim().split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}

function getPlayerBarTimes(): { current?: number; duration?: number } {
  // Try several selectors — YouTube Music has changed its DOM structure over time.
  const timeNode =
    document.querySelector<HTMLElement>('ytmusic-player-bar .time-info') ??
    document.querySelector<HTMLElement>('#time-info') ??
    document.querySelector<HTMLElement>('ytmusic-player-bar span.time-info') ??
    document.querySelector<HTMLElement>('.ytmusic-player-bar .time-info');
  const raw = timeNode?.textContent?.trim();
  if (!raw) return {};

  const match = raw.match(/([^/]+)\s*\/\s*([^/]+)/);
  if (!match) return {};

  return {
    current: parseClock(match[1] ?? ''),
    duration: parseClock(match[2] ?? ''),
  };
}

/**
 * Extract the YouTube video ID from URL or DOM.
 * Used as fallback when mediaSession artwork isn't a ytimg.com URL.
 */
function getVideoId(): string | undefined {
  // 1. ?v= in the current URL
  const urlId = new URLSearchParams(window.location.search).get('v');
  if (urlId) return urlId;

  // 2. Embedded player title link — always present, always has v= param
  const ytpLink = document.querySelector<HTMLAnchorElement>('a.ytp-title-link');
  if (ytpLink?.href) {
    const id = new URLSearchParams(ytpLink.search).get('v') ??
               ytpLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];
    if (id) return id;
  }

  // 3. href.match on full page URL (covers direct song navigation)
  const urlMatch = document.location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];
  if (urlMatch) return urlMatch;

  // 4. Title link anchor inside player bar
  const titleLink = document.querySelector<HTMLAnchorElement>(
    'ytmusic-player-bar a[href*="watch?v="]'
  );
  if (titleLink) {
    const id = new URLSearchParams(titleLink.search).get('v');
    if (id) return id;
  }

  // 5. ytimg.com thumbnail URL contains the video ID
  const imgs = document.querySelectorAll<HTMLImageElement>(
    '#song-image img, ytmusic-player-bar img#img, ytmusic-player-bar img, ytmusic-player img'
  );
  for (const img of imgs) {
    const src = img.src || img.getAttribute('src') || '';
    const m = src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
    if (m) return m[1];
  }

  return undefined;
}

/** Album art URL. Send full https:// URL — Discord RPC handles proxying. */
function getArtUrl(): string | undefined {
  const id = getVideoId();
  if (id) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  return undefined;
}

/** Returns true if an element exists AND is currently rendered. */
function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const html = el as HTMLElement;
  const rect = html.getBoundingClientRect?.();
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;
  const style = window.getComputedStyle(html);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (Number.parseFloat(style.opacity) === 0) return false;
  return true;
}

/** Returns true if an ad is currently playing in the YouTube Music player. */
function isAdPlaying(): boolean {
  // 1. Primary signal — YouTube's #movie_player gains `ad-showing` and
  //    `ad-interrupting` classes during ads. This is what YouTube's own
  //    player API checks internally and is the most reliable indicator.
  const moviePlayer = document.querySelector('#movie_player');
  if (moviePlayer?.classList.contains('ad-showing') ||
      moviePlayer?.classList.contains('ad-interrupting')) {
    console.warn('[FreeMiD] isAdPlaying: #movie_player.ad-showing');
    return true;
  }

  // 2. Player-bar attribute check — YTM has used several names across versions.
  const playerBar = document.querySelector('ytmusic-player-bar');
  for (const attr of ['has-ad', 'ad-showing', 'ad', 'is-ad']) {
    if (playerBar?.hasAttribute(attr)) {
      console.warn(`[FreeMiD] isAdPlaying: playerBar[${attr}]`);
      return true;
    }
  }

  // 3. Ad-specific DOM elements that must be VISIBLE (these elements often
  //    persist in the DOM after the ad ends, hidden via display/opacity).
  const adSelectors = [
    'ytmusic-ad-instream-companion-slot',
    'ytmusic-ad-badge',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    '.ytp-ad-message-container',
  ];
  for (const sel of adSelectors) {
    const el = document.querySelector(sel);
    if (isVisible(el)) {
      console.warn(`[FreeMiD] isAdPlaying: ${sel} (visible)`);
      return true;
    }
  }

  // 4. mediaSession artwork heuristic — real YTM tracks serve artwork from
  //    YouTube/Google CDNs; instream ads use advertiser CDNs.
  const artwork = navigator.mediaSession?.metadata?.artwork ?? [];
  const ytmDomains = ['ytimg.com', 'googleusercontent.com', 'youtube.com'];
  if (artwork.length > 0 && !artwork.some((a) => ytmDomains.some((d) => a.src.includes(d)))) {
    console.warn('[FreeMiD] isAdPlaying: non-YTM artwork →', artwork.map((a) => a.src));
    return true;
  }

  return false;
}

presence.on('UpdateData', () => {
  // Suppress presence entirely during ads — mediaSession is populated by the
  // ad, not the track, so we cannot trust title/artist at this point.
  if (isAdPlaying()) {
    presence.clearActivity();
    return;
  }

  const ms = navigator.mediaSession;
  const video = document.querySelector<HTMLVideoElement>('.video-stream, video');

  // Prefer mediaSession — YouTube Music keeps it up-to-date reliably
  let title = ms?.metadata?.title?.trim();
  let artist = ms?.metadata?.artist?.trim();

  // DOM fallback
  if (!title) {
    const playerBar = document.querySelector('ytmusic-player-bar');
    title = (
      playerBar?.querySelector<HTMLElement>('.title.ytmusic-player-bar') ??
      playerBar?.querySelector<HTMLElement>('yt-formatted-string.title') ??
      document.querySelector<HTMLElement>('.ytmusic-player-bar .title')
    )?.textContent?.trim();

    artist = (
      playerBar?.querySelector<HTMLElement>('.byline.ytmusic-player-bar') ??
      playerBar?.querySelector<HTMLElement>('yt-formatted-string.byline') ??
      document.querySelector<HTMLElement>('.ytmusic-player-bar .byline')
    )?.textContent?.trim()?.replace(/\s*•.+$/, '').trim();
  }

  // Page title last resort
  if (!title) {
    const parts = document.title.replace(' - YouTube Music', '').split(' - ');
    if (parts.length >= 2) {
      title = parts[0].trim();
      artist = parts.slice(1).join(' - ').trim();
    }
  }

  if (!title) {
    presence.clearActivity();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const playbackState = ms?.playbackState;
  const paused = playbackState
    ? playbackState !== 'playing'
    : (video ? video.paused : true);

  const barTimes = getPlayerBarTimes();

  // YouTube Music is a continuous stream — both video.currentTime and
  // video.duration accumulate across tracks and must never be used.
  // barTimes (scraped from the player bar) is the only reliable source.
  const current = barTimes.current ?? 0;
  const duration = barTimes.duration ?? 0;
  console.debug('[FreeMiD] barTimes:', barTimes, 'video.currentTime:', video?.currentTime?.toFixed(1));

  const artUrl = getArtUrl();
  const videoId = getVideoId();
  const songUrl = videoId
    ? `https://music.youtube.com/watch?v=${videoId}`
    : undefined;

  const trackId = videoId || `${title}::${artist || ''}`;

  let trackJustChanged = false;
  if (trackId !== activeTrackId || playbackAnchorStart === undefined) {
    activeTrackId = trackId;
    pausedAtWallClock = undefined;
    trackJustChanged = true;
    // barTimes.current correctly shows position within the current song for
    // both fresh injection and mid-session track changes, so we anchor directly.
    // The update interval (~10 s) means we detect changes well after barTimes
    // has already updated to the new song's position.
    playbackAnchorStart = now - current;
  }

  if (paused) {
    if (pausedAtWallClock === undefined) {
      pausedAtWallClock = now;
    }
  } else if (playbackAnchorStart !== undefined) {
    if (pausedAtWallClock !== undefined) {
      // Shift anchor forward by pause duration so paused time is excluded.
      playbackAnchorStart += now - pausedAtWallClock;
      pausedAtWallClock = undefined;
    }

    if (!trackJustChanged && barTimes.current !== undefined) {
      const expectedCurrent = now - playbackAnchorStart;
      if (Math.abs(expectedCurrent - current) > 3) {
        // Re-anchor on large drift (seek or stream discontinuity).
        playbackAnchorStart = now - current;
      }
    }
  }

  const timestamps =
    duration > 0 && playbackAnchorStart !== undefined
      ? { start: playbackAnchorStart, end: playbackAnchorStart + duration }
      : undefined;

  // Paused: clear presence once on pause entry, then do nothing until resume.
  // clearPresenceData() sends a Discord clear without stopping the interval,
  // so the anchor math above keeps running and resume restores correctly.
  if (paused) {
    if (lastPausedState === false) {
      presence.clearPresenceData();
    }
    lastPausedState = true;
    return;
  }

  lastPausedState = false;

  presence.setActivity({
    applicationId: import.meta.env.VITE_DISCORD_CLIENT_ID,
    name: artist || 'YT Music',
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : 'YouTube Music',
    startTimestamp: timestamps?.start,
    endTimestamp: timestamps?.end,
    largeImageKey: artUrl,
    largeImageText: ms?.metadata?.album || title,
    largeImageUrl: songUrl,
    buttons: songUrl ? [{ label: 'Listen on YT Music', url: songUrl }] : undefined,
  });
});
