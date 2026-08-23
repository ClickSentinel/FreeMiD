import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  artistFromActivity,
  fallbackLogoPath,
  isUnsupportedPlatformUpdateError,
  windowsSetupUrl,
} from './helpers';

describe('popup helpers', () => {
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
    expect(fallbackLogoPath({ smallImageText: 'Apple Music' })).toBe(
      'icons/applemusic-logo-1024.png',
    );
    expect(fallbackLogoPath({ activityName: 'YouTube Music' })).toBe(
      'icons/ytmusic-logo-1024.png',
    );
    expect(fallbackLogoPath({ sub: 'By YouTube' })).toBe(
      'icons/youtube-logo-1024.png',
    );
    expect(fallbackLogoPath({ activityName: 'Unknown' })).toBeNull();
  });

  it('lets the service label outrank a track that names another service', () => {
    // smallImageText is written by FreeMiD; the artist and subtitle are
    // whatever the track is called. A band called "Tidal Wave" on SoundCloud
    // used to be served the TIDAL logo.
    expect(
      fallbackLogoPath({
        smallImageText: 'SoundCloud',
        activityName: 'Tidal Wave',
        sub: 'by Tidal Wave',
      }),
    ).toBe('icons/soundcloud-logo-1024.png');
    expect(
      fallbackLogoPath({
        smallImageText: 'TIDAL',
        activityName: 'Apple Music Appreciation Society',
      }),
    ).toBe('icons/tidal-logo-1024.png');
  });

  it('still widens the search when no service label is carried', () => {
    // Desktop presence omits smallImageText unless it also has artwork, so
    // the artist and subtitle stay the only signal in that case.
    expect(fallbackLogoPath({ activityName: 'TIDAL' })).toBe(
      'icons/tidal-logo-1024.png',
    );
    expect(
      fallbackLogoPath({ smallImageText: 'Unknown', sub: 'By YouTube' }),
    ).toBe('icons/youtube-logo-1024.png');
  });

  it('identifies unsupported-platform update errors', () => {
    expect(
      isUnsupportedPlatformUpdateError(
        'automatic updates are not supported on this platform',
      ),
    ).toBe(true);
    expect(isUnsupportedPlatformUpdateError('manual bootstrap required')).toBe(
      true,
    );
    // Case-insensitive
    expect(
      isUnsupportedPlatformUpdateError(
        'Automatic Updates Are Not Supported On This Platform',
      ),
    ).toBe(true);
    // Transient port errors must not trigger the install-guide path
    expect(
      isUnsupportedPlatformUpdateError(
        'Attempting to use a disconnected port object',
      ),
    ).toBe(false);
    expect(isUnsupportedPlatformUpdateError('network error')).toBe(false);
    expect(isUnsupportedPlatformUpdateError(undefined)).toBe(false);
  });

  describe('windowsSetupUrl', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('falls back to the install docs when no override is set', () => {
      expect(windowsSetupUrl()).toBe(
        'https://github.com/ClickSentinel/FreeMiD#installation',
      );
    });

    it('uses the env override when it is a URL', () => {
      vi.stubEnv(
        'VITE_WINDOWS_SETUP_URL',
        'http://127.0.0.1:8787/freemid-setup.exe',
      );
      expect(windowsSetupUrl()).toBe('http://127.0.0.1:8787/freemid-setup.exe');
    });
  });
});
