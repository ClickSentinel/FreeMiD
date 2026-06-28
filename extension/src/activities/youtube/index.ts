import { PRESENCE_ASSET_KEYS } from '../../constants/presenceAssets';
import { Presence } from '../../presence/Presence';

// Replace with your own Discord Application ID if you want custom artwork.
// Create a free app at https://discord.com/developers/applications
const presence = new Presence({
  clientId: import.meta.env.VITE_DISCORD_CLIENT_ID,
  updateInterval: 5,
});

function isWatchPage(): boolean {
  const path = window.location.pathname;
  return (
    path === '/watch' ||
    path.startsWith('/shorts/') ||
    path.startsWith('/live/')
  );
}

function getTitle(): string {
  return (
    document
      .querySelector<HTMLElement>(
        'h1.ytd-video-primary-info-renderer yt-formatted-string, h1.style-scope.ytd-video-primary-info-renderer',
      )
      ?.textContent?.trim() || document.title.replace(' - YouTube', '').trim()
  );
}

function getChannel(): string {
  const selectors = [
    '#channel-name a',
    '.ytd-channel-name a',
    'ytd-watch-metadata #owner a[href^="/"]',
    'ytd-video-owner-renderer a[href^="/"]',
  ] as const;

  const names = new Set<string>();

  for (const selector of selectors) {
    for (const node of document.querySelectorAll<HTMLAnchorElement>(selector)) {
      const value = node.textContent?.trim();
      if (value) names.add(value);
    }
  }

  if (names.size > 0) {
    return Array.from(names).join(', ');
  }

  return 'YouTube';
}

function getVideoEl(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(
    'video.html5-main-video, video',
  );
}

function isVideoPlaying(video: HTMLVideoElement | null): boolean {
  const playbackState = navigator.mediaSession?.playbackState;
  if (playbackState === 'playing') return true;
  if (playbackState === 'paused') return false;

  if (video) {
    if (!video.paused && !video.ended && video.readyState > 1) {
      return true;
    }
    if (video.paused || video.ended) {
      return false;
    }
  }

  // On YouTube, the control text reflects the opposite action:
  // "Pause" means the video is currently playing, "Play" means paused.
  const playButton =
    document.querySelector<HTMLButtonElement>('.ytp-play-button');
  const label = (
    playButton?.getAttribute('aria-label') ||
    playButton?.getAttribute('title') ||
    ''
  ).toLowerCase();
  if (label.includes('pause')) return true;
  if (label.includes('play')) return false;

  return false;
}

function getVideoId(): string | null {
  const id = new URLSearchParams(window.location.search).get('v');
  if (id) return id;

  const pathMatch = window.location.pathname.match(
    /^\/(?:shorts|live)\/([a-zA-Z0-9_-]{6,})/,
  );
  if (pathMatch?.[1]) return pathMatch[1];

  const match = window.location.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? null;
}

function getVideoUrl(): string {
  const videoId = getVideoId();
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  return window.location.href;
}

function normalizeChannelIconUrl(url: string): string {
  let out = url;

  // Common YouTube avatar path segment, e.g. /s88-c-k-c0x00ffffff-no-rj/
  out = out.replace(/\/s\d+(-[a-z0-9-]+)?\//i, '/s800$1/');

  // Common avatar suffix, e.g. =s88-c-k-c0x00ffffff-no-rj
  out = out.replace(/=s\d+(-[a-z0-9-]+)?$/i, '=s800$1');

  try {
    const parsed = new URL(out);
    if (parsed.searchParams.has('sz')) {
      parsed.searchParams.set('sz', '800');
      out = parsed.toString();
    }
  } catch {
    // Keep original URL if parsing fails.
  }

  return out;
}

function getChannelIconUrl(): string | undefined {
  const selectors = [
    'ytd-watch-metadata #avatar img#img',
    'ytd-video-owner-renderer #avatar img#img',
    '#owner #avatar img#img',
  ] as const;

  for (const selector of selectors) {
    const img = document.querySelector<HTMLImageElement>(selector);
    if (!img) continue;

    const srcSet = img.getAttribute('srcset')?.trim();
    if (srcSet) {
      const candidates = srcSet
        .split(',')
        .map((entry) => entry.trim().split(/\s+/)[0])
        .filter(
          (entry): entry is string => !!entry && /^https?:\/\//i.test(entry),
        );

      // srcset is ordered low to high resolution; use the highest candidate.
      const best = candidates[candidates.length - 1];
      if (best) {
        return normalizeChannelIconUrl(best);
      }
    }

    const src = img.src?.trim();
    if (src && /^https?:\/\//i.test(src)) {
      return normalizeChannelIconUrl(src);
    }
  }

  return undefined;
}

function getVideoThumbnailUrl(): string | undefined {
  const ogImage = document
    .querySelector<HTMLMetaElement>('meta[property="og:image"]')
    ?.content?.trim();
  if (ogImage && /^https?:\/\//i.test(ogImage)) {
    return ogImage;
  }

  const videoId = getVideoId();
  if (videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  return undefined;
}

presence.on('UpdateData', () => {
  if (!isWatchPage()) {
    presence.clearPresenceData();
    return;
  }

  const title = getTitle();
  const channel = getChannel();
  const video = getVideoEl();
  const playing = isVideoPlaying(video);
  const duration = video?.duration ?? 0;
  const elapsed = video?.currentTime ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const channelIcon = getChannelIconUrl();
  const videoThumbnail = getVideoThumbnailUrl();
  const largeImage =
    channelIcon ?? videoThumbnail ?? PRESENCE_ASSET_KEYS.youtubeLogo;
  const videoUrl = getVideoUrl();

  if (!title || !playing) {
    // Match YT Music behavior: hide presence whenever playback is idle.
    presence.clearPresenceData();
    return;
  }

  // duration is Infinity for live streams; guard against it to avoid sending
  // { start } with no { end }, which Discord shows as a counting-up game timer.
  const hasProgress = playing && duration > 0 && Number.isFinite(duration);
  const startTimestamp = hasProgress ? nowSec - Math.floor(elapsed) : undefined;
  const endTimestamp =
    hasProgress && startTimestamp != null
      ? startTimestamp + Math.floor(duration)
      : undefined;

  presence.setActivity({
    name: 'YouTube',
    type: 3,
    details: title.substring(0, 128),
    state: `By ${channel}`,
    largeImageKey: largeImage,
    largeImageText: channel,
    largeImageUrl: videoUrl,
    smallImageKey: PRESENCE_ASSET_KEYS.youtubeLogo,
    smallImageText: 'YouTube',
    // Provide both timestamps so popup and Discord can render synced progress.
    startTimestamp,
    endTimestamp,
    buttons: [{ label: 'Watch on YouTube', url: videoUrl }],
  });
});

// ── Event-driven updates ─────────────────────────────────────────────────────
const signal = presence.freshSignal();
const trigger = () => presence.triggerUpdate();

// Re-evaluate immediately on play/pause — critical for lock handoff speed.
document.addEventListener('play', trigger, { capture: true, signal });
document.addEventListener('pause', trigger, { capture: true, signal });
// loadedmetadata fires when a new video starts loading (SPA navigation).
document.addEventListener('loadedmetadata', trigger, { capture: true, signal });

// Observe the video title heading for SPA navigation (title updates before loadedmetadata).
presence.watchSelector(
  'h1.ytd-video-primary-info-renderer, h1.style-scope.ytd-video-primary-info-renderer',
  signal,
);
