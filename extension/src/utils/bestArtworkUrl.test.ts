import { describe, expect, it } from 'vitest';

import { bestArtworkUrl } from './bestArtworkUrl';

const img = (src: string, sizes?: string): MediaImage =>
  ({ src, sizes }) as MediaImage;

describe('bestArtworkUrl', () => {
  it('returns nothing for a missing or empty list', () => {
    expect(bestArtworkUrl(undefined)).toBeUndefined();
    expect(bestArtworkUrl([])).toBeUndefined();
  });

  it('picks the largest by area, not by array order', () => {
    expect(
      bestArtworkUrl([
        img('https://example.test/large.jpg', '512x512'),
        img('https://example.test/small.jpg', '96x96'),
      ]),
    ).toBe('https://example.test/large.jpg');
  });

  it('reads a multi-size entry rather than scoring it zero', () => {
    // "96x96 128x128" is spec-legal. Splitting the whole string on "x" parses
    // the middle token as NaN and drops the entry below a single-size one.
    expect(
      bestArtworkUrl([
        img('https://example.test/single.jpg', '100x100'),
        img('https://example.test/multi.jpg', '96x96 512x512'),
      ]),
    ).toBe('https://example.test/multi.jpg');
  });

  it('rejects a src that is not URL-like', () => {
    expect(
      bestArtworkUrl([img('javascript:alert(1)', '512x512')]),
    ).toBeUndefined();
  });

  it('prefers a sized entry over an unparseable one', () => {
    expect(
      bestArtworkUrl([
        img('https://example.test/unknown.jpg', 'any'),
        img('https://example.test/sized.jpg', '64x64'),
      ]),
    ).toBe('https://example.test/sized.jpg');
  });

  it('still returns an entry when no size can be read', () => {
    expect(bestArtworkUrl([img('https://example.test/only.jpg')])).toBe(
      'https://example.test/only.jpg',
    );
  });
});
