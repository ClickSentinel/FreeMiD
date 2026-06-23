import { describe, expect, it } from 'vitest';

import { artistFromActivity, fallbackLogoPath, urlLike } from './helpers';

describe('popup helpers', () => {
  it('detects URL-like image values', () => {
    expect(urlLike('https://example.com/image.png')).toBe(true);
    expect(urlLike('http://example.com/image.png')).toBe(true);
    expect(urlLike('youtube-logo-1024')).toBe(false);
    expect(urlLike(undefined)).toBe(false);
  });

  it('prefers subtext artist names over activity name', () => {
    expect(
      artistFromActivity({ sub: 'by Artist Name', activityName: 'YouTube' }),
    ).toBe('Artist Name');
    expect(artistFromActivity({ activityName: 'TIDAL' })).toBe('TIDAL');
    expect(artistFromActivity({})).toBe('');
  });

  it('maps service text to the expected local preview asset path', () => {
    expect(fallbackLogoPath({ smallImageText: 'TIDAL' })).toBe(
      'icons/tidal-logo-1024.png',
    );
    expect(fallbackLogoPath({ activityName: 'YouTube Music' })).toBe(
      'icons/ytmusic-logo-1024.png',
    );
    expect(fallbackLogoPath({ sub: 'By YouTube' })).toBe(
      'icons/youtube-logo-1024.png',
    );
    expect(fallbackLogoPath({ activityName: 'Unknown' })).toBeNull();
  });
});
