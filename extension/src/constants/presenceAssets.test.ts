import { describe, expect, it } from 'vitest';

import { PRESENCE_ASSET_KEYS, PRESENCE_PREVIEW_ASSETS } from './presenceAssets';

describe('presence assets', () => {
  it('includes the expected Discord asset keys', () => {
    expect(PRESENCE_ASSET_KEYS).toEqual({
      youtubeLogo: 'youtube-logo-1024',
      tidalLogo: 'tidal-logo-1024',
      ytmusicLogo: 'ytmusic-logo-1024',
    });
  });

  it('includes the expected local preview asset paths', () => {
    expect(PRESENCE_PREVIEW_ASSETS).toEqual({
      youtubeLogo: 'icons/youtube-logo-1024.png',
      tidalLogo: 'icons/tidal-logo-1024.png',
      ytmusicLogo: 'icons/ytmusic-logo-1024.png',
    });
  });
});
