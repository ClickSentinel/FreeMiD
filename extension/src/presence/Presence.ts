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

  on(event: 'UpdateData', callback: () => void | Promise<void>): void {
    if (event !== 'UpdateData') return;
    if (this.intervalId) clearInterval(this.intervalId);

    const safeCallback = () => {
      // Stop silently if the extension was reloaded — avoids the
      // "Cannot read properties of undefined (reading 'sendMessage')" crash.
      if (!this.isContextValid()) {
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = undefined;
        return;
      }
      void Promise.resolve(callback());
    };

    safeCallback();
    this.intervalId = setInterval(safeCallback, this.updateIntervalMs);
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
        data.startTimestamp !== undefined || data.endTimestamp !== undefined
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

    chrome.runtime.sendMessage({ type: 'FREEMID_SET_ACTIVITY', data: activity }).catch(() => {
      // Background may not be ready yet; data will be pushed on next tick
    });
  }

  /** Remove the current Discord Rich Presence */
  clearActivity(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (!this.isContextValid()) return;
    chrome.runtime.sendMessage({ type: 'FREEMID_CLEAR_ACTIVITY' }).catch(() => {});
  }

  /**
   * Send a clear to Discord without stopping the update interval.
   * Use this inside UpdateData handlers to flush stale presence state
   * while keeping the tick running (unlike clearActivity which stops it).
   */
  clearPresenceData(): void {
    if (!this.isContextValid()) return;
    chrome.runtime.sendMessage({ type: 'FREEMID_CLEAR_ACTIVITY' }).catch(() => {});
  }

  /**
   * Utility: get the value of a query-string parameter from the current URL.
   */
  static getPageVariable<T = string>(varName: string, searchURL?: string): T | undefined {
    const url = new URL(searchURL ?? window.location.href);
    const val = url.searchParams.get(varName);
    return val !== null ? (val as unknown as T) : undefined;
  }
}
