/**
 * FreeMiD — Discord RPC Bridge Content Script
 *
 * Injected into a discord.com tab by the background service worker.
 * Because this script runs inside discord.com, WebSocket connections to
 * ws://127.0.0.1:6463 carry Origin: https://discord.com — the only origin
 * Discord's local RPC server accepts from a browser context.
 *
 * Message protocol with the background service worker:
 *   Background → Bridge : { type: 'FREEMID_RPC_SEND',   payload: <raw RPC object> }
 *   Background → Bridge : { type: 'FREEMID_BRIDGE_PING' }
 *   Bridge → Background : { type: 'FREEMID_BRIDGE_MSG',    data: <raw RPC object> }
 *   Bridge → Background : { type: 'FREEMID_BRIDGE_STATUS', connected: boolean }
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const CLIENT_ID: string = import.meta.env.VITE_DISCORD_CLIENT_ID as string;
const RPC_PORTS = [6463, 6464, 6465, 6466, 6467, 6468, 6469, 6470, 6471, 6472];
const RECONNECT_MS = 5_000;

// ── State ──────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let portIndex = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── Bridge init ────────────────────────────────────────────────────────────────

function startBridge(): void {
  if (!CLIENT_ID) {
    console.error('[FreeMiD] VITE_DISCORD_CLIENT_ID is not set — bridge cannot connect');
    return;
  }

  console.log('[FreeMiD] Bridge starting');
  connect();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as Record<string, unknown>;

    if (msg.type === 'FREEMID_BRIDGE_PING') {
      sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
      return true;
    }

    if (msg.type === 'FREEMID_RPC_SEND') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg.payload));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: 'not connected' });
      }
      return true;
    }
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const port = RPC_PORTS[portIndex % RPC_PORTS.length];
  console.log(`[FreeMiD] Attempting connection on port ${port}`);

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/?v=1&client_id=${CLIENT_ID}`);
  } catch {
    advance();
    return;
  }

  ws.onopen = () => {
    console.log(`[FreeMiD] Connected to Discord RPC on port ${port}`);
    chrome.runtime.sendMessage({ type: 'FREEMID_BRIDGE_STATUS', connected: true, port }).catch(() => {});
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string) as object;
      chrome.runtime.sendMessage({ type: 'FREEMID_BRIDGE_MSG', data }).catch(() => {});
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = (ev) => {
    console.warn(`[FreeMiD] Disconnected from Discord RPC on port ${port} (code ${ev.code})`);
    ws = null;
    chrome.runtime.sendMessage({ type: 'FREEMID_BRIDGE_STATUS', connected: false }).catch(() => {});
    advance();
  };

  ws.onerror = () => {
    console.warn(`[FreeMiD] WebSocket error on port ${port}`);
    ws?.close();
  };
}

function advance(): void {
  portIndex = (portIndex + 1) % RPC_PORTS.length;
  schedule();
}

function schedule(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

// ── Guard — must be LAST so all const/let declarations above are initialized ───

const _win = window as Window & { __freemidBridgeActive?: boolean };
if (!_win.__freemidBridgeActive) {
  _win.__freemidBridgeActive = true;
  startBridge();
}
