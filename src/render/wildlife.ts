import type { Camera } from "./camera";
import type { GameState } from "../game/state";
import { getSprite } from "./textures";

/**
 * Paint every animal in `state.animals` as a small camera-projected
 * sprite. Runs each frame on the main ctx after structures + villagers
 * so animals overlap the world the same way villagers do. If the
 * sprite asset isn't loaded yet (user is still dropping PNGs into
 * /IMG/Wildlife/), we fall back to a small colored circle so the
 * animal is still visible.
 */

/** Tile-side render size — wildlife is small relative to villagers. */
const DRAW_SIZE_TILES = 6;

export function drawWildlife(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  const animals = state.animals;
  if (!animals || animals.length === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const a of animals) {
    const sxPx = viewW / 2 + (a.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (a.y - cam.y) * cam.zoom;
    const sz = DRAW_SIZE_TILES * cam.zoom;
    if (sxPx + sz / 2 < 0 || sxPx - sz / 2 > viewW) continue;
    if (syPx + sz / 2 < 0 || syPx - sz / 2 > viewH) continue;
    const sprite = getSprite(a.sprite);
    if (sprite) {
      if (a.facing === -1) {
        // Facing flip via negative X scale. Each save() MUST be paired
        // with a restore() on every code path — without that, the
        // canvas-state stack grew unboundedly (the prior version left
        // the save unrestored when facing !== -1, leaking ~50 stack
        // entries per frame and freezing the page within seconds).
        ctx.save();
        ctx.translate(sxPx, syPx);
        ctx.scale(-1, 1);
        ctx.drawImage(sprite, -sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      } else {
        ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
      }
    } else {
      ctx.fillStyle = "#7a5430";
      ctx.beginPath();
      ctx.arc(sxPx, syPx, sz * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
