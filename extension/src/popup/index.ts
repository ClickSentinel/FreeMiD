const dot = document.getElementById('dot')!;
const statusText = document.getElementById('status-text')!;
const noActivity = document.getElementById('no-activity')!;
const activitySection = document.getElementById('activity-section')!;
const authPrompt = document.getElementById('auth-prompt')!;
const authBtn = document.getElementById('auth-btn')! as HTMLButtonElement;

type HostStatus = { type: 'HOST_STATUS'; connected: boolean; authRequired?: boolean };

function setStatus(connected: boolean | null, authRequired?: boolean): void {
  if (authRequired) {
    authPrompt.style.display = 'block';
    authBtn.disabled = false;
    authBtn.textContent = 'Authorize with Discord';
    dot.className = 'dot';
    statusText.textContent = 'Not authorized';
  } else if (connected === null) {
    authPrompt.style.display = 'none';
    dot.className = 'dot connecting';
    statusText.textContent = 'Connecting to Discord…';
  } else if (connected) {
    authPrompt.style.display = 'none';
    dot.className = 'dot connected';
    statusText.textContent = 'Connected to Discord';
  } else {
    authPrompt.style.display = 'none';
    dot.className = 'dot';
    statusText.textContent = 'Discord not detected';
  }
}

authBtn.addEventListener('click', () => {
  authBtn.disabled = true;
  authBtn.textContent = 'Waiting for authorization…';
  void chrome.runtime.sendMessage({ type: 'INITIATE_AUTH' });
});

// Listen for status broadcasts from the background worker
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as HostStatus;
  if (m.type === 'HOST_STATUS') setStatus(m.connected, m.authRequired);
});

// Bootstrap: ask the background for current state
(async () => {
  try {
    // Request current WS status from background
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as { connected: boolean; authRequired?: boolean } | undefined;
    if (status != null) setStatus(status.connected, status.authRequired);
  } catch {
    // background not ready yet — keep "connecting" state
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      noActivity.textContent = `Checking ${new URL(tab.url).hostname}…`;
    }
  } catch {
    // ignore
  }
})();
