/**
 * FreeMiD — Background Service Worker
 *
 * Responsibilities:
 *  1. Maintain a WebSocket connection directly to Discord's local RPC server (127.0.0.1:6463-6472)
 *  2. Register per-domain content scripts (activities) dynamically
 *  3. Relay activity data from content scripts to Discord via the RPC protocol
 *  4. Instantly clear the Discord status when the active tab leaves a known domain
 *
 * No native host is required — the extension communicates with Discord directly.
 */

import { ACTIVITY_REGISTRY, type ActivityMeta } from '../activities/registry';

/**
 * Discord application client ID.
 * Set VITE_DISCORD_CLIENT_ID in extension/.env (never commit that file).
 */
const CLIENT_ID: string = import.meta.env.VITE_DISCORD_CLIENT_ID as string;
if (!CLIENT_ID) console.error('[FreeMiD] VITE_DISCORD_CLIENT_ID is not set — Rich Presence will not work.');
/** Discord runs its local RPC WebSocket server on one of these ports */
const DISCORD_RPC_PORTS = [6463, 6464, 6465, 6466, 6467, 6468, 6469, 6470, 6471, 6472];
const RECONNECT_DELAY_MS = 5000;

// ── WebSocket management ───────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let rpcReady = false;
let portIndex = 0;

function connectToDiscord(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const port = DISCORD_RPC_PORTS[portIndex % DISCORD_RPC_PORTS.length];

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?v=1&client_id=${CLIENT_ID}`);
  } catch {
    advancePortAndReconnect();
    return;
  }

  ws.onopen = () => {
    console.log(`[FreeMiD] Connected to Discord RPC on port ${port}`);
    // Discord sends READY dispatch automatically; wait for it before sending activities
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as { evt?: string };
      if (msg.evt === 'READY') {
        rpcReady = true;
        console.log('[FreeMiD] Discord RPC ready');
        broadcastStatus({ connected: true });
      }
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => {
    rpcReady = false;
    ws = null;
    console.log('[FreeMiD] Disconnected from Discord RPC');
    broadcastStatus({ connected: false });
    advancePortAndReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function advancePortAndReconnect(): void {
  portIndex = (portIndex + 1) % DISCORD_RPC_PORTS.length;
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToDiscord();
  }, RECONNECT_DELAY_MS);
}

/**
 * Send a Discord RPC SET_ACTIVITY command.
 * Strips FreeMiD-internal fields (application_id, name) that don't belong in the RPC payload.
 */
export function setActivity(activity: object): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !rpcReady) {
    connectToDiscord();
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { application_id, name, ...discordActivity } = activity as Record<string, unknown>;

  ws.send(JSON.stringify({
    cmd: 'SET_ACTIVITY',
    args: { pid: 1, activity: discordActivity },
    nonce: crypto.randomUUID(),
  }));
}

/**
 * Send a Discord RPC SET_ACTIVITY command with a null activity to clear the status.
 */
export function clearActivity(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || !rpcReady) return;

  ws.send(JSON.stringify({
    cmd: 'SET_ACTIVITY',
    args: { pid: 1, activity: null },
    nonce: crypto.randomUUID(),
  }));
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
  // Parse both the URL and the Chrome extension match pattern into components
  // so we compare scheme/host/path independently. This prevents a crafted
  // query-string like https://evil.com/?x=https://music.youtube.com/ from
  // bypassing a regex anchored only at the start.
  try {
    const parsed = new URL(url);

    const schemeEnd = pattern.indexOf('://');
    if (schemeEnd === -1) return false;
    const patternScheme = pattern.slice(0, schemeEnd);
    const afterScheme = pattern.slice(schemeEnd + 3);
    const slashIdx = afterScheme.indexOf('/');
    const patternHost = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
    const patternPath = slashIdx === -1 ? '' : afterScheme.slice(slashIdx);

    // Scheme: '*' matches any, otherwise must be exact (minus the trailing ':')
    if (patternScheme !== '*' && patternScheme !== parsed.protocol.slice(0, -1)) {
      return false;
    }

    // Host: must match the full hostname — no partial substring matches
    const hostRe = new RegExp(
      '^' + patternHost.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );
    if (!hostRe.test(parsed.hostname)) return false;

    // Path: prefix match, '*' as wildcard
    if (!patternPath || patternPath === '/*') return true;
    const pathRe = new RegExp(
      '^' + patternPath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
      'i'
    );
    return pathRe.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

/** Track which tabId has an active activity script injected */
const activeActivityTabs = new Map<number, string /* activityId */>();

async function handleTabNavigation(tabId: number, url: string): Promise<void> {
  const meta = matchActivity(url);

  if (!meta) {
    // Left a known domain — clear status immediately
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
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN && rpcReady) });
    return true;
  }
});

// Keep service worker alive with a periodic alarm while connected.
// This prevents Chrome from terminating it and dropping the WS connection.
chrome.alarms.create('freemid-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'freemid-keepalive') {
    connectToDiscord();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function broadcastStatus(status: { connected: boolean }): void {
  chrome.runtime.sendMessage({ type: 'HOST_STATUS', ...status }).catch(() => {
    // popup may not be open; ignore
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

connectToDiscord();
