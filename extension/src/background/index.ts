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

const NATIVE_HOST_NAME = 'com.clicksentinel.freemid';

// ── Native host port ──────────────────────────────────────────────────────────

let nativePort: chrome.runtime.Port | null = null;
let hostConnected = false;        // STDIO port is alive
let discordConnected = false;     // Discord IPC handshake succeeded
let lastError: string | null = null;

function connectNativeHost(): void {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    hostConnected = true;
    lastError = null;
    console.log('[FreeMiD] Native host port opened');

    nativePort.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; connected?: boolean; error?: string };
      if (m.type === 'STATUS') {
        discordConnected = m.connected === true;
        lastError = m.error ?? null;
        if (m.error) console.warn('[FreeMiD] host reported error:', m.error);
        broadcastStatus();
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message ?? 'disconnected';
      console.warn(`[FreeMiD] Native host disconnected: ${err}`);
      nativePort = null;
      hostConnected = false;
      discordConnected = false;
      lastError = err;
      broadcastStatus();
    });

    // Ask for an initial status update.
    sendToHost({ type: 'PING' });
  } catch (e) {
    nativePort = null;
    hostConnected = false;
    discordConnected = false;
    lastError = e instanceof Error ? e.message : String(e);
    console.error('[FreeMiD] Failed to connect to native host:', lastError);
    broadcastStatus();
  }
}

function sendToHost(payload: object): boolean {
  if (!nativePort) {
    connectNativeHost();
    if (!nativePort) return false;
  }
  try {
    nativePort.postMessage(payload);
    return true;
  } catch (e) {
    console.error('[FreeMiD] postMessage failed:', e);
    nativePort = null;
    hostConnected = false;
    discordConnected = false;
    lastError = e instanceof Error ? e.message : String(e);
    broadcastStatus();
    return false;
  }
}

// ── Activity helpers ──────────────────────────────────────────────────────────

/**
 * Send Discord Rich Presence activity via the native host.
 */
export function setActivity(activity: object): void {
  sendToHost({ type: 'SET_ACTIVITY', activity });
}

export function clearActivity(): void {
  sendToHost({ type: 'CLEAR_ACTIVITY' });
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

async function handleTabNavigation(tabId: number, url: string): Promise<void> {
  const meta = matchActivity(url);

  if (!meta) {
    if (activeActivityTabs.has(tabId)) {
      activeActivityTabs.delete(tabId);
      clearActivity();
    }
    return;
  }

  if (activeActivityTabs.get(tabId) === meta.id) return;

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
  void handleTabNavigation(tabId, tab.url);
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
  if (activeActivityTabs.has(tabId)) {
    activeActivityTabs.delete(tabId);
    clearActivity();
  }
});

// Messages from injected activity scripts and the popup.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as Record<string, unknown>;

  if (msg.type === 'FREEMID_SET_ACTIVITY' && typeof msg.data === 'object') {
    setActivity(msg.data as object);
    return;
  }

  if (msg.type === 'FREEMID_CLEAR_ACTIVITY') {
    clearActivity();
    return;
  }

  if (msg.type === 'GET_STATUS') {
    // Return the cached state immediately (kept fresh by the keepalive PING).
    // If the port isn't open yet, try to connect — the onMessage STATUS
    // response will broadcast the real state to the popup shortly after.
    if (!nativePort) connectNativeHost();
    sendResponse({
      hostConnected,
      discordConnected,
      error: lastError,
    });
    return true;
  }
});

// Keep the service worker alive and the native host port healthy.
chrome.alarms.create('freemid-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'freemid-keepalive') {
    if (!nativePort) connectNativeHost();
    else sendToHost({ type: 'PING' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcastStatus(): void {
  chrome.runtime
    .sendMessage({
      type: 'HOST_STATUS',
      hostConnected,
      discordConnected,
      error: lastError,
    })
    .catch(() => {
      // popup might not be open — ignore
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

connectNativeHost();
