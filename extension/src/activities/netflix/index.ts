import { Presence } from '../../presence/Presence';

const presence = new Presence({ clientId: 'FREEMID_CLIENT_ID', updateInterval: 5 });

function getTitle(): string | null {
  return (
    document.querySelector<HTMLElement>(
      '.title-title, [data-uia="video-title"], .VideoTitle'
    )?.textContent?.trim() ?? null
  );
}

function getVideoEl(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video');
}

function isOnWatch(): boolean {
  return window.location.pathname.startsWith('/watch');
}

presence.on('UpdateData', () => {
  if (!isOnWatch()) {
    presence.setActivity({
      type: 3,
      details: 'Browsing Netflix',
      largeImageKey: 'https://assets.nflxext.com/us/ffe/siteui/common/icons/nficon2016.ico',
      largeImageText: 'Netflix',
    });
    return;
  }

  const title  = getTitle();
  const video  = getVideoEl();
  const paused = video?.paused ?? true;
  const duration = video?.duration ?? 0;
  const elapsed  = video?.currentTime ?? 0;
  const now      = Date.now();

  presence.setActivity({
    type: 3,
    details: title?.substring(0, 128) ?? 'Watching something',
    state: paused ? 'Paused' : 'Playing',
    largeImageKey: 'https://assets.nflxext.com/us/ffe/siteui/common/icons/nficon2016.ico',
    largeImageText: 'Netflix',
    smallImageKey: paused
      ? 'https://www.freemid.app/assets/pause.png'
      : 'https://www.freemid.app/assets/play.png',
    smallImageText: paused ? 'Paused' : 'Playing',
    endTimestamp: !paused && duration > 0
      ? Math.floor(now / 1000) + Math.floor(duration - elapsed)
      : undefined,
  });
});
