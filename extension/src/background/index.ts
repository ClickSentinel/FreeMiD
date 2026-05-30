/**
 * FreeMiD — Background Service Worker
 *
 * Responsibilities:
 *  1. Maintain a WebSocket connection to the FreeMiD native host (127.0.0.1:3005)
 *  2. Register per-domain content scripts (activities) dynamically
 *  3. Relay activity data from content scripts to the native host
 *  4. Instantly clear the Discord status when the active tab leaves a known domain
 *     (free, unlike PreMiD's 20-minute paywall "feature")
 */

import { ACTIVITY_REGISTRY, type ActivityMeta } from '../activities/registry';

const HOST_URL = 'ws://127.0.0.1:3005';
const RECONNECT_DELAY_MS = 3000;

// ── WebSocket management ───────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hostConnected = false;

function connectToHost(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(HOST_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    hostConnected = true;
    console.log('[FreeMiD] Connected to native host');
    broadcastStatus({ connected: true });
  };

  ws.onclose = () => {
    hostConnected = false;
    ws = null;
    console.log('[FreeMiD] Disconnected from native host');
    broadcastStatus({ connected: false });
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      if (msg.type === 'CONNECTED') {
        console.log('[FreeMiD] Host version:', msg.version);
      }
    } catch {
      // ignore malformed messages
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToHost();
  }, RECONNECT_DELAY_MS);
}

function sendToHost(payload: object): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectToHost(); // attempt reconnect; next activity update will retry
    return;
  }
  ws.send(JSON.stringify(payload));
}

export function setActivity(activity: object): void {
  sendToHost({ type: 'SET_ACTIVITY', activity });
}

export function clearActivity(): void {
  sendToHost({ type: 'CLEAR_ACTIVITY' });
}

// ── Activity registry & content script injection ───────────────────────────────

/** Returns the first matching activity for a given URL, or null. */
function matchActivity(url: string): ActivityMeta | null {
  for (const meta of Object.values(ACTIVITY_REGISTRY)) {
    if (meta.matches.some((pattern) => urlMatchesPattern(url, pattern))) {
      return meta;
    }
  }
  return null;
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  // Convert glob-style patterns (*.youtube.com) to RegExp
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}`, 'i').test(url);
}

/** Track which tabId has an active activity script injected */
const activeActivityTabs = new Map<number, string /* activityId */>();

async function handleTabNavigation(tabId: number, url: string): Promise<void> {
  const meta = matchActivity(url);

  if (!meta) {
    // Left a known domain — clear status INSTANTLY (free, unlike PreMiD)
    if (activeActivityTabs.has(tabId)) {
      activeActivityTabs.delete(tabId);
      clearActivity();
    }
    return;
  }

  if (activeActivityTabs.get(tabId) === meta.id) {
    return; // already injected for this activity
  }

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
  if (changeInfo.status === 'complete' && tab.url) {
    void handleTabNavigation(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) void handleTabNavigation(tabId, tab.url);
  } catch {
    // tab may no longer exist
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeActivityTabs.has(tabId)) {
    activeActivityTabs.delete(tabId);
    clearActivity();
  }
});

// Messages from injected activity scripts
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

  // Popup requesting connection status — respond synchronously with current state
  if (msg.type === 'GET_STATUS') {
    const connected = !!(ws && ws.readyState === WebSocket.OPEN);
    sendResponse({ connected });
    return true;
  }
});

// Keep service worker alive with a periodic alarm while the host is connected.
// This prevents Chrome from terminating it and dropping the WS connection.
chrome.alarms.create('freemid-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'freemid-keepalive') {
    connectToHost();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcastStatus(status: { connected: boolean }): void {
  chrome.runtime.sendMessage({ type: 'HOST_STATUS', ...status }).catch(() => {
    // popup may not be open; ignore
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

connectToHost();
