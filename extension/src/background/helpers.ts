import { ACTIVITY_REGISTRY, type ActivityMeta } from '../activities/registry';
import { GITHUB_REPO } from '../constants/github';

export const MIN_SELF_UPDATE_HOST_VERSION = '0.4.0';
export const MIN_WINDOWS_SELF_UPDATE_HOST_VERSION = '0.4.0';

export function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url);

    const schemeEnd = pattern.indexOf('://');
    if (schemeEnd === -1) return false;
    const patternScheme = pattern.slice(0, schemeEnd);
    const afterScheme = pattern.slice(schemeEnd + 3);
    const slashIdx = afterScheme.indexOf('/');
    const patternHost =
      slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? '' : afterScheme.slice(slashIdx);

    if (
      patternScheme !== '*' &&
      patternScheme !== parsed.protocol.slice(0, -1)
    ) {
      return false;
    }

    const hostRe = new RegExp(
      '^' +
        patternHost.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
      'i',
    );
    if (!hostRe.test(parsed.hostname)) return false;

    if (!patternPath || patternPath === '/*') return true;
    const pathRe = new RegExp(
      '^' +
        patternPath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
      'i',
    );
    return pathRe.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

export function matchActivity(url: string): ActivityMeta | null {
  for (const meta of Object.values(ACTIVITY_REGISTRY)) {
    if (meta.matches.some((pattern) => urlMatchesPattern(url, pattern))) {
      return meta;
    }
  }
  return null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isUpdateAvailable(
  hostVersion: string | null,
  latestVersion: string | null,
): boolean {
  if (!hostVersion || !latestVersion) return false;
  return compareVersions(latestVersion, hostVersion) > 0;
}

export function preferredUpdateVersion(
  latestVersion: string | null,
  extensionVersion: string,
): string {
  if (latestVersion && compareVersions(latestVersion, extensionVersion) > 0) {
    return latestVersion;
  }
  return extensionVersion;
}

export function isUpdateAvailableForHost(
  hostVersion: string | null,
  latestVersion: string | null,
  extensionVersion: string,
): boolean {
  if (!hostVersion) return false;
  const baselineVersion = preferredUpdateVersion(
    latestVersion,
    extensionVersion,
  );
  return compareVersions(baselineVersion, hostVersion) > 0;
}

export async function lookupArtworkUrl(
  artist: string,
  title: string,
  album?: string,
): Promise<string | null> {
  try {
    const esc = (s: string) => s.replace(/"/g, '\\"');
    // -video:true excludes music videos, which score equally high as audio
    // recordings but have wrong or no art in the Cover Art Archive.
    const query = encodeURIComponent(
      `artist:"${esc(artist)}" AND recording:"${esc(title)}" AND -video:true`,
    );
    const mbResp = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=5`,
      {
        headers: {
          'User-Agent': `FreeMiD/${chrome.runtime.getManifest().version} (https://github.com/${GITHUB_REPO})`,
        },
      },
    );
    if (!mbResp.ok) return null;

    const mbData = (await mbResp.json()) as {
      recordings?: Array<{
        releases?: Array<{
          id: string;
          title?: string;
          status?: string;
          'release-group'?: { id: string; 'primary-type'?: string };
        }>;
      }>;
    };

    // Collect Official releases from the top 3 recordings, deduplicated by
    // release-group. Score: album-name match (3) > Album type (2) > other (1).
    const albumLower = album?.toLowerCase().trim();
    type Candidate = { releaseId: string; rgId?: string; score: number };
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const rec of (mbData.recordings ?? []).slice(0, 3)) {
      for (const rel of rec.releases ?? []) {
        if (rel.status !== 'Official') continue;
        const rgId = rel['release-group']?.id;
        const dedupeKey = rgId ?? rel.id;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const isAlbum = rel['release-group']?.['primary-type'] === 'Album';
        const nameMatch =
          !!albumLower &&
          !!rel.title &&
          rel.title.toLowerCase().trim() === albumLower;
        candidates.push({
          releaseId: rel.id,
          rgId,
          score: nameMatch ? 3 : isAlbum ? 2 : 1,
        });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    // The release-group endpoint returns canonical front art for the whole album
    // group and succeeds more often than individual release lookups.
    const triedRgs = new Set<string>();
    for (const c of candidates.slice(0, 5)) {
      if (c.rgId && !triedRgs.has(c.rgId)) {
        triedRgs.add(c.rgId);
        const resp = await fetch(
          `https://coverartarchive.org/release-group/${c.rgId}/front`,
          { method: 'HEAD' },
        );
        if (resp.ok) return resp.url;
      }
    }

    // Fall back to individual release IDs.
    const triedRels = new Set<string>();
    for (const c of candidates.slice(0, 5)) {
      if (!triedRels.has(c.releaseId)) {
        triedRels.add(c.releaseId);
        const resp = await fetch(
          `https://coverartarchive.org/release/${c.releaseId}/front-500`,
          { method: 'HEAD' },
        );
        if (resp.ok) return resp.url;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function isHostSelfUpdateSupported(
  hostVersion: string | null,
  minVersion = MIN_SELF_UPDATE_HOST_VERSION,
  platform: 'windows' | 'other' = 'other',
  minWindowsVersion = MIN_WINDOWS_SELF_UPDATE_HOST_VERSION,
): boolean {
  if (!hostVersion) return false;
  const effectiveMinVersion =
    platform === 'windows'
      ? compareVersions(minWindowsVersion, minVersion) > 0
        ? minWindowsVersion
        : minVersion
      : minVersion;
  return compareVersions(hostVersion, effectiveMinVersion) >= 0;
}
