import type { DebugEntry } from './log';

/**
 * Render the buffer as a plain-text log suitable for pasting into an issue.
 *
 * Each line carries both an absolute timestamp and an offset from the first
 * entry. The offset is what makes timing bugs legible — "throttle-defer 4200ms"
 * followed by "flush" 4.2 s later reads as a story, where wall-clock stamps
 * alone would not.
 */
export function formatDebugLog(
  entries: DebugEntry[],
  meta?: Record<string, string | number | boolean | null | undefined>,
): string {
  const lines: string[] = [];

  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined) lines.push(`# ${key}: ${String(value)}`);
    }
  }
  lines.push(`# entries: ${entries.length}`);

  if (entries.length === 0) {
    lines.push('');
    lines.push('(no entries — is debug logging enabled?)');
    return lines.join('\n');
  }

  lines.push('');

  const first = entries[0]?.t ?? 0;
  const scopeWidth = Math.max(
    ...entries.map((e) => e.scope.length),
    'scope'.length,
  );
  const eventWidth = Math.max(
    ...entries.map((e) => e.event.length),
    'event'.length,
  );

  for (const entry of entries) {
    const offset = ((entry.t - first) / 1000).toFixed(3).padStart(9);
    const stamp = new Date(entry.t).toISOString();
    const scope = entry.scope.padEnd(scopeWidth);
    const event = entry.event.padEnd(eventWidth);
    let line = `${stamp} +${offset}s  ${scope}  ${event}`;
    if (entry.data !== undefined) line += `  ${safeStringify(entry.data)}`;
    lines.push(line);
  }

  return lines.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or otherwise unserialisable — never let the export throw.
    return '[unserialisable]';
  }
}
