import { urlLike } from './urlLike';

/**
 * Pick the largest usable image from a Media Session artwork list.
 *
 * The spec does not guarantee entries are ordered by size, even where a given
 * site happens to supply them ascending, so choose by area rather than trusting
 * array order. Entries are gated through urlLike() because `src` is fully
 * page-controlled and could in principle carry any scheme.
 */
export function bestArtworkUrl(
  artwork: readonly MediaImage[] | undefined,
): string | undefined {
  if (!artwork || artwork.length === 0) return undefined;

  let best: { src: string; area: number } | undefined;
  for (const entry of artwork) {
    if (!entry.src || !urlLike(entry.src)) continue;
    const area = largestArea(entry.sizes);
    if (!best || area > best.area) best = { src: entry.src, area };
  }
  return best?.src;
}

/**
 * Largest area described by a `sizes` string, or 0 if none can be read.
 *
 * `sizes` may list several dimensions separated by whitespace, as in
 * "96x96 128x128". Splitting the whole string on "x" mis-reads the middle
 * token ("96 128" parses as NaN) and drops the entry to zero area, which ranks
 * a multi-size entry below a single-size one it may well beat.
 */
function largestArea(sizes: string | undefined): number {
  let largest = 0;
  for (const token of (sizes ?? '').split(/\s+/)) {
    const [w, h] = token.split('x').map(Number);
    if (w === undefined || h === undefined) continue;
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    largest = Math.max(largest, w * h);
  }
  return largest;
}
