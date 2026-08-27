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

/** Hand the worker a message as though a content script sent it. */
function fromTab(mock: ChromeMock, data: object, tabId = 1): void {
  mock.runtimeMessage.emit(
    { type: 'FREEMID_SET_ACTIVITY', data },
    { id: 'test-extension', tab: { id: tabId } },
    () => {},
  );
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
