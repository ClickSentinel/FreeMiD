export function parseClock(text: string): number | undefined {
  const parts = text
    .trim()
    .split(':')
    .map((part) => Number.parseInt(part, 10));
  if (parts.some((value) => Number.isNaN(value))) return undefined;
  if (parts.length === 2) {
    const [m = 0, s = 0] = parts;
    return m * 60 + s;
  }
  if (parts.length === 3) {
    const [h = 0, m = 0, s = 0] = parts;
    return h * 3600 + m * 60 + s;
  }
  return undefined;
}
