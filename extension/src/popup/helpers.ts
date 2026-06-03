import { PRESENCE_PREVIEW_ASSETS } from '../constants/presenceAssets';

export type ActivityPreview = {
  sub?: string;
  activityName?: string;
  smallImageText?: string;
};

export function urlLike(value?: string): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function artistFromActivity(act: ActivityPreview): string {
  const fromSub = act.sub?.replace(/^by\s+/i, '').trim();
  if (fromSub) return fromSub;
  if (act.activityName) return act.activityName;
  return '';
}

export function fallbackLogoPath(act: ActivityPreview): string | null {
  const service = `${act.smallImageText ?? ''} ${act.activityName ?? ''} ${act.sub ?? ''}`.toLowerCase();
  if (service.includes('tidal')) return PRESENCE_PREVIEW_ASSETS.tidalLogo;
  if (service.includes('youtube music') || service.includes('yt music')) return PRESENCE_PREVIEW_ASSETS.ytmusicLogo;
  if (service.includes('youtube')) return PRESENCE_PREVIEW_ASSETS.youtubeLogo;
  return null;
}