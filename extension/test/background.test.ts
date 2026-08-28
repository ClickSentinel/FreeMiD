/**
 * Tests that reach the service worker's own wiring.
 *
 * Everything here was previously unreachable: the worker registers its
 * listeners and opens its native port at module scope, so removing a whole
 * branch of the STATUS handler left every test passing. See test/chromeMock.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChromeMock, installChromeMock } from './chromeMock';

const STATUS = (connected: boolean) => ({
  type: 'STATUS',
  connected,
  version: '0.4.7',
  capabilities: ['self-update'],
  runtimeOs: 'linux',
});

const track = (title: string) => ({
  name: 'Artist',
  type: 2,
  details: title,
  state: 'by Artist',
});

/** Boot a fresh worker against a fresh mock. */
async function boot(): Promise<ChromeMock> {
  vi.resetModules();
  const mock = installChromeMock();
  await import('../src/background/index');
  await mock.ready();
  return mock;
}

/** Let the worker's promise chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

/** Drive a completed navigation so the worker injects an activity into a tab. */
async function navigate(
  mock: ChromeMock,
  tabId: number,
  url: string,
): Promise<void> {
  mock.tabsUpdated.emit(tabId, { status: 'complete' }, { url });
  await flush();
}

/** Hand the worker a message as though a content script sent it. */
function fromTab(mock: ChromeMock, data: object, tabId = 1): void {
  mock.runtimeMessage.emit(
    { type: 'FREEMID_SET_ACTIVITY', data },
    { id: 'test-extension', tab: { id: tabId } },
    () => {},
  );
}

/** Hand the worker a clear as though a content script sent it. */
function clearFromTab(mock: ChromeMock, tabId: number): void {
  mock.runtimeMessage.emit(
    { type: 'FREEMID_CLEAR_ACTIVITY' },
    { id: 'test-extension', tab: { id: tabId } },
    () => {},
  );
}

/** Whether a CLEAR_ACTIVITY has reached the host. */
function clears(mock: ChromeMock): number {
  return mock
    .port()
    .postMessage.mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'CLEAR_ACTIVITY',
    ).length;
}

describe('background service worker', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('opens a native port and pings it on boot', async () => {
    const mock = await boot();
    const pinged = mock
      .port()
      .postMessage.mock.calls.some(
        ([m]) => (m as { type: string }).type === 'PING',
      );
    expect(pinged).toBe(true);
  });

  it('forwards an activity to the host', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));

    fromTab(mock, track('First'));

    expect(mock.port().sentActivities()).toHaveLength(1);
  });

  it('re-sends an unchanged payload after Discord comes back', async () => {
    // The regression this exists for: Discord keeps no memory of what it was
    // shown before it restarts, so the dedup belief is stale. Without the reset
    // the identical payload is suppressed and presence never returns — for a
    // static payload, never at all.
    const mock = await boot();
    const port = mock.port();
    port.fromHost(STATUS(true));

    fromTab(mock, track('First'));
    expect(port.sentActivities()).toHaveLength(1);

    // Same payload while still connected: correctly deduped.
    fromTab(mock, track('First'));
    expect(port.sentActivities()).toHaveLength(1);

    port.fromHost(STATUS(false));
    port.fromHost(STATUS(true));

    fromTab(mock, track('First'));
    expect(
      port.sentActivities(),
      'the payload Discord lost must go out again',
    ).toHaveLength(2);
  });

  it('does not re-send when the connection never dropped', async () => {
    // A STATUS arrives on every keepalive. Only an edge means anything;
    // treating each one as a reconnection would defeat dedup entirely.
    const mock = await boot();
    const port = mock.port();
    port.fromHost(STATUS(true));

    fromTab(mock, track('First'));
    port.fromHost(STATUS(true));
    port.fromHost(STATUS(true));
    fromTab(mock, track('First'));

    expect(port.sentActivities()).toHaveLength(1);
  });
});

describe('presence lock', () => {
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

  it('claims the lock for the tab that reports first', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);

    fromTab(mock, track('First'), 1);

    expect(mock.port().sentActivities()).toHaveLength(1);
  });

  it('rejects a different site while one holds the lock', async () => {
    // What the lock is actually for: one service on Discord at a time.
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    await navigate(mock, 2, 'https://tidal.com/browse/track/1');

    fromTab(mock, track('From YouTube'), 1);
    fromTab(mock, track('From TIDAL'), 2);

    const sent = mock.port().sentActivities() as { details: string }[];
    expect(sent.map((a) => a.details)).toEqual(['From YouTube']);
  });

  it('hands the lock to the most recent tab of the same site', async () => {
    // Within a site the lock is not exclusive — the last tab to report holds
    // it, and is then the only one able to clear it.
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    await navigate(mock, 2, YT);

    fromTab(mock, track('First'), 1);
    fromTab(mock, track('Second'), 2);

    clearFromTab(mock, 1);
    expect(clears(mock), 'tab 1 no longer holds it').toBe(0);

    clearFromTab(mock, 2);
    expect(clears(mock), 'tab 2 does').toBe(1);
  });

  it('does not let another tab of the same site clear the holder', async () => {
    // The lock is claimed under a site id rather than a tab, so a clear from
    // any tab of that site resolves to the same holder. A YouTube tab off a
    // watch page clears on every tick, which would wipe presence a watching
    // tab had set.
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    await navigate(mock, 2, YT);

    fromTab(mock, track('First'), 1);
    expect(mock.port().sentActivities()).toHaveLength(1);

    clearFromTab(mock, 2);

    expect(
      clears(mock),
      'a tab that never held the lock must not release it',
    ).toBe(0);
  });

  it('lets the holding tab clear its own presence', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);

    fromTab(mock, track('First'), 1);
    clearFromTab(mock, 1);

    expect(clears(mock)).toBe(1);
  });
});
