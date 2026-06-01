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
const elapsedBar    = document.getElementById('elapsed-bar')   as HTMLElement | null;
const elapsedLabel  = document.getElementById('elapsed-label') as HTMLElement | null;
const elapsedTime   = document.getElementById('elapsed-time')  as HTMLElement | null;

if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// ── Uptime ────────────────────────────────────────────────────────────────────

let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let connectedSinceMs: number | null = null;
let elapsedInterval: ReturnType<typeof setInterval> | null = null;
let activityStartMs: number | null = null;

// How long to show "Checking for Discord..." before revealing help panel
const DISCORD_CHECK_DELAY_MS = 3000;
let discordCheckTimer: ReturnType<typeof setTimeout> | null = null;
let discordCheckShown = false;

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

// ── Elapsed bar (Discord-style) ───────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function updateElapsedDisplay(): void {
  if (activityStartMs == null || !elapsedTime) return;
  elapsedTime.textContent = formatElapsed(Date.now() - activityStartMs);
}

function startElapsedTick(): void {
  if (elapsedInterval) return;
  elapsedInterval = setInterval(updateElapsedDisplay, 1000);
  updateElapsedDisplay();
}

function stopElapsedTick(): void {
  if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
  activityStartMs = null;
  if (elapsedBar) elapsedBar.classList.add('hidden');
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
    stopElapsedTick();
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

  if (!status.hostConnected) {
    dot.className = 'dot error';
    label.textContent = 'Native host not running';
    sub.textContent = status.error ?? 'Install the FreeMiD host to continue';
    helpHost.classList.remove('hidden');
    stopUptimeTick();
    stopElapsedTick();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  if (!status.discordConnected) {
    stopUptimeTick();
    stopElapsedTick();
    if (activityPanel) activityPanel.hidden = true;
    // Show "checking" for DISCORD_CHECK_DELAY_MS before revealing help panel
    if (!discordCheckShown) {
      dot.className = 'dot connecting';
      label.textContent = 'Checking for Discord…';
      sub.textContent = 'Looking for the Discord desktop app';
      if (!discordCheckTimer) {
        discordCheckTimer = setTimeout(() => {
          discordCheckShown = true;
          discordCheckTimer = null;
          dot.className = 'dot warning';
          label.textContent = 'Waiting for Discord';
          sub.textContent = status.error ?? 'Open the Discord desktop app';
          helpDiscord.classList.remove('hidden');
        }, DISCORD_CHECK_DELAY_MS);
      }
    } else {
      dot.className = 'dot warning';
      label.textContent = 'Waiting for Discord';
      sub.textContent = status.error ?? 'Open the Discord desktop app';
      helpDiscord.classList.remove('hidden');
    }
    return;
  }

  // Discord is connected — clear the check state for next disconnection
  if (discordCheckTimer) { clearTimeout(discordCheckTimer); discordCheckTimer = null; }
  discordCheckShown = false;

  if (paused) {
    dot.className = 'dot warning';
    label.textContent = 'Rich Presence paused';
    sub.textContent = 'Toggle to resume sending to Discord';
    stopUptimeTick();
    stopElapsedTick();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  // Activity preview & elapsed bar — only shown when fully connected and active
  const act = status.lastActivity;
  if (activityPanel) activityPanel.hidden = !act;
  if (act) {
    if (activityTitle) activityTitle.textContent = act.title;
    if (activitySub)   activitySub.textContent   = act.sub;
    // Elapsed bar: reset timer when track changes
    const trackKey = act.title + '|' + act.sub;
    if (elapsedLabel && elapsedLabel.dataset['activity'] !== trackKey) {
      elapsedLabel.dataset['activity'] = trackKey;
      activityStartMs = Date.now();
    } else if (activityStartMs == null) {
      activityStartMs = Date.now();
    }
    if (elapsedBar) elapsedBar.classList.remove('hidden');
    startElapsedTick();
  } else {
    stopElapsedTick();
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
