export function parseClock(text: string): number | undefined {
  const parts = text.trim().split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((value) => Number.isNaN(value))) return undefined;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return undefined;
}
