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

/**
 * Local service logo for a preview whose Discord asset art cannot be shown.
 *
 * `smallImageText` is written by FreeMiD itself and always names the service,
 * so it is matched on its own first and settles the answer when present. Only
 * when it is absent does the search widen to the artist and subtitle, which
 * carry whatever the track is called: an artist named "Tidal Wave" playing on
 * SoundCloud would otherwise be served the TIDAL logo.
 *
 * The widened pass still exists because desktop presence omits
 * `smallImageText` whenever it has no artwork URL to pair it with (see
 * `small_text` in background/index.ts).
 */
export function fallbackLogoPath(act: ActivityPreview): string | null {
  return (
    logoForService(act.smallImageText ?? '') ??
    logoForService(`${act.activityName ?? ''} ${act.sub ?? ''}`)
  );
}

/**
 * Longest service name first, so "YouTube Music" is never taken for
 * "YouTube". The others share no substring with each other.
 */
function logoForService(text: string): string | null {
  const service = text.toLowerCase();
  if (service.includes('youtube music') || service.includes('yt music'))
    return PRESENCE_PREVIEW_ASSETS.ytmusicLogo;
  if (service.includes('youtube')) return PRESENCE_PREVIEW_ASSETS.youtubeLogo;
  if (service.includes('apple music'))
    return PRESENCE_PREVIEW_ASSETS.appleMusicLogo;
  if (service.includes('soundcloud'))
    return PRESENCE_PREVIEW_ASSETS.soundcloudLogo;
  if (service.includes('tidal')) return PRESENCE_PREVIEW_ASSETS.tidalLogo;
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
