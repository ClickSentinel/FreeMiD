import { Presence } from '../../presence/Presence';

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
      largeImageKey: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_32x32.png',
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
  const now      = Date.now();

  presence.setActivity({
    type: 3,
    details: title.substring(0, 128),
    state: `By ${channel}`,
    largeImageKey: 'https://www.gstatic.com/youtube/img/branding/favicon/favicon_32x32.png',
    largeImageText: 'YouTube',
    smallImageKey: paused
      ? 'https://www.freemid.app/assets/pause.png'
      : 'https://www.freemid.app/assets/play.png',
    smallImageText: paused ? 'Paused' : 'Playing',
    // Show end timestamp while playing so Discord shows a countdown
    endTimestamp: !paused && duration > 0
      ? Math.floor(now / 1000) + Math.floor(duration - elapsed)
      : undefined,
    buttons: [{ label: 'Watch on YouTube', url: window.location.href.split('&')[0]! }],
  });
});
