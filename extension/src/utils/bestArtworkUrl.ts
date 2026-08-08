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
    const [w, h] = (entry.sizes ?? '').split('x').map(Number);
    const area =
      w != null && h != null && Number.isFinite(w) && Number.isFinite(h)
        ? w * h
        : 0;
    if (!best || area > best.area) best = { src: entry.src, area };
  }
  return best?.src;
}
