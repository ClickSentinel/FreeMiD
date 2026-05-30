/**
 * FreeMiD — Popup
 *
 * Listens to HOST_STATUS broadcasts from the background service worker
 * and renders a single, clear connection state.
 */

const dot = document.getElementById('dot')!;
const label = document.getElementById('status-label')!;
const sub = document.getElementById('status-sub')!;
const helpHost = document.getElementById('help-host')!;
const helpDiscord = document.getElementById('help-discord')!;
const pageInfo = document.getElementById('page-info')!;

type Status = {
  hostConnected: boolean;
  discordConnected: boolean;
  error?: string | null;
};

function render(status: Status | null): void {
  helpHost.classList.add('hidden');
  helpDiscord.classList.add('hidden');

  if (!status) {
    dot.className = 'dot connecting';
    label.textContent = 'Connecting…';
    sub.textContent = 'Reaching native host';
    return;
  }

  if (!status.hostConnected) {
    dot.className = 'dot error';
    label.textContent = 'Native host not running';
    sub.textContent = status.error ?? 'Install the FreeMiD host to continue';
    helpHost.classList.remove('hidden');
    return;
  }

  if (!status.discordConnected) {
    dot.className = 'dot warning';
    label.textContent = 'Waiting for Discord';
    sub.textContent = status.error ?? 'Open the Discord desktop app';
    helpDiscord.classList.remove('hidden');
    return;
  }

  dot.className = 'dot connected';
  label.textContent = 'Connected';
  sub.textContent = 'Rich Presence is live';
}

// Live updates from the background.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string } & Status;
  if (m.type === 'HOST_STATUS') render(m);
});

// Bootstrap.
(async () => {
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status | undefined;
    render(status ?? null);
  } catch {
    render(null);
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      pageInfo.textContent = new URL(tab.url).hostname;
    }
  } catch {
    pageInfo.textContent = '—';
  }
})();
