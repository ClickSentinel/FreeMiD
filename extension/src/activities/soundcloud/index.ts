import { PRESENCE_ASSET_KEYS } from '../../constants/presenceAssets';
import { METADATA_SETTLE_DELAYS_MS } from '../../constants/timing';
import { debugLog } from '../../debug/log';
import { Presence } from '../../presence/Presence';
import { bestArtworkUrl } from '../../utils/bestArtworkUrl';
import { PlaybackAnchor } from '../../utils/PlaybackAnchor';
import { parseClock } from '../../utils/parseClock';

const presence = new Presence({
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
});

const anchor = new PlaybackAnchor();
let lastTrackId: string | undefined;
let lastPausedState: boolean | undefined;

/**
 * Read a clock out of a player-bar time node.
 *
 * SoundCloud puts a visually-hidden accessibility label in the same node as the
 * visible time, so `textContent` reads "Duration: 1 minute 4 seconds1:04".
 * Only the trailing clock is wanted; a plain trim() yields nonsense.
 */
function clockFrom(selector: string): number | undefined {
  const raw = document.querySelector(selector)?.textContent ?? '';
  const match = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*$/);
  return match?.[1] ? parseClock(match[1]) : undefined;
}

/**
 * SoundCloud sets `mediaSession.playbackState` correctly (unlike Apple Music,
 * which leaves it at "none" mid-playback), so it is the primary signal. The
 * transport button is the fallback: it carries `playing` while active and
 * `disabled` when the queue is empty.
 */
function isPlaying(): boolean {
  const state = navigator.mediaSession?.playbackState;
  if (state === 'playing') return true;
  if (state === 'paused') return false;
  return (
    document
      .querySelector('.playControls__play')
      ?.classList.contains('playing') ?? false
  );
}

presence.on('UpdateData', () => {
  // SoundCloud populates mediaSession fully and atomically, so it is preferred
  // for everything it carries. The DOM supplies only what it does not: the
  // permalink, and the elapsed/duration clocks.
  const md = navigator.mediaSession?.metadata;
  const title = md?.title?.trim();
  const artist = md?.artist?.trim();

  if (!title) {
    // clearPresenceData (not clearActivity) keeps the tick and listeners alive
    // so presence recovers when a track starts.
    presence.clearPresenceData();
    return;
  }

  const permalink =
    document
      .querySelector<HTMLAnchorElement>('.playbackSoundBadge__titleLink')
      ?.getAttribute('href') ?? undefined;

  const paused = !isPlaying();
  const current = clockFrom('.playbackTimeline__timePassed');
  const duration = clockFrom('.playbackTimeline__duration') ?? 0;

  // The permalink is a stable per-track identity, so unlike YouTube Music there
  // is no lagging-id problem here and no coherence gate is needed.
  const trackId = permalink ?? `${title}::${artist ?? ''}`;

  if (trackId !== lastTrackId) {
    debugLog('soundcloud', 'track-change', {
      trackId,
      title,
      artist,
      duration,
    });
    lastTrackId = trackId;
    presence.scheduleTrigger(...METADATA_SETTLE_DELAYS_MS);
  }

  const { timestamps } = anchor.update(trackId, current, duration, paused);

  if (paused) {
    if (lastPausedState === false) {
      presence.clearPresenceData();
    }
    lastPausedState = true;
    return;
  }
  lastPausedState = false;

  const trackUrl = permalink
    ? new URL(permalink, 'https://soundcloud.com').href
    : undefined;
  // Tracks without their own art report an empty album rather than omitting it.
  const album = md?.album?.trim() || undefined;

  presence.setActivity({
    applicationId: import.meta.env.VITE_DISCORD_CLIENT_ID,
    name: artist || 'SoundCloud',
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : 'SoundCloud',
    startTimestamp: timestamps?.start,
    endTimestamp: timestamps?.end,
    // mediaSession carries several sizes; the DOM only has a 50px thumbnail.
    largeImageKey: bestArtworkUrl(md?.artwork),
    largeImageText: album,
    largeImageUrl: trackUrl,
    smallImageKey: PRESENCE_ASSET_KEYS.soundcloudLogo,
    smallImageText: 'SoundCloud',
    buttons: trackUrl
      ? [{ label: 'Listen on SoundCloud', url: trackUrl }]
      : undefined,
  });
});

// ── Event-driven updates ─────────────────────────────────────────────────────
const signal = presence.freshSignal();

// No `play`/`pause` listeners here: SoundCloud keeps no <audio> or <video> in
// the document at all, so those events have nothing to bubble from and would
// never fire. Everything is driven by the observers below plus the tick.

// Track changes. Observing the badge rather than the title link directly means
// a replaced link is caught as a childList mutation on the parent — and the
// link *is* replaced on every skip, confirmed live.
presence.watchSelector('.playbackSoundBadge', signal);

// Play/pause. The transport button relabels between "Play current" and
// "Pause current"; watching that attribute is far quieter than watching the
// whole control bar, whose timeline text changes every second.
presence.watchSelector('.playControls__play', signal, {
  observeAttributes: true,
  attributeFilter: ['aria-label'],
});
