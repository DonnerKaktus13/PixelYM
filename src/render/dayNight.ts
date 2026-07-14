/**
 * Screen-space day/night cycle. Draws two stacked fill-rect overlays on
 * the viewport canvas:
 *   - A cool night-blue layer whose alpha tracks "how far past sunset" we
 *     are, peaking at midnight.
 *   - A warm dawn/dusk tint that peaks during the transitions (t ≈ 0.25
 *     and 0.75) and fades to zero at noon and midnight.
 *
 * Both overlays are computed from a single phase `t ∈ [0, 1)` derived
 * from wall-clock time so the cycle keeps moving even when the game tick
 * is paused. `t = 0` is noon, `t = 0.5` is midnight.
 */

const DAY_LENGTH_MS = 60 * 60 * 1000;     // 1-hour full day-night cycle.
const NIGHT_FRACTION = 20 / 60;           // 20 of those 60 minutes are night.
/** Transition half-width as a fraction of the full cycle (~58s here).
 *  Smoothstep over this range fades darkness in at dusk and out at dawn. */
const TRANS_HALF = 0.04;

const NIGHT_R = 10, NIGHT_G = 16, NIGHT_B = 44;
const NIGHT_MAX_ALPHA = 0.72;

const WARM_R = 230, WARM_G = 110, WARM_B = 50;
const WARM_MAX_ALPHA = 0.22;

// Peak-day light blue. Strongest at noon (t=0), fades out toward dusk,
// completely off through the night. The hue is intentionally soft so it
// reads as "bright midday sky tint" without washing out the terrain.
const DAY_R = 150, DAY_G = 200, DAY_B = 235;
const DAY_MAX_ALPHA = 0.18;

if (import.meta.hot) import.meta.hot.accept();

/**
 * Phase is computed against `(nowMs - startedAtMs)`. That keeps it in
 * sync with the engine's `isNight()` check (which uses the same
 * baseline) — without subtracting `startedAtMs` the dayNight overlay
 * tracked raw performance.now() so the tint didn't move with DevPanel
 * time-jumps and didn't agree with the volcano sprite-sync, producing
 * the "looks like day forever" bug.
 */
export function drawDayNightOverlay(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  nowMs: number,
  startedAtMs: number = 0,
): void {
  const t = (((nowMs - startedAtMs) / DAY_LENGTH_MS) % 1 + 1) % 1;
  // Darkness curve: 0 at noon (t=0), 1 at midnight (t=0.5).
  const darkness = (1 - Math.cos(t * Math.PI * 2)) / 2;
  // distFromMidnight ∈ [0, 0.5]. Warmth peaks midway through it (0.25),
  // i.e. dusk (t≈0.25) and dawn (t≈0.75). sin() over 0..π gives the bell.
  const distFromMidnight = Math.abs(t - 0.5);
  const warmness = Math.sin(distFromMidnight * 2 * Math.PI);

  const nightAlpha = darkness * NIGHT_MAX_ALPHA;
  const warmAlpha = warmness * WARM_MAX_ALPHA;
  // Day-blue peaks at noon. `dayness²` sharpens the peak so it doesn't
  // smear into the dusk warmth — full blue right around t≈0, gone by
  // the time the warm tint kicks in.
  const dayness = 1 - darkness;
  const dayAlpha = dayness * dayness * DAY_MAX_ALPHA;

  if (dayAlpha > 0.01) {
    ctx.fillStyle = `rgba(${DAY_R},${DAY_G},${DAY_B},${dayAlpha})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  if (nightAlpha > 0.01) {
    ctx.fillStyle = `rgba(${NIGHT_R},${NIGHT_G},${NIGHT_B},${nightAlpha})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  if (warmAlpha > 0.01) {
    ctx.fillStyle = `rgba(${WARM_R},${WARM_G},${WARM_B},${warmAlpha})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }
}
