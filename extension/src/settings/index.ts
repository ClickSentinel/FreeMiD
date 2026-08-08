import { githubRepoUrl } from '../constants/github';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { formatDebugLog } from '../debug/format';
import type { DebugEntry } from '../debug/log';

/**
 * FreeMiD — Settings
 */

const extVersionEl = document.getElementById('ext-version') as HTMLElement;
const hostVersionEl = document.getElementById('host-version') as HTMLElement;
const btnUninstall = document.getElementById(
  'btn-uninstall',
) as HTMLButtonElement | null;

const debugToggle = document.getElementById(
  'debug-enabled',
) as HTMLInputElement | null;
const btnDebugCopy = document.getElementById(
  'btn-debug-copy',
) as HTMLButtonElement | null;
const btnDebugDownload = document.getElementById(
  'btn-debug-download',
) as HTMLButtonElement | null;
const btnDebugClear = document.getElementById(
  'btn-debug-clear',
) as HTMLButtonElement | null;
const debugStatus = document.getElementById('debug-status');

const extensionVersion = chrome.runtime.getManifest().version;
extVersionEl.textContent = `v${extensionVersion}`;

type Status = {
  hostConnected: boolean;
  hostVersion?: string | null;
};

type DebugLogResponse = {
  entries?: DebugEntry[];
  hostVersion?: string | null;
  hostRuntimeOs?: string | null;
  hostRuntimeArch?: string | null;
};

async function loadHostVersion(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as
      | Status
      | undefined;
    hostVersionEl.textContent =
      status?.hostConnected && status.hostVersion
        ? `v${status.hostVersion}`
        : 'Not connected';
  } catch {
    hostVersionEl.textContent = 'Not connected';
  }
}

void loadHostVersion();

btnUninstall?.addEventListener('click', () => {
  void chrome.tabs.create({ url: githubRepoUrl('uninstall') });
});

// ── Debug logging ─────────────────────────────────────────────────────────────

function setDebugStatus(message: string): void {
  if (debugStatus) debugStatus.textContent = message;
}

async function fetchDebugLog(): Promise<DebugLogResponse> {
  try {
    return ((await chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOG' })) ??
      {}) as DebugLogResponse;
  } catch {
    return {};
  }
}

/** Build the export text, including the environment needed to interpret it. */
async function buildDebugText(): Promise<{ text: string; count: number }> {
  const res = await fetchDebugLog();
  const entries = res.entries ?? [];
  const text = formatDebugLog(entries, {
    extension: extensionVersion,
    host: res.hostVersion ?? 'not connected',
    platform: [res.hostRuntimeOs, res.hostRuntimeArch]
      .filter(Boolean)
      .join('/'),
    userAgent: navigator.userAgent,
    exported: new Date().toISOString(),
  });
  return { text, count: entries.length };
}

async function refreshDebugCount(): Promise<void> {
  const res = await fetchDebugLog();
  const count = res.entries?.length ?? 0;
  setDebugStatus(
    count === 0
      ? 'No entries recorded.'
      : `${count} ${count === 1 ? 'entry' : 'entries'} recorded.`,
  );
}

void chrome.storage.local.get(STORAGE_KEYS.debugEnabled).then((stored) => {
  if (debugToggle) {
    debugToggle.checked = stored[STORAGE_KEYS.debugEnabled] === true;
  }
});
void refreshDebugCount();

debugToggle?.addEventListener('change', () => {
  const enabled = debugToggle.checked;
  void chrome.storage.local.set({ [STORAGE_KEYS.debugEnabled]: enabled });
  setDebugStatus(
    enabled
      ? 'Recording. Reload any music tab so its content script picks this up.'
      : 'Stopped. The buffer is kept until you clear it.',
  );
});

btnDebugCopy?.addEventListener('click', async () => {
  const { text, count } = await buildDebugText();
  try {
    await navigator.clipboard.writeText(text);
    setDebugStatus(`Copied ${count} ${count === 1 ? 'entry' : 'entries'}.`);
  } catch {
    // Clipboard can be refused; the download path always works.
    setDebugStatus('Could not copy — use Download instead.');
  }
});

btnDebugDownload?.addEventListener('click', async () => {
  const { text, count } = await buildDebugText();
  const url = URL.createObjectURL(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `freemid-debug-${stamp}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
  setDebugStatus(`Downloaded ${count} ${count === 1 ? 'entry' : 'entries'}.`);
});

btnDebugClear?.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOG' });
  } catch {
    // Background may be asleep; the buffer is rebuilt empty on next start.
  }
  setDebugStatus('Cleared.');
});
