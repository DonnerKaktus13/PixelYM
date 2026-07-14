import type { Camera } from "./camera";
import type { GameState } from "../game/state";
import { getSprite } from "./textures";

/**
 * Paint volcano-only visual effects: flying debris arcs.
 * The previous smoke-ring orbit was removed at the user's request —
 * eruptions are now rare set-piece events instead of constant ambient
 * effects.
 */

export function drawVulcanoEffects(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
  _nowMs: number,
): void {
  // Early bail — debris is empty 99% of the time (eruptions are rare
  // set-pieces). Skipping the ctx.save/restore + the (empty) loop
  // shaves a small but real chunk off every quiet frame.
  const debris = state.debris;
  if (!debris || debris.length === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  for (const d of debris) {
    const t = Math.min(1, d.age / d.flightTicks);
    const wx = d.startX + (d.targetX - d.startX) * t;
    const wy = d.startY + (d.targetY - d.startY) * t;
    // Parabolic arc: sin(t·π) gives 0 at endpoints, peak at midflight.
    const arc = Math.sin(t * Math.PI) * d.peakHeight;
    const cxPx = viewW / 2 + (wx - cam.x) * cam.zoom;
    const cyPxNoArc = viewH / 2 + (wy - cam.y) * cam.zoom;
    const cyPx = cyPxNoArc - arc * cam.zoom * 0.05;
    const sprite = getSprite(d.sprite);
    const drawSize = 30 * cam.zoom;
    if (cxPx + drawSize < 0 || cxPx - drawSize > viewW) continue;
    if (cyPx + drawSize < 0 || cyPx - drawSize > viewH) continue;
    // Ground shadow at the un-arced position.
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(cxPx, cyPxNoArc, drawSize * 0.9, drawSize * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    if (sprite) {
      ctx.drawImage(sprite,
        cxPx - drawSize, cyPx - drawSize,
        drawSize * 2, drawSize * 2);
    } else {
      ctx.fillStyle = "#5a3020";
      ctx.beginPath();
      ctx.arc(cxPx, cyPx, drawSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
