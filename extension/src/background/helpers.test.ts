import { describe, expect, it } from 'vitest';

import { compareVersions, isUpdateAvailable, matchActivity, urlMatchesPattern } from './helpers';

describe('background helpers', () => {
  it('matches Chrome-style host patterns against URLs', () => {
    expect(urlMatchesPattern('https://www.youtube.com/watch?v=abc', '*://www.youtube.com/*')).toBe(true);
    expect(urlMatchesPattern('https://music.youtube.com/watch?v=abc', '*://music.youtube.com/*')).toBe(true);
    expect(urlMatchesPattern('https://example.com/', '*://www.youtube.com/*')).toBe(false);
    expect(urlMatchesPattern('notaurl', '*://www.youtube.com/*')).toBe(false);
  });

  it('maps known URLs to activity metadata', () => {
    expect(matchActivity('https://www.youtube.com/watch?v=abc')?.id).toBe('youtube');
    expect(matchActivity('https://music.youtube.com/watch?v=abc')?.id).toBe('youtubemusic');
    expect(matchActivity('https://listen.tidal.com/album/123')?.id).toBe('tidal');
    expect(matchActivity('https://example.com')).toBeNull();
  });

  it('compares semantic versions correctly', () => {
    expect(compareVersions('0.3.13', '0.3.12')).toBeGreaterThan(0);
    expect(compareVersions('0.3.12', '0.3.13')).toBeLessThan(0);
    expect(compareVersions('0.3.13', '0.3.13')).toBe(0);
  });

  it('detects update availability only when latest is newer', () => {
    expect(isUpdateAvailable('0.3.12', '0.3.13')).toBe(true);
    expect(isUpdateAvailable('0.3.13', '0.3.13')).toBe(false);
    expect(isUpdateAvailable(null, '0.3.13')).toBe(false);
    expect(isUpdateAvailable('0.3.12', null)).toBe(false);
  });
});