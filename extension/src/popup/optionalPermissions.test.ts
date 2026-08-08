import { describe, expect, it } from 'vitest';

import { ACTIVITIES, ACTIVITY_REGISTRY } from '../activities/registry';
import { optionalOriginsFor } from './helpers';

describe('optionalOriginsFor', () => {
  it('returns the origins for a site granted at runtime', () => {
    expect(optionalOriginsFor('soundcloud')).toEqual([
      '*://soundcloud.com/*',
      '*://*.soundcloud.com/*',
    ]);
  });

  it('returns nothing for sites whose access is required at install', () => {
    for (const siteId of ['youtube', 'youtubemusic', 'tidal', 'applemusic']) {
      expect(optionalOriginsFor(siteId), siteId).toBeUndefined();
    }
  });

  it('returns nothing for an unknown site', () => {
    expect(optionalOriginsFor('nope')).toBeUndefined();
  });

  it('hands back a copy, so a caller cannot mutate the registry', () => {
    const origins = optionalOriginsFor('soundcloud');
    origins?.push('*://evil.example/*');
    expect(ACTIVITY_REGISTRY.soundcloud.matches).toHaveLength(2);
  });

  it('asks for exactly the origins the activity is injected on', () => {
    // If these drift apart, the extension either requests access it never uses
    // or injects into a host it was never granted.
    expect(optionalOriginsFor('soundcloud')).toEqual([
      ...ACTIVITY_REGISTRY.soundcloud.matches,
    ]);
  });
});

describe('optional permission declarations', () => {
  it('keeps every optional site out of the required manifest permissions', async () => {
    // A required host permission added to a published extension disables it for
    // every existing user until they re-approve, which is the whole reason this
    // path exists.
    const manifest = (await import(
      '../../public/manifest.json'
    )) as unknown as {
      default: {
        host_permissions: string[];
        optional_host_permissions?: string[];
      };
    };
    const { host_permissions, optional_host_permissions = [] } =
      manifest.default;

    for (const [siteId, meta] of Object.entries(ACTIVITIES)) {
      if (!meta.optionalPermission) continue;
      for (const match of meta.matches) {
        expect(
          host_permissions,
          `${siteId} must not be required`,
        ).not.toContain(match);
        expect(
          optional_host_permissions,
          `${siteId} must be declared optional`,
        ).toContain(match);
      }
    }
  });

  it('keeps every non-optional site in the required manifest permissions', async () => {
    const manifest = (await import(
      '../../public/manifest.json'
    )) as unknown as {
      default: { host_permissions: string[] };
    };

    for (const [siteId, meta] of Object.entries(ACTIVITIES)) {
      if (meta.optionalPermission) continue;
      for (const match of meta.matches) {
        expect(
          manifest.default.host_permissions,
          `${siteId} needs ${match}`,
        ).toContain(match);
      }
    }
  });
});
