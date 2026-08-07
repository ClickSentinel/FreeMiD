/**
 * FreeMiD debug logging.
 *
 * MV3 splits an extension across three consoles — the page (content scripts),
 * the service worker, and the popup — which makes collecting a coherent trace
 * of a single event painful. This funnels all three into one ordered buffer
 * owned by the background worker, exportable from the settings page.
 *
 * Off by default. When disabled every call site costs one boolean check.
 */

import { STORAGE_KEYS } from '../constants/storageKeys';

export interface DebugEntry {
  /** Epoch ms — the only way to order entries across contexts. */
  t: number;
  /** Where it came from, e.g. 'bg', 'presence', 'ytmusic'. */
  scope: string;
  /** Short stable event name, e.g. 'throttle-defer'. */
  event: string;
  data?: unknown;
}

export const DEBUG_MESSAGE_TYPE = 'FREEMID_DEBUG_LOG';

let enabled = false;
let sink: ((entry: DebugEntry) => void) | null = null;

/**
 * The background installs a direct sink; every other context leaves this unset
 * and forwards over runtime messaging instead.
 */
export function setDebugSink(fn: (entry: DebugEntry) => void): void {
  sink = fn;
}

/** Drop the local sink so entries fall back to runtime messaging. */
export function clearDebugSink(): void {
  sink = null;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

/** Exposed for tests and for the settings page's optimistic toggle. */
export function setDebugEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Read the flag from storage and keep it current. Safe to call from any
 * context; failures are swallowed so a missing storage permission or an
 * invalidated context can never break presence.
 */
export function initDebugFlag(): Promise<void> {
  try {
    return chrome.storage.local
      .get(STORAGE_KEYS.debugEnabled)
      .then((stored) => {
        enabled = stored[STORAGE_KEYS.debugEnabled] === true;
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          const change = changes[STORAGE_KEYS.debugEnabled];
          if (change) enabled = change.newValue === true;
        });
      })
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Record a debug event. No-op unless debug logging is enabled.
 *
 * Keep `data` small and JSON-serialisable — entries are persisted to
 * chrome.storage.local and shown verbatim in the exported log.
 */
export function debugLog(scope: string, event: string, data?: unknown): void {
  if (!enabled) return;

  const entry: DebugEntry = { t: Date.now(), scope, event };
  if (data !== undefined) entry.data = data;

  if (sink) {
    sink(entry);
    return;
  }

  try {
    // Content scripts and the popup forward to the background's buffer. The
    // context can be invalidated mid-flight (extension reload), which throws
    // synchronously rather than rejecting — hence the try as well as the catch.
    void chrome.runtime
      .sendMessage({ type: DEBUG_MESSAGE_TYPE, entry })
      ?.catch(() => {});
  } catch {
    // Extension reloaded out from under us — drop the entry.
  }
}
