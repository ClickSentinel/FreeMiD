/**
 * FreeMiD — Popup
 */

const dot        = document.getElementById('dot')!;
const label      = document.getElementById('status-label')!;
const sub        = document.getElementById('status-sub')!;
const helpHost   = document.getElementById('help-host')!;
const helpDiscord = document.getElementById('help-discord')!;
const pageInfo   = document.getElementById('page-info')!;

const activityPanel = document.getElementById('activity-panel') as HTMLElement | null;
const activityTitle = document.getElementById('activity-title') as HTMLElement | null;
const activitySub   = document.getElementById('activity-sub')   as HTMLElement | null;
const pauseRow  = document.getElementById('pause-row')  as HTMLElement      | null;
const pauseSub  = document.getElementById('pause-sub')  as HTMLElement      | null;
const btnPause  = document.getElementById('btn-pause')  as HTMLButtonElement | null;
const toggleYT  = document.getElementById('toggle-youtube') as HTMLButtonElement | null;
const toggleYTM = document.getElementById('toggle-ytm')     as HTMLButtonElement | null;
const btnOpenDiscord = document.getElementById('btn-open-discord') as HTMLButtonElement | null;
const reconnectBtn   = document.getElementById('btn-reconnect')    as HTMLButtonElement | null;
const versionEl = document.getElementById('version');
const hostVersionEl = document.getElementById('host-version') as HTMLElement | null;
const updateBanner  = document.getElementById('update-banner') as HTMLElement | null;
const updateText    = document.getElementById('update-text')   as HTMLElement | null;
const btnUpdate     = document.getElementById('btn-update')    as HTMLButtonElement | null;

if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// ── Uptime ────────────────────────────────────────────────────────────────────

let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let connectedSinceMs: number | null = null;

function formatUptime(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function updateUptimeDisplay(): void {
  if (connectedSinceMs == null) return;
  sub.textContent = `Rich Presence is live · ${formatUptime(Date.now() - connectedSinceMs)}`;
}

function startUptimeTick(): void {
  if (uptimeInterval) return;
  uptimeInterval = setInterval(updateUptimeDisplay, 10_000);
}

function stopUptimeTick(): void {
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  connectedSinceMs = null;
}

// ── Reconnect ─────────────────────────────────────────────────────────────────

reconnectBtn?.addEventListener('click', async () => {
  if (!reconnectBtn) return;
  reconnectBtn.classList.add('spinning');
  reconnectBtn.disabled = true;
  dot.className = 'dot connecting';
  label.textContent = 'Reconnecting…';
  sub.textContent = '';
  await fetchStatus();
  reconnectBtn.classList.remove('spinning');
  reconnectBtn.disabled = false;
});

// ── Pause toggle ──────────────────────────────────────────────────────────────

btnPause?.addEventListener('click', () => {
  const nowPaused = btnPause.getAttribute('aria-checked') === 'true'; // ON = active, so clicking ON → pause
  void chrome.runtime.sendMessage({ type: 'SET_PAUSED', value: nowPaused });
});

// ── Site toggles ──────────────────────────────────────────────────────────────

function wireSiteToggle(btn: HTMLButtonElement | null, siteId: string): void {
  btn?.addEventListener('click', () => {
    const nowEnabled = btn.getAttribute('aria-checked') !== 'true';
    void chrome.runtime.sendMessage({ type: 'SET_SITE_ENABLED', siteId, enabled: nowEnabled });
  });
}
wireSiteToggle(toggleYT,  'youtube');
wireSiteToggle(toggleYTM, 'youtubemusic');

// ── Open Discord ──────────────────────────────────────────────────────────────

btnOpenDiscord?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'discord://' });
});

btnUpdate?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'https://github.com/ClickSentinel/FreeMiD/releases/latest' });
});

// ── Render ────────────────────────────────────────────────────────────────────

type Status = {
  hostConnected: boolean;
  discordConnected: boolean;
  error?: string | null;
  paused?: boolean;
  lastActivity?: { title: string; sub: string } | null;
  connectedSince?: number | null;
  enabledSites?: Record<string, boolean>;
  hostVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
};

function setToggle(btn: HTMLButtonElement | null, checked: boolean): void {
  btn?.setAttribute('aria-checked', String(checked));
}

function render(status: Status | null): void {
  helpHost.classList.add('hidden');
  helpDiscord.classList.add('hidden');

  if (!status) {
    dot.className = 'dot connecting';
    label.textContent = 'Connecting…';
    sub.textContent = 'Reaching native host';
    if (hostVersionEl) hostVersionEl.textContent = '';
    if (updateBanner) updateBanner.classList.add('hidden');
    stopUptimeTick();
    return;
  }

  const paused = status.paused ?? false;

  // Host version
  if (hostVersionEl) {
    hostVersionEl.textContent = status.hostVersion ? `Host v${status.hostVersion}` : '';
  }

  // Update banner
  if (updateBanner) {
    if (status.updateAvailable && status.latestVersion) {
      updateBanner.classList.remove('hidden');
      if (updateText) updateText.textContent = `Host update available: v${status.latestVersion}`;
    } else {
      updateBanner.classList.add('hidden');
    }
  }

  // Pause toggle — toggle is ON when Rich Presence is active (not paused)
  setToggle(btnPause, !paused);
  if (pauseSub) pauseSub.textContent = paused ? 'Paused' : 'Active';
  if (pauseRow) pauseRow.dataset['paused'] = String(paused);

  // Site toggles
  setToggle(toggleYT,  status.enabledSites?.['youtube']      ?? true);
  setToggle(toggleYTM, status.enabledSites?.['youtubemusic'] ?? true);

  // Activity preview
  const act = status.lastActivity;
  if (activityPanel) activityPanel.hidden = !act || paused;
  if (act) {
    if (activityTitle) activityTitle.textContent = act.title;
    if (activitySub)   activitySub.textContent   = act.sub;
  }

  // Connection state
  if (!status.hostConnected) {
    dot.className = 'dot error';
    label.textContent = 'Native host not running';
    sub.textContent = status.error ?? 'Install the FreeMiD host to continue';
    helpHost.classList.remove('hidden');
    stopUptimeTick();
    return;
  }

  if (!status.discordConnected) {
    dot.className = 'dot warning';
    label.textContent = 'Waiting for Discord';
    sub.textContent = status.error ?? 'Open the Discord desktop app';
    helpDiscord.classList.remove('hidden');
    stopUptimeTick();
    return;
  }

  if (paused) {
    dot.className = 'dot warning';
    label.textContent = 'Rich Presence paused';
    sub.textContent = 'Toggle to resume sending to Discord';
    stopUptimeTick();
    return;
  }

  dot.className = 'dot connected';
  label.textContent = 'Connected';
  if (status.connectedSince != null) {
    connectedSinceMs = status.connectedSince;
    startUptimeTick();
    updateUptimeDisplay();
  } else {
    sub.textContent = 'Rich Presence is live';
  }
}

// ── Live updates & bootstrap ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string } & Status;
  if (m.type === 'HOST_STATUS') render(m);
});

async function fetchStatus(retriesLeft = 4, intervalMs = 700): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status | undefined;
    render(status ?? null);
    if (!status?.discordConnected && retriesLeft > 0) {
      setTimeout(() => void fetchStatus(retriesLeft - 1, intervalMs), intervalMs);
    }
  } catch {
    render(null);
  }
}

void (async () => {
  void fetchStatus();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      try { pageInfo.textContent = new URL(tab.url).hostname; }
      catch { pageInfo.textContent = tab.url; }
    }
  } catch {
    pageInfo.textContent = '—';
  }
})();
