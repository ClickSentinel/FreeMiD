import { describe, expect, it } from 'vitest';

import { urlLike } from './urlLike';

describe('urlLike', () => {
  it('detects URL-like image values', () => {
    expect(urlLike('https://example.com/image.png')).toBe(true);
    expect(urlLike('http://example.com/image.png')).toBe(true);
    expect(urlLike('youtube-logo-1024')).toBe(false);
    expect(urlLike(undefined)).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(urlLike('javascript:alert(1)')).toBe(false);
    expect(urlLike('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(urlLike('file:///etc/passwd')).toBe(false);
  });
});
