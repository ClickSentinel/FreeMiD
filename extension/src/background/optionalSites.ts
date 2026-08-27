/**
 * Policy for sites whose host access is granted at runtime.
 *
 * Extracted from the service worker so it can be exercised directly; the
 * worker's module body has import-time side effects (native port, listeners,
 * alarms) that make it untestable in place. See docs/PERMISSIONS.md.
 */

import { ACTIVITIES } from '../activities/registry';

/**
 * Starting state of the per-site toggles.
 *
 * A site whose host access is optional must start off: nothing has been
 * granted yet, so injection would fail. optionalSites.test.ts asserts that,
 * which is the guard docs/PERMISSIONS.md used to say was missing.
 *
 * Spread this rather than assigning it, so the live toggle state cannot write
 * back into the defaults.
 */
export const DEFAULT_ENABLED_SITES: Readonly<Record<string, boolean>> = {
  youtube: true,
  youtubemusic: true,
  tidal: true,
  applemusic: true,
  soundcloud: false,
};

/** Reads back whether every listed origin is currently held. */
export type OriginProbe = (origins: string[]) => Promise<boolean>;

/**
 * Which optional sites no longer hold all the origins they inject on.
 *
 * Asking Chrome what is held beats comparing against the origin list a removal
 * event carries: that comparison only holds while the revoked origin is
 * reported in exactly the form it was requested, and a narrowed or normalised
 * origin would leave the toggle on while injection failed.
 *
 * A probe that throws counts as held. Turning a working site off because its
 * permission state could not be read is the worse failure, and it matches what
 * the popup does with the same question.
 */
export async function ungrantedOptionalSites(
  contains: OriginProbe,
): Promise<string[]> {
  const ungranted: string[] = [];
  for (const [siteId, meta] of Object.entries(ACTIVITIES)) {
    if (!meta.optionalPermission) continue;
    try {
      if (await contains([...meta.matches])) continue;
    } catch {
      continue;
    }
    ungranted.push(siteId);
  }
  return ungranted;
}
