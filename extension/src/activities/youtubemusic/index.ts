import { PRESENCE_ASSET_KEYS } from '../../constants/presenceAssets';
import {
  METADATA_SETTLE_DELAYS_MS,
  SNAPSHOT_SETTLE_MS,
} from '../../constants/timing';
import { debugLog } from '../../debug/log';
import { Presence } from '../../presence/Presence';
import { PlaybackAnchor } from '../../utils/PlaybackAnchor';
import { parseClock } from '../../utils/parseClock';

const presence = new Presence({
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
});

const anchor = new PlaybackAnchor();
let lastPausedState: boolean | undefined;
let lastTrackId: string | undefined;
let trackSeenAt: number | undefined;
/** Duration of the track we last built a payload for. */
let lastDuration: number | undefined;
/** Duration carried by the track we just left, to spot a bar that has not repainted. */
let previousDuration: number | undefined;
/** True between a track change and the first snapshot that gets through. */
let awaitingBarRepaint = false;

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
 * Extract the YouTube video ID of the track that is *currently playing*.
 *
 * Source order matters, and is the opposite of what it looks like it should be.
 * The URL's `?v=` identifies the page you navigated to, not what the queue has
 * since advanced to — on a skip it keeps the old id for over a second. The
 * player bar is rebuilt for each track, so its link and artwork track playback.
 *
 * Reading the URL first produced ids that trailed the title by ~1.4 s, which
 * did more than mispair artwork: `trackId` is derived from this, so a stale id
 * made `trackId !== lastTrackId` false and track changes went undetected
 * entirely. Live DOM sources first; URL only as a fallback for the initial load
 * before the player bar exists.
 */
function getVideoId(): string | undefined {
  // 1. Title link inside the player bar — rebuilt per track
  const titleLink = document.querySelector<HTMLAnchorElement>(
    'ytmusic-player-bar a[href*="watch?v="]',
  );
  if (titleLink) {
    const id = new URLSearchParams(titleLink.search).get('v');
    if (id) return id;
  }

  // 2. ytimg.com thumbnail URL contains the video ID — swapped per track
  const imgs = document.querySelectorAll<HTMLImageElement>(
    '#song-image img, ytmusic-player-bar img#img, ytmusic-player-bar img, ytmusic-player img',
  );
  for (const img of imgs) {
    const src = img.src || img.getAttribute('src') || '';
    const m = src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
    if (m) return m[1];
  }

  // 3. Embedded player title link
  const ytpLink = document.querySelector<HTMLAnchorElement>('a.ytp-title-link');
  if (ytpLink?.href) {
    const id =
      new URLSearchParams(ytpLink.search).get('v') ??
      ytpLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];
    if (id) return id;
  }

  // 4. ?v= in the page URL — lags playback, so last resort only. Covers the
  //    initial load, where it is the only source that exists yet.
  const urlId = new URLSearchParams(window.location.search).get('v');
  if (urlId) return urlId;

  return (
    document.location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1] ?? undefined
  );
}

/** Album art URL. Send full https:// URL — Discord RPC handles proxying. */
function getArtUrl(): string | undefined {
  const id = getVideoId();
  if (id) return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  return undefined;
}

presence.on('UpdateData', () => {
  // NOTE: ad detection removed in v0.3.7 — multiple attempts at DOM-based
  // detection caused regressions where presence would not recover after an
  // ad ended. Tracked in the bug filed against this repo. Until we have a
  // reliable signal, presence will momentarily show the ad as a track.

  const ms = navigator.mediaSession;
  const video = document.querySelector<HTMLVideoElement>(
    '.video-stream, video',
  );

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
    )?.textContent
      ?.trim()
      ?.replace(/\s*•.+$/, '')
      .trim();
  }

  // Page title last resort
  if (!title) {
    const parts = document.title.replace(' - YouTube Music', '').split(' - ');
    if (parts.length >= 2) {
      const [head, ...rest] = parts;
      title = (head ?? '').trim();
      artist = rest.join(' - ').trim();
    }
  }

  if (!title) {
    // clearPresenceData (not clearActivity) keeps the interval and event
    // listeners active so presence can recover when a title appears.
    presence.clearPresenceData();
    return;
  }

  const playbackState = ms?.playbackState;
  const paused = playbackState
    ? playbackState !== 'playing'
    : video
      ? video.paused
      : true;

  const barTimes = getPlayerBarTimes();

  // YouTube Music is a continuous stream — both video.currentTime and
  // video.duration accumulate across tracks and must never be used.
  // barTimes (scraped from the player bar) is the only reliable source.
  // Pass barTimes.current as-is (possibly undefined) so PlaybackAnchor
  // skips the drift check rather than re-anchoring to 0 when the bar hasn't loaded.
  const current = barTimes.current;
  const duration = barTimes.duration ?? 0;

  const artUrl = getArtUrl();
  const videoId = getVideoId();
  const songUrl = videoId
    ? `https://music.youtube.com/watch?v=${videoId}`
    : undefined;

  const trackId = videoId || `${title}::${artist || ''}`;

  if (trackId !== lastTrackId) {
    debugLog('ytmusic', 'track-change', {
      trackId,
      title,
      artist,
      album: ms?.metadata?.album,
      duration,
    });
    lastTrackId = trackId;
    trackSeenAt = Date.now();
    // Remember what the bar read for the track we are leaving: while it still
    // reads that, it has not repainted for the new one.
    previousDuration = lastDuration;
    awaitingBarRepaint = true;
    // Auto-advance does not fire a `play` event — YouTube Music never pauses
    // the media element between queued tracks — so the track change itself has
    // to schedule the refinement passes that a play event would have.
    presence.scheduleTrigger(...METADATA_SETTLE_DELAYS_MS);
  }

  // The title changes before the player bar repaints, so a snapshot taken the
  // instant we notice a new track still reads the *previous* track's duration.
  // Sending that gives Discord a wrong-length progress bar, and since the send
  // consumes the throttle budget the correction waits a full interval behind
  // it. Hold the snapshot until the bar catches up.
  //
  // Scoped to the window after a track change and cleared as soon as one
  // snapshot gets through: on a settled track `duration` naturally equals what
  // we last sent, and comparing against that would withhold every tick.
  const sinceTrackChangeMs = Date.now() - (trackSeenAt ?? 0);
  const barStillShowsPreviousTrack =
    awaitingBarRepaint &&
    duration > 0 &&
    duration === previousDuration &&
    sinceTrackChangeMs < SNAPSHOT_SETTLE_MS;
  if (barStillShowsPreviousTrack) {
    debugLog('ytmusic', 'stale-duration-withheld', {
      duration,
      sinceTrackChangeMs,
    });
    return;
  }

  // Either the bar repainted or the window expired — stop second-guessing it.
  awaitingBarRepaint = false;
  lastDuration = duration;

  const { timestamps } = anchor.update(trackId, current, duration, paused);

  // Paused: clear presence once on pause entry, then do nothing until resume.
  // clearPresenceData() sends a Discord clear without stopping the interval,
  // so the anchor keeps running and resume restores correctly.
  if (paused) {
    if (lastPausedState === false) {
      presence.clearPresenceData();
    }
    lastPausedState = true;
    return;
  }

  lastPausedState = false;

  // YouTube Music populates mediaSession.metadata.album asynchronously, ~500–
  // 1000 ms behind the title. We deliberately do NOT wait for it: the album is
  // only the artwork tooltip, and withholding the whole payload for it delayed
  // the title and artist by up to 1.5 s on every track change. The scheduled
  // refinements re-send once it lands, and the background coalesces the pair —
  // deferral is owned there alone, so the two waits overlap instead of adding.
  const album = ms?.metadata?.album || undefined;

  presence.setActivity({
    applicationId: import.meta.env.VITE_DISCORD_CLIENT_ID,
    name: artist || 'YT Music',
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : 'YouTube Music',
    startTimestamp: timestamps?.start,
    endTimestamp: timestamps?.end,
    largeImageKey: artUrl,
    largeImageText: album,
    largeImageUrl: songUrl,
    smallImageKey: PRESENCE_ASSET_KEYS.ytmusicLogo,
    smallImageText: 'YouTube Music',
    buttons: songUrl
      ? [{ label: 'Listen on YT Music', url: songUrl }]
      : undefined,
  });
});

// ── Event-driven updates ─────────────────────────────────────────────────────
const signal = presence.freshSignal();
const trigger = () => presence.triggerUpdate();

// pause must fire immediately — critical for lock-release speed.
// play and loadedmetadata schedule the settle refinements: 300 ms for
// mediaSession.metadata (title / artist / album), 1000 ms for the player-bar
// time-info (duration). scheduleTrigger cancels any pending timers from a
// previous event so rapid skips never interleave callbacks. The same schedule
// is armed on track change in the handler above, which is what covers
// auto-advance — YouTube Music fires no play event between queued tracks.
const scheduleSettle = () =>
  presence.scheduleTrigger(...METADATA_SETTLE_DELAYS_MS);
document.addEventListener('pause', trigger, { capture: true, signal });
document.addEventListener('play', scheduleSettle, { capture: true, signal });
document.addEventListener('loadedmetadata', scheduleSettle, {
  capture: true,
  signal,
});

// Observe the player bar title for immediate track-change detection.
presence.watchSelector(
  'ytmusic-player-bar .title.ytmusic-player-bar, ytmusic-player-bar yt-formatted-string.title',
  signal,
);
