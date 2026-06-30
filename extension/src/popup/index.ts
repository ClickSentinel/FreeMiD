import { compareVersions, isUpdateInProgress } from '../background/helpers';
import { githubLatestDownloadUrl, githubRepoUrl } from '../constants/github';
import {
  artistFromActivity,
  fallbackLogoPath,
  isUnsupportedPlatformUpdateError,
  urlLike,
} from './helpers';

/**
 * FreeMiD — Popup
 */

const dot = document.getElementById('dot') as HTMLElement;
const label = document.getElementById('status-label') as HTMLElement;
const sub = document.getElementById('status-sub') as HTMLElement;
const helpHost = document.getElementById('help-host') as HTMLElement;
const helpDiscord = document.getElementById('help-discord') as HTMLElement;
const btnInstallHost = document.getElementById(
  'btn-install-host',
) as HTMLButtonElement | null;
const activityPanel = document.getElementById(
  'activity-panel',
) as HTMLElement | null;
const activityTitle = document.getElementById(
  'activity-title',
) as HTMLElement | null;
const activitySub = document.getElementById(
  'activity-sub',
) as HTMLElement | null;
const activityMetaText = document.getElementById(
  'activity-meta-text',
) as HTMLElement | null;
const activityArt = document.getElementById(
  'activity-art',
) as HTMLImageElement | null;
const activityLogo = document.getElementById(
  'activity-logo',
) as HTMLImageElement | null;
const pauseRow = document.getElementById('pause-row') as HTMLElement | null;
const pauseSub = document.getElementById('pause-sub') as HTMLElement | null;
const btnPause = document.getElementById(
  'btn-pause',
) as HTMLButtonElement | null;
const toggleYT = document.getElementById(
  'toggle-youtube',
) as HTMLButtonElement | null;
const toggleYTM = document.getElementById(
  'toggle-ytm',
) as HTMLButtonElement | null;
const toggleTidal = document.getElementById(
  'toggle-tidal',
) as HTMLButtonElement | null;
const btnOpenDiscord = document.getElementById(
  'btn-open-discord',
) as HTMLButtonElement | null;
const reconnectBtn = document.getElementById(
  'btn-reconnect',
) as HTMLButtonElement | null;
const versionEl = document.getElementById('version');
const hostVersionEl = document.getElementById(
  'host-version',
) as HTMLElement | null;
const btnUpdate = document.getElementById(
  'btn-update',
) as HTMLButtonElement | null;
const btnUninstall = document.getElementById(
  'btn-uninstall',
) as HTMLButtonElement | null;
const elapsedBar = document.getElementById('elapsed-bar') as HTMLElement | null;
const timelineFill = document.getElementById(
  'timeline-fill',
) as HTMLElement | null;
const timelineElapsed = document.getElementById(
  'timeline-elapsed',
) as HTMLElement | null;
const timelineTotal = document.getElementById(
  'timeline-total',
) as HTMLElement | null;
const extensionVersion = chrome.runtime.getManifest().version;
const DEV_WINDOWS_SETUP_URL =
  import.meta.env.VITE_WINDOWS_SETUP_URL?.trim() || '';
let latestStatus: Status | null = null;
let reconnectGraceUntilMs: number | null = null;
let reconnectSawDisconnect = false;
let reconnectPollTimer: ReturnType<typeof setInterval> | null = null;
const RECONNECT_UI_GRACE_MS = 15_000;
const RECONNECT_BUTTON_COOLDOWN_MS = 15_000;
let reconnectButtonUnlockAtMs = 0;

function windowsSetupUrl(): string {
  // Keep env override for local testing, but default users to install docs.
  return urlLike(DEV_WINDOWS_SETUP_URL)
    ? DEV_WINDOWS_SETUP_URL
    : githubRepoUrl('installation');
}

if (versionEl) versionEl.textContent = `v${extensionVersion}`;

// Clarify button behavior by platform so Windows users know these actions open Setup.
const isWindowsPlatform = /Win/i.test(navigator.platform);
if (isWindowsPlatform) {
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
const parsedDiscordCheckDelay = Number.parseInt(
  import.meta.env.VITE_DISCORD_CHECK_DELAY_MS ?? '',
  10,
);
const DISCORD_CHECK_DELAY_MS =
  Number.isFinite(parsedDiscordCheckDelay) && parsedDiscordCheckDelay > 0
    ? parsedDiscordCheckDelay
    : 10000;
let discordCheckTimer: ReturnType<typeof setTimeout> | null = null;
let discordCheckShown = false;
// Debounce before revealing "Native host not installed" help panel, matching
// the Discord check pattern. Prevents a false flash during post-update reconnect
// when lastError carries a stale Chrome port error but the host is about to
// come back up.
const HOST_CHECK_DELAY_MS = 2000;
let hostCheckTimer: ReturnType<typeof setTimeout> | null = null;
let hostCheckShown = false;

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
  if (h > 0)
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function updateTimelineDisplay(): void {
  if (
    timelineStartSec == null ||
    timelineEndSec == null ||
    !timelineFill ||
    !timelineElapsed ||
    !timelineTotal
  )
    return;

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

function stopAllTicks(): void {
  stopUptimeTick();
  stopTimelineTick();
}

// ── Reconnect ─────────────────────────────────────────────────────────────────

reconnectBtn?.addEventListener('click', async () => {
  if (!reconnectBtn) return;
  if (Date.now() < reconnectButtonUnlockAtMs) return;

  reconnectButtonUnlockAtMs = Date.now() + RECONNECT_BUTTON_COOLDOWN_MS;
  reconnectBtn.classList.add('spinning');
  reconnectBtn.disabled = true;
  reconnectGraceUntilMs = Date.now() + RECONNECT_UI_GRACE_MS;
  reconnectSawDisconnect = false;
  setStatus('connecting', 'Reconnecting…', '');

  if (!reconnectPollTimer) {
    reconnectPollTimer = setInterval(() => {
      void fetchStatus(0);
    }, 700);
  }

  const res = (await chrome.runtime.sendMessage({ type: 'RECONNECT_HOST' })) as
    | { ok: true; retryAfterMs?: number }
    | { ok: false; error?: string; retryAfterMs?: number };

  if (
    typeof res?.retryAfterMs === 'number' &&
    Number.isFinite(res.retryAfterMs) &&
    res.retryAfterMs > 0
  ) {
    reconnectButtonUnlockAtMs = Math.max(
      reconnectButtonUnlockAtMs,
      Date.now() + res.retryAfterMs,
    );
  }

  if (!res?.ok) {
    if (res?.error === 'Reconnect cooling down') {
      // A reconnect is already in progress — keep the grace window active but
      // stop the spinner and tell the user why the button is locked.
      setStatus(
        'connecting',
        'Connecting…',
        'Already reconnecting — please wait',
      );
    } else {
      reconnectGraceUntilMs = null;
      reconnectSawDisconnect = false;
      if (reconnectPollTimer) {
        clearInterval(reconnectPollTimer);
        reconnectPollTimer = null;
      }
      setStatus(
        'error',
        'Reconnect failed',
        res?.error ?? 'Failed to reconnect native host',
      );
    }

    reconnectBtn.classList.remove('spinning');
    reconnectBtn.disabled = Date.now() < reconnectButtonUnlockAtMs;
  }
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
    void chrome.runtime.sendMessage({
      type: 'SET_SITE_ENABLED',
      siteId,
      enabled: nowEnabled,
    });
  });
}
wireSiteToggle(toggleYT, 'youtube');
wireSiteToggle(toggleYTM, 'youtubemusic');
wireSiteToggle(toggleTidal, 'tidal');

// ── Open Discord ──────────────────────────────────────────────────────────────

btnOpenDiscord?.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'discord://' });
});

btnUpdate?.addEventListener('click', () => {
  if (btnUpdate?.disabled) return;

  void (async () => {
    const explicitManualBootstrap =
      latestStatus?.hostSelfUpdateSupported === false;
    if (explicitManualBootstrap) {
      setStatus(
        'warning',
        'Manual host update required',
        'Opening install instructions',
      );
      void chrome.tabs.create({ url: windowsSetupUrl() });
      return;
    }

    const unsupportedPlatformUpdate =
      isWindowsPlatform &&
      isUnsupportedPlatformUpdateError(latestStatus?.updateStatus?.error);

    if (unsupportedPlatformUpdate) {
      setStatus(
        'warning',
        'Manual host update required',
        'Opening install instructions',
      );
      void chrome.tabs.create({ url: windowsSetupUrl() });
      return;
    }

    const res = (await chrome.runtime.sendMessage({
      type: 'RUN_HOST_UPDATE',
    })) as
      | { ok: true }
      | { ok: false; manualInstall?: boolean; error?: string };

    if (res && !res.ok && res.manualInstall) {
      if (isWindowsPlatform) {
        setStatus(
          'warning',
          'Manual host update required',
          'Opening install instructions',
        );
        void chrome.tabs.create({ url: windowsSetupUrl() });
      } else {
        setStatus(
          'warning',
          'Manual host update required',
          'Open install guide to run one-time bootstrap',
        );
        const installGuideUrl = githubRepoUrl('installation');
        void chrome.tabs.create({ url: installGuideUrl });
      }
      return;
    }

    if (res && !res.ok) {
      setStatus(
        'error',
        'Host update failed to start',
        res.error ?? 'Failed to send update command',
      );
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
  hostSelfUpdateSupported?: boolean | null;
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
    status:
      | 'requested'
      | 'checking'
      | 'downloading'
      | 'reconnecting'
      | 'up_to_date'
      | 'success'
      | 'failed';
    version?: string;
    error?: string;
  } | null;
};

function clearTimer(
  timer: ReturnType<typeof setInterval> | null,
  clearFn: (handle: ReturnType<typeof setInterval>) => void,
): void {
  if (timer) clearFn(timer);
}

function setStatus(
  kind: 'connecting' | 'warning' | 'error' | 'connected',
  title: string,
  message: string,
): void {
  dot.className = `dot ${kind}`;
  label.textContent = title;
  sub.textContent = message;
}

function setImageEl(el: HTMLImageElement, url: string | null): void {
  if (url) {
    el.src = url;
    el.hidden = false;
  } else {
    el.removeAttribute('src');
    el.hidden = true;
  }
}

function setToggle(btn: HTMLButtonElement | null, checked: boolean): void {
  btn?.setAttribute('aria-checked', String(checked));
}

function render(status: Status | null): void {
  latestStatus = status;
  helpHost.classList.add('hidden');
  helpDiscord.classList.add('hidden');
  reconnectBtn?.classList.remove('visible');

  if (reconnectBtn && Date.now() < reconnectButtonUnlockAtMs) {
    reconnectBtn.disabled = true;
  }

  const reconnectGraceActive =
    reconnectGraceUntilMs != null && Date.now() < reconnectGraceUntilMs;

  if (!status) {
    if (reconnectGraceActive) {
      setStatus('connecting', 'Connecting…', 'Restarting native host');
    } else {
      setStatus('connecting', 'Connecting…', 'Reaching native host');
    }
    if (hostVersionEl) hostVersionEl.textContent = '';
    if (btnUpdate) btnUpdate.classList.remove('visible', 'spinning');
    reconnectBtn?.classList.add('visible');
    stopAllTicks();
    return;
  }

  const paused = status.paused ?? false;

  if (reconnectGraceUntilMs != null && !status.hostConnected) {
    reconnectSawDisconnect = true;
  }

  if (reconnectGraceUntilMs != null) {
    const graceExpired = Date.now() >= reconnectGraceUntilMs;
    const reconnectRecovered = reconnectSawDisconnect && status.hostConnected;

    if (reconnectRecovered || graceExpired) {
      reconnectGraceUntilMs = null;
      reconnectSawDisconnect = false;
      if (reconnectPollTimer) {
        clearInterval(reconnectPollTimer);
        reconnectPollTimer = null;
      }
      if (reconnectBtn) {
        reconnectBtn.classList.remove('spinning');
        reconnectBtn.disabled = Date.now() < reconnectButtonUnlockAtMs;
      }
    } else {
      setStatus('connecting', 'Connecting…', 'Restarting native host');
      reconnectBtn?.classList.add('visible');
      stopAllTicks();
      if (activityPanel) activityPanel.hidden = true;
      return;
    }
  }

  // Host version
  if (hostVersionEl) {
    hostVersionEl.textContent = status.hostVersion
      ? `host v${status.hostVersion}`
      : '';
  }

  // Inline host update control
  if (btnUpdate) {
    btnUpdate.classList.remove('spinning');

    if (status.updateStatus) {
      const s = status.updateStatus.status;

      if (isUpdateInProgress(status.updateStatus)) {
        btnUpdate.classList.add('visible', 'spinning');
        btnUpdate.disabled = true;
        btnUpdate.textContent = s === 'reconnecting' ? 'Applying' : 'Updating';
        btnUpdate.title =
          s === 'downloading'
            ? 'Downloading host update...'
            : s === 'reconnecting'
              ? 'Restarting host with updated binary...'
              : 'Checking for updates...';
      } else if (s === 'failed') {
        btnUpdate.classList.add('visible');
        btnUpdate.disabled = false;
        if (
          isWindowsPlatform &&
          isUnsupportedPlatformUpdateError(status.updateStatus.error)
        ) {
          btnUpdate.textContent = 'Install Guide';
          btnUpdate.title = 'Open install instructions';
        } else {
          btnUpdate.textContent = 'Retry';
          btnUpdate.title = status.updateStatus.error
            ? `Update failed: ${status.updateStatus.error}`
            : 'Update failed. Try again.';
        }
      } else {
        // up_to_date / success: hide the control until a new update is available.
        btnUpdate.classList.remove('visible');
      }
    } else if (status.updateAvailable) {
      btnUpdate.classList.add('visible');
      btnUpdate.disabled = false;
      if (status.hostSelfUpdateSupported === false) {
        btnUpdate.textContent = 'Install Guide';
        btnUpdate.title =
          'Open install instructions for one-time host bootstrap';
      } else {
        const availableVersion =
          status.latestVersion &&
          compareVersions(status.latestVersion, extensionVersion) > 0
            ? status.latestVersion
            : extensionVersion;
        btnUpdate.textContent = 'Update';
        btnUpdate.title = `Update host to v${availableVersion}`;
      }
    } else {
      btnUpdate.classList.remove('visible');
    }
  }

  // Pause toggle — toggle is ON when Rich Presence is active (not paused)
  setToggle(btnPause, !paused);
  if (pauseSub) pauseSub.textContent = paused ? 'Paused' : 'Active';
  if (pauseRow) pauseRow.dataset.paused = String(paused);

  // Site toggles
  setToggle(toggleYT, status.enabledSites?.youtube ?? true);
  setToggle(toggleYTM, status.enabledSites?.youtubemusic ?? true);
  setToggle(toggleTidal, status.enabledSites?.tidal ?? true);

  if (!status.hostConnected) {
    if (discordCheckTimer) {
      clearTimeout(discordCheckTimer);
      discordCheckTimer = null;
    }
    discordCheckShown = false;

    const updateInProgress = isUpdateInProgress(status.updateStatus);

    if (updateInProgress) {
      const isReconnecting = status.updateStatus?.status === 'reconnecting';
      setStatus(
        'connecting',
        isReconnecting ? 'Applying update…' : 'Updating host…',
        isReconnecting
          ? 'Restarting native host with updated binary'
          : 'Waiting for native host update process',
      );
      stopAllTicks();
      if (activityPanel) activityPanel.hidden = true;
      return;
    }

    // If there is no explicit error yet, treat this as a transient connecting
    // state to avoid flashing between statuses while the host handshake settles.
    if (!status.error) {
      if (hostCheckTimer) {
        clearTimeout(hostCheckTimer);
        hostCheckTimer = null;
      }
      hostCheckShown = false;
      setStatus('connecting', 'Connecting…', 'Reaching native host');
    } else if (hostCheckShown) {
      setStatus('error', 'Native host not running', status.error);
      helpHost.classList.remove('hidden');
    } else {
      setStatus('error', 'Native host not running', status.error);
      if (!hostCheckTimer) {
        hostCheckTimer = setTimeout(() => {
          hostCheckTimer = null;
          hostCheckShown = true;
          render(latestStatus);
        }, HOST_CHECK_DELAY_MS);
      }
    }

    reconnectBtn?.classList.add('visible');
    stopAllTicks();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  // Host is connected — clear any pending host-error debounce.
  if (hostCheckTimer) {
    clearTimeout(hostCheckTimer);
    hostCheckTimer = null;
  }
  hostCheckShown = false;

  if (!status.discordConnected) {
    stopAllTicks();
    if (activityPanel) activityPanel.hidden = true;
    // Show "checking" for DISCORD_CHECK_DELAY_MS before revealing help panel
    if (!discordCheckShown) {
      setStatus(
        'connecting',
        'Checking for Discord…',
        'Looking for the Discord desktop app',
      );
      if (!discordCheckTimer) {
        discordCheckTimer = setTimeout(() => {
          discordCheckShown = true;
          discordCheckTimer = null;
          setStatus(
            'warning',
            'Waiting for Discord',
            status.error ?? 'Open the Discord desktop app',
          );
          helpDiscord.classList.remove('hidden');
        }, DISCORD_CHECK_DELAY_MS);
      }
    } else {
      setStatus(
        'warning',
        'Waiting for Discord',
        status.error ?? 'Open the Discord desktop app',
      );
      helpDiscord.classList.remove('hidden');
    }
    return;
  }

  // Discord is connected — clear the check state for next disconnection
  if (discordCheckTimer) {
    clearTimeout(discordCheckTimer);
    discordCheckTimer = null;
  }
  discordCheckShown = false;

  if (paused) {
    setStatus(
      'warning',
      'Rich Presence paused',
      'Toggle to resume sending to Discord',
    );
    stopAllTicks();
    if (activityPanel) activityPanel.hidden = true;
    return;
  }

  // Activity preview & timeline bar — only shown when fully connected and active
  const act = status.lastActivity;
  if (activityPanel) activityPanel.hidden = !act;
  if (act) {
    if (activityTitle) {
      let inner = activityTitle.querySelector('span');
      if (!inner) {
        inner = document.createElement('span');
        activityTitle.textContent = '';
        activityTitle.appendChild(inner);
      }
      if (inner.dataset.scrollTitle !== act.title) {
        inner.classList.remove('scrolling');
        inner.style.removeProperty('--marquee-offset');
        inner.textContent = act.title;
        // Cache the title now so rapid polls don't re-set text while the
        // rAF measurement is pending.
        inner.dataset.scrollTitle = act.title;
        // Defer measurement one frame — the activity panel may have just
        // become visible and clientWidth would be stale/zero in the same tick.
        const titleSnapshot = act.title;
        requestAnimationFrame(() => {
          if (inner.dataset.scrollTitle !== titleSnapshot) return;
          const containerWidth = activityTitle.clientWidth;
          const overflow = inner.scrollWidth - containerWidth;
          if (overflow > 8) {
            inner.style.setProperty('--marquee-offset', `-${overflow}px`);
            inner.classList.add('scrolling');
          }
        });
      }
    }
    if (activitySub) {
      const album = act.largeImageText ?? '';
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
    if (activityArt) setImageEl(activityArt, artUrl ?? null);

    if (activityLogo) {
      const logoPath = fallbackLogoPath(act);
      const logoUrl = urlLike(act.smallImageKey)
        ? act.smallImageKey
        : logoPath
          ? chrome.runtime.getURL(logoPath)
          : null;
      setImageEl(activityLogo, logoUrl ?? null);
    }

    if (
      typeof act.startTimestamp === 'number' &&
      typeof act.endTimestamp === 'number' &&
      act.endTimestamp > act.startTimestamp
    ) {
      const key = `${act.startTimestamp}:${act.endTimestamp}`;
      if (timelineKey !== key) {
        timelineKey = key;
        timelineStartSec = act.startTimestamp;
        timelineEndSec = act.endTimestamp;
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
    const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as
      | Status
      | undefined;
    render(status ?? null);
    // Retry only while host is connected but Discord handshake is pending.
    if (status?.hostConnected && !status.discordConnected && retriesLeft > 0) {
      setTimeout(
        () => void fetchStatus(retriesLeft - 1, intervalMs),
        intervalMs,
      );
    }
  } catch {
    render(null);
  }
}

void fetchStatus();
