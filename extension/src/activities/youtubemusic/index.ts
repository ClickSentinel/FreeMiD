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
/** Fields of the track we last built a payload for, to spot a half-updated DOM. */
let lastVideoId: string | undefined;
let lastTitle: string | undefined;
let lastDuration: number | undefined;
/** When the current snapshot first looked incoherent, to bound the wait. */
let incoherentSince: number | undefined;
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

  // 2. ytimg.com thumbnail URL contains the video ID — swapped per track.
  //    Every selector here MUST be scoped to the player bar. A bare
  //    `#song-image img` also matches track-list rows on an album page, and
  //    since those re-render as you scroll it returned a different track's id
  //    on each tick — nine spurious track changes in 1.6 s, cycling through
  //    the album. A stale id is one wrong artwork; an unstable one is chaos.
  const imgs = document.querySelectorAll<HTMLImageElement>(
    'ytmusic-player-bar #song-image img, ytmusic-player-bar img#img, ytmusic-player-bar img',
  );
  for (const img of imgs) {
    const src = img.src || img.getAttribute('src') || '';
    const m = src.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
    if (m) return m[1];
  }

  // 3. Embedded player title link — one per page, so it cannot cross-match
  const ytpLink = document.querySelector<HTMLAnchorElement>('a.ytp-title-link');
  if (ytpLink?.href) {
    const id =
      new URLSearchParams(ytpLink.search).get('v') ??
      ytpLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];
    if (id) return id;
  }

  // 4. ?v= in the page URL — lags playback, so last resort only. Covers the
  //    initial load, where it is the only source that exists yet. Stale but
  //    stable, which is the right trade for a fallback.
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
    // Remember what the bar read for the track we are leaving: while it still
    // reads that, it has not repainted for the new one.
    previousDuration = lastDuration;
    awaitingBarRepaint = true;
    // Auto-advance does not fire a `play` event — YouTube Music never pauses
    // the media element between queued tracks — so the track change itself has
    // to schedule the refinement passes that a play event would have.
    presence.scheduleTrigger(...METADATA_SETTLE_DELAYS_MS);
  }

  // The fields identifying a track — video id (player bar DOM), title
  // (mediaSession) and duration (player bar text) — update independently, and
  // any of them can move first. Observed in traces: the id led the title by
  // ~600 ms in one direction and trailed it by ~1.4 s in the other, and the
  // duration lagged both by ~250 ms.
  //
  // A payload built mid-transition pairs one track's artwork or progress bar
  // with another track's title. That is wrong rather than merely incomplete,
  // so it is withheld until the fields agree — bounded, because a source that
  // never catches up must not stall presence forever.
  const idChanged = videoId !== lastVideoId;
  const titleChanged = title !== lastTitle;
  // Exactly one identity source moved: they cannot both describe the same
  // track yet. Neither moving is a settled track; both moving is a clean change.
  const identityDisagrees = idChanged !== titleChanged;
  // The bar still reads the duration of the track we just left.
  const durationIsPrevious = duration > 0 && duration === previousDuration;

  if (identityDisagrees || (awaitingBarRepaint && durationIsPrevious)) {
    incoherentSince ??= Date.now();
    const heldForMs = Date.now() - incoherentSince;
    if (heldForMs < SNAPSHOT_SETTLE_MS) {
      debugLog('ytmusic', 'snapshot-withheld', {
        reason: identityDisagrees ? 'identity' : 'duration',
        videoId,
        title,
        duration,
        heldForMs,
      });
      return;
    }
  }

  // Agreed, or held long enough — stop second-guessing and record the state
  // that the next tick will compare against.
  incoherentSince = undefined;
  awaitingBarRepaint = false;
  lastVideoId = videoId;
  lastTitle = title;
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
