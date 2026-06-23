import { describe, expect, it } from 'vitest';

import { ACTIVITY_REGISTRY } from './registry';

describe('ACTIVITY_REGISTRY', () => {
  it('contains the expected activity IDs', () => {
    expect(Object.keys(ACTIVITY_REGISTRY).sort()).toEqual([
      'tidal',
      'youtube',
      'youtubemusic',
    ]);
  });

  it('keeps the expected YouTube match patterns', () => {
    expect(ACTIVITY_REGISTRY.youtube.matches).toEqual([
      '*://www.youtube.com/*',
      '*://youtube.com/*',
    ]);
  });

  it('keeps the expected YouTube Music and TIDAL match patterns', () => {
    expect(ACTIVITY_REGISTRY.youtubemusic.matches).toEqual([
      '*://music.youtube.com/*',
    ]);
    expect(ACTIVITY_REGISTRY.tidal.matches).toEqual([
      '*://tidal.com/*',
      '*://listen.tidal.com/*',
    ]);
  });
});
