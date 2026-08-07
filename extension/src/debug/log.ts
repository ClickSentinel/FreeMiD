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
 * Whether the flag has been resolved from storage yet. Until it has, we cannot
 * know whether an entry should be kept, so entries are held rather than
 * dropped — see debugLog().
 */
let flagResolved = false;

/**
 * Entries recorded before the flag resolved. Bounded: a context that never
 * calls initDebugFlag() (or whose storage read never settles) must not grow
 * this without limit.
 */
let preInitQueue: DebugEntry[] = [];
const PRE_INIT_QUEUE_MAX = 50;

/**
 * The background installs a direct sink; every other context leaves this unset
 * and forwards over runtime messaging instead.
 */
export function setDebugSink(fn: (entry: DebugEntry) => void): void {
  sink = fn;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

function emit(entry: DebugEntry): void {
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

/** Settle the flag and release anything recorded while it was unknown. */
function resolveFlag(value: boolean): void {
  enabled = value;
  flagResolved = true;
  const queued = preInitQueue;
  preInitQueue = [];
  if (value) for (const entry of queued) emit(entry);
}

/**
 * Set the flag directly, bypassing storage. Used by tests; also settles the
 * flag, so entries stop being queued.
 */
export function setDebugEnabled(value: boolean): void {
  resolveFlag(value);
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
        resolveFlag(stored[STORAGE_KEYS.debugEnabled] === true);
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          const change = changes[STORAGE_KEYS.debugEnabled];
          if (change) enabled = change.newValue === true;
        });
      })
      .catch(() => resolveFlag(false));
  } catch {
    resolveFlag(false);
    return Promise.resolve();
  }
}

/** Test seam — restore module state between cases. */
export function __resetDebugForTest(): void {
  enabled = false;
  sink = null;
  flagResolved = false;
  preInitQueue = [];
}

/**
 * Record a debug event. No-op unless debug logging is enabled.
 *
 * Keep `data` small and JSON-serialisable — entries are persisted to
 * chrome.storage.local and shown verbatim in the exported log.
 */
export function debugLog(scope: string, event: string, data?: unknown): void {
  // Fast path once the flag is known and off — one boolean check.
  if (flagResolved && !enabled) return;

  const entry: DebugEntry = { t: Date.now(), scope, event };
  if (data !== undefined) entry.data = data;

  if (!flagResolved) {
    // Activities wire up their observers synchronously at injection, which is
    // before the storage read resolves. Dropping those entries would silently
    // hide exactly the setup we want to inspect (observer-attach), so hold
    // them — with their original timestamps — until the flag is known.
    if (preInitQueue.length < PRE_INIT_QUEUE_MAX) preInitQueue.push(entry);
    return;
  }

  emit(entry);
}
