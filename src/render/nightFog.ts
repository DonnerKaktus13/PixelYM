import type { Camera } from "./camera";
import type { GameState } from "../game/state";
import { getVesselDef } from "../game/vessels";

/**
 * Night-time fog of war. Layered on top of the existing day/night blue
 * tint: as the cycle approaches midnight, the screen darkens toward full
 * black except for radial light pools around the player's own buildings
 * and docked/flying airships. Campfires throw the brightest pool;
 * everything else is dim. Result: at midnight the player can only see
 * inside their own kingdom plus wherever their airships are scouting.
 *
 * Implementation:
 *   1. Compute darkness phase (same curve as dayNight).
 *   2. Below DARKNESS_ONSET the overlay is a no-op (dusk handled by
 *      dayNight alone).
 *   3. Above onset, paint a full-black layer on an offscreen canvas at
 *      `strength` alpha, then use `destination-out` radial gradients to
 *      punch light holes around the player's own structures + vessels.
 *   4. Blit the layer onto the main ctx.
 */

const DAY_LENGTH_MS = 60 * 60 * 1000;
/** Below this darkness value the overlay does nothing — the dayNight
 *  blue tint handles dusk/dawn alone. Past this point fog ramps up. */
const DARKNESS_ONSET = 0.45;
/** Darkness value at which the fog saturates to fully opaque pitch-black
 *  (everywhere outside light pools). Picked tight to the onset so most
 *  of the night reads as actual black rather than a fading blue. */
const DARKNESS_FULL = 0.55;

interface LightSource {
  /** Pool radius in TILE units (multiplied by cam.zoom for screen). */
  radius: number;
  /** Centre alpha in [0,1] — how strongly the destination-out gradient
   *  erases the black fog. 1 = fully bright at centre, 0.5 = still dim. */
  centerAlpha: number;
}

/** Pick a light pool spec from a building's defKey. Campfires are the
 *  brightest; ports and shelters throw a medium pool; workbenches +
 *  production buildings throw a small dim light. */
function lightForStructure(defKey: string): LightSource {
  if (defKey === "campfire") return { radius: 160, centerAlpha: 0.95 };
  if (defKey.startsWith("airship_port") || defKey.startsWith("port_")) return { radius: 130, centerAlpha: 0.85 };
  if (defKey === "workbench") return { radius: 110, centerAlpha: 0.8 };
  // Shelters, outposts, production buildings — modest house glow.
  return { radius: 100, centerAlpha: 0.7 };
}

/** Cached offscreen canvas — resized lazily to match the viewport. */
let _fogCanvas: HTMLCanvasElement | null = null;
let _fogCtx: CanvasRenderingContext2D | null = null;
function ensureFogCanvas(viewW: number, viewH: number): HTMLCanvasElement {
  if (!_fogCanvas || _fogCanvas.width !== viewW || _fogCanvas.height !== viewH) {
    _fogCanvas = document.createElement("canvas");
    _fogCanvas.width = viewW;
    _fogCanvas.height = viewH;
    _fogCtx = _fogCanvas.getContext("2d", { alpha: true });
  }
  return _fogCanvas;
}

export function drawNightFog(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
  nowMs: number,
  startedAtMs: number = 0,
): void {
  const t = (((nowMs - startedAtMs) / DAY_LENGTH_MS) % 1 + 1) % 1;
  const darkness = (1 - Math.cos(t * Math.PI * 2)) / 2;
  if (darkness <= DARKNESS_ONSET) return;
  // Step to full pitch-black the instant darkness crosses the onset.
  // Ramping looked translucent — the user wants the unlit areas truly
  // black, not a fading blue, so we drop the soft fade and snap to
  // 100 % opacity for the whole night.
  void DARKNESS_FULL;
  const strength = 1;

  const fog = ensureFogCanvas(viewW, viewH);
  const fctx = _fogCtx!;
  fctx.globalCompositeOperation = "source-over";
  fctx.clearRect(0, 0, viewW, viewH);
  // Full black canvas. Lights punch holes via destination-out.
  fctx.fillStyle = "rgba(0,0,0,1)";
  fctx.fillRect(0, 0, viewW, viewH);

  fctx.globalCompositeOperation = "destination-out";
  const humanId = state.humanId;

  // World-space viewport bounds — quick cull so we skip lights far off
  // the visible area.
  const wHalfW = (viewW / 2) / cam.zoom;
  const wHalfH = (viewH / 2) / cam.zoom;
  const wMinX = cam.x - wHalfW;
  const wMaxX = cam.x + wHalfW;
  const wMinY = cam.y - wHalfH;
  const wMaxY = cam.y + wHalfH;

  // Structures.
  for (const s of state.structures) {
    if (s.ownerId !== humanId) continue;
    if (s.x + 200 < wMinX || s.x - 200 > wMaxX) continue;
    if (s.y + 200 < wMinY || s.y - 200 > wMaxY) continue;
    const light = lightForStructure(s.defKey);
    paintLight(fctx, viewW, viewH, cam, s.x, s.y, light.radius, light.centerAlpha);
  }

  // Active volcanoes — only the cones in `vulcanoDeactivateOnDay` are
  // currently active, and they flip to "vulcano_active" sprites at
  // night. They light their immediate area almost as brightly as a
  // campfire (lava glow). Iterating the map (a handful of entries)
  // instead of every prop keeps the cost flat.
  const volcMap = state.vulcanoDeactivateOnDay;
  if (volcMap) {
    const props = state.world.props;
    const harvested = state.harvestedProps;
    for (const k in volcMap) {
      const propIdx = +k;
      if (harvested && harvested.has(propIdx)) continue;
      const p = props[propIdx];
      if (!p) continue;
      if (p.x + 220 < wMinX || p.x - 220 > wMaxX) continue;
      if (p.y + 220 < wMinY || p.y - 220 > wMaxY) continue;
      paintLight(fctx, viewW, viewH, cam, p.x, p.y, 220, 0.92);
    }
  }

  // Vessels — docked airships keep their hangar lit; flying ones throw a
  // smaller pool wherever they're scouting. Ships sitting in port harbour
  // get a modest light too.
  for (const v of state.vessels) {
    if (v.ownerId !== humanId) continue;
    if (v.x === undefined || v.y === undefined) continue;
    const def = getVesselDef(v.defKey);
    if (!def) continue;
    const isAirship = def.category === "airship";
    const light: LightSource = isAirship
      ? (v.status === "flying" ? { radius: 100, centerAlpha: 0.75 } : { radius: 90, centerAlpha: 0.7 })
      : { radius: 80, centerAlpha: 0.65 };
    if (v.x + light.radius < wMinX || v.x - light.radius > wMaxX) continue;
    if (v.y + light.radius < wMinY || v.y - light.radius > wMaxY) continue;
    paintLight(fctx, viewW, viewH, cam, v.x, v.y, light.radius, light.centerAlpha);
  }

  fctx.globalCompositeOperation = "source-over";

  // Composite onto main ctx. `strength` ramps from 0 at dusk-onset to 1
  // at full midnight, so dawn / dusk still let the player see the whole
  // map dimly while only deep night collapses to kingdom-vision.
  ctx.globalAlpha = strength;
  ctx.drawImage(fog, 0, 0);
  ctx.globalAlpha = 1;
}

function paintLight(
  fctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera,
  wx: number, wy: number,
  radiusTiles: number, centerAlpha: number,
): void {
  const sx = viewW / 2 + (wx - cam.x) * cam.zoom;
  const sy = viewH / 2 + (wy - cam.y) * cam.zoom;
  const r = radiusTiles * cam.zoom;
  if (r < 1) return;
  if (sx + r < 0 || sx - r > viewW || sy + r < 0 || sy - r > viewH) return;
  // Soft radial gradient — fully erased at the centre (centerAlpha), zero
  // at the rim, with a slight inner plateau so the bright core reads as
  // light rather than a single hot spot. Approximated by two stops.
  const grad = fctx.createRadialGradient(sx, sy, 0, sx, sy, r);
  grad.addColorStop(0, `rgba(0,0,0,${centerAlpha})`);
  grad.addColorStop(0.35, `rgba(0,0,0,${centerAlpha * 0.6})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  fctx.fillStyle = grad;
  fctx.beginPath();
  fctx.arc(sx, sy, r, 0, Math.PI * 2);
  fctx.fill();
}
