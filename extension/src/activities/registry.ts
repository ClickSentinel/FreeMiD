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
} satisfies Record<string, ActivityMeta>;
