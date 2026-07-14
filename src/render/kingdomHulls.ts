import type { Camera } from "./camera";
import type { GameState } from "../game/state";

/**
 * Paint a coloured convex-hull outline around every NON-human tribe's
 * structures, with the tribe's name written at the hull centroid. Lets
 * the player see where rival kingdoms sit at a glance without staring
 * at the territory-colour grid.
 *
 * Hulls are recomputed every frame — cheap because we only walk owned
 * structure positions and Graham-scan is O(N log N) on at most a few
 * dozen points per tribe.
 */
export function drawKingdomHulls(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  const humanId = state.humanId;
  // Group structure positions by ownerId.
  const byOwner = new Map<number, { x: number; y: number }[]>();
  for (const s of state.structures) {
    if (s.ownerId === humanId) continue;
    let list = byOwner.get(s.ownerId);
    if (!list) { list = []; byOwner.set(s.ownerId, list); }
    list.push({ x: s.x, y: s.y });
  }
  if (byOwner.size === 0) return;

  ctx.save();
  for (const [ownerId, pts] of byOwner) {
    if (pts.length < 1) continue;
    const player = state.players[ownerId];
    if (!player || !player.alive) continue;
    const hull = convexHull(pts);
    if (hull.length === 0) continue;
    const color = colourForOwner(ownerId);

    // Project hull to screen and stroke.
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = withAlpha(color, 0.10);
    ctx.beginPath();
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i];
      const sx = viewW / 2 + (p.x - cam.x) * cam.zoom;
      const sy = viewH / 2 + (p.y - cam.y) * cam.zoom;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Centroid for label.
    let cx = 0, cy = 0;
    for (const p of hull) { cx += p.x; cy += p.y; }
    cx /= hull.length;
    cy /= hull.length;
    const lx = viewW / 2 + (cx - cam.x) * cam.zoom;
    const ly = viewH / 2 + (cy - cam.y) * cam.zoom;
    // Crisp shadow-stroke + fill so the name reads against any biome.
    const fontPx = Math.max(12, Math.min(36, cam.zoom * 6));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, fontPx * 0.15);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.fillStyle = color;
    ctx.strokeText(player.name, lx, ly);
    ctx.fillText(player.name, lx, ly);
  }
  ctx.restore();
}

/** Andrew's monotone-chain convex hull. Returns the hull in CCW order. */
function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const n = pts.length;
  const lower: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) {
      lower.pop();
    }
    lower.push(pts[i]);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) {
      upper.pop();
    }
    upper.push(pts[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Deterministic hash → vivid HSL colour. Same owner gets the same
 *  colour every frame so the hulls don't shimmer between renders. */
function colourForOwner(ownerId: number): string {
  // Cheap integer hash → 0..359 hue.
  let h = (ownerId * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = (h * 1597334677) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 75%, 60%)`;
}

function withAlpha(hsl: string, alpha: number): string {
  // Convert "hsl(h, s%, l%)" → "hsla(h, s%, l%, alpha)".
  return hsl.replace(/^hsl\(/, "hsla(").replace(/\)$/, `, ${alpha})`);
}
