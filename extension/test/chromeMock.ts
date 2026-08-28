/**
 * A chrome API stand-in the background service worker can be imported against.
 *
 * The worker registers all its listeners and opens its native port at module
 * scope, which is what keeps it out of reach of a unit test. Rather than work
 * around that, this captures what it registers so a test can drive it: feed a
 * STATUS through the native port, hand it a runtime message, fire an alarm.
 *
 * Only the surface the worker actually touches is implemented. Anything it
 * calls that is missing will throw rather than silently do nothing, so the
 * mock cannot drift out of date unnoticed.
 */
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

/** One registered event, with a way to fire it. */
class FakeEvent {
  readonly listeners: Listener[] = [];
  addListener = (fn: Listener): void => {
    this.listeners.push(fn);
  };
  removeListener = (fn: Listener): void => {
    const i = this.listeners.indexOf(fn);
    if (i >= 0) this.listeners.splice(i, 1);
  };
  hasListener = (fn: Listener): boolean => this.listeners.includes(fn);
  emit(...args: unknown[]): unknown[] {
    return this.listeners.map((fn) => fn(...args));
  }
}

export class FakePort {
  readonly postMessage = vi.fn();
  readonly disconnect = vi.fn();
  readonly onMessage = new FakeEvent();
  readonly onDisconnect = new FakeEvent();

  /** Deliver a message from the host to the extension. */
  fromHost(msg: unknown): void {
    this.onMessage.emit(msg);
  }

  /** Every SET_ACTIVITY payload that reached the host, oldest first. */
  sentActivities(): unknown[] {
    return this.postMessage.mock.calls
      .map(([m]) => m as { type?: string; activity?: unknown })
      .filter((m) => m.type === 'SET_ACTIVITY')
      .map((m) => m.activity);
  }
}

export interface ChromeMock {
  ports: FakePort[];
  /** The port the worker is currently using. */
  port(): FakePort;
  runtimeMessage: FakeEvent;
  tabsUpdated: FakeEvent;
  alarm: FakeEvent;
  permissionsRemoved: FakeEvent;
  local: Record<string, unknown>;
  /** Resolves once the worker has opened its native port. */
  ready(): Promise<FakePort>;
  /** Activity bundles the worker has injected, oldest first. */
  injected: { tabId: number; files: string[] }[];
  /** Control what the liveness probe reports for the next navigation. */
  setScriptAlive(alive: boolean): void;
  permissionsContains: ReturnType<typeof vi.fn>;
}

export function installChromeMock(
  opts: {
    storage?: Record<string, unknown>;
    /** What permissions.contains() reports. Everything is held by default. */
    hasOrigins?: boolean;
  } = {},
): ChromeMock {
  const ports: FakePort[] = [];
  const injected: { tabId: number; files: string[] }[] = [];
  // What the liveness probe reports. Default dead, so a navigation injects.
  let scriptAlive = false;
  const local: Record<string, unknown> = { ...opts.storage };
  const session: Record<string, unknown> = {};
  const runtimeMessage = new FakeEvent();
  const tabsUpdated = new FakeEvent();
  const alarm = new FakeEvent();
  const permissionsRemoved = new FakeEvent();

  const pick = (
    store: Record<string, unknown>,
    keys: string | string[] | null | undefined,
  ): Record<string, unknown> => {
    if (keys == null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };

  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined as { message?: string } | undefined,
      getManifest: () => ({ version: '0.4.7' }),
      connectNative: vi.fn(() => {
        const p = new FakePort();
        ports.push(p);
        return p;
      }),
      sendMessage: vi.fn(() => Promise.resolve(undefined)),
      onMessage: runtimeMessage,
      onSuspend: new FakeEvent(),
    },
    storage: {
      local: {
        get: vi.fn((keys?: string | string[]) =>
          Promise.resolve(pick(local, keys)),
        ),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(local, items);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          delete local[key];
          return Promise.resolve();
        }),
      },
      session: {
        get: vi.fn((keys?: string | string[]) =>
          Promise.resolve(pick(session, keys)),
        ),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(session, items);
          return Promise.resolve();
        }),
        remove: vi.fn(() => Promise.resolve()),
      },
      onChanged: new FakeEvent(),
    },
    alarms: {
      create: vi.fn(),
      get: vi.fn((_name: string, cb: (a: unknown) => void) => cb(undefined)),
      onAlarm: alarm,
    },
    tabs: {
      query: vi.fn((_q: unknown, cb: (tabs: unknown[]) => void) => cb([])),
      get: vi.fn(() => Promise.reject(new Error('no tab'))),
      onUpdated: tabsUpdated,
      onActivated: new FakeEvent(),
      onRemoved: new FakeEvent(),
    },
    scripting: {
      // The worker uses executeScript two ways: `func` probes whether a live
      // activity is already running in the tab, `files` performs the actual
      // injection. Tests need to tell them apart.
      executeScript: vi.fn((opts: { func?: unknown; files?: string[] }) => {
        if (opts.func) return Promise.resolve([{ result: scriptAlive }]);
        injected.push({
          tabId: 0,
          files: opts.files ?? [],
        });
        return Promise.resolve([{ result: undefined }]);
      }),
    },
    permissions: {
      contains: vi.fn(() => Promise.resolve(opts.hasOrigins ?? true)),
      request: vi.fn(() => Promise.resolve(true)),
      onRemoved: permissionsRemoved,
    },
  };

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: chrome,
  });
  // The worker checks for updates on boot; never reach the network from a test.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline in tests'))),
  );

  return {
    ports,
    port: () => {
      const p = ports.at(-1);
      if (!p) throw new Error('the worker has not opened a native port');
      return p;
    },
    runtimeMessage,
    tabsUpdated,
    alarm,
    permissionsRemoved,
    local,
    injected,
    setScriptAlive(alive: boolean) {
      scriptAlive = alive;
    },
    permissionsContains: chrome.permissions.contains,
    async ready() {
      // The worker opens its port inside a promise chain over storage reads.
      for (let i = 0; i < 50 && ports.length === 0; i += 1) {
        await Promise.resolve();
      }
      if (ports.length === 0) {
        throw new Error('the worker never opened a native port');
      }
      return ports[ports.length - 1] as FakePort;
    },
  };
}
