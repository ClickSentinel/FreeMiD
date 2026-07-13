import { describe, expect, it } from 'vitest';

import { parseIsoDuration } from './parseIsoDuration';

describe('parseIsoDuration', () => {
  it('parses seconds only', () => {
    expect(parseIsoDuration('PT2S')).toBe(2);
  });

  it('parses minutes and seconds', () => {
    expect(parseIsoDuration('PT1M28S')).toBe(88);
  });

  it('parses hours, minutes, and seconds', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
  });

  it('returns undefined for missing or invalid input', () => {
    expect(parseIsoDuration(undefined)).toBeUndefined();
    expect(parseIsoDuration(null)).toBeUndefined();
    expect(parseIsoDuration('')).toBeUndefined();
    expect(parseIsoDuration('not-a-duration')).toBeUndefined();
    expect(parseIsoDuration('PT')).toBeUndefined();
  });
});
