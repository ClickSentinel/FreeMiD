import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: 'FREEMID_CLIENT_ID' });

let activeTrackId: string | undefined;
let playbackAnchorStart: number | undefined;
let pausedAtWallClock: number | undefined;
let lastPausedState: boolean | undefined;
// Set to the epoch-second timestamp of a mid-session track change.
// Drift correction is suppressed for DRIFT_GRACE_SECONDS after a change
// so we don't re-anchor with the previous song's stale currentTime.
let trackChangedAt: number | undefined;
const DRIFT_GRACE_SECONDS = 3;

function parseClock(text: string): number | undefined {
  const parts = text.trim().split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}

function getPlayerBarTimes(): { current?: number; duration?: number } {
  const timeNode = document.querySelector<HTMLElement>('ytmusic-player-bar .time-info');
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

presence.on('UpdateData', () => {
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
  const videoDuration = video ? video.duration : NaN;
  const videoCurrent = video ? Math.floor(video.currentTime) : 0;

  const current = Number.isFinite(videoCurrent) && videoCurrent >= 0
    ? videoCurrent
    : (barTimes.current ?? 0);

  const artUrl = getArtUrl();
  const videoId = getVideoId();
  const songUrl = videoId
    ? `https://music.youtube.com/watch?v=${videoId}`
    : undefined;

  const trackId = videoId || `${title}::${artist || ''}`;

  let trackJustChanged = false;
  if (trackId !== activeTrackId) {
    const isFirstInjection = activeTrackId === undefined;
    activeTrackId = trackId;
    pausedAtWallClock = undefined;
    trackJustChanged = true;

    if (isFirstInjection) {
      // Fresh script injection (initial load or extension reload):
      // video.currentTime is accurate — anchor directly so Discord shows
      // the correct elapsed time immediately.
      playbackAnchorStart = now - current;
      trackChangedAt = undefined;
    } else {
      // Track changed mid-session: video.currentTime may still reflect the
      // previous song's final position (mediaSession updates before the
      // video element resets). Anchor at 'now' (assume new track starts at 0)
      // and suppress drift correction for a few seconds to let currentTime
      // settle, then the drift check will re-anchor to the true position.
      playbackAnchorStart = now;
      trackChangedAt = now;
    }
  } else if (playbackAnchorStart === undefined) {
    playbackAnchorStart = now - current;
    trackChangedAt = undefined;
  }

  // On a track change, only trust video.duration — barTimes still shows the
  // previous song's total until the DOM updates. If video.duration isn't ready
  // yet (NaN/Infinity) we use 0 so we skip timestamps for this one tick rather
  // than displaying the old song's wrong total.
  const duration = (() => {
    if (Number.isFinite(videoDuration) && videoDuration > 0) return Math.floor(videoDuration);
    if (trackJustChanged) return 0; // barTimes may be stale — skip timestamps this tick
    return barTimes.duration ?? 0;
  })();

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

    // Suppress drift correction for a few seconds after a mid-session track
    // change so stale currentTime can't corrupt the new anchor. After the
    // grace period, drift correction re-anchors as normal (handles seeks too).
    const inGracePeriod =
      trackChangedAt !== undefined && now - trackChangedAt < DRIFT_GRACE_SECONDS;
    if (!inGracePeriod) {
      if (trackChangedAt !== undefined) trackChangedAt = undefined;
      const expectedCurrent = now - playbackAnchorStart;
      if (Math.abs(expectedCurrent - current) > 3) {
        // Re-anchor on large drift (seek/skip/new stream segment).
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
    applicationId: 'FREEMID_CLIENT_ID',
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
