import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  isHostSelfUpdateSupported,
  isUpdateAvailable,
  isUpdateAvailableForHost,
  lookupArtworkUrl,
  matchActivity,
  parseUrl,
  preferredUpdateVersion,
  urlMatchesPattern,
} from './helpers';

describe('background helpers', () => {
  it('matches Chrome-style host patterns against URLs', () => {
    expect(
      urlMatchesPattern(
        'https://www.youtube.com/watch?v=abc',
        '*://www.youtube.com/*',
      ),
    ).toBe(true);
    expect(
      urlMatchesPattern(
        'https://music.youtube.com/watch?v=abc',
        '*://music.youtube.com/*',
      ),
    ).toBe(true);
    expect(
      urlMatchesPattern('https://example.com/', '*://www.youtube.com/*'),
    ).toBe(false);
    expect(urlMatchesPattern('notaurl', '*://www.youtube.com/*')).toBe(false);
  });

  it('maps known URLs to activity metadata', () => {
    expect(matchActivity('https://www.youtube.com/watch?v=abc')?.id).toBe(
      'youtube',
    );
    expect(matchActivity('https://music.youtube.com/watch?v=abc')?.id).toBe(
      'youtubemusic',
    );
    expect(matchActivity('https://listen.tidal.com/album/123')?.id).toBe(
      'tidal',
    );
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

  it('chooses newer of extension and cached latest for display/decision baseline', () => {
    expect(preferredUpdateVersion('0.3.11', '0.3.14')).toBe('0.3.14');
    expect(preferredUpdateVersion('0.3.15', '0.3.14')).toBe('0.3.15');
    expect(preferredUpdateVersion(null, '0.3.14')).toBe('0.3.14');
  });

  it('detects update availability against host using computed baseline', () => {
    expect(isUpdateAvailableForHost('0.3.13', '0.3.11', '0.3.14')).toBe(true);
    expect(isUpdateAvailableForHost('0.3.14', '0.3.11', '0.3.14')).toBe(false);
    expect(isUpdateAvailableForHost('0.3.14', '0.3.15', '0.3.14')).toBe(true);
    expect(isUpdateAvailableForHost(null, '0.3.15', '0.3.14')).toBe(false);
  });

  it('gates self-update to hosts at or above minimum supported version', () => {
    expect(isHostSelfUpdateSupported('0.4.0')).toBe(true);
    expect(isHostSelfUpdateSupported('0.4.1')).toBe(true);
    expect(isHostSelfUpdateSupported('0.3.15')).toBe(false);
    expect(isHostSelfUpdateSupported('0.3.12')).toBe(false);
    expect(isHostSelfUpdateSupported(null)).toBe(false);
  });

  it('enforces stricter minimum on Windows hosts', () => {
    expect(isHostSelfUpdateSupported('0.3.15', '0.4.0', 'windows')).toBe(false);
    expect(isHostSelfUpdateSupported('0.4.0', '0.4.0', 'windows')).toBe(true);
    expect(isHostSelfUpdateSupported('0.4.1', '0.4.0', 'windows')).toBe(true);
  });

  it('parseUrl returns a URL object for valid input and null for invalid', () => {
    expect(parseUrl('https://example.com/path')?.hostname).toBe('example.com');
    expect(parseUrl('not a url')).toBeNull();
    expect(parseUrl('')).toBeNull();
  });
});

// ── lookupArtworkUrl ──────────────────────────────────────────────────────────

type MbRelease = {
  id: string;
  title?: string;
  status?: string;
  'release-group'?: { id: string; 'primary-type'?: string };
};

type MbRecording = { releases?: MbRelease[] };

function mbOk(recordings: MbRecording[]): Partial<Response> {
  return { ok: true, json: async () => ({ recordings }) } as Partial<Response>;
}

function caOk(url: string): Partial<Response> {
  return { ok: true, url } as Partial<Response>;
}

function caFail(): Partial<Response> {
  return { ok: false, url: '' } as Partial<Response>;
}

/**
 * Stubs globalThis.fetch with a handler that receives a pre-parsed URL object.
 * Use `parsed.hostname` and `parsed.pathname` to route responses — never
 * `rawUrl.includes('hostname')`, which CodeQL flags as incomplete sanitization.
 */
function stubFetch(
  handler: (parsed: URL) => Partial<Response>,
): ReturnType<typeof vi.fn> {
  const fn = vi
    .fn()
    .mockImplementation((rawUrl: string) =>
      Promise.resolve(handler(new URL(rawUrl))),
    );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Extract the hostname from a raw URL string captured in mock.calls. */
function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

describe('lookupArtworkUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  function mockChrome(): void {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { runtime: { getManifest: () => ({ version: '0.4.2' }) } },
    });
  }

  it('returns null when the MusicBrainz fetch throws', async () => {
    mockChrome();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBeNull();
  });

  it('returns null when MusicBrainz returns a non-OK response', async () => {
    mockChrome();
    stubFetch(() => ({ ok: false }));
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBeNull();
  });

  it('returns null when the recordings array is empty', async () => {
    mockChrome();
    const fetchFn = stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk([]) : caFail(),
    );
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBeNull();
    // No Cover Art Archive requests should be made when there are no candidates.
    expect(
      (fetchFn.mock.calls as [string][]).filter(
        ([u]) => hostnameOf(u) === 'coverartarchive.org',
      ),
    ).toHaveLength(0);
  });

  it('skips non-Official releases and makes no Cover Art Archive requests', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      {
        id: 'rel-1',
        status: 'Bootleg',
        'release-group': { id: 'rg-1', 'primary-type': 'Album' },
      },
    ];
    const fetchFn = stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk([{ releases }]) : caFail(),
    );
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBeNull();
    expect(
      (fetchFn.mock.calls as [string][]).filter(
        ([u]) => hostnameOf(u) === 'coverartarchive.org',
      ),
    ).toHaveLength(0);
  });

  it('returns the release-group art URL when Cover Art Archive responds OK', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      {
        id: 'rel-1',
        status: 'Official',
        'release-group': { id: 'rg-1', 'primary-type': 'Album' },
      },
    ];
    stubFetch((url) => {
      if (url.hostname === 'musicbrainz.org') return mbOk([{ releases }]);
      if (url.pathname.includes('/release-group/rg-1'))
        return caOk('https://ia.example.com/art.jpg');
      return caFail();
    });
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBe(
      'https://ia.example.com/art.jpg',
    );
  });

  it('falls back to the release endpoint when the release-group endpoint returns no art', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      {
        id: 'rel-1',
        status: 'Official',
        'release-group': { id: 'rg-1', 'primary-type': 'Album' },
      },
    ];
    stubFetch((url) => {
      if (url.hostname === 'musicbrainz.org') return mbOk([{ releases }]);
      if (url.pathname.startsWith('/release-group/')) return caFail();
      if (url.pathname.includes('/release/rel-1'))
        return caOk('https://ia.example.com/rel.jpg');
      return caFail();
    });
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBe(
      'https://ia.example.com/rel.jpg',
    );
  });

  it('returns null when all Cover Art Archive endpoints fail', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      {
        id: 'rel-1',
        status: 'Official',
        'release-group': { id: 'rg-1', 'primary-type': 'Album' },
      },
    ];
    stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk([{ releases }]) : caFail(),
    );
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBeNull();
  });

  it('prioritises the album-name-matched release over other Album releases', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      {
        id: 'rel-other',
        title: 'Different Album',
        status: 'Official',
        'release-group': { id: 'rg-other', 'primary-type': 'Album' },
      },
      {
        id: 'rel-match',
        title: 'My Album',
        status: 'Official',
        'release-group': { id: 'rg-match', 'primary-type': 'Album' },
      },
    ];
    const fetchFn = stubFetch((url) => {
      if (url.hostname === 'musicbrainz.org') return mbOk([{ releases }]);
      if (url.pathname.includes('/rg-match'))
        return caOk('https://ia.example.com/match.jpg');
      if (url.pathname.includes('/rg-other'))
        return caOk('https://ia.example.com/other.jpg');
      return caFail();
    });

    const result = await lookupArtworkUrl('Artist', 'Title', 'My Album');
    expect(result).toBe('https://ia.example.com/match.jpg');
    // The first Cover Art Archive call must be for the name-matched release-group.
    const caaCalls = (fetchFn.mock.calls as [string][]).filter(
      ([u]) => hostnameOf(u) === 'coverartarchive.org',
    );
    expect(caaCalls[0]?.[0]).toContain('rg-match');
  });

  it('deduplicates release-group IDs across recordings', async () => {
    mockChrome();
    const sharedRelease: MbRelease = {
      id: 'rel-1',
      status: 'Official',
      'release-group': { id: 'rg-shared', 'primary-type': 'Album' },
    };
    // Three recordings, all pointing to the same release-group.
    const recordings: MbRecording[] = [
      { releases: [sharedRelease] },
      { releases: [sharedRelease] },
      { releases: [sharedRelease] },
    ];
    const fetchFn = stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk(recordings) : caFail(),
    );
    await lookupArtworkUrl('Artist', 'Title');
    const caaCalls = (fetchFn.mock.calls as [string][]).filter(
      ([u]) => hostnameOf(u) === 'coverartarchive.org',
    );
    // Only 1 release-group attempt + 1 release fallback (both for the single deduplicated candidate).
    expect(caaCalls).toHaveLength(2);
  });

  it('falls back to the release endpoint when a release has no release-group', async () => {
    mockChrome();
    const releases: MbRelease[] = [
      { id: 'rel-no-rg', status: 'Official' }, // no release-group field
    ];
    stubFetch((url) => {
      if (url.hostname === 'musicbrainz.org') return mbOk([{ releases }]);
      if (url.pathname.includes('/release/rel-no-rg'))
        return caOk('https://ia.example.com/norg.jpg');
      return caFail();
    });
    await expect(lookupArtworkUrl('Artist', 'Title')).resolves.toBe(
      'https://ia.example.com/norg.jpg',
    );
  });

  it('includes -video:true in the MusicBrainz query to exclude music videos', async () => {
    mockChrome();
    const fetchFn = stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk([]) : caFail(),
    );
    await lookupArtworkUrl('Artist', 'Title');
    const mbUrl =
      (fetchFn.mock.calls as [string][]).find(
        ([u]) => hostnameOf(u) === 'musicbrainz.org',
      )?.[0] ?? '';
    expect(decodeURIComponent(mbUrl)).toContain('-video:true');
  });

  it('escapes backslashes in artist and title before encoding the Lucene query', async () => {
    mockChrome();
    const fetchFn = stubFetch((url) =>
      url.hostname === 'musicbrainz.org' ? mbOk([]) : caFail(),
    );
    await lookupArtworkUrl('AC\\DC', 'Back in Black');
    const mbUrl =
      (fetchFn.mock.calls as [string][]).find(
        ([u]) => hostnameOf(u) === 'musicbrainz.org',
      )?.[0] ?? '';
    const decoded = decodeURIComponent(mbUrl);
    // Backslash must be doubled so the Lucene parser sees a literal backslash.
    expect(decoded).toContain('artist:"AC\\\\DC"');
  });
});
