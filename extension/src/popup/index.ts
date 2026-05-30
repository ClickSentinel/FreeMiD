const dot = document.getElementById('dot')!;
const statusText = document.getElementById('status-text')!;
const noActivity = document.getElementById('no-activity')!;
const activitySection = document.getElementById('activity-section')!;

type HostStatus = { type: 'HOST_STATUS'; connected: boolean };

function setStatus(connected: boolean | null): void {
  if (connected === null) {
    dot.className = 'dot connecting';
    statusText.textContent = 'Connecting to native host…';
  } else if (connected) {
    dot.className = 'dot connected';
    statusText.textContent = 'Native host connected — Discord ready';
  } else {
    dot.className = 'dot';
    statusText.textContent = 'Native host not running — start FreeMiD';
  }
}

// Listen for status broadcasts from the background worker
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as HostStatus;
  if (m.type === 'HOST_STATUS') setStatus(m.connected);
});

// Bootstrap: ask the background for current state
(async () => {
  try {
    // Request current WS status from background
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as { connected: boolean } | undefined;
    if (status != null) setStatus(status.connected);
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
