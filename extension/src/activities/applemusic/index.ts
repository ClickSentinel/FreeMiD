import { PRESENCE_ASSET_KEYS } from '../../constants/presenceAssets';
import { Presence } from '../../presence/Presence';
import { PlaybackAnchor } from '../../utils/PlaybackAnchor';
import { parseIsoDuration } from '../../utils/parseIsoDuration';
import { urlLike } from '../../utils/urlLike';

const presence = new Presence({
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
});

const anchor = new PlaybackAnchor();
let pausedConfirmTicks = 0;

// Apple's player renders both the play and pause buttons at all times,
// toggling aria-hidden on whichever isn't the current action — the pause
// button visible (not aria-hidden) means audio is currently playing.
// mediaSession.playbackState is not reliably set by Apple Music's web
// player (observed staying "none" during active playback), so it's only a
// last-resort fallback here, not the primary signal like YouTube Music.
function isPlaying(): boolean {
  const pauseBtn = document.querySelector<HTMLElement>('.playback-play__pause');
  const playBtn = document.querySelector<HTMLElement>('.playback-play__play');
  if (pauseBtn && pauseBtn.getAttribute('aria-hidden') !== 'true') {
    return true;
  }
  if (playBtn && playBtn.getAttribute('aria-hidden') !== 'true') {
    return false;
  }
  return navigator.mediaSession?.playbackState === 'playing';
}

// The Media Session spec does not guarantee `artwork` entries are ordered by
// size, even though Apple currently supplies them ascending — parse each
// entry's `sizes` string (e.g. "512x512") and pick the largest by area
// instead of assuming array order. Also gate through urlLike(): `src` is
// fully page-controlled and could in principle be any URL scheme.
function bestArtworkUrl(
  artwork: readonly MediaImage[] | undefined,
): string | undefined {
  if (!artwork || artwork.length === 0) return undefined;
  let best: { src: string; area: number } | undefined;
  for (const entry of artwork) {
    if (!entry.src || !urlLike(entry.src)) continue;
    const [w, h] = (entry.sizes ?? '').split('x').map(Number);
    const area =
      w != null && h != null && Number.isFinite(w) && Number.isFinite(h)
        ? w * h
        : 0;
    if (!best || area > best.area) best = { src: entry.src, area };
  }
  return best?.src;
}

// The player bar's elapsed/remaining <time> elements carry real ISO 8601
// durations in their datetime attribute (e.g. "PT2S", "PT1M28S") — more
// reliable than parsing the "0:02" display text. They live inside
// <amp-playback-controls-progress>'s open shadow root, not the light DOM, so
// a plain document.querySelector can't see them.
function getElapsedAndDuration(): {
  current: number | undefined;
  duration: number;
} {
  const progressRoot = document.querySelector(
    'amp-playback-controls-progress',
  )?.shadowRoot;
  const elapsedEl = progressRoot?.querySelector<HTMLElement>('.time.elapsed');
  const remainingEl =
    progressRoot?.querySelector<HTMLElement>('.time.remaining');
  const current = parseIsoDuration(elapsedEl?.getAttribute('datetime'));
  const remaining = parseIsoDuration(remainingEl?.getAttribute('datetime'));
  const duration =
    current != null && remaining != null ? current + remaining : 0;
  return { current, duration };
}

presence.on('UpdateData', () => {
  // Title/artist/album/artwork come from the Media Session API — Apple
  // Music's web player populates navigator.mediaSession.metadata reliably
  // and atomically (unlike YouTube Music, no async-arriving-album race).
  // Artwork URLs here (mzstatic.com, up to 512x512) are much higher quality
  // than anything visible in the DOM, which only exposes a 40-80px lazy
  // player-bar thumbnail.
  const md = navigator.mediaSession?.metadata;
  const title = md?.title?.trim();
  const artist = md?.artist?.trim();
  const album = md?.album?.trim();

  if (!title) {
    presence.clearPresenceData();
    return;
  }

  const paused = !isPlaying();
  pausedConfirmTicks = paused ? pausedConfirmTicks + 1 : 0;

  const { current, duration } = getElapsedAndDuration();
  const trackId = `${artist ?? ''}::${title}::${album ?? ''}`;
  const { timestamps } = anchor.update(trackId, current, duration, paused);

  if (paused) {
    // Require two consecutive paused ticks before clearing. isPlaying()'s
    // DOM signal is a best-effort read of an unfamiliar site's markup —
    // this avoids transient glitches dropping activity mid-song.
    if (pausedConfirmTicks === 2) {
      presence.clearPresenceData();
    }
    return;
  }

  const artUrl = bestArtworkUrl(md?.artwork);

  presence.setActivity({
    applicationId: import.meta.env.VITE_DISCORD_CLIENT_ID,
    name: artist || 'Apple Music',
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : 'Apple Music',
    startTimestamp: timestamps?.start,
    endTimestamp: timestamps?.end,
    largeImageKey: artUrl,
    largeImageText: album,
    smallImageKey: PRESENCE_ASSET_KEYS.appleMusicLogo,
    smallImageText: 'Apple Music',
  });
});

// ── Event-driven updates ─────────────────────────────────────────────────────
const signal = presence.freshSignal();
const trigger = () => presence.triggerUpdate();

// Best-effort fast path — Apple Music's actual playback is likely MSE/EME
// backed, so a native play/pause event dispatched on the underlying element
// may or may not bubble to document. Harmless if it never fires.
document.addEventListener('play', trigger, { capture: true, signal });
document.addEventListener('pause', trigger, { capture: true, signal });

// Primary signal: watch the player bar for both track-title changes
// (childList/characterData) and play/pause button toggles (aria-hidden
// attribute mutations).
presence.watchSelector('.player-bar', signal, {
  observeAttributes: true,
  attributeFilter: ['aria-hidden'],
});
