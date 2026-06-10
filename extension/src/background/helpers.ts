import { ACTIVITY_REGISTRY, type ActivityMeta } from '../activities/registry';

export const MIN_SELF_UPDATE_HOST_VERSION = '0.3.14';

export function urlMatchesPattern(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url);

    const schemeEnd = pattern.indexOf('://');
    if (schemeEnd === -1) return false;
    const patternScheme = pattern.slice(0, schemeEnd);
    const afterScheme = pattern.slice(schemeEnd + 3);
    const slashIdx = afterScheme.indexOf('/');
    const patternHost = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? '' : afterScheme.slice(slashIdx);

    if (patternScheme !== '*' && patternScheme !== parsed.protocol.slice(0, -1)) {
      return false;
    }

    const hostRe = new RegExp(
      '^' + patternHost.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i',
    );
    if (!hostRe.test(parsed.hostname)) return false;

    if (!patternPath || patternPath === '/*') return true;
    const pathRe = new RegExp(
      '^' + patternPath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
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

export function isUpdateAvailable(hostVersion: string | null, latestVersion: string | null): boolean {
  if (!hostVersion || !latestVersion) return false;
  return compareVersions(latestVersion, hostVersion) > 0;
}

export function preferredUpdateVersion(latestVersion: string | null, extensionVersion: string): string {
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
  const baselineVersion = preferredUpdateVersion(latestVersion, extensionVersion);
  return compareVersions(baselineVersion, hostVersion) > 0;
}

export function isHostSelfUpdateSupported(
  hostVersion: string | null,
  minVersion = MIN_SELF_UPDATE_HOST_VERSION,
): boolean {
  if (!hostVersion) return false;
  return compareVersions(hostVersion, minVersion) >= 0;
}