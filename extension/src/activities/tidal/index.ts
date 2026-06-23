import { PRESENCE_ASSET_KEYS } from '../../constants/presenceAssets';
import { Presence } from '../../presence/Presence';
import { parseClock } from '../../utils/parseClock';

const presence = new Presence({
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
  updateInterval: 5,
});

let activeTrackUrl: string | undefined;
let playbackAnchorStart: number | undefined;
let pausedAtWallClock: number | undefined;
let pausedConfirmTicks = 0;

function text(sel: string): string {
  return document.querySelector<HTMLElement>(sel)?.textContent?.trim() ?? '';
}

function currentTrackUrl(): string | undefined {
  const href = document
    .querySelector<HTMLAnchorElement>('[data-test="footer-track-title"] a')
    ?.getAttribute('href');
  if (!href) return undefined;
  try {
    return new URL(href, window.location.origin).toString();
  } catch {
    return undefined;
  }
}

function currentArtworkUrl(): string | undefined {
  const src = document
    .querySelector<HTMLImageElement>('[data-test="current-media-imagery"] img')
    ?.getAttribute('src');
  if (!src) return undefined;

  try {
    return new URL(src, window.location.origin).toString();
  } catch {
    return undefined;
  }
}

function isPlaying(): boolean {
  const msState = navigator.mediaSession?.playbackState;
  if (msState === 'playing') return true;
  if (msState === 'paused') return false;

  const media = document.querySelector<HTMLMediaElement>('audio, video');
  if (media) return !media.paused && !media.ended;

  // Fallback to control semantics if media state is unavailable.
  if (
    document.querySelector(
      '[aria-label*="Pause" i], [title*="Pause" i], [data-test*="pause" i]',
    )
  ) {
    return true;
  }
  if (
    document.querySelector(
      '[aria-label*="Play" i], [title*="Play" i], [data-test*="play" i]',
    )
  ) {
    return false;
  }

  // Bias toward playing if detection is inconclusive to avoid false clears.
  return true;
}

presence.on('UpdateData', () => {
  const title = text(
    '[data-test="footer-track-title"] a, [data-test="footer-track-title"]',
  );
  const artist = text('[data-test="footer-player"] a[href*="/artist/"]');
  const collection = text(
    '[data-test="footer-player"] a[href*="/playlist/"], [data-test="footer-player"] a[href*="/album/"]',
  );

  if (!title) {
    presence.clearPresenceData();
    return;
  }

  const current =
    parseClock(
      text('[data-test="current-time"] time, [data-test="current-time"]'),
    ) ?? 0;
  const duration =
    parseClock(text('[data-test="duration"] time, [data-test="duration"]')) ??
    0;
  const trackUrl = currentTrackUrl();
  const artUrl = currentArtworkUrl();

  const now = Math.floor(Date.now() / 1000);
  const paused = !isPlaying();
  pausedConfirmTicks = paused ? pausedConfirmTicks + 1 : 0;

  const trackChanged =
    trackUrl !== activeTrackUrl || playbackAnchorStart === undefined;
  if (trackChanged) {
    activeTrackUrl = trackUrl;
    playbackAnchorStart = now - current;
    pausedAtWallClock = undefined;
  }

  if (paused) {
    if (pausedAtWallClock === undefined) {
      pausedAtWallClock = now;
    }
  } else if (playbackAnchorStart !== undefined) {
    if (pausedAtWallClock !== undefined) {
      playbackAnchorStart += now - pausedAtWallClock;
      pausedAtWallClock = undefined;
    }

    if (!trackChanged) {
      const expectedCurrent = now - playbackAnchorStart;
      if (Math.abs(expectedCurrent - current) > 3) {
        playbackAnchorStart = now - current;
      }
    }
  }

  const timestamps =
    duration > 0 && playbackAnchorStart !== undefined
      ? { start: playbackAnchorStart, end: playbackAnchorStart + duration }
      : undefined;

  if (paused) {
    // Require two consecutive paused ticks before clearing. This avoids
    // transient DOM/control-state glitches dropping activity mid-song.
    if (pausedConfirmTicks === 2) {
      presence.clearPresenceData();
    }
    return;
  }

  presence.setActivity({
    applicationId: import.meta.env.VITE_DISCORD_CLIENT_ID,
    name: artist || 'TIDAL',
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : 'TIDAL',
    startTimestamp: timestamps?.start,
    endTimestamp: timestamps?.end,
    largeImageKey: artUrl,
    largeImageText: collection || title,
    largeImageUrl: trackUrl,
    smallImageKey: PRESENCE_ASSET_KEYS.tidalLogo,
    smallImageText: 'TIDAL',
    buttons: trackUrl
      ? [{ label: 'Listen on TIDAL', url: trackUrl }]
      : undefined,
  });
});
