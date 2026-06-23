export const STORAGE_KEYS = {
  paused: 'paused',
  enabledSites: 'enabledSites',
  latestVersion: 'latestVersion',
} as const;

/** Keys for chrome.storage.session — survives SW restarts, cleared on browser close. */
export const SESSION_KEYS = {
  pendingReconnect: 'freemid_pending_reconnect',
} as const;
