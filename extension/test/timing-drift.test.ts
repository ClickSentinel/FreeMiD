import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HOST_IDLE_TIMEOUT_MS } from '../src/constants/timing';

/**
 * Cross-language drift guards.
 *
 * These live outside src/ because they need Node APIs, and src/ is type-checked
 * as browser-only code (tsconfig `types: ["chrome"]`). Vitest still picks them
 * up via the `test/**` include in vite.config.mts.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('extension/native-host timing drift', () => {
  it('mirrors the native host idle timeout', () => {
    // The keepalive period is chosen to sit under this value. If the Rust side
    // changes it, the TS mirror (and the invariant test that uses it) is stale.
    const mainRs = readFileSync(
      resolve(repoRoot, 'native-host/src/main.rs'),
      'utf8',
    );
    const match = mainRs.match(
      /const HOST_IDLE_TIMEOUT_MS:\s*u64\s*=\s*([0-9_]+)\s*;/,
    );
    expect(
      match,
      'HOST_IDLE_TIMEOUT_MS not found in native-host/src/main.rs',
    ).not.toBeNull();
    expect(Number(match?.[1]?.replace(/_/g, ''))).toBe(HOST_IDLE_TIMEOUT_MS);
  });
});
