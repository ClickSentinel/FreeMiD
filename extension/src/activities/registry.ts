/**
 * Activity Registry
 *
 * Maps activity IDs to their metadata. The background service worker uses
 * this to decide which activity script to inject for a given URL.
 *
 * Add new activities here when you add a new src/activities/<id>/index.ts.
 */

export interface ActivityMeta {
  id: string;
  name: string;
  /** URL match patterns (supports * glob). No protocol needed. */
  matches: string[];
  /**
   * Request these origins at runtime instead of declaring them as required
   * host permissions.
   *
   * Adding a required host permission to a published extension makes Chrome
   * disable it for every existing user until they re-approve — disruptive for
   * people who will never use the site. Optional permissions are requested
   * from the popup when the user first enables the toggle, so nobody else is
   * interrupted. See docs/PERMISSIONS.md.
   */
  optionalPermission?: boolean;
}

export const ACTIVITY_REGISTRY = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    matches: ['*://www.youtube.com/*', '*://youtube.com/*'],
  },
  youtubemusic: {
    id: 'youtubemusic',
    name: 'YouTube Music',
    matches: ['*://music.youtube.com/*'],
  },
  tidal: {
    id: 'tidal',
    name: 'TIDAL',
    matches: ['*://tidal.com/*', '*://listen.tidal.com/*'],
  },
  applemusic: {
    id: 'applemusic',
    name: 'Apple Music',
    matches: ['*://music.apple.com/*'],
  },
  soundcloud: {
    id: 'soundcloud',
    name: 'SoundCloud',
    matches: ['*://soundcloud.com/*', '*://*.soundcloud.com/*'],
    optionalPermission: true,
  },
} satisfies Record<string, ActivityMeta>;

/**
 * The same registry as a uniform map.
 *
 * ACTIVITY_REGISTRY uses `satisfies` so each entry keeps its literal type,
 * which is what lets tests assert on exact match patterns — but it also means
 * an entry without `optionalPermission` has no such property to read. This view
 * restores the shared shape for iteration and lookup.
 */
export const ACTIVITIES: Record<string, ActivityMeta> = ACTIVITY_REGISTRY;
