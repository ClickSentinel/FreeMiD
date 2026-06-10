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

import { ACTIVITY_REGISTRY, type ActivityMeta } from '../activities/registry';
import { GITHUB_REPO } from '../constants/github';
import { STORAGE_KEYS } from '../constants/storageKeys';
import {
  compareVersions,
  MIN_SELF_UPDATE_HOST_VERSION,
  MIN_WINDOWS_SELF_UPDATE_HOST_VERSION,
  isHostSelfUpdateSupported,
  isUpdateAvailableForHost,
  preferredUpdateVersion,
} from './helpers';

const NATIVE_HOST_NAME = 'com.clicksentinel.freemid';
const DEV_UPDATE_LATEST_URL = import.meta.env.VITE_UPDATE_LATEST_URL?.trim() || '';
const DEV_UPDATE_RELEASES_BASE = import.meta.env.VITE_UPDATE_RELEASES_BASE?.trim() || '';
const DEV_MIN_SELF_UPDATE_HOST_VERSION =
  import.meta.env.VITE_MIN_SELF_UPDATE_HOST_VERSION?.trim() || MIN_SELF_UPDATE_HOST_VERSION;
const DEV_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION =
  import.meta.env.VITE_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION?.trim() || MIN_WINDOWS_SELF_UPDATE_HOST_VERSION;
const IS_WINDOWS_PLATFORM = /Windows/i.test(navigator.userAgent);

// ── Native host port ──────────────────────────────────────────────────────────

let nativePort: chrome.runtime.Port | null = null;
let hostConnected = false;        // STDIO port is alive
let discordConnected = false;     // Discord IPC handshake succeeded
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
let enabledSites: Record<string, boolean> = { youtube: true, youtubemusic: true, tidal: true };
let hostVersion: string | null = null;
let hostSelfUpdateSupported: boolean | null = null;
let hostRuntimeOs: string | null = null;
let hostRuntimeArch: string | null = null;
let hostBinaryPath: string | null = null;
let latestVersion: string | null = null;
let updateStatus: {
  status: 'requested' | 'checking' | 'downloading' | 'reconnecting' | 'up_to_date' | 'success' | 'failed';
  version?: string;
  error?: string;
} | null = null;
let autoReconnectScheduled = false;
let disconnectReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let applyVerifyTimer: ReturnType<typeof setInterval> | null = null;
let applyVerifyDeadlineMs: number | null = null;
let applyVerifyTargetVersion: string | null = null;
let reconnectInProgress = false;
let reconnectQueued = false;
let reconnectSettleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingManualReconnect = false;
let manualReconnectRetryTimer: ReturnType<typeof setTimeout> | null = null;
let manualReconnectAttemptsRemaining = 0;
let suspendInProgress = false;
let reconnectCooldownUntilMs = 0;

const APPLY_VERIFY_INTERVAL_MS = 1000;
const APPLY_VERIFY_TIMEOUT_MS = 30000;
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

function maybeFinalizeAppliedVersion(): boolean {
  if (!applyVerifyTargetVersion || !hostVersion) return false;
  if (compareVersions(hostVersion, applyVerifyTargetVersion) >= 0) {
    clearApplyVerification();
    updateStatus = null;
    broadcastStatus();
    return true;
  }
  return false;
}

function startApplyVerification(targetVersion: string): void {
  clearApplyVerification();
  applyVerifyTargetVersion = targetVersion;
  applyVerifyDeadlineMs = Date.now() + APPLY_VERIFY_TIMEOUT_MS;

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
  hostRuntimeOs = null;
  hostRuntimeArch = null;
  hostBinaryPath = null;
  lastError = error ?? null;
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
    } else if (!nativePort) {
      connectNativeHost();
    }

    if (reconnectInProgress && !hostConnected && manualReconnectAttemptsRemaining > 0) {
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
        runtimeOs?: string;
        runtimeArch?: string;
        binaryPath?: string;
        status?: 'checking' | 'downloading' | 'reconnecting' | 'up_to_date' | 'success' | 'failed';
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
          if (updateStatus?.status === 'reconnecting' || updateStatus?.status === 'success') {
            const targetVersion = applyVerifyTargetVersion
              ?? updateStatus.version
              ?? chrome.runtime.getManifest().version;
            applyVerifyTargetVersion = targetVersion;
            maybeFinalizeAppliedVersion();
          }
        }
        if (typeof m.selfUpdateSupported === 'boolean') {
          hostSelfUpdateSupported = m.selfUpdateSupported;
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
          notifyConnectionChange(true);
        } else if (!discordConnected && wasConnected) {
          discordConnectedSince = null;
          notifyConnectionChange(false);
        }
        lastError = m.error ?? null;
        if (m.error) console.warn('[FreeMiD] host reported error:', m.error);
        broadcastStatus();
      } else if (m.type === 'UPDATE_STATUS' && m.status) {
        updateStatus = {
          status: m.status,
          version: typeof m.version === 'string' ? m.version : undefined,
          error: typeof m.error === 'string' ? m.error : undefined,
        };
        if (m.status === 'success' && !autoReconnectScheduled) {
          const targetVersion = typeof m.version === 'string'
            ? m.version
            : preferredUpdateVersion(latestVersion, chrome.runtime.getManifest().version);
          updateStatus = {
            status: 'reconnecting',
            version: targetVersion,
          };
          startApplyVerification(targetVersion);
          autoReconnectScheduled = true;
          // Reconnect shortly after success so Chrome relaunches the host and
          // picks up the newly replaced binary on disk.
          setTimeout(() => {
            autoReconnectScheduled = false;
            reconnectNativeHost();
          }, POST_UPDATE_RECONNECT_DELAY_MS);
        }
        broadcastStatus();
      }
    });

    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const err = chrome.runtime.lastError?.message ?? 'disconnected';
      console.warn(`[FreeMiD] Native host disconnected: ${err}`);

      const wasUpdateInFlight =
        updateStatus?.status === 'requested'
        || updateStatus?.status === 'checking'
        || updateStatus?.status === 'downloading'
        || updateStatus?.status === 'reconnecting';

      resetHostConnection(err);

      if (suspendInProgress) {
        resetReconnectState({ clearQueued: true });
        broadcastStatus();
        return;
      }

      if (pendingManualReconnect) {
        pendingManualReconnect = false;
        manualReconnectAttemptsRemaining = Math.max(1, manualReconnectAttemptsRemaining);
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

function reconnectNativeHost(): void {
  requestReconnectNativeHost();
}

function reconnectCooldownRemainingMs(): number {
  return Math.max(0, reconnectCooldownUntilMs - Date.now());
}

// ── Activity helpers ──────────────────────────────────────────────────────────

/**
 * Send Discord Rich Presence activity via the native host.
 * Pass siteId to enforce per-site enable/disable and pause state.
 */
export function setActivity(activity: object, siteId?: string): void {
  if (paused) return;
  if (siteId !== undefined && !enabledSites[siteId]) return;

  const a = activity as {
    name?: string;
    type?: number;
    details?: string;
    state?: string;
    startTimestamp?: number;
    endTimestamp?: number;
    timestamps?: { start?: number; end?: number };
    assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
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

  lastActivity = a.details
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
  sendToHost({ type: 'SET_ACTIVITY', activity });
}

export function clearActivity(): void {
  lastActivity = null;
  sendToHost({ type: 'CLEAR_ACTIVITY' });
}

function notifyConnectionChange(connected: boolean): void {
  chrome.notifications.create('freemid-status', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: 'FreeMiD',
    message: connected ? 'Connected to Discord' : 'Disconnected from Discord',
    silent: true,
  });
}

// ── Activity registry & content script injection ───────────────────────────────

function matchActivity(url: string): ActivityMeta | null {
  for (const meta of Object.values(ACTIVITY_REGISTRY)) {
    if (meta.matches.some((pattern) => urlMatchesPattern(url, pattern))) {
      return meta;
    }
  }
  return null;
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  // Parse both URL and Chrome match pattern into components so we compare
  // scheme/host/path independently. Prevents URL-string injection via query.
  try {
    const parsed = new URL(url);

    const schemeEnd = pattern.indexOf('://');
    if (schemeEnd === -1) return false;
    const patternScheme = pattern.slice(0, schemeEnd);
    const afterScheme = pattern.slice(schemeEnd + 3);
    const slashIdx = afterScheme.indexOf('/');
    const patternHost = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? '' : afterScheme.slice(slashIdx);

    if (patternScheme !== '*' && patternScheme !== parsed.protocol.slice(0, -1)) {
      return false;
    }

    const hostRe = new RegExp(
      '^' + patternHost.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i',
    );
    if (!hostRe.test(parsed.hostname)) return false;

    if (!patternPath || patternPath === '/*') return true;
    const pathRe = new RegExp(
      '^' + patternPath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
      'i',
    );
    return pathRe.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

/** Map of tabId → activityId for tabs that currently have a script injected. */
const activeActivityTabs = new Map<number, string>();

async function handleTabNavigation(
  tabId: number,
  url: string,
  options?: { forceInject?: boolean },
): Promise<void> {
  const meta = matchActivity(url);

  if (!meta) {
    clearTabActivity(tabId);
    return;
  }

  if (!enabledSites[meta.id]) {
    clearTabActivity(tabId);
    return;
  }

  const forceInject = options?.forceInject === true;
  if (!forceInject && activeActivityTabs.get(tabId) === meta.id) return;

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
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as Record<string, unknown>;

  if (msg.type === 'FREEMID_SET_ACTIVITY' && typeof msg.data === 'object') {
    const siteId = sender.tab?.id != null ? activeActivityTabs.get(sender.tab.id) : undefined;
    setActivity(msg.data as object, siteId);
    return;
  }

  if (msg.type === 'FREEMID_CLEAR_ACTIVITY') {
    clearActivity();
    return;
  }

  if (msg.type === 'SET_PAUSED') {
    paused = msg.value as boolean;
    void chrome.storage.local.set({ [STORAGE_KEYS.paused]: paused });
    if (paused) clearActivity();
    broadcastStatus();
    return;
  }

  if (msg.type === 'SET_SITE_ENABLED') {
    const siteId = msg.siteId as string;
    const enabled = msg.enabled as boolean;
    enabledSites[siteId] = enabled;
    void chrome.storage.local.set({ [STORAGE_KEYS.enabledSites]: enabledSites });
    if (!enabled && [...activeActivityTabs.values()].includes(siteId)) {
      clearActivity();
    }
    broadcastStatus();
    return;
  }

  if (msg.type === 'GET_STATUS') {
    // Return the cached state immediately (kept fresh by the keepalive PING).
    // If the port isn't open yet, try to connect — the onMessage STATUS
    // response will broadcast the real state to the popup shortly after.
    if (!nativePort) connectNativeHost();
    if (!latestVersion) {
      void checkForUpdates();
    }
    sendResponse({
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
    });
    return true;
  }

  if (msg.type === 'RUN_HOST_UPDATE') {
    if (!nativePort) connectNativeHost();
    if (!nativePort) {
      sendResponse({ ok: false, error: 'Native host not connected' });
      return true;
    }

    if (hostSelfUpdateSupported === false) {
      sendResponse({ ok: false, manualInstall: true });
      return true;
    }

    if (!isHostSelfUpdateSupported(
      hostVersion,
      DEV_MIN_SELF_UPDATE_HOST_VERSION,
      IS_WINDOWS_PLATFORM ? 'windows' : 'other',
      DEV_MIN_WINDOWS_SELF_UPDATE_HOST_VERSION,
    )) {
      sendResponse({ ok: false, manualInstall: true });
      return true;
    }

    clearApplyVerification();
    updateStatus = { status: 'requested' };
    broadcastStatus();

    const ok = sendToHost({
      type: 'UPDATE',
      ...(DEV_UPDATE_LATEST_URL ? { latestUrl: DEV_UPDATE_LATEST_URL } : {}),
      ...(DEV_UPDATE_RELEASES_BASE ? { releasesBaseUrl: DEV_UPDATE_RELEASES_BASE } : {}),
    });

    if (!ok) {
      const error = lastError ?? 'Failed to send update command';
      updateStatus = { status: 'failed', error };
      broadcastStatus();
      sendResponse({ ok: false, error });
      return true;
    }

    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT_HOST') {
    const remainingMs = reconnectCooldownRemainingMs();
    if (remainingMs > 0) {
      sendResponse({ ok: false, error: 'Reconnect cooling down', retryAfterMs: remainingMs });
      return true;
    }

    reconnectCooldownUntilMs = Date.now() + RECONNECT_REQUEST_COOLDOWN_MS;
    requestReconnectNativeHost();
    sendResponse({ ok: true, retryAfterMs: RECONNECT_REQUEST_COOLDOWN_MS });
    return true;
  }
});

// Keep the service worker alive and the native host port healthy.
chrome.alarms.create('freemid-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'freemid-keepalive') {
    // Keep an existing host port healthy, but do not auto-spawn a new host.
    // Reconnect should happen on explicit demand (popup/status/activity/update).
    if (nativePort) sendToHost({ type: 'PING' });
  }
  if (alarm.name === 'freemid-update-check') { void checkForUpdates(); }
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

function broadcastStatus(): void {
  chrome.runtime
    .sendMessage({
      type: 'HOST_STATUS',
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
    })
    .catch(() => {
      // popup might not be open — ignore
    });
}

function clearTabActivity(tabId: number): void {
  if (!activeActivityTabs.has(tabId)) return;
  activeActivityTabs.delete(tabId);
  clearActivity();
}

// ── Version & update check ────────────────────────────────────────────────────

function isUpdateAvailable(): boolean {
  return isUpdateAvailableForHost(hostVersion, latestVersion, chrome.runtime.getManifest().version);
}

async function checkForUpdates(): Promise<void> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
    );
    if (!resp.ok) return;
    const data = (await resp.json()) as { tag_name?: string };
    const tag = (data.tag_name ?? '').replace(/^v/, '');
    if (tag) {
      latestVersion = tag;
      await chrome.storage.local.set({ [STORAGE_KEYS.latestVersion]: latestVersion });
      broadcastStatus();
    }
  } catch (e) {
    console.warn('[FreeMiD] Update check failed:', e);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Load persisted state (pause flag, site toggles) before connecting.
void chrome.storage.local.get([STORAGE_KEYS.paused, STORAGE_KEYS.enabledSites, STORAGE_KEYS.latestVersion]).then((stored) => {
  if (typeof stored[STORAGE_KEYS.paused] === 'boolean') paused = stored[STORAGE_KEYS.paused] as boolean;
  if (stored[STORAGE_KEYS.enabledSites] && typeof stored[STORAGE_KEYS.enabledSites] === 'object') {
    enabledSites = { ...enabledSites, ...(stored[STORAGE_KEYS.enabledSites] as Record<string, boolean>) };
  }
  if (typeof stored[STORAGE_KEYS.latestVersion] === 'string') latestVersion = stored[STORAGE_KEYS.latestVersion] as string;
  connectNativeHost();
  if (!latestVersion) {
    void checkForUpdates();
  }
  // Schedule daily update check — only create if not already scheduled so a
  // service-worker restart doesn't reset the 24 h timer.
  chrome.alarms.get('freemid-update-check', (existing) => {
    if (!existing) {
      chrome.alarms.create('freemid-update-check', { delayInMinutes: 2, periodInMinutes: 1440 });
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
