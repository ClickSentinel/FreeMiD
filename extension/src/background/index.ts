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

// ── Auth state ────────────────────────────────────────────────────────────────

/** True once AUTHENTICATE has been confirmed by Discord RPC */
let rpcAuthenticated = false;
/** True when we are waiting for the user to complete the OAuth2 flow */
let needsAuth = false;

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64urlEncode(arr.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  return base64urlEncode(await crypto.subtle.digest('SHA-256', data));
}

// ── Token management ──────────────────────────────────────────────────────────

interface StoredTokens {
  discord_access_token?: string;
  discord_token_expiry?: number;
  discord_refresh_token?: string;
}

async function loadValidToken(): Promise<string | null> {
  const { discord_access_token, discord_token_expiry, discord_refresh_token } =
    await chrome.storage.local.get([
      'discord_access_token',
      'discord_token_expiry',
      'discord_refresh_token',
    ]) as StoredTokens;

  if (!discord_access_token) return null;

  // Refresh proactively if expiring within 60 s
  if (discord_token_expiry && Date.now() > discord_token_expiry - 60_000) {
    if (discord_refresh_token) return attemptTokenRefresh(discord_refresh_token);
    await chrome.storage.local.remove(['discord_access_token', 'discord_token_expiry', 'discord_refresh_token']);
    return null;
  }

  return discord_access_token;
}

async function attemptTokenRefresh(refreshTok: string): Promise<string | null> {
  try {
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTok,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { access_token: string; expires_in: number; refresh_token?: string };
    await chrome.storage.local.set({
      discord_access_token: json.access_token,
      discord_token_expiry: Date.now() + json.expires_in * 1000,
      discord_refresh_token: json.refresh_token ?? refreshTok,
    });
    return json.access_token;
  } catch (e) {
    console.error('[FreeMiD] Token refresh failed:', e);
    await chrome.storage.local.remove(['discord_access_token', 'discord_token_expiry', 'discord_refresh_token']);
    return null;
  }
}

// ── OAuth2 PKCE flow ──────────────────────────────────────────────────────────

/**
 * Opens Discord's OAuth2 consent page via chrome.identity.launchWebAuthFlow
 * (PKCE — no client secret required). On success, stores tokens and
 * calls sendAuthenticate() so the RPC session becomes active immediately.
 */
async function initiateOAuthFlow(): Promise<void> {
  if (!CLIENT_ID) {
    console.error('[FreeMiD] Cannot start OAuth: VITE_DISCORD_CLIENT_ID is not set');
    return;
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'rpc rpc.activities.write');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  } catch (e) {
    console.error('[FreeMiD] OAuth flow cancelled or failed:', e);
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }

  if (!responseUrl) {
    console.warn('[FreeMiD] OAuth flow returned no URL (user cancelled)');
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }

  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) {
    console.error('[FreeMiD] OAuth redirect missing authorization code');
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }

  let tokenRes: Response;
  try {
    tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
  } catch (e) {
    console.error('[FreeMiD] Token exchange network error:', e);
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }

  if (!tokenRes.ok) {
    console.error('[FreeMiD] Token exchange failed:', await tokenRes.text());
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }

  const json = await tokenRes.json() as { access_token: string; expires_in: number; refresh_token: string };
  await chrome.storage.local.set({
    discord_access_token: json.access_token,
    discord_token_expiry: Date.now() + json.expires_in * 1000,
    discord_refresh_token: json.refresh_token,
  });

  needsAuth = false;
  sendAuthenticate(json.access_token);
}

// ── Discord RPC authentication ─────────────────────────────────────────────────

function sendAuthenticate(token: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    cmd: 'AUTHENTICATE',
    nonce: crypto.randomUUID(),
    args: { access_token: token },
  }));
}

async function checkAuthAndProceed(): Promise<void> {
  const token = await loadValidToken();
  if (!token) {
    needsAuth = true;
    broadcastStatus({ connected: false, authRequired: true });
    return;
  }
  sendAuthenticate(token);
}

// ── WebSocket management ───────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as { evt?: string; cmd?: string };

      if (msg.evt === 'READY') {
        console.log('[FreeMiD] Discord RPC ready — checking auth');
        void checkAuthAndProceed();
        return;
      }

      if (msg.cmd === 'AUTHENTICATE') {
        if (msg.evt === 'ERROR') {
          console.warn('[FreeMiD] AUTHENTICATE rejected — clearing stored token');
          rpcAuthenticated = false;
          needsAuth = true;
          void chrome.storage.local.remove(['discord_access_token', 'discord_token_expiry', 'discord_refresh_token']);
          broadcastStatus({ connected: false, authRequired: true });
        } else {
          rpcAuthenticated = true;
          needsAuth = false;
          console.log('[FreeMiD] Authenticated with Discord RPC');
          broadcastStatus({ connected: true, authRequired: false });
        }
      }
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => {
    rpcAuthenticated = false;
    ws = null;
    console.log('[FreeMiD] Disconnected from Discord RPC');
    broadcastStatus({ connected: false, authRequired: needsAuth });
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
  if (!ws || ws.readyState !== WebSocket.OPEN || !rpcAuthenticated) {
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
  if (!ws || ws.readyState !== WebSocket.OPEN || !rpcAuthenticated) return;

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

  if (msg.type === 'INITIATE_AUTH') {
    void initiateOAuthFlow();
    return;
  }

  // Popup requesting connection status — respond synchronously with current state
  if (msg.type === 'GET_STATUS') {
    sendResponse({
      connected: !!(ws && ws.readyState === WebSocket.OPEN && rpcAuthenticated),
      authRequired: needsAuth,
    });
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

function broadcastStatus(status: { connected: boolean; authRequired?: boolean }): void {
  chrome.runtime.sendMessage({ type: 'HOST_STATUS', ...status }).catch(() => {
    // popup may not be open; ignore
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

connectToDiscord();
