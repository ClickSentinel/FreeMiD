import { PRESENCE_PREVIEW_ASSETS } from '../constants/presenceAssets';
import { githubLatestDownloadUrl, githubRepoUrl } from '../constants/github';

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
const btnUpdate     = document.getElementById('btn-update')    as HTMLButtonElement | null;
const btnUninstall  = document.getElementById('btn-uninstall') as HTMLButtonElement | null;
const elapsedBar    = document.getElementById('elapsed-bar')   as HTMLElement | null;
const timelineFill    = document.getElementById('timeline-fill')    as HTMLElement | null;
const timelineElapsed = document.getElementById('timeline-elapsed') as HTMLElement | null;
const timelineTotal   = document.getElementById('timeline-total')   as HTMLElement | null;
const extensionVersion = chrome.runtime.getManifest().version;
const DEV_WINDOWS_SETUP_URL = import.meta.env.VITE_WINDOWS_SETUP_URL?.trim() || '';

function windowsSetupUrl(): string {
  return urlLike(DEV_WINDOWS_SETUP_URL)
    ? DEV_WINDOWS_SETUP_URL
    : githubLatestDownloadUrl('freemid-setup.exe');
}

if (versionEl) versionEl.textContent = `v${extensionVersion}`;

// Clarify button behavior by platform so Windows users know these actions open Setup.
const isWindowsPlatform = /Win/i.test(navigator.platform);
if (isWindowsPlatform) {
  if (btnUpdate) {
    btnUpdate.textContent = 'Setup';
    btnUpdate.title = 'Open the FreeMiD setup executable';
    btnUpdate.classList.add('visible');
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

// How long to show "Checking for Discord..." before revealing help panel.
// Override for local tuning with VITE_DISCORD_CHECK_DELAY_MS.
const parsedDiscordCheckDelay = Number.parseInt(import.meta.env.VITE_DISCORD_CHECK_DELAY_MS ?? '', 10);
const DISCORD_CHECK_DELAY_MS = Number.isFinite(parsedDiscordCheckDelay) && parsedDiscordCheckDelay > 0
  ? parsedDiscordCheckDelay
  : 10000;
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
  clearTimer(uptimeInterval, clearInterval);
  uptimeInterval = null;
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

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
  clearTimer(timelineInterval, clearInterval);
  timelineInterval = null;
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
  setStatus('connecting', 'Reconnecting…', '');
  await chrome.runtime.sendMessage({ type: 'RECONNECT_HOST' });
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
  if (isWindowsPlatform) {
    const url = windowsSetupUrl();
    void chrome.tabs.create({ url });
    return;
  }

  if (btnUpdate?.disabled) return;

  void (async () => {
    const res = await chrome.runtime.sendMessage({ type: 'RUN_HOST_UPDATE' }) as
      | { ok: true }
      | { ok: false; manualInstall?: boolean };

    if (res && !res.ok && res.manualInstall) {
      setStatus('warning', 'Manual host update required', 'Open install guide to run one-time bootstrap');
      const installGuideUrl = githubRepoUrl('installation');
      void chrome.tabs.create({ url: installGuideUrl });
    }
  })();
});

btnInstallHost?.addEventListener('click', () => {
  const installUrl = githubRepoUrl('installation');
  void chrome.tabs.create({ url: installUrl });
});

btnUninstall?.addEventListener('click', () => {
  const url = isWindowsPlatform
    ? windowsSetupUrl()
    : githubLatestDownloadUrl('uninstall.sh');
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
  updateStatus?: {
    status: 'requested' | 'checking' | 'downloading' | 'reconnecting' | 'up_to_date' | 'success' | 'failed';
    version?: string;
    error?: string;
  } | null;
};

function urlLike(value?: string): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function clearTimer(timer: ReturnType<typeof setInterval> | null, clearFn: (handle: ReturnType<typeof setInterval>) => void): void {
  if (timer) clearFn(timer);
}

function setStatus(kind: 'connecting' | 'warning' | 'error' | 'connected', title: string, message: string): void {
  dot.className = `dot ${kind}`;
  label.textContent = title;
  sub.textContent = message;
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
    setStatus('connecting', 'Connecting…', 'Reaching native host');
    if (hostVersionEl) hostVersionEl.textContent = '';
    if (btnUpdate && !isWindowsPlatform) btnUpdate.classList.remove('visible', 'spinning');
    stopUptimeTick();
    stopTimelineTick();
    return;
  }

  const paused = status.paused ?? false;

  // Host version
  if (hostVersionEl) {
    hostVersionEl.textContent = status.hostVersion ? `host v${status.hostVersion}` : '';
  }

  // Inline host update control
  if (btnUpdate) {
    btnUpdate.classList.remove('spinning');

    if (isWindowsPlatform) {
      btnUpdate.disabled = false;
      btnUpdate.textContent = 'Setup';
      btnUpdate.title = 'Open the FreeMiD setup executable';
      btnUpdate.classList.add('visible');
    } else if (status.updateStatus) {
      const s = status.updateStatus.status;
      const inProgress = s === 'requested' || s === 'checking' || s === 'downloading' || s === 'reconnecting';

      if (inProgress) {
        btnUpdate.classList.add('visible', 'spinning');
        btnUpdate.disabled = true;
        btnUpdate.textContent = s === 'reconnecting' ? 'Applying' : 'Updating';
        btnUpdate.title = s === 'downloading'
          ? 'Downloading host update...'
          : s === 'reconnecting'
            ? 'Restarting host with updated binary...'
            : 'Checking for updates...';
      } else if (s === 'failed') {
        btnUpdate.classList.add('visible');
        btnUpdate.disabled = false;
        btnUpdate.textContent = 'Retry';
        btnUpdate.title = status.updateStatus.error ? `Update failed: ${status.updateStatus.error}` : 'Update failed. Try again.';
      } else {
        // up_to_date / success: hide the control until a new update is available.
        btnUpdate.classList.remove('visible');
      }
    } else if (status.updateAvailable) {
      const availableVersion = status.latestVersion && compareVersions(status.latestVersion, extensionVersion) > 0
        ? status.latestVersion
        : extensionVersion;
      btnUpdate.classList.add('visible');
      btnUpdate.disabled = false;
      btnUpdate.textContent = 'Update';
      btnUpdate.title = `Update host to v${availableVersion}`;
    } else {
      btnUpdate.classList.remove('visible');
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
      setStatus('connecting', 'Connecting…', 'Reaching native host');
    } else {
      setStatus('error', 'Native host not running', status.error);
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
      setStatus('connecting', 'Checking for Discord…', 'Looking for the Discord desktop app');
      if (!discordCheckTimer) {
        discordCheckTimer = setTimeout(() => {
          discordCheckShown = true;
          discordCheckTimer = null;
          setStatus('warning', 'Waiting for Discord', status.error ?? 'Open the Discord desktop app');
          helpDiscord.classList.remove('hidden');
        }, DISCORD_CHECK_DELAY_MS);
      }
    } else {
      setStatus('warning', 'Waiting for Discord', status.error ?? 'Open the Discord desktop app');
      helpDiscord.classList.remove('hidden');
    }
    return;
  }

  // Discord is connected — clear the check state for next disconnection
  if (discordCheckTimer) { clearTimeout(discordCheckTimer); discordCheckTimer = null; }
  discordCheckShown = false;

  if (paused) {
    setStatus('warning', 'Rich Presence paused', 'Toggle to resume sending to Discord');
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

  setStatus('connected', 'Connected', '');
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
