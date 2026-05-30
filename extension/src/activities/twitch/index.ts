import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: 'FREEMID_CLIENT_ID', updateInterval: 5 });

function getChannel(): string | null {
  return (
    document.querySelector<HTMLElement>('h1.tw-title, [data-a-target="stream-title"]')
      ?.textContent
      ?.trim() ?? null
  );
}

function getStreamTitle(): string | null {
  return (
    document.querySelector<HTMLElement>(
      '[data-a-target="stream-game-link"], .stream-game-title'
    )?.textContent?.trim() ?? null
  );
}

function isLive(): boolean {
  return !!document.querySelector('[data-test-selector="live-badge"], .live-badge');
}

function isVideoPage(): boolean {
  return /^\/videos\/\d+/.test(window.location.pathname);
}

function isDirectory(): boolean {
  return window.location.pathname.startsWith('/directory');
}

presence.on('UpdateData', () => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const channelSlug = pathParts[0];

  if (!channelSlug || isDirectory()) {
    presence.setActivity({
      type: 3,
      details: 'Browsing Twitch',
      largeImageKey: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c1.png',
      largeImageText: 'Twitch',
    });
    return;
  }

  if (isVideoPage()) {
    const videoTitle = document.querySelector<HTMLElement>('h1.tw-title')?.textContent?.trim();
    presence.setActivity({
      type: 3,
      details: videoTitle?.substring(0, 128) ?? 'Watching a video',
      state: `on ${channelSlug}`,
      largeImageKey: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c1.png',
      largeImageText: 'Twitch',
      buttons: [{ label: 'Watch on Twitch', url: window.location.href }],
    });
    return;
  }

  // Channel / live page
  const channelName = getChannel() ?? channelSlug;
  const game = getStreamTitle();
  const live = isLive();

  presence.setActivity({
    type: 3,
    details: live
      ? `Watching ${channelName} (LIVE)`
      : `Watching ${channelName}`,
    state: game ? `Playing: ${game}` : undefined,
    startTimestamp: live ? Math.floor(Date.now() / 1000) : undefined,
    largeImageKey: 'https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c1.png',
    largeImageText: 'Twitch',
    smallImageKey: live ? 'https://www.freemid.app/assets/live.png' : undefined,
    smallImageText: live ? 'LIVE' : undefined,
    buttons: [{ label: 'Watch on Twitch', url: window.location.href }],
  });
});
