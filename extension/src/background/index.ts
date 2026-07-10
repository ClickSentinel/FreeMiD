/**
 * FreeMiD — Background Service Worker
 *
 * Responsibilities:
 *  1. Maintain a Chrome Native Messaging port to the FreeMiD native host
 *     (`com.clicksentinel.freemid`), which talks to Discord IPC locally.
 *  2. Watch tabs and inject the right activity content script based on URL.
 *  3. Forward SET_ACTIVITY / CLEAR_ACTIVITY messages from activity scripts
 *     to the native host.
 *  4. Clear status instantly when the active tab leaves a known domain.
 */

import { GITHUB_REPO } from '../constants/github';
import { SESSION_KEYS, STORAGE_KEYS } from '../constants/storageKeys';
import {
  compareVersions,
  isHostSelfUpdateSupported,
  isUpdateAvailableForHost,
  isUpdateInProgress,
  lookupArtworkUrl,
  MIN_SELF_UPDATE_HOST_VERSION,
  MIN_WINDOWS_SELF_UPDATE_HOST_VERSION,
  matchActivity,
  preferredUpdateVersion,
} from './helpers';

const NATIVE_HOST_NAME = 'com.clicksentinel.freemid';
const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID?.trim() || '';
const DEV_UPDATE_LATEST_URL =
  import.meta.env.VITE_UPDATE_LATEST_URL?.trim() || '';
const DEV_UPDATE_RELEASES_BASE =
  import.meta.env.VITE_UPDATE_RELEASES_BASE?.trim() || '';
const DEV_MIN_SELF_UPDATE_HOST_VERSION =
  import.meta.env.VITE_MIN_SELF_UPDATE_HOST_VERSION?.trim() ||
  MIN_SELF_UPDATE_HOST_VERSION;
const DEV_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION =
  import.meta.env.VITE_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION?.trim() ||
  MIN_WINDOWS_SELF_UPDATE_HOST_VERSION;
const IS_WINDOWS_PLATFORM = /Windows/i.test(navigator.userAgent);

// ── Native host port ──────────────────────────────────────────────────────────

let nativePort: chrome.runtime.Port | null = null;
let hostConnected = false; // STDIO port is alive
let discordConnected = false; // Discord IPC handshake succeeded
let lastError: string | null = null;
let paused = false;
let lastActivity: {
  title: string;
  sub: string;
  startTimestamp?: number;
  endTimestamp?: number;
  activityName?: string;
  activityType?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  firstButtonLabel?: string;
} | null = null;
let discordConnectedSince: number | null = null;
let enabledSites: Record<string, boolean> = {
  youtube: true,
  youtubemusic: true,
  tidal: true,
  applemusic: true,
};
let hostVersion: string | null = null;
let hostSelfUpdateSupported: boolean | null = null;
let hostCapabilities: Set<string> = new Set();
let hostRuntimeOs: string | null = null;
let hostRuntimeArch: string | null = null;
let hostBinaryPath: string | null = null;
let latestVersion: string | null = null;
let updateStatus: {
  status:
    | 'requested'
    | 'checking'
    | 'downloading'
    | 'reconnecting'
    | 'up_to_date'
    | 'success'
    | 'failed';
  version?: string;
  error?: string;
} | null = null;
let autoReconnectScheduled = false;
let disconnectReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let applyVerifyTimer: ReturnType<typeof setInterval> | null = null;
let applyVerifyDeadlineMs: number | null = null;
let applyVerifyTargetVersion: string | null = null;
let updateRequestTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectInProgress = false;
let reconnectQueued = false;
let reconnectSettleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingManualReconnect = false;
let manualReconnectRetryTimer: ReturnType<typeof setTimeout> | null = null;
let manualReconnectAttemptsRemaining = 0;
let suspendInProgress = false;
let reconnectCooldownUntilMs = 0;
let presenceHolder: string | null = null; // sourceId that currently holds the Discord presence lock
let lastSentActivityJson: string | null = null; // last payload sent to Discord; skip if identical
// Discord rate-limits SET_ACTIVITY to ~5 per 20 s. We enforce a 5 s minimum
// between sends (4/20 s) to stay safely below it. Rapid song skips schedule a
// trailing flush so the final settled song always reaches Discord.
const DISCORD_MIN_INTERVAL_MS = 5_000;
let lastActivitySentAt = 0;
let pendingActivityFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingActivityPayload: object | null = null;
let activityBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
// Desktop apps reachable via the native host's SMTC bridge (see
// native-host/src/smtc.rs KNOWN_APPS — the `app` id here must match).
const DESKTOP_APPS: Record<
  string,
  { presenceKey: string; brandName: string; logoAssetKey: string }
> = {
  tidal: {
    presenceKey: 'tidal-desktop',
    brandName: 'TIDAL',
    logoAssetKey: 'tidal-logo-1024',
  },
  applemusic: {
    presenceKey: 'applemusic-desktop',
    brandName: 'Apple Music',
    logoAssetKey: 'applemusic-logo-1024',
  },
};
// Reverse lookup: presenceHolder key (e.g. 'tidal-desktop') -> site toggle id
// (e.g. 'tidal') — desktop presence shares its web activity's site toggle.
const DESKTOP_PRESENCE_TO_TOGGLE: Record<string, string> = Object.fromEntries(
  Object.entries(DESKTOP_APPS).map(([appId, cfg]) => [cfg.presenceKey, appId]),
);

// LRU artwork cache keyed by "artist\x00title\x00album". Map insertion order gives
// us LRU eviction for free: delete-then-re-set on read moves entry to the end.
const ART_CACHE_MAX = 200;
const desktopArtCache = new Map<string, string | null>();
const artPending = new Map<string, Promise<string | null>>();

function artCacheGet(key: string): string | null | undefined {
  if (!desktopArtCache.has(key)) return undefined;
  const val = desktopArtCache.get(key) as string | null;
  desktopArtCache.delete(key);
  desktopArtCache.set(key, val);
  return val;
}

function artCacheSet(key: string, value: string | null): void {
  desktopArtCache.delete(key);
  if (desktopArtCache.size >= ART_CACHE_MAX)
    desktopArtCache.delete(desktopArtCache.keys().next().value as string);
  desktopArtCache.set(key, value);
}

function lookupArtworkCached(
  artist: string,
  title: string,
  album?: string,
): Promise<string | null> {
  const key = `${artist}\x00${title}\x00${album ?? ''}`;
  const cached = artCacheGet(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let pending = artPending.get(key);
  if (!pending) {
    pending = lookupArtworkUrl(artist, title, album).then((url) => {
      artCacheSet(key, url);
      artPending.delete(key);
      return url;
    });
    artPending.set(key, pending);
  }
  return pending;
}

const APPLY_VERIFY_INTERVAL_MS = 1000;
const APPLY_VERIFY_TIMEOUT_MS = IS_WINDOWS_PLATFORM ? 130000 : 30000;
const UPDATE_REQUEST_TIMEOUT_MS = IS_WINDOWS_PLATFORM ? 12000 : 8000;
const POST_UPDATE_RECONNECT_DELAY_MS = IS_WINDOWS_PLATFORM ? 5000 : 150;
const DISCONNECT_RECONNECT_DELAY_MS = IS_WINDOWS_PLATFORM ? 5000 : 400;
const RECONNECT_REQUEST_COOLDOWN_MS = IS_WINDOWS_PLATFORM ? 15000 : 8000;
const RECONNECT_CONFIG = IS_WINDOWS_PLATFORM
  ? {
      settleTimeoutMs: 12000,
      manualRetryDelayMs: 700,
      manualMaxAttempts: 12,
    }
  : {
      settleTimeoutMs: 4000,
      manualRetryDelayMs: 300,
      manualMaxAttempts: 6,
    };

function clearApplyVerification(): void {
  if (disconnectReconnectTimer) {
    clearTimeout(disconnectReconnectTimer);
    disconnectReconnectTimer = null;
  }
  if (applyVerifyTimer) {
    clearInterval(applyVerifyTimer);
    applyVerifyTimer = null;
  }
  applyVerifyDeadlineMs = null;
  applyVerifyTargetVersion = null;
}

function clearUpdateRequestTimeout(): void {
  if (updateRequestTimeoutTimer) {
    clearTimeout(updateRequestTimeoutTimer);
    updateRequestTimeoutTimer = null;
  }
}

function manualInstallRequiredError(): string {
  return IS_WINDOWS_PLATFORM
    ? `Manual bootstrap required: install native host v${MIN_WINDOWS_SELF_UPDATE_HOST_VERSION} or later via setup, then retry in-app updates.`
    : 'Manual bootstrap required: install the latest native host once, then retry in-app updates.';
}

function armUpdateRequestTimeout(): void {
  clearUpdateRequestTimeout();
  updateRequestTimeoutTimer = setTimeout(() => {
    updateRequestTimeoutTimer = null;
    if (updateStatus?.status !== 'requested') return;

    updateStatus = {
      status: 'failed',
      error: IS_WINDOWS_PLATFORM
        ? `Host did not acknowledge update. Install v${MIN_WINDOWS_SELF_UPDATE_HOST_VERSION} or later with Setup once, then retry in-app updates.`
        : 'Host did not acknowledge update command. Please reinstall the native host manually.',
    };
    broadcastStatus();
  }, UPDATE_REQUEST_TIMEOUT_MS);
}

function maybeFinalizeAppliedVersion(): boolean {
  if (!applyVerifyTargetVersion || !hostVersion) return false;
  if (compareVersions(hostVersion, applyVerifyTargetVersion) >= 0) {
    clearApplyVerification();
    clearPendingReconnectSession();
    updateStatus = null;
    broadcastStatus();
    return true;
  }
  return false;
}

function clearPendingReconnectSession(): void {
  void chrome.storage.session.remove(SESSION_KEYS.pendingReconnect);
}

function triggerHostUpdate(): { ok: boolean; error?: string } {
  clearApplyVerification();
  clearPendingReconnectSession();
  updateStatus = { status: 'requested' };
  broadcastStatus();
  const ok = sendToHost({
    type: 'UPDATE',
    ...(DEV_UPDATE_LATEST_URL ? { latestUrl: DEV_UPDATE_LATEST_URL } : {}),
    ...(DEV_UPDATE_RELEASES_BASE
      ? { releasesBaseUrl: DEV_UPDATE_RELEASES_BASE }
      : {}),
  });
  if (!ok) {
    clearUpdateRequestTimeout();
    const error = lastError ?? 'Failed to send update command';
    updateStatus = { status: 'failed', error };
    broadcastStatus();
    return { ok: false, error };
  }
  armUpdateRequestTimeout();
  return { ok: true };
}

function maybeAutoUpdate(): void {
  if (!isUpdateAvailable()) return;
  if (hostSelfUpdateSupported !== true) return;
  if (presenceHolder !== null) return;
  if (updateStatus !== null) return;
  if (!nativePort) return;
  triggerHostUpdate();
}

function startApplyVerification(
  targetVersion: string,
  deadlineMs = Date.now() + APPLY_VERIFY_TIMEOUT_MS,
): void {
  clearApplyVerification();
  applyVerifyTargetVersion = targetVersion;
  applyVerifyDeadlineMs = deadlineMs;

  const tick = (): void => {
    if (updateStatus?.status !== 'reconnecting') {
      clearApplyVerification();
      return;
    }

    if (maybeFinalizeAppliedVersion()) return;

    if (applyVerifyDeadlineMs && Date.now() >= applyVerifyDeadlineMs) {
      const current = hostVersion ?? 'unknown';
      updateStatus = {
        status: 'failed',
        error: `Host version is still ${current} after update`,
      };
      clearApplyVerification();
      clearPendingReconnectSession();
      broadcastStatus();
      return;
    }

    if (!nativePort) {
      connectNativeHost();
      return;
    }
    sendToHost({ type: 'PING' });
  };

  tick();
  applyVerifyTimer = setInterval(tick, APPLY_VERIFY_INTERVAL_MS);
}

function resetHostConnection(error?: string): void {
  nativePort = null;
  hostConnected = false;
  discordConnected = false;
  hostSelfUpdateSupported = null;
  hostCapabilities = new Set();
  hostRuntimeOs = null;
  hostRuntimeArch = null;
  hostBinaryPath = null;
  lastError = error ?? null;
  // Release the desktop presence lock on disconnect: the native host process
  // is gone so no further DESKTOP_MEDIA events will arrive to release it
  // voluntarily, and the lock would otherwise block browser activities until
  // the watcher re-pushes state after reconnect (~24 s via keepalive alarm).
  if (presenceHolder !== null && presenceHolder in DESKTOP_PRESENCE_TO_TOGGLE) {
    presenceHolder = null;
  }
}

function clearReconnectSettleTimer(): void {
  if (reconnectSettleTimer) {
    clearTimeout(reconnectSettleTimer);
    reconnectSettleTimer = null;
  }
}

function clearManualReconnectRetryTimer(): void {
  if (manualReconnectRetryTimer) {
    clearTimeout(manualReconnectRetryTimer);
    manualReconnectRetryTimer = null;
  }
}

function markWorkerActive(): void {
  suspendInProgress = false;
}

function resetReconnectState(options?: { clearQueued?: boolean }): void {
  pendingManualReconnect = false;
  reconnectInProgress = false;
  clearReconnectSettleTimer();
  clearManualReconnectRetryTimer();
  manualReconnectAttemptsRemaining = 0;
  if (options?.clearQueued) {
    reconnectQueued = false;
  }
}

function scheduleManualReconnectRetry(delayMs: number): void {
  if (manualReconnectAttemptsRemaining <= 0) return;
  if (manualReconnectRetryTimer) return;

  manualReconnectRetryTimer = setTimeout(() => {
    manualReconnectRetryTimer = null;
    if (!reconnectInProgress || suspendInProgress) return;

    manualReconnectAttemptsRemaining -= 1;

    // Keep probing until we actually receive STATUS.
    // Always ping when a port exists to verify it is truly live; stale/disconnected
    // port objects can otherwise leave reconnect stuck in a false "connected" state.
    if (nativePort) {
      const ok = sendToHost({ type: 'PING' });
      if (!ok) {
        // sendToHost already reset/disconnected broken ports.
        connectNativeHost();
      }
    } else {
      connectNativeHost();
    }

    if (
      reconnectInProgress &&
      !hostConnected &&
      manualReconnectAttemptsRemaining > 0
    ) {
      scheduleManualReconnectRetry(RECONNECT_CONFIG.manualRetryDelayMs);
    }
  }, delayMs);
}

function markReconnectingStatus(): void {
  hostConnected = false;
  discordConnected = false;
  discordConnectedSince = null;
  lastError = null;
}

function finalizeReconnectAttempt(): void {
  resetReconnectState();

  if (reconnectQueued) {
    reconnectQueued = false;
    void requestReconnectNativeHost();
  }
}

function reconnectNativeHostNow(): void {
  if (nativePort) {
    pendingManualReconnect = true;
    // Set status immediately so popup does not briefly show stale connected state
    // while we wait for port teardown/host relaunch.
    markReconnectingStatus();
    broadcastStatus();

    try {
      nativePort.disconnect();
      // Fallback probe in case onDisconnect is delayed or skipped for a stale port.
      scheduleManualReconnectRetry(RECONNECT_CONFIG.manualRetryDelayMs);
      return;
    } catch {
      // If disconnect throws, fall back to an immediate clean reconnect.
      pendingManualReconnect = false;
    }
  }
  resetHostConnection();
  markReconnectingStatus();
  broadcastStatus();
  connectNativeHost();
}

function requestReconnectNativeHost(): boolean {
  markWorkerActive();

  if (reconnectInProgress) {
    reconnectQueued = true;
    return false;
  }

  reconnectInProgress = true;
  reconnectQueued = false;
  manualReconnectAttemptsRemaining = RECONNECT_CONFIG.manualMaxAttempts;
  reconnectNativeHostNow();

  clearReconnectSettleTimer();
  reconnectSettleTimer = setTimeout(() => {
    finalizeReconnectAttempt();
  }, RECONNECT_CONFIG.settleTimeoutMs);

  return true;
}

function connectNativeHost(): void {
  // Any explicit connect path means the worker is active again.
  markWorkerActive();

  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    const port = nativePort;
    // Do not mark connected until we receive a STATUS from the host.
    // This avoids transient "connected -> disconnected" flicker when the
    // host executable is missing and Chrome disconnects immediately.
    hostConnected = false;
    lastError = null;
    console.log('[FreeMiD] Native host port opened');

    port.onMessage.addListener((msg: unknown) => {
      if (nativePort !== port) return;
      const m = msg as {
        type?: string;
        connected?: boolean;
        error?: string;
        version?: string;
        selfUpdateSupported?: boolean;
        capabilities?: string[];
        runtimeOs?: string;
        runtimeArch?: string;
        binaryPath?: string;
        status?:
          | 'checking'
          | 'downloading'
          | 'reconnecting'
          | 'up_to_date'
          | 'success'
          | 'failed';
        app?: string;
        track?: {
          title: string;
          artist: string;
          album?: string;
          state: string;
          position_secs?: number;
          duration_secs?: number;
        } | null;
      };
      if (m.type === 'STATUS') {
        if (reconnectInProgress) {
          finalizeReconnectAttempt();
        }
        hostConnected = true;
        const wasConnected = discordConnected;
        discordConnected = m.connected === true;
        if (m.version) {
          hostVersion = m.version;
          if (
            updateStatus?.status === 'reconnecting' ||
            updateStatus?.status === 'success'
          ) {
            const targetVersion =
              applyVerifyTargetVersion ??
              updateStatus.version ??
              chrome.runtime.getManifest().version;
            applyVerifyTargetVersion = targetVersion;
            maybeFinalizeAppliedVersion();
          }
        }
        hostCapabilities = new Set(
          Array.isArray(m.capabilities) ? m.capabilities : [],
        );
        // Derive from the capabilities set (new hosts) or the legacy scalar
        // field (hosts that pre-date capabilities). Require explicit support to
        // avoid false-positive update attempts that get stuck in 'requested'.
        if (hostCapabilities.has('self-update')) {
          hostSelfUpdateSupported = true;
        } else if (typeof m.selfUpdateSupported === 'boolean') {
          hostSelfUpdateSupported = m.selfUpdateSupported;
        } else {
          hostSelfUpdateSupported = false;
        }
        if (typeof m.runtimeOs === 'string') {
          hostRuntimeOs = m.runtimeOs;
        }
        if (typeof m.runtimeArch === 'string') {
          hostRuntimeArch = m.runtimeArch;
        }
        if (typeof m.binaryPath === 'string') {
          hostBinaryPath = m.binaryPath;
        }
        if (discordConnected && !wasConnected) {
          discordConnectedSince = Date.now();
        } else if (!discordConnected && wasConnected) {
          discordConnectedSince = null;
        }
        lastError = m.error ?? null;
        if (m.error) console.warn('[FreeMiD] host reported error:', m.error);

        // If a legacy host acknowledged STATUS but never emits UPDATE_STATUS,
        // fail fast with manual-install guidance instead of waiting indefinitely.
        if (
          updateStatus?.status === 'requested' &&
          hostSelfUpdateSupported !== true
        ) {
          clearUpdateRequestTimeout();
          updateStatus = {
            status: 'failed',
            error: manualInstallRequiredError(),
          };
        }

        broadcastStatus();
      } else if (m.type === 'DESKTOP_MEDIA' && m.app) {
        const app = m.app;
        const desktopApp = DESKTOP_APPS[app];
        if (desktopApp) {
          const { presenceKey, brandName, logoAssetKey } = desktopApp;
          const track = m.track;
          const hasBrowserTab = [...activeActivityTabs.values()].includes(app);
          if (!hasBrowserTab && track && track.state === 'playing') {
            const now = Math.floor(Date.now() / 1000);
            // Only set timestamps when both position and duration are available.
            // Sending only `start` (no `end`) causes Discord to show a game-style
            // counting-up timer instead of a music progress bar. The SMTC fires
            // MediaPropertiesChanged before TimelinePropertiesChanged, so the first
            // push may have position but not yet duration — skip timestamps then.
            const start =
              track.position_secs != null && track.duration_secs != null
                ? now - Math.floor(track.position_secs)
                : undefined;
            const end =
              start !== undefined && track.duration_secs != null
                ? start + Math.floor(track.duration_secs)
                : undefined;

            const artKey = `${track.artist}|${track.title}|${track.album ?? ''}`;
            const artUrl = artCacheGet(artKey) ?? null;
            if (!desktopArtCache.has(artKey)) {
              void lookupArtworkCached(
                track.artist,
                track.title,
                track.album ?? undefined,
              ).then((url) => {
                // Re-poll to apply the now-cached art URL if still showing.
                if (url && presenceHolder === presenceKey && nativePort) {
                  sendToHost({ type: 'GET_DESKTOP_MEDIA', app });
                }
              });
            }

            setActivity(
              {
                application_id: DISCORD_CLIENT_ID || undefined,
                name: track.artist || brandName,
                type: 2,
                details: track.title,
                state: track.artist ? `by ${track.artist}` : brandName,
                timestamps: start !== undefined ? { start, end } : undefined,
                assets: {
                  large_image: artUrl ?? logoAssetKey,
                  large_text: track.album || undefined,
                  small_image: artUrl ? logoAssetKey : undefined,
                  small_text: artUrl ? brandName : undefined,
                },
              },
              presenceKey,
            );
          } else {
            releasePresence(presenceKey);
          }
        }
      } else if (m.type === 'UPDATE_STATUS' && m.status) {
        clearUpdateRequestTimeout();
        updateStatus = {
          status: m.status,
          version: typeof m.version === 'string' ? m.version : undefined,
          error: typeof m.error === 'string' ? m.error : undefined,
        };
        if (m.status === 'success' && !autoReconnectScheduled) {
          const targetVersion =
            typeof m.version === 'string'
              ? m.version
              : preferredUpdateVersion(
                  latestVersion,
                  chrome.runtime.getManifest().version,
                );
          updateStatus = {
            status: 'reconnecting',
            version: targetVersion,
          };
          const reconnectDeadline = Date.now() + APPLY_VERIFY_TIMEOUT_MS;
          startApplyVerification(targetVersion, reconnectDeadline);
          // Persist across SW restarts so the reconnect can be completed even
          // if the worker is suspended before the timer below fires.
          void chrome.storage.session.set({
            [SESSION_KEYS.pendingReconnect]: {
              version: targetVersion,
              deadline: reconnectDeadline,
            },
          });
          autoReconnectScheduled = true;
          // Reconnect shortly after success so Chrome relaunches the host and
          // picks up the newly replaced binary on disk.
          setTimeout(() => {
            autoReconnectScheduled = false;
            requestReconnectNativeHost();
          }, POST_UPDATE_RECONNECT_DELAY_MS);
        }
        broadcastStatus();
      }
    });

    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const err = chrome.runtime.lastError?.message ?? 'disconnected';
      console.warn(`[FreeMiD] Native host disconnected: ${err}`);

      const wasUpdateInFlight = isUpdateInProgress(updateStatus);

      clearUpdateRequestTimeout();

      resetHostConnection(err);

      if (suspendInProgress) {
        resetReconnectState({ clearQueued: true });
        broadcastStatus();
        return;
      }

      if (pendingManualReconnect) {
        pendingManualReconnect = false;
        manualReconnectAttemptsRemaining = Math.max(
          1,
          manualReconnectAttemptsRemaining,
        );
        scheduleManualReconnectRetry(0);
      } else if (reconnectInProgress && !wasUpdateInFlight) {
        scheduleManualReconnectRetry(RECONNECT_CONFIG.manualRetryDelayMs);
      }

      if (wasUpdateInFlight) {
        if (updateStatus?.status !== 'reconnecting') {
          updateStatus = {
            status: 'reconnecting',
            version: updateStatus?.version,
          };
        }
        if (!disconnectReconnectTimer) {
          disconnectReconnectTimer = setTimeout(() => {
            disconnectReconnectTimer = null;
            connectNativeHost();
          }, DISCONNECT_RECONNECT_DELAY_MS);
        }
      }

      broadcastStatus();
    });

    // Ask for an initial status update.
    sendToHost({ type: 'PING' });
  } catch (e) {
    resetHostConnection(e instanceof Error ? e.message : String(e));
    console.error('[FreeMiD] Failed to connect to native host:', lastError);
    broadcastStatus();
  }
}

function sendToHost(payload: object): boolean {
  if (!nativePort) {
    connectNativeHost();
    if (!nativePort) return false;
  }
  const port = nativePort;
  try {
    port.postMessage(payload);
    return true;
  } catch (e) {
    console.error('[FreeMiD] postMessage failed:', e);
    try {
      port.disconnect();
    } catch {
      // ignore disconnect errors for a broken port
    }
    resetHostConnection(e instanceof Error ? e.message : String(e));
    broadcastStatus();
    return false;
  }
}

function reconnectCooldownRemainingMs(): number {
  return Math.max(0, reconnectCooldownUntilMs - Date.now());
}

/**
 * Request an immediate SMTC poll for a known desktop app (see DESKTOP_APPS),
 * skipping if there's nothing to gain: no host connection, wrong platform,
 * the site is disabled/paused, or a browser tab for the same site is already
 * reporting presence.
 */
function pollDesktopMediaForApp(appId: string): void {
  if (
    DESKTOP_APPS[appId] &&
    nativePort &&
    hostRuntimeOs === 'windows' &&
    enabledSites[appId] &&
    !paused &&
    ![...activeActivityTabs.values()].includes(appId)
  ) {
    sendToHost({ type: 'GET_DESKTOP_MEDIA', app: appId });
  }
}

// ── Activity helpers ──────────────────────────────────────────────────────────

function flushPendingActivity(): void {
  pendingActivityFlushTimer = null;
  const activity = pendingActivityPayload;
  pendingActivityPayload = null;
  if (activity === null) return;

  const activityJson = JSON.stringify(activity);
  if (activityJson === lastSentActivityJson) return;

  lastActivitySentAt = Date.now();
  lastSentActivityJson = activityJson;
  sendToHost({ type: 'SET_ACTIVITY', activity });
}

/**
 * Send Discord Rich Presence activity via the native host.
 * Pass siteId to enforce per-site enable/disable and pause state.
 */
export function setActivity(activity: object, siteId?: string): void {
  if (paused) return;
  // Desktop presence keys (e.g. 'tidal-desktop') share their web activity's
  // site toggle rather than having their own.
  const toggleKey =
    siteId !== undefined
      ? (DESKTOP_PRESENCE_TO_TOGGLE[siteId] ?? siteId)
      : siteId;
  if (toggleKey !== undefined && !enabledSites[toggleKey]) return;
  // Lock model: first playing source claims the lock; others are blocked until
  // the holder voluntarily releases via releasePresence().
  if (presenceHolder !== null && presenceHolder !== siteId) return;
  if (siteId !== undefined) presenceHolder = siteId;

  const a = activity as {
    name?: string;
    type?: number;
    details?: string;
    state?: string;
    startTimestamp?: number;
    endTimestamp?: number;
    timestamps?: { start?: number; end?: number };
    assets?: {
      large_image?: string;
      large_text?: string;
      small_image?: string;
      small_text?: string;
    };
    buttons?: Array<{ label?: string; url?: string }>;
  };

  const startTs =
    typeof a.startTimestamp === 'number'
      ? a.startTimestamp
      : typeof a.timestamps?.start === 'number'
        ? a.timestamps.start
        : undefined;
  const endTs =
    typeof a.endTimestamp === 'number'
      ? a.endTimestamp
      : typeof a.timestamps?.end === 'number'
        ? a.timestamps.end
        : undefined;

  const nextActivity = a.details
    ? {
        title: a.details,
        sub: a.state ?? '',
        startTimestamp: startTs,
        endTimestamp: endTs,
        activityName: a.name,
        activityType: a.type,
        largeImageKey: a.assets?.large_image,
        largeImageText: a.assets?.large_text,
        smallImageKey: a.assets?.small_image,
        smallImageText: a.assets?.small_text,
        firstButtonLabel: a.buttons?.[0]?.label,
      }
    : null;

  // Notify the popup when visible metadata changes. On a track change, debounce
  // by 1100 ms so the 300 ms and 1000 ms UpdateData triggers consolidate into
  // one broadcast — by 1000 ms mediaSession.album and barTimes are both settled.
  // Same-track updates (seek, timestamp tick) broadcast immediately.
  if (JSON.stringify(nextActivity) !== JSON.stringify(lastActivity)) {
    const titleChanged = nextActivity?.title !== lastActivity?.title;
    lastActivity = nextActivity;
    if (activityBroadcastTimer !== null) {
      clearTimeout(activityBroadcastTimer);
      activityBroadcastTimer = null;
    }
    if (titleChanged && nextActivity !== null) {
      activityBroadcastTimer = setTimeout(() => {
        activityBroadcastTimer = null;
        broadcastStatus();
      }, 1100);
    } else {
      broadcastStatus();
    }
  }

  // Dedup: skip if nothing has changed since the last send.
  // If a flush is pending with a different payload and we just returned to the
  // previously-sent state (A→B→A), cancel that flush — it would send stale data.
  const activityJson = JSON.stringify(activity);
  if (activityJson === lastSentActivityJson) {
    if (pendingActivityFlushTimer !== null) {
      clearTimeout(pendingActivityFlushTimer);
      pendingActivityFlushTimer = null;
      pendingActivityPayload = null;
    }
    return;
  }

  // Throttle: enforce DISCORD_MIN_INTERVAL_MS between Discord IPC calls.
  // If a pending flush already exists, replace its payload with this newer one
  // (the timer keeps running — it fires at the originally scheduled time).
  const elapsed = Date.now() - lastActivitySentAt;
  if (elapsed < DISCORD_MIN_INTERVAL_MS) {
    pendingActivityPayload = activity;
    if (pendingActivityFlushTimer === null) {
      pendingActivityFlushTimer = setTimeout(
        flushPendingActivity,
        DISCORD_MIN_INTERVAL_MS - elapsed,
      );
    }
    return;
  }

  // Enough time has passed — send immediately.
  if (pendingActivityFlushTimer !== null) {
    clearTimeout(pendingActivityFlushTimer);
    pendingActivityFlushTimer = null;
    pendingActivityPayload = null;
  }
  lastActivitySentAt = Date.now();
  lastSentActivityJson = activityJson;
  sendToHost({ type: 'SET_ACTIVITY', activity });
}

function cancelPendingActivityFlush(): void {
  if (pendingActivityFlushTimer !== null) {
    clearTimeout(pendingActivityFlushTimer);
    pendingActivityFlushTimer = null;
  }
  if (activityBroadcastTimer !== null) {
    clearTimeout(activityBroadcastTimer);
    activityBroadcastTimer = null;
  }
  pendingActivityPayload = null;
  lastSentActivityJson = null;
  lastActivitySentAt = 0;
}

export function clearActivity(): void {
  cancelPendingActivityFlush();
  presenceHolder = null;
  lastActivity = null;
  sendToHost({ type: 'CLEAR_ACTIVITY' });
  broadcastStatus();
}

// Release presence held by a specific source. No-op if another source holds it.
function releasePresence(sourceId: string): void {
  if (presenceHolder !== sourceId) return;
  cancelPendingActivityFlush();
  presenceHolder = null;
  lastActivity = null;
  sendToHost({ type: 'CLEAR_ACTIVITY' });
  broadcastStatus();
  maybeAutoUpdate();
}

// ── Activity registry & content script injection ───────────────────────────────

/** Map of tabId → activityId for tabs that currently have a script injected. */
const activeActivityTabs = new Map<number, string>();

async function handleTabNavigation(
  tabId: number,
  url: string,
  options?: { forceInject?: boolean },
): Promise<void> {
  const meta = matchActivity(url);

  if (!meta || !enabledSites[meta.id]) {
    clearTabActivity(tabId);
    return;
  }

  const forceInject = options?.forceInject === true;
  if (!forceInject && activeActivityTabs.get(tabId) === meta.id) return;

  // A web activity always takes priority over its desktop counterpart —
  // release the desktop lock so the web content script can claim it.
  const desktopApp = DESKTOP_APPS[meta.id];
  if (desktopApp) releasePresence(desktopApp.presenceKey);

  activeActivityTabs.set(tabId, meta.id);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [`activities/${meta.id}/index.js`],
    });
    console.log(`[FreeMiD] Injected activity "${meta.id}" into tab ${tabId}`);
  } catch (err) {
    console.error(`[FreeMiD] Failed to inject activity "${meta.id}":`, err);
    activeActivityTabs.delete(tabId);
  }
}

// ── Chrome event listeners ─────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  // A completed navigation replaces the page context, so always re-inject
  // the activity script even if this tab is still on the same service.
  void handleTabNavigation(tabId, tab.url, { forceInject: true });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) void handleTabNavigation(tabId, tab.url);
  } catch {
    // tab gone
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabActivity(tabId);
});

// Messages from injected activity scripts and the popup.
chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    const msg = message as Record<string, unknown>;

    if (
      msg.type === 'FREEMID_SET_ACTIVITY' &&
      msg.data !== null &&
      typeof msg.data === 'object'
    ) {
      const siteId =
        sender.tab?.id != null
          ? activeActivityTabs.get(sender.tab.id)
          : undefined;

      // Tidal's web player shows compilation or playlist art for tracks that
      // appear on compilations. Override with a MusicBrainz/CAA lookup so
      // Discord shows the original album art.
      if (siteId === 'tidal') {
        const d = msg.data as Record<string, unknown>;
        const artist = typeof d.name === 'string' ? d.name : undefined;
        const title = typeof d.details === 'string' ? d.details : undefined;
        const assets =
          d.assets !== null && typeof d.assets === 'object'
            ? (d.assets as Record<string, unknown>)
            : undefined;
        const largeText =
          typeof assets?.large_text === 'string'
            ? assets.large_text
            : undefined;
        const album = largeText !== title ? largeText : undefined;

        if (artist && title) {
          // Include album in the key so a bad album name (playlist name) on
          // the first tick doesn't permanently poison the cache for the same
          // track once the correct album name arrives via mediaSession.
          const artKey = `${artist}|${title}|${album ?? ''}`;
          const cachedUrl = artCacheGet(artKey);
          if (cachedUrl !== undefined) {
            if (cachedUrl && assets) assets.large_image = cachedUrl;
          } else {
            void lookupArtworkCached(artist, title, album);
          }
        }
      }

      setActivity(msg.data as object, siteId);
      return;
    }

    if (msg.type === 'FREEMID_CLEAR_ACTIVITY') {
      const siteId =
        sender.tab?.id != null
          ? activeActivityTabs.get(sender.tab.id)
          : undefined;
      if (siteId !== undefined) {
        releasePresence(siteId);
      } else {
        clearActivity();
      }
      return;
    }

    if (msg.type === 'SET_PAUSED') {
      if (typeof msg.value !== 'boolean') return;
      paused = msg.value;
      void chrome.storage.local.set({ [STORAGE_KEYS.paused]: paused });
      if (paused) clearActivity();
      broadcastStatus();
      return;
    }

    if (msg.type === 'SET_SITE_ENABLED') {
      if (typeof msg.siteId !== 'string' || typeof msg.enabled !== 'boolean')
        return;
      const siteId = msg.siteId;
      const enabled = msg.enabled;
      enabledSites[siteId] = enabled;
      void chrome.storage.local.set({
        [STORAGE_KEYS.enabledSites]: enabledSites,
      });
      if (!enabled) {
        // Only clear when the disabled site actually holds the lock.
        // Clearing unconditionally when a tab is merely injected would evict
        // presence owned by a different site that currently holds the lock.
        const holdsLock =
          presenceHolder === siteId ||
          presenceHolder === DESKTOP_APPS[siteId]?.presenceKey;
        if (holdsLock) {
          clearActivity();
        }
      } else {
        // Site was just re-enabled — immediately poll SMTC (if it's a known
        // desktop app) so presence restores without waiting for the next
        // keepalive cycle (~24 s).
        pollDesktopMediaForApp(siteId);
      }
      broadcastStatus();
      return;
    }

    if (msg.type === 'GET_STATUS') {
      // Wait for persisted state (paused/enabledSites) to finish loading before
      // answering — otherwise a request that races a cold service-worker start
      // gets the hardcoded module defaults instead of the user's real saved
      // preferences, which then visibly corrects itself moments later.
      void stateLoaded.then(() => {
        // Return the cached state immediately (kept fresh by the keepalive PING).
        // If the port isn't open yet, try to connect — the onMessage STATUS
        // response will broadcast the real state to the popup shortly after.
        if (!nativePort) connectNativeHost();
        if (!latestVersion) {
          void checkForUpdates();
        }
        // Trigger an immediate desktop media poll for each known desktop app
        // when the popup opens, so there is no need to wait for the next
        // keepalive alarm (~24 s).
        for (const appId of Object.keys(DESKTOP_APPS)) {
          pollDesktopMediaForApp(appId);
        }
        sendResponse(buildStatus());
      });
      return true;
    }

    if (msg.type === 'RUN_HOST_UPDATE') {
      if (!nativePort) connectNativeHost();
      if (!nativePort) {
        sendResponse({ ok: false, error: 'Native host not connected' });
        return true;
      }

      // Require explicit capability from the host. Older hosts (e.g. v0.3.14)
      // do not emit this field and cannot process UPDATE, which otherwise leaves
      // the popup stuck in a spinning "requested" state.
      if (
        hostSelfUpdateSupported !== true ||
        !isHostSelfUpdateSupported(
          hostVersion,
          DEV_MIN_SELF_UPDATE_HOST_VERSION,
          IS_WINDOWS_PLATFORM ? 'windows' : 'other',
          DEV_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION,
        )
      ) {
        clearApplyVerification();
        clearPendingReconnectSession();
        clearUpdateRequestTimeout();
        updateStatus = {
          status: 'failed',
          error: manualInstallRequiredError(),
        };
        broadcastStatus();
        sendResponse({
          ok: false,
          manualInstall: true,
          error: manualInstallRequiredError(),
        });
        return true;
      }

      const result = triggerHostUpdate();
      sendResponse(result);
      return true;
    }

    if (msg.type === 'RECONNECT_HOST') {
      const remainingMs = reconnectCooldownRemainingMs();
      if (remainingMs > 0) {
        sendResponse({
          ok: false,
          error: 'Reconnect cooling down',
          retryAfterMs: remainingMs,
        });
        return true;
      }

      reconnectCooldownUntilMs = Date.now() + RECONNECT_REQUEST_COOLDOWN_MS;
      requestReconnectNativeHost();
      sendResponse({ ok: true, retryAfterMs: RECONNECT_REQUEST_COOLDOWN_MS });
      return true;
    }
  },
);

// Keep the service worker alive and the native host port healthy.
chrome.alarms.create('freemid-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'freemid-keepalive') {
    // Keep an existing host port healthy, but do not auto-spawn a new host.
    // Reconnect should happen on explicit demand (popup/status/activity/update).
    if (nativePort) sendToHost({ type: 'PING' });
  }
  if (alarm.name === 'freemid-update-check') {
    void checkForUpdates().then(() => {
      maybeAutoUpdate();
    });
  }
  if (alarm.name === 'freemid-host-version-check') {
    // On non-Windows, if the user manually updated the native host binary
    // (e.g. via install.sh), the old process is still running. A quiet reconnect
    // causes Chrome to spawn the new binary, picking up the updated version.
    if (!IS_WINDOWS_PLATFORM && isUpdateAvailable() && !updateStatus) {
      requestReconnectNativeHost();
    }
  }
});

chrome.runtime.onSuspend.addListener(() => {
  suspendInProgress = true;
  resetReconnectState({ clearQueued: true });

  if (!nativePort) return;
  try {
    nativePort.disconnect();
  } catch {
    // Ignore teardown errors during worker suspend.
  }
  resetHostConnection('Service worker suspended');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStatus() {
  return {
    hostConnected,
    discordConnected,
    error: lastError,
    paused,
    lastActivity,
    connectedSince: discordConnectedSince,
    enabledSites,
    hostVersion,
    hostSelfUpdateSupported,
    hostRuntimeOs,
    hostRuntimeArch,
    hostBinaryPath,
    latestVersion,
    updateAvailable: isUpdateAvailable(),
    updateStatus,
  };
}

function broadcastStatus(): void {
  chrome.runtime
    .sendMessage({ type: 'HOST_STATUS', ...buildStatus() })
    .catch(() => {
      // popup might not be open — ignore
    });
}

function clearTabActivity(tabId: number): void {
  const siteId = activeActivityTabs.get(tabId);
  if (!siteId) return;
  activeActivityTabs.delete(tabId);
  // Only release the lock if no other tab of the same site is still active.
  const stillActive = [...activeActivityTabs.values()].includes(siteId);
  if (!stillActive) releasePresence(siteId);
}

// ── Version & update check ────────────────────────────────────────────────────

function isUpdateAvailable(): boolean {
  return isUpdateAvailableForHost(
    hostVersion,
    latestVersion,
    chrome.runtime.getManifest().version,
  );
}

async function checkForUpdates(): Promise<void> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!resp.ok) return;
    const data = (await resp.json()) as { tag_name?: string };
    const tag = (data.tag_name ?? '').replace(/^v/, '');
    if (tag) {
      latestVersion = tag;
      await chrome.storage.local.set({
        [STORAGE_KEYS.latestVersion]: latestVersion,
      });
      broadcastStatus();
    }
  } catch (e) {
    console.warn('[FreeMiD] Update check failed:', e);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Load persisted state (pause flag, site toggles) before answering GET_STATUS —
// until this resolves, `paused`/`enabledSites` still hold their hardcoded
// module-level defaults, and a GET_STATUS message that arrives while the
// service worker is still waking up would otherwise get those wrong defaults
// instead of the user's real saved preferences.
const stateLoaded: Promise<void> = chrome.storage.local
  .get([
    STORAGE_KEYS.paused,
    STORAGE_KEYS.enabledSites,
    STORAGE_KEYS.latestVersion,
  ])
  .then((stored) => {
    if (typeof stored[STORAGE_KEYS.paused] === 'boolean')
      paused = stored[STORAGE_KEYS.paused] as boolean;
    if (
      stored[STORAGE_KEYS.enabledSites] &&
      typeof stored[STORAGE_KEYS.enabledSites] === 'object'
    ) {
      enabledSites = {
        ...enabledSites,
        ...(stored[STORAGE_KEYS.enabledSites] as Record<string, boolean>),
      };
    }
    if (typeof stored[STORAGE_KEYS.latestVersion] === 'string')
      latestVersion = stored[STORAGE_KEYS.latestVersion] as string;
  });

// Load pending reconnect (session-scoped) alongside persisted state, then connect.
void Promise.all([
  stateLoaded,
  chrome.storage.session.get(SESSION_KEYS.pendingReconnect),
]).then(([, session]) => {
  connectNativeHost();
  // Restore a pending post-update reconnect if the SW was suspended before
  // the reconnect timer fired. startApplyVerification will send PINGs and
  // finalize (or time out) once the new host replies with its version.
  const pending = session[SESSION_KEYS.pendingReconnect] as
    | { version: string; deadline: number }
    | undefined;
  if (
    pending !== undefined &&
    typeof pending.version === 'string' &&
    typeof pending.deadline === 'number' &&
    pending.deadline > Date.now()
  ) {
    updateStatus = { status: 'reconnecting', version: pending.version };
    startApplyVerification(pending.version, pending.deadline);
  } else if (pending !== undefined) {
    clearPendingReconnectSession();
  }
  if (!latestVersion) {
    void checkForUpdates();
  }
  // Schedule daily update check — only create if not already scheduled so a
  // service-worker restart doesn't reset the 24 h timer.
  chrome.alarms.get('freemid-update-check', (existing) => {
    if (!existing) {
      chrome.alarms.create('freemid-update-check', {
        delayInMinutes: 2,
        periodInMinutes: 1440,
      });
    }
  });
  // Periodically reconnect on non-Windows to pick up externally-installed host
  // binaries (e.g. after the user runs install.sh to manually update).
  chrome.alarms.get('freemid-host-version-check', (existing) => {
    if (!existing) {
      chrome.alarms.create('freemid-host-version-check', {
        delayInMinutes: 30,
        periodInMinutes: 30,
      });
    }
  });
  // Re-inject activity scripts into any tabs that are already open when the
  // service worker starts (e.g. after the extension is reloaded). Without this,
  // existing YouTube / YouTube Music tabs become orphaned and stop sending
  // activity updates until the user manually refreshes the page.
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url) void handleTabNavigation(tab.id, tab.url);
    }
  });
});
