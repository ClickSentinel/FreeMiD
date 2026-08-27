import { describe, expect, it, vi } from 'vitest';

import { ACTIVITIES } from '../activities/registry';
import { DEFAULT_ENABLED_SITES, ungrantedOptionalSites } from './optionalSites';

describe('DEFAULT_ENABLED_SITES', () => {
  it('starts every optional site off', () => {
    // Nothing is granted on a fresh install, so a site defaulted on would
    // attempt injection and fail. docs/PERMISSIONS.md called this out as the
    // one step in "adding another optional site" with no guard.
    for (const [siteId, meta] of Object.entries(ACTIVITIES)) {
      if (!meta.optionalPermission) continue;
      expect(DEFAULT_ENABLED_SITES[siteId], siteId).toBe(false);
    }
  });

  it('starts every required site on', () => {
    for (const [siteId, meta] of Object.entries(ACTIVITIES)) {
      if (meta.optionalPermission) continue;
      expect(DEFAULT_ENABLED_SITES[siteId], siteId).toBe(true);
    }
  });

  it('covers every registered activity', () => {
    expect(Object.keys(DEFAULT_ENABLED_SITES).sort()).toEqual(
      Object.keys(ACTIVITIES).sort(),
    );
  });
});

describe('ungrantedOptionalSites', () => {
  it('reports an optional site whose origins are not held', async () => {
    expect(await ungrantedOptionalSites(async () => false)).toEqual([
      'soundcloud',
    ]);
  });

  it('reports nothing while the origins are held', async () => {
    expect(await ungrantedOptionalSites(async () => true)).toEqual([]);
  });

  it('never probes a site whose access is required at install', async () => {
    const contains = vi.fn(async () => false);
    await ungrantedOptionalSites(contains);
    expect(contains).toHaveBeenCalledTimes(1);
    expect(contains).toHaveBeenCalledWith([
      '*://soundcloud.com/*',
      '*://*.soundcloud.com/*',
    ]);
  });

  it('asks for exactly the origins the activity is injected on', async () => {
    // If the probe and the injection rule drift, a site can be turned off for
    // lacking an origin it never needed, or left on without one it does.
    const contains = vi.fn(async () => true);
    await ungrantedOptionalSites(contains);
    expect(contains).toHaveBeenCalledWith([
      ...(ACTIVITIES.soundcloud?.matches ?? []),
    ]);
  });

  it('treats an unreadable permission state as held', async () => {
    // Turning a working site off because Chrome would not answer is the worse
    // failure, and it matches what the popup does with the same question.
    const result = await ungrantedOptionalSites(() => {
      throw new Error('permissions unavailable');
    });
    expect(result).toEqual([]);
  });

  it('treats a rejected probe as held', async () => {
    const result = await ungrantedOptionalSites(() =>
      Promise.reject(new Error('nope')),
    );
    expect(result).toEqual([]);
  });
});
