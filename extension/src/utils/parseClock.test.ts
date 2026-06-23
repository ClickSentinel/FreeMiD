import { describe, expect, it } from 'vitest';

import { parseClock } from './parseClock';

describe('parseClock', () => {
  it('parses mm:ss values', () => {
    expect(parseClock('03:15')).toBe(195);
  });

  it('parses hh:mm:ss values', () => {
    expect(parseClock('1:02:03')).toBe(3723);
  });

  it('trims surrounding whitespace', () => {
    expect(parseClock(' 04:05 ')).toBe(245);
  });

  it('returns undefined for invalid values', () => {
    expect(parseClock('nope')).toBeUndefined();
    expect(parseClock('1:xx')).toBeUndefined();
    expect(parseClock('1')).toBeUndefined();
    expect(parseClock('1:2:3:4')).toBeUndefined();
  });
});
