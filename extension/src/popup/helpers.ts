import { ACTIVITIES } from '../activities/registry';
import { githubRepoUrl } from '../constants/github';
import { PRESENCE_PREVIEW_ASSETS } from '../constants/presenceAssets';
import { urlLike } from '../utils/urlLike';

export type ActivityPreview = {
  sub?: string;
  activityName?: string;
  smallImageText?: string;
};

export const isWindowsPlatform = /Win/i.test(navigator.platform);

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
  if (service.includes('soundcloud'))
    return PRESENCE_PREVIEW_ASSETS.soundcloudLogo;
  if (service.includes('apple music'))
    return PRESENCE_PREVIEW_ASSETS.appleMusicLogo;
  if (service.includes('youtube music') || service.includes('yt music'))
    return PRESENCE_PREVIEW_ASSETS.ytmusicLogo;
  if (service.includes('youtube')) return PRESENCE_PREVIEW_ASSETS.youtubeLogo;
  return null;
}

/**
 * Origins a site needs granted at runtime, or undefined if its host access is
 * already required at install time.
 *
 * Returning the registry's own match patterns keeps the permission request and
 * the injection rule from drifting apart — they are the same list.
 */
export function optionalOriginsFor(siteId: string): string[] | undefined {
  const meta = ACTIVITIES[siteId];
  return meta?.optionalPermission ? [...meta.matches] : undefined;
}
