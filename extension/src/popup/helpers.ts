import { githubRepoUrl } from '../constants/github';
import { PRESENCE_PREVIEW_ASSETS } from '../constants/presenceAssets';

export type ActivityPreview = {
  sub?: string;
  activityName?: string;
  smallImageText?: string;
};

export const isWindowsPlatform = /Win/i.test(navigator.platform);

export function urlLike(value?: string): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function windowsSetupUrl(): string {
  // Keep env override for local testing, but default users to install docs.
  const devWindowsSetupUrl =
    import.meta.env.VITE_WINDOWS_SETUP_URL?.trim() || '';
  return urlLike(devWindowsSetupUrl)
    ? devWindowsSetupUrl
    : githubRepoUrl('installation');
}

export function artistFromActivity(act: ActivityPreview): string {
  const fromSub = act.sub?.replace(/^by\s+/i, '').trim();
  if (fromSub) return fromSub;
  if (act.activityName) return act.activityName;
  return '';
}

export function isUnsupportedPlatformUpdateError(error?: string): boolean {
  return (
    typeof error === 'string' &&
    (/automatic updates are not supported on this platform/i.test(error) ||
      /manual bootstrap required/i.test(error))
  );
}

export function fallbackLogoPath(act: ActivityPreview): string | null {
  const service =
    `${act.smallImageText ?? ''} ${act.activityName ?? ''} ${act.sub ?? ''}`.toLowerCase();
  if (service.includes('tidal')) return PRESENCE_PREVIEW_ASSETS.tidalLogo;
  if (service.includes('youtube music') || service.includes('yt music'))
    return PRESENCE_PREVIEW_ASSETS.ytmusicLogo;
  if (service.includes('youtube')) return PRESENCE_PREVIEW_ASSETS.youtubeLogo;
  return null;
}
