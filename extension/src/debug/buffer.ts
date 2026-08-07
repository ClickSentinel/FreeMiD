/**
 * Background-owned ring buffer for debug entries.
 *
 * Persisted to chrome.storage.local because the service worker is torn down
 * routinely — and worker teardown is itself one of the things worth debugging,
 * so an in-memory-only buffer would lose exactly the traces we want.
 */

import { STORAGE_KEYS } from '../constants/storageKeys';
import { DEBUG_FLUSH_DEBOUNCE_MS } from '../constants/timing';
import { type DebugEntry, setDebugSink } from './log';

/** Roughly an hour of steady-state playback at the current tick rate. */
export const DEBUG_MAX_ENTRIES = 1000;

let entries: DebugEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void chrome.storage.local
      .set({ [STORAGE_KEYS.debugLog]: entries })
      .catch(() => {});
  }, DEBUG_FLUSH_DEBOUNCE_MS);
}

/**
 * Append an already-stamped entry. Used both by the local sink and by the
 * background's handler for entries forwarded from other contexts — those carry
 * their own timestamp and must not be re-stamped, or cross-context ordering
 * would collapse to "whenever the message happened to arrive".
 */
export function appendDebugEntry(entry: DebugEntry): void {
  entries.push(entry);
  if (entries.length > DEBUG_MAX_ENTRIES) {
    entries.splice(0, entries.length - DEBUG_MAX_ENTRIES);
  }
  scheduleFlush();
}

/** Rehydrate from storage and start receiving entries. Background only. */
export async function initDebugBuffer(): Promise<void> {
  // Claim the sink before awaiting: the flag may resolve first and flush its
  // pre-init queue, and without a sink those entries would go out over runtime
  // messaging — from the background to itself.
  setDebugSink(appendDebugEntry);

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.debugLog);
    const restored = stored[STORAGE_KEYS.debugLog];
    if (Array.isArray(restored)) {
      // Prepend rather than replace: anything appended while the read was in
      // flight is newer than what was persisted, and must survive rehydration.
      entries = [...(restored as DebugEntry[]), ...entries].slice(
        -DEBUG_MAX_ENTRIES,
      );
    }
  } catch {
    // Keep whatever has accumulated if storage is unavailable.
  }
}

export function getDebugEntries(): DebugEntry[] {
  return entries;
}

export function clearDebugEntries(): void {
  entries = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void chrome.storage.local.remove(STORAGE_KEYS.debugLog).catch(() => {});
}

/** Test seam — lets the buffer be reset between cases. */
export function __setDebugEntriesForTest(next: DebugEntry[]): void {
  entries = next;
}
