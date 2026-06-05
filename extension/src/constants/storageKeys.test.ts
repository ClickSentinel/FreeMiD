import { describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from './storageKeys';

describe('STORAGE_KEYS', () => {
  it('exposes the expected persisted key names', () => {
    expect(STORAGE_KEYS).toEqual({
      paused: 'paused',
      enabledSites: 'enabledSites',
      latestVersion: 'latestVersion',
    });
  });
});