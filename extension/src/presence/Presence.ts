/**
 * FreeMiD Presence API
 *
 * Activities import this class, construct a Presence, and register an
 * "UpdateData" handler to relay scraped data to the background service worker.
 *
 * Activities import this class, construct a Presence, register an
 * "UpdateData" handler, and call setActivity() with the scraped data.
 * The class relays that data to the background service worker via
 * chrome.runtime.sendMessage.
 */

export interface PresenceData {
  /** Override the Discord Application ID for per-activity artwork */
  applicationId?: string;
  /** Override the "Listening to / Playing / Watching" label shown in Discord */
  name?: string;
  /** 0=Playing  2=Listening  3=Watching  5=Competing */
  type?: 0 | 2 | 3 | 5;
  details?: string;
  state?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  /** Full URL or Discord asset key */
  largeImageKey?: string;
  largeImageText?: string;
  /** URL opened when clicking the large image */
  largeImageUrl?: string;
  /** Full URL or Discord asset key */
  smallImageKey?: string;
  smallImageText?: string;
  /** URL opened when clicking the small image */
  smallImageUrl?: string;
  buttons?: Array<{ label: string; url: string }>;
}

interface PresenceConfig {
  /** Discord Application (client) ID */
  clientId: string;
  /**
   * How often (seconds) the UpdateData handler is called.
   * Minimum 1 s. Default 10 s.
   */
  updateInterval?: number;
}

export class Presence {
  private readonly clientId: string;
  private readonly updateIntervalMs: number;
  private intervalId?: ReturnType<typeof setInterval>;
  private scheduledCallback: (() => void) | undefined;
  private pendingTriggerTimers: ReturnType<typeof setTimeout>[] = [];

  constructor({ clientId, updateInterval = 10 }: PresenceConfig) {
    this.clientId = clientId;
    this.updateIntervalMs = Math.max(1, updateInterval) * 1000;
  }

  /**
   * Register a callback that fires on every update tick.
   * Only "UpdateData" is supported.
   */
  /** Returns false if the extension context has been invalidated (e.g. after reload). */
  private isContextValid(): boolean {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  private sendClear(): void {
    if (!this.isContextValid()) return;
    chrome.runtime
      .sendMessage({ type: 'FREEMID_CLEAR_ACTIVITY' })
      .catch(() => {});
  }

  private clearPendingTriggers(): void {
    for (const t of this.pendingTriggerTimers) clearTimeout(t);
    this.pendingTriggerTimers = [];
  }

  on(event: 'UpdateData', callback: () => void | Promise<void>): void {
    if (event !== 'UpdateData') return;

    // Guard against duplicate instances in the same tab. The MV3 service
    // worker restarts frequently and clears activeActivityTabs each time,
    // so it may re-inject this script into a tab that is already running it.
    // globalThis persists across injections in the same isolated content
    // script world, so we can use it to stop the previous interval before
    // starting a new one — preventing two instances from racing each other
    // with conflicting anchor state.
    const GUARD_KEY = '__freemid_presence_interval';
    const prevId = (globalThis as Record<string, unknown>)[GUARD_KEY] as
      | ReturnType<typeof setInterval>
      | undefined;
    if (prevId !== undefined) clearInterval(prevId);
    if (this.intervalId) clearInterval(this.intervalId);

    const safeCallback = () => {
      // Stop silently if the extension was reloaded — avoids the
      // "Cannot read properties of undefined (reading 'sendMessage')" crash.
      if (!this.isContextValid()) {
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = undefined;
        (globalThis as Record<string, unknown>)[GUARD_KEY] = undefined;
        return;
      }
      void Promise.resolve(callback());
    };

    this.scheduledCallback = safeCallback;
    safeCallback();
    this.intervalId = setInterval(safeCallback, this.updateIntervalMs);
    (globalThis as Record<string, unknown>)[GUARD_KEY] = this.intervalId;
  }

  /** Push presence data to Discord via the background service worker */
  setActivity(data: PresenceData): void {
    if (!this.isContextValid()) return;

    const activity = {
      application_id: data.applicationId ?? this.clientId,
      name: data.name,
      type: data.type ?? 0,
      details: data.details,
      state: data.state,
      timestamps:
        data.startTimestamp !== undefined && data.endTimestamp !== undefined
          ? { start: data.startTimestamp, end: data.endTimestamp }
          : undefined,
      assets:
        data.largeImageKey !== undefined || data.smallImageKey !== undefined
          ? {
              large_image: data.largeImageKey,
              large_text: data.largeImageText,
              large_url: data.largeImageUrl,
              small_image: data.smallImageKey,
              small_text: data.smallImageText,
              small_url: data.smallImageUrl,
            }
          : undefined,
      buttons: data.buttons,
    };

    chrome.runtime
      .sendMessage({ type: 'FREEMID_SET_ACTIVITY', data: activity })
      .catch(() => {
        // Background may not be ready yet; data will be pushed on next tick
      });
  }

  /** Remove the current Discord Rich Presence */
  clearActivity(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.sendClear();
  }

  /**
   * Immediately fire the UpdateData callback without waiting for the next
   * interval tick. Used by event-driven observers (MutationObserver, play/pause
   * events) in activity scripts to push updates as soon as the DOM changes.
   */
  triggerUpdate(): void {
    this.scheduledCallback?.();
  }

  /**
   * Schedule triggerUpdate() calls after each of the given delays (ms),
   * cancelling any previously scheduled calls first. Use this on `play` events
   * instead of raw setTimeout so that rapid song skips don't leave overlapping
   * timer chains that fire with stale or inconsistent DOM state.
   */
  scheduleTrigger(...delays: number[]): void {
    this.clearPendingTriggers();
    this.pendingTriggerTimers = delays.map((d) =>
      setTimeout(() => this.triggerUpdate(), d),
    );
  }

  /**
   * Abort any AbortController stored from a previous injection of this
   * activity script, then return a fresh AbortSignal for the current one.
   * Activity scripts pass this signal to addEventListener and MutationObserver
   * cleanup handlers so they are removed automatically on re-injection.
   */
  freshSignal(): AbortSignal {
    this.clearPendingTriggers();

    const KEY = '__freemid_events_abort';
    const prev = (globalThis as Record<string, unknown>)[KEY] as
      | AbortController
      | undefined;
    prev?.abort();
    const controller = new AbortController();
    (globalThis as Record<string, unknown>)[KEY] = controller;
    return controller.signal;
  }

  /**
   * Observe `selector` for DOM mutations and call triggerUpdate() when it
   * changes. If the element is not yet in the DOM, a document.body watcher
   * waits for it to appear. Both observers are tied to `signal` (obtained from
   * freshSignal()) so they are disconnected when the activity is re-injected.
   *
   * Pass `observeAttributes: true` for sites that signal state changes (e.g.
   * play/pause) via attribute mutations like `aria-hidden` rather than text
   * or child changes. Pass `attributeFilter` alongside it to narrow which
   * attributes trigger an update, instead of the whole subtree's attributes —
   * recommended whenever the specific attribute(s) are known, since an
   * unfiltered subtree observer fires on every attribute mutation under
   * `selector`, not just the one(s) actually being watched for.
   */
  watchSelector(
    selector: string,
    signal: AbortSignal,
    options?: { observeAttributes?: boolean; attributeFilter?: string[] },
  ): void {
    const connect = (el: Element): void => {
      const obs = new MutationObserver(() => this.triggerUpdate());
      obs.observe(el, {
        characterData: true,
        childList: true,
        subtree: true,
        attributes: options?.observeAttributes,
        attributeFilter: options?.attributeFilter,
      });
      signal.addEventListener('abort', () => obs.disconnect());
    };

    const el = document.querySelector(selector);
    if (el) {
      connect(el);
    } else {
      const watcher = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          watcher.disconnect();
          connect(found);
        }
      });
      watcher.observe(document.body, { childList: true, subtree: true });
      signal.addEventListener('abort', () => watcher.disconnect());
    }
  }

  /**
   * Send a clear to Discord without stopping the update interval.
   * Use this inside UpdateData handlers to flush stale presence state
   * while keeping the tick running (unlike clearActivity which stops it).
   */
  clearPresenceData(): void {
    this.sendClear();
  }

  /**
   * Utility: get the value of a query-string parameter from the current URL.
   */
  static getPageVariable(
    varName: string,
    searchURL?: string,
  ): string | undefined {
    const url = new URL(searchURL ?? window.location.href);
    return url.searchParams.get(varName) ?? undefined;
  }
}
