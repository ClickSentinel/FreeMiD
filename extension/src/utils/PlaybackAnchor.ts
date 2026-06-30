/**
 * Tracks playback position using a wall-clock anchor.
 *
 * Discord timestamps are wall-clock start/end times, not a live position.
 * We anchor when a track starts, shift the anchor forward through pauses,
 * and re-anchor on seeks (detected as >3 s drift from expected position).
 *
 * Pass `current` as `undefined` when the source value is unavailable — the
 * class skips the drift check in that case rather than re-anchoring to 0.
 */
export class PlaybackAnchor {
  private trackKey: string | undefined;
  private anchorStart: number | undefined;
  private pausedAt: number | undefined;

  update(
    trackKey: string,
    current: number | undefined,
    duration: number,
    paused: boolean,
    now = Math.floor(Date.now() / 1000),
  ): {
    timestamps: { start: number; end: number } | undefined;
    trackChanged: boolean;
  } {
    const currentSecs = current ?? 0;
    const trackChanged =
      trackKey !== this.trackKey || this.anchorStart === undefined;

    if (trackChanged) {
      this.trackKey = trackKey;
      this.anchorStart = now - currentSecs;
      this.pausedAt = undefined;
    }

    if (paused) {
      if (this.pausedAt === undefined) this.pausedAt = now;
    } else if (this.anchorStart !== undefined) {
      if (this.pausedAt !== undefined) {
        this.anchorStart += now - this.pausedAt;
        this.pausedAt = undefined;
      }
      if (!trackChanged && current !== undefined) {
        const expectedCurrent = now - this.anchorStart;
        if (Math.abs(expectedCurrent - current) > 3) {
          this.anchorStart = now - current;
        }
      }
    }

    const timestamps =
      duration > 0 && this.anchorStart !== undefined
        ? { start: this.anchorStart, end: this.anchorStart + duration }
        : undefined;

    return { timestamps, trackChanged };
  }
}
