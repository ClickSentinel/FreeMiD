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
async function boot(
  opts: { storage?: Record<string, unknown>; hasOrigins?: boolean } = {},
): Promise<ChromeMock> {
  vi.resetModules();
  const mock = installChromeMock(opts);
  await import('../src/background/index');
  await mock.ready();
  await flush();
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

describe('activity injection', () => {
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

  it('injects the matching activity on a completed navigation', async () => {
    const mock = await boot();
    await navigate(mock, 1, YT);

    expect(mock.injected.map((i) => i.files)).toEqual([
      ['activities/youtube/index.js'],
    ]);
  });

  it('injects nothing for a URL no activity claims', async () => {
    const mock = await boot();
    await navigate(mock, 1, 'https://example.com/');

    expect(mock.injected).toHaveLength(0);
  });

  it('skips injecting when a live script is already running', async () => {
    // Chrome reports status:'complete' for an SPA's history navigations too,
    // where the page context and the running script both survive. Re-injecting
    // there resets the activity's module state for nothing.
    const mock = await boot();
    await navigate(mock, 1, YT);
    expect(mock.injected).toHaveLength(1);

    mock.setScriptAlive(true);
    await navigate(mock, 1, YT);

    expect(mock.injected, 'a live script must not be replaced').toHaveLength(1);
  });

  it('injects again once the script is gone', async () => {
    // A real document load leaves nothing running, and the probe reports that.
    const mock = await boot();
    mock.setScriptAlive(true);
    await navigate(mock, 1, YT);
    const afterAlive = mock.injected.length;

    mock.setScriptAlive(false);
    await navigate(mock, 1, YT);

    expect(mock.injected.length).toBeGreaterThan(afterAlive);
  });

  it('injects nothing for a site the user has turned off', async () => {
    const mock = await boot();
    mock.runtimeMessage.emit(
      { type: 'SET_SITE_ENABLED', siteId: 'youtube', enabled: false },
      { id: 'test-extension' },
      () => {},
    );
    await flush();

    await navigate(mock, 1, YT);

    expect(mock.injected).toHaveLength(0);
  });
});

describe('site toggles and pause', () => {
  const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

  function setSite(mock: ChromeMock, siteId: string, enabled: boolean): void {
    mock.runtimeMessage.emit(
      { type: 'SET_SITE_ENABLED', siteId, enabled },
      { id: 'test-extension' },
      () => {},
    );
  }

  it('clears presence when the site holding the lock is turned off', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    fromTab(mock, track('First'), 1);

    setSite(mock, 'youtube', false);
    await flush();

    expect(clears(mock)).toBe(1);
  });

  it('leaves presence alone when a different site is turned off', async () => {
    // Turning off a site that is not reporting must not evict one that is.
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    fromTab(mock, track('First'), 1);

    setSite(mock, 'tidal', false);
    await flush();

    expect(clears(mock)).toBe(0);
  });

  it('rejects activity from a site that is turned off', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    setSite(mock, 'youtube', false);
    await flush();

    fromTab(mock, track('First'), 1);

    expect(mock.port().sentActivities()).toHaveLength(0);
  });

  it('clears presence and refuses further updates while paused', async () => {
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);
    fromTab(mock, track('First'), 1);
    expect(mock.port().sentActivities()).toHaveLength(1);

    mock.runtimeMessage.emit(
      { type: 'SET_PAUSED', value: true },
      { id: 'test-extension' },
      () => {},
    );
    await flush();

    expect(clears(mock), 'pausing drops what is showing').toBe(1);

    fromTab(mock, track('Second'), 1);
    expect(
      mock.port().sentActivities(),
      'nothing reports while paused',
    ).toHaveLength(1);
  });

  it('ignores a message from outside the extension', async () => {
    // Every handler is gated on the sender id; a page cannot drive presence.
    const mock = await boot();
    mock.port().fromHost(STATUS(true));
    await navigate(mock, 1, YT);

    mock.runtimeMessage.emit(
      { type: 'FREEMID_SET_ACTIVITY', data: track('Injected') },
      { id: 'some-other-extension', tab: { id: 1 } },
      () => {},
    );

    expect(mock.port().sentActivities()).toHaveLength(0);
  });
});

describe('optional host permissions', () => {
  const ENABLED = 'enabledSites';

  it('turns off a stored site whose origins are no longer held', async () => {
    // A revocation while the worker is asleep produces no event it can react
    // to, so the stored toggle would otherwise stay on with nothing granted
    // and injection would fail silently.
    const mock = await boot({
      storage: { [ENABLED]: { youtube: true, soundcloud: true } },
      hasOrigins: false,
    });

    expect(
      (mock.local[ENABLED] as Record<string, boolean>).soundcloud,
      'reconciled against what Chrome actually holds',
    ).toBe(false);
  });

  it('leaves a site on when its origins are held', async () => {
    const mock = await boot({
      storage: { [ENABLED]: { youtube: true, soundcloud: true } },
      hasOrigins: true,
    });

    expect(
      (mock.local[ENABLED] as Record<string, boolean> | undefined)?.soundcloud,
    ).not.toBe(false);
  });

  it('never disturbs a site whose access is required at install', async () => {
    // Only optional sites are probed; a required one has nothing to reconcile.
    const mock = await boot({
      storage: { [ENABLED]: { youtube: true, soundcloud: false } },
      hasOrigins: false,
    });

    expect(
      (mock.local[ENABLED] as Record<string, boolean> | undefined)?.youtube,
    ).not.toBe(false);
  });

  it('turns a site off when its permission is revoked while running', async () => {
    const mock = await boot({
      storage: { [ENABLED]: { youtube: true, soundcloud: true } },
      hasOrigins: true,
    });

    mock.permissionsContains.mockResolvedValue(false);
    mock.permissionsRemoved.emit({ origins: ['*://soundcloud.com/*'] });
    await flush();

    expect((mock.local[ENABLED] as Record<string, boolean>).soundcloud).toBe(
      false,
    );
  });
});
