import { describe, expect, it } from 'vitest';

import { SESSION_KEYS, STORAGE_KEYS } from './storageKeys';

describe('STORAGE_KEYS', () => {
  it('exposes the expected persisted key names', () => {
    expect(STORAGE_KEYS).toEqual({
      paused: 'paused',
      enabledSites: 'enabledSites',
      latestVersion: 'latestVersion',
    });
  });
});

describe('SESSION_KEYS', () => {
  it('exposes the expected session key names', () => {
    expect(SESSION_KEYS).toEqual({
      pendingReconnect: 'freemid_pending_reconnect',
    });
  });
});
