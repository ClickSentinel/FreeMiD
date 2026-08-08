export const STORAGE_KEYS = {
  paused: 'paused',
  enabledSites: 'enabledSites',
  latestVersion: 'latestVersion',
  /** Debug logging toggle (off by default; set from the settings page). */
  debugEnabled: 'debugEnabled',
  /** Persisted debug ring buffer — survives service-worker teardown. */
  debugLog: 'debugLog',
} as const;

/** Keys for chrome.storage.session — survives SW restarts, cleared on browser close. */
export const SESSION_KEYS = {
  pendingReconnect: 'freemid_pending_reconnect',
} as const;
