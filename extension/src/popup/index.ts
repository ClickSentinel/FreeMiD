import { PRESENCE_PREVIEW_ASSETS } from '../constants/presenceAssets';

/**
 * FreeMiD — Popup
 */

const dot        = document.getElementById('dot')!;
const label      = document.getElementById('status-label')!;
const sub        = document.getElementById('status-sub')!;
const helpHost   = document.getElementById('help-host')!;
const helpDiscord = document.getElementById('help-discord')!;
const btnInstallHost = document.getElementById('btn-install-host') as HTMLButtonElement | null;
const pageInfo   = document.getElementById('page-info')!;

const activityPanel = document.getElementById('activity-panel') as HTMLElement | null;
const activityTitle = document.getElementById('activity-title') as HTMLElement | null;
const activitySub   = document.getElementById('activity-sub')   as HTMLElement | null;
const activityMetaText = document.getElementById('activity-meta-text') as HTMLElement | null;
const activityArt   = document.getElementById('activity-art')   as HTMLImageElement | null;
const activityLogo  = document.getElementById('activity-logo')  as HTMLImageElement | null;
const pauseRow  = document.getElementById('pause-row')  as HTMLElement      | null;
const pauseSub  = document.getElementById('pause-sub')  as HTMLElement      | null;
const btnPause  = document.getElementById('btn-pause')  as HTMLButtonElement | null;
const toggleYT  = document.getElementById('toggle-youtube') as HTMLButtonElement | null;
const toggleYTM = document.getElementById('toggle-ytm')     as HTMLButtonElement | null;
const toggleTidal = document.getElementById('toggle-tidal') as HTMLButtonElement | null;
const btnOpenDiscord = document.getElementById('btn-open-discord') as HTMLButtonElement | null;
const reconnectBtn   = document.getElementById('btn-reconnect')    as HTMLButtonElement | null;
const versionEl = document.getElementById('version');
const hostVersionEl = document.getElementById('host-version') as HTMLElement | null;
const updateBanner  = document.getElementById('update-banner') as HTMLElement | null;
const updateText    = document.getElementById('update-text')   as HTMLElement | null;
const btnUpdate     = document.getElementById('btn-update')    as HTMLButtonElement | null;
const btnUninstall  = document.getElementById('btn-uninstall') as HTMLButtonElement | null;
const elapsedBar    = document.getElementById('elapsed-bar')   as HTMLElement | null;
const timelineFill    = document.getElementById('timeline-fill')    as HTMLElement | null;
const timelineElapsed = document.getElementById('timeline-elapsed') as HTMLElement | null;
const timelineTotal   = document.getElementById('timeline-total')   as HTMLElement | null;

if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

// Clarify button behavior by platform so Windows users know these actions open Setup.
const isWindowsPlatform = /Win/i.test(navigator.platform);
if (isWindowsPlatform) {
  if (btnUpdate) {
    btnUpdate.textContent = 'Open Setup ↗';
    btnUpdate.title = 'Open the latest FreeMiD setup executable';
  }
  if (btnUninstall) {
    btnUninstall.textContent = 'Open Setup';
    btnUninstall.title = 'Open setup and choose Uninstall';
  }
}

// ── Uptime ────────────────────────────────────────────────────────────────────

let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let connectedSinceMs: number | null = null;
let timelineInterval: ReturnType<typeof setInterval> | null = null;
let timelineStartSec: number | null = null;
let timelineEndSec: number | null = null;
let timelineKey: string | null = null;

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

// ── Timeline bar (Discord-style) ─────────────────────────────────────────────

function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function updateTimelineDisplay(): void {
  if (
    timelineStartSec == null ||
    timelineEndSec == null ||
    !timelineFill ||
    !timelineElapsed ||
    !timelineTotal
  ) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const duration = Math.max(0, timelineEndSec - timelineStartSec);
  const elapsed = Math.min(Math.max(0, nowSec - timelineStartSec), duration);
  const pct = duration > 0 ? (elapsed / duration) * 100 : 0;

  timelineFill.style.width = `${pct}%`;
  timelineElapsed.textContent = formatTimestamp(elapsed);
  timelineTotal.textContent = formatTimestamp(duration);
}

function startTimelineTick(): void {
  if (timelineInterval) return;
  timelineInterval = setInterval(updateTimelineDisplay, 1000);
  updateTimelineDisplay();
}

function stopTimelineTick(): void {
  if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
  timelineStartSec = null;
  timelineEndSec = null;
  timelineKey = null;
  if (timelineFill) timelineFill.style.width = '0%';
  if (timelineElapsed) timelineElapsed.textContent = '0:00';
  if (timelineTotal) timelineTotal.textContent = '0:00';
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
wireSiteToggle(toggleTidal, 'tidal');

// ── Open Discord ──────────────────────────────────────────────────────────────

btnOpenDiscord?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'discord://' });
});

btnUpdate?.addEventListener('click', () => {
  const url = isWindowsPlatform
    ? 'https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-setup.exe'
    : 'https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.sh';
  void chrome.tabs.create({ url });
});

btnInstallHost?.addEventListener('click', () => {
  const installUrl = 'https://github.com/ClickSentinel/FreeMiD#installation';
  void chrome.tabs.create({ url: installUrl });
});

btnUninstall?.addEventListener('click', () => {
  const url = isWindowsPlatform
    ? 'https://github.com/ClickSentinel/FreeMiD/releases/latest/download/freemid-setup.exe'
    : 'https://github.com/ClickSentinel/FreeMiD/releases/latest/download/uninstall.sh';
  void chrome.tabs.create({ url });
});

// ── Render ────────────────────────────────────────────────────────────────────

type Status = {
  hostConnected: boolean;
  discordConnected: boolean;
  error?: string | null;
  paused?: boolean;
  lastActivity?: {
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
  } | null;
  connectedSince?: number | null;
  enabledSites?: Record<string, boolean>;
  hostVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
};

function urlLike(value?: string): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function artistFromActivity(act: NonNullable<Status['lastActivity']>): string {
  const fromSub = act.sub?.replace(/^by\s+/i, '').trim();
  if (fromSub) return fromSub;
  if (act.activityName) return act.activityName;
  return '';
}

function fallbackLogoUrl(act: NonNullable<Status['lastActivity']>): string | null {
  const service = `${act.smallImageText ?? ''} ${act.activityName ?? ''} ${act.sub ?? ''}`.toLowerCase();
  if (service.includes('tidal')) {
    return chrome.runtime.getURL(PRESENCE_PREVIEW_ASSETS.tidalLogo);
  }
  if (service.includes('youtube music') || service.includes('yt music')) {
    return chrome.runtime.getURL(PRESENCE_PREVIEW_ASSETS.ytmusicLogo);
  }
  if (service.includes('youtube')) return 'https://www.youtube.com/s/desktop/6cfcd65f/img/logos/favicon_32x32.png';
  return null;
}

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
    stopTimelineTick();
    return;
  }

  const paused = status.paused ?? false;

  // Host version
  if (hostVersionEl) {
    hostVersionEl.textContent = status.hostVersion ? `host v${status.hostVersion}` : '';
  }

  // Update banner
  if (updateBanner) {
    if (status.updateAvailable && status.latestVersion) {
      updateBanner.classList.remove('hidden');
      if (updateText) {
        updateText.textContent = isWindowsPlatform
          ? `Host update available: v${status.latestVersion} (opens Setup)`
          : `Host update available: v${status.latestVersion}`;
      }
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
  setToggle(toggleTidal, status.enabledSites?.['tidal'] ?? true);

  if (!status.hostConnected) {
    if (discordCheckTimer) { clearTimeout(discordCheckTimer); discordCheckTimer = null; }
    discordCheckShown = false;

    // If there is no explicit error yet, treat this as a transient connecting
    // state to avoid flashing between statuses while the host handshake settles.
    if (!status.error) {
      dot.className = 'dot connecting';
      label.textContent = 'Connecting…';
      sub.textContent = 'Reaching native host';
    } else {
      dot.className = 'dot error';
      label.textContent = 'Native host not running';
      sub.textContent = status.error;
      helpHost.classList.remove('hidden');
    }

    stopUptimeTick();
    stopTimelineTick();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  if (!status.discordConnected) {
    stopUptimeTick();
    stopTimelineTick();
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
    stopTimelineTick();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  // Activity preview & timeline bar — only shown when fully connected and active
  const act = status.lastActivity;
  if (activityPanel) activityPanel.hidden = !act;
  if (act) {
    if (activityTitle) activityTitle.textContent = act.title;
    if (activitySub) {
      const album = act.largeImageText && act.largeImageText !== act.title ? act.largeImageText : '';
      activitySub.textContent = album;
    }
    if (activityMetaText) {
      activityMetaText.textContent = artistFromActivity(act);
    }

    const artUrl = urlLike(act.largeImageKey)
      ? act.largeImageKey
      : urlLike(act.smallImageKey)
        ? act.smallImageKey
        : null;
    if (activityArt) {
      if (artUrl) {
        activityArt.src = artUrl;
        activityArt.hidden = false;
      } else {
        activityArt.removeAttribute('src');
        activityArt.hidden = true;
      }
    }

    if (activityLogo) {
      const logoUrl = urlLike(act.smallImageKey) ? act.smallImageKey : fallbackLogoUrl(act);
      if (logoUrl) {
        activityLogo.src = logoUrl;
        activityLogo.hidden = false;
      } else {
        activityLogo.removeAttribute('src');
        activityLogo.hidden = true;
      }
    }

    const hasTimeline =
      typeof act.startTimestamp === 'number' &&
      typeof act.endTimestamp === 'number' &&
      act.endTimestamp > act.startTimestamp;

    if (hasTimeline) {
      const key = `${act.startTimestamp}:${act.endTimestamp}`;
      if (timelineKey !== key) {
        timelineKey = key;
        timelineStartSec = act.startTimestamp!;
        timelineEndSec = act.endTimestamp!;
      }
      if (elapsedBar) elapsedBar.classList.remove('hidden');
      startTimelineTick();
      updateTimelineDisplay();
    } else {
      stopTimelineTick();
    }
  } else {
    stopTimelineTick();
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
    // Retry only while host is connected but Discord handshake is pending.
    if (status?.hostConnected && !status.discordConnected && retriesLeft > 0) {
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
