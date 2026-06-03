import { Presence } from '../../presence/Presence';
import { SERVICE_ICON_URLS } from '../../constants/serviceIcons';

// Replace with your own Discord Application ID if you want custom artwork.
// Create a free app at https://discord.com/developers/applications
const presence = new Presence({ clientId: import.meta.env.VITE_DISCORD_CLIENT_ID, updateInterval: 5 });

function isWatchPage(): boolean {
  return window.location.pathname === '/watch';
}

function getTitle(): string {
  return (
    document.querySelector<HTMLElement>(
      'h1.ytd-video-primary-info-renderer yt-formatted-string, h1.style-scope.ytd-video-primary-info-renderer'
    )?.textContent?.trim() ||
    document.title.replace(' - YouTube', '').trim()
  );
}

function getChannel(): string {
  return (
    document.querySelector<HTMLAnchorElement>('#channel-name a, .ytd-channel-name a')
      ?.textContent
      ?.trim() ?? 'YouTube'
  );
}

function getVideoEl(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
}

presence.on('UpdateData', () => {
  if (!isWatchPage()) {
    presence.setActivity({
      type: 3, // Watching
      details: 'Browsing YouTube',
      largeImageKey: SERVICE_ICON_URLS.youtube,
      largeImageText: 'YouTube',
    });
    return;
  }

  const title   = getTitle();
  const channel = getChannel();
  const video   = getVideoEl();
  const paused  = video?.paused ?? true;
  const duration = video?.duration ?? 0;
  const elapsed  = video?.currentTime ?? 0;
  const nowSec   = Math.floor(Date.now() / 1000);

  const hasProgress = !paused && duration > 0;
  const startTimestamp = hasProgress ? nowSec - Math.floor(elapsed) : undefined;
  const endTimestamp = hasProgress && startTimestamp != null
    ? startTimestamp + Math.floor(duration)
    : undefined;

  presence.setActivity({
    type: 3,
    details: title.substring(0, 128),
    state: `By ${channel}`,
    largeImageKey: SERVICE_ICON_URLS.youtube,
    largeImageText: 'YouTube',
    smallImageKey: paused
      ? 'https://www.freemid.app/assets/pause.png'
      : 'https://www.freemid.app/assets/play.png',
    smallImageText: paused ? 'Paused' : 'Playing',
    // Provide both timestamps so popup and Discord can render synced progress.
    startTimestamp,
    endTimestamp,
    buttons: [{ label: 'Watch on YouTube', url: window.location.href.split('&')[0]! }],
  });
});
