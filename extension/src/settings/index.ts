import { githubRepoUrl } from '../constants/github';

/**
 * FreeMiD — Settings
 */

const extVersionEl = document.getElementById('ext-version') as HTMLElement;
const hostVersionEl = document.getElementById('host-version') as HTMLElement;
const btnUninstall = document.getElementById(
  'btn-uninstall',
) as HTMLButtonElement | null;

const extensionVersion = chrome.runtime.getManifest().version;
extVersionEl.textContent = `v${extensionVersion}`;

type Status = {
  hostConnected: boolean;
  hostVersion?: string | null;
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
