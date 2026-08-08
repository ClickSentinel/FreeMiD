import { describe, expect, it } from 'vitest';

import { formatDebugLog } from './format';
import type { DebugEntry } from './log';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

function entry(offsetMs: number, over: Partial<DebugEntry> = {}): DebugEntry {
  return { t: BASE + offsetMs, scope: 'bg', event: 'sent', ...over };
}

describe('formatDebugLog', () => {
  it('renders offsets relative to the first entry', () => {
    const text = formatDebugLog([
      entry(0, { event: 'track-change' }),
      entry(4200, { event: 'throttle-defer' }),
      entry(9200, { event: 'flush' }),
    ]);

    expect(text).toContain('+    0.000s');
    expect(text).toContain('+    4.200s');
    expect(text).toContain('+    9.200s');
  });

  it('keeps columns aligned across mixed scopes', () => {
    const text = formatDebugLog([
      entry(0, { scope: 'bg', event: 'sent' }),
      entry(10, { scope: 'ytmusic', event: 'track-change' }),
    ]);
    const [, , first, second] = text.split('\n');

    // Both scope columns must start and end at the same offset, otherwise a
    // long trace is unreadable.
    expect(first?.indexOf('bg')).toBe(second?.indexOf('ytmusic'));
    expect(first?.indexOf('sent')).toBe(second?.indexOf('track-change'));
  });

  it('appends serialised data when present', () => {
    const text = formatDebugLog([entry(0, { data: { inMs: 4200 } })]);
    expect(text).toContain('{"inMs":4200}');
  });

  it('survives unserialisable data rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const text = formatDebugLog([entry(0, { data: circular })]);
    expect(text).toContain('[unserialisable]');
  });

  it('includes metadata headers and an entry count', () => {
    const text = formatDebugLog([entry(0)], {
      extension: '0.4.7',
      host: '0.4.7',
      omitted: undefined,
    });

    expect(text).toContain('# extension: 0.4.7');
    expect(text).toContain('# host: 0.4.7');
    expect(text).toContain('# entries: 1');
    expect(text).not.toContain('omitted');
  });

  it('says so plainly when the buffer is empty', () => {
    const text = formatDebugLog([]);
    expect(text).toContain('# entries: 0');
    expect(text).toContain('is debug logging enabled?');
  });
});
