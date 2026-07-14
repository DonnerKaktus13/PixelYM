import { getSprite } from "./textures";
import type { Camera } from "./camera";

/**
 * World-anchored cloud overlay (white drifting clouds only — no rain, no
 * dark/storm clouds).
 *
 * Conceptual model:
 *   • Clouds live in WORLD tile coordinates and drift right at
 *     WIND_TILES_PER_S. Camera transform projects them to screen at draw
 *     time, so panning/zooming actually moves the clouds with the world.
 *   • N persistent patches (each = a cluster of CLOUDS_PER_PATCH children
 *     with stable offsets from the patch centre) drift across the world.
 *     When a patch goes off the right edge of the world it wraps back to
 *     the left with a fresh vertical position.
 */

// cloud3 removed — only the remaining four standard white-cloud sprites.
const CLOUD_SPRITES = ["cloud1", "cloud2", "cloud4", "cloud5"];
const NUM_PATCHES = 10;
const CLOUDS_PER_PATCH = 5;
const WIND_TILES_PER_S = 10;          // 1/4× the previous speed — slow drift
// Cluster is now more drawn-out: wider radius, more horizontal squash.
// Adjacent children rarely overlap heavily — clouds in a patch read as a
// strung-out wisp rather than a tight ball.
const CLUSTER_RADIUS_TILES = 220;
const VERTICAL_SQUASH = 0.42;
// 4× the previous size — clouds now read as proper landmarks rather than
// distant wisps.
const CLOUD_SIZE_TILES = 380;
// Camera zoom above which we enable high-quality smoothing on the cloud
// blit. At low zoom the clouds are tiny and the fast nearest-neighbour
// path looks fine; at close zoom the sprite scales way up and antialiasing
// makes the edges read smoothly.
const HIGH_ZOOM_AA_THRESHOLD = 1.5;
// Zoom-driven cloud fade. Above FADE_END_ZOOM the clouds are skipped
// entirely — they'd block too much of the close-up view. The fade starts
// at FADE_START_ZOOM and goes linearly to fully transparent at the end
// threshold. The end threshold sits "within 3 zoom levels of max" (max
// zoom = 4, wheel factor 1.2 per click → 4 / 1.2³ ≈ 2.31). Start is 3
// further wheel clicks below the end so the fade spans 3 levels.
const FADE_END_ZOOM = 4 / Math.pow(1.2, 3);
const FADE_START_ZOOM = 4 / Math.pow(1.2, 6);

interface Cloud {
  /** Offset from patch centre — stable, defines cluster shape. */
  ox: number;
  oy: number;
  sprite: string;
  size: number;
  /** Filled each frame from patch centre + offset (world coords). */
  wx: number;
  wy: number;
  /** Baseline orbit angle when the patch is captured by a volcano. The
   *  rendered angle is `orbitAngle + t * ORBIT_SPEED`. Undefined for
   *  free-drift clouds. */
  orbitAngle?: number;
  orbitRadius?: number;
}

interface Patch {
  cx: number;
  cy: number;
  clouds: Cloud[];
  /** Random phase for per-patch vertical wobble. */
  phase: number;
  /** When set, the patch has been pulled in by an active volcano and
   *  its 10 child clouds orbit (orbitX, orbitY) instead of drifting
   *  with the wind. propIdx is used to check the volcano is still
   *  active each tick; if not, the patch is released back to drift. */
  orbitX?: number;
  orbitY?: number;
  orbitVulcanoIdx?: number;
}

/** World-tile distance within which an active volcano captures a
 *  passing cloud patch. Generous so patches get pulled in without
 *  having to fly directly over the cone. */
const VULCANO_CAPTURE_RADIUS_TILES = 700;
/** Orbit radius range. Pushed out (was 90..160) so the ring sits well
 *  clear of the cone — the captured clouds now read as a wide storm
 *  ring rather than a tight halo. */
const ORBIT_RADIUS_MIN = 200;
const ORBIT_RADIUS_MAX = 320;
/** Orbital angular velocity (radians / s). Slow swirl so the captured
 *  ring reads as ominous rather than spinning prop. */
const ORBIT_ANGULAR_SPEED = 0.18;
/** Vertical squash for the orbit ellipse — same "fake perspective" trick
 *  the smoke ring in drawVulcanoEffects uses. */
const ORBIT_VERTICAL_SQUASH = 0.55;
/** Per-child cloud size when captured. Bumped 1.5× (was 130) so each
 *  cloud reads as a substantial storm puff rather than a wisp; pairs
 *  with the lower orbit-child count below. */
const CAPTURED_CLOUD_SIZE_TILES = 195;
/** Number of orbiting children when a patch is captured. Halved from
 *  10 → 5 to cut the per-frame ctx.filter cost in half — the user
 *  reported "massive lag" with the original count. */
const ORBIT_CHILDREN = 5;

export class Clouds {
  private patches: Patch[] = [];
  private worldW = 0;
  private worldH = 0;
  private initialised = false;
  private t = 0;

  /** Lazy init — world dims aren't known until first update. */
  private maybeInit(worldW: number, worldH: number): void {
    if (this.initialised) return;
    this.worldW = worldW;
    this.worldH = worldH;
    for (let i = 0; i < NUM_PATCHES; i++) {
      this.patches.push(this.makePatch(Math.random() * worldW));
    }
    this.initialised = true;
  }

  private makePatch(cx: number): Patch {
    // Bias patches to the upper / middle of the world (clouds rarely sit
    // at the south pole) — but allow some spread.
    const cy = this.worldH * (0.10 + Math.random() * 0.55);
    const clouds: Cloud[] = [];
    for (let k = 0; k < CLOUDS_PER_PATCH; k++) {
      // Distribute children unevenly along a stretched horizontal arc so
      // the cluster looks like a wisp, not a circle. Random angle within
      // a bias range, radius with falloff.
      const ang = (Math.random() - 0.5) * Math.PI * 1.6;
      const r = CLUSTER_RADIUS_TILES * (0.30 + Math.random() * 0.70);
      clouds.push({
        ox: Math.cos(ang) * r,
        oy: Math.sin(ang) * r * VERTICAL_SQUASH,
        sprite: CLOUD_SPRITES[(Math.random() * CLOUD_SPRITES.length) | 0],
        size: CLOUD_SIZE_TILES * (0.70 + Math.random() * 0.60),
        wx: 0, wy: 0,
      });
    }
    return { cx, cy, clouds, phase: Math.random() * 1000 };
  }

  /** Advance state by dtMs. Called once per frame. `activeVulcanos`
   *  carries the propIdx + world position of every currently-active
   *  cone — used to pull in nearby cloud patches and orbit their
   *  children around the cone. Omit / empty array to skip the orbit
   *  mechanic entirely. */
  update(
    dtMs: number,
    worldW: number,
    worldH: number,
    activeVulcanos?: Array<{ idx: number; x: number; y: number }>,
  ): void {
    this.maybeInit(worldW, worldH);
    const dt = dtMs / 1000;
    this.t += dt;
    const volcanoes = activeVulcanos ?? [];
    const activeIdxs = new Set<number>(volcanoes.map((v) => v.idx));

    for (const p of this.patches) {
      // 1. Release a captured patch if its volcano is no longer active
      // (deactivated by stepVulcanoActivationRollover). Reset to a
      // fresh drift cluster so the patch becomes a normal cloud again.
      if (p.orbitVulcanoIdx !== undefined && !activeIdxs.has(p.orbitVulcanoIdx)) {
        p.orbitX = undefined;
        p.orbitY = undefined;
        p.orbitVulcanoIdx = undefined;
        p.clouds = this.makeChildClouds();
        // Drop the patch on the west edge so it drifts back across
        // the world. Vertical pos unchanged.
        p.cx = -CLUSTER_RADIUS_TILES - CLOUD_SIZE_TILES;
      }
      // 2. Capture check: free-drift patch within range of an active
      // volcano gets pulled in and its children are replaced with 10
      // orbiting child clouds.
      if (p.orbitVulcanoIdx === undefined && volcanoes.length > 0) {
        let nearest: { idx: number; x: number; y: number } | null = null;
        let bestD2 = VULCANO_CAPTURE_RADIUS_TILES * VULCANO_CAPTURE_RADIUS_TILES;
        for (const v of volcanoes) {
          const dx = p.cx - v.x;
          const dy = p.cy - v.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; nearest = v; }
        }
        if (nearest) {
          p.orbitX = nearest.x;
          p.orbitY = nearest.y;
          p.orbitVulcanoIdx = nearest.idx;
          const children: Cloud[] = [];
          for (let i = 0; i < ORBIT_CHILDREN; i++) {
            const ang = (i / ORBIT_CHILDREN) * Math.PI * 2;
            const rad = ORBIT_RADIUS_MIN + Math.random() * (ORBIT_RADIUS_MAX - ORBIT_RADIUS_MIN);
            children.push({
              ox: 0, oy: 0,
              sprite: CLOUD_SPRITES[(Math.random() * CLOUD_SPRITES.length) | 0],
              size: CAPTURED_CLOUD_SIZE_TILES * (0.85 + Math.random() * 0.4),
              wx: 0, wy: 0,
              orbitAngle: ang,
              orbitRadius: rad,
            });
          }
          p.clouds = children;
        }
      }
      // 3. Tick the patch in its current mode.
      if (p.orbitVulcanoIdx !== undefined) {
        // Orbiting around (orbitX, orbitY). Each child sits at its base
        // angle + global time-driven sweep so the whole ring rotates
        // together. Ellipse squashed vertically for fake perspective.
        const phase = this.t * ORBIT_ANGULAR_SPEED;
        for (const c of p.clouds) {
          const a = (c.orbitAngle ?? 0) + phase;
          const r = c.orbitRadius ?? 100;
          c.wx = (p.orbitX ?? 0) + Math.cos(a) * r;
          c.wy = (p.orbitY ?? 0) + Math.sin(a) * r * ORBIT_VERTICAL_SQUASH;
        }
        // Pin patch centre to the volcano so any future release reset
        // logic has a sensible (cx, cy).
        p.cx = p.orbitX ?? p.cx;
        p.cy = p.orbitY ?? p.cy;
      } else {
        // Normal drift in world space.
        p.cx += WIND_TILES_PER_S * dt;
        p.cy += Math.sin(this.t * 0.7 + p.phase) * 8 * dt;
        if (p.cx - CLUSTER_RADIUS_TILES > worldW + CLOUD_SIZE_TILES) {
          p.cx = -CLUSTER_RADIUS_TILES - CLOUD_SIZE_TILES;
          p.cy = worldH * (0.10 + Math.random() * 0.55);
        }
        for (const c of p.clouds) {
          c.wx = p.cx + c.ox;
          c.wy = p.cy + c.oy;
        }
      }
    }
  }

  /** Build a fresh batch of drift-cluster children (used when a captured
   *  patch is released back to free drift). Mirrors the original
   *  makePatch cluster shape. */
  private makeChildClouds(): Cloud[] {
    const out: Cloud[] = [];
    for (let k = 0; k < CLOUDS_PER_PATCH; k++) {
      const ang = (Math.random() - 0.5) * Math.PI * 1.6;
      const r = CLUSTER_RADIUS_TILES * (0.30 + Math.random() * 0.70);
      out.push({
        ox: Math.cos(ang) * r,
        oy: Math.sin(ang) * r * VERTICAL_SQUASH,
        sprite: CLOUD_SPRITES[(Math.random() * CLOUD_SPRITES.length) | 0],
        size: CLOUD_SIZE_TILES * (0.70 + Math.random() * 0.60),
        wx: 0, wy: 0,
      });
    }
    return out;
  }

  /** Paint clouds into the viewport canvas, transformed by camera. */
  draw(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, cam: Camera): void {
    // Skip entirely once the camera is inside the "within 3 zoom levels of
    // max" band — clouds would be fully transparent so there's nothing to
    // draw and we save the per-cloud bbox math.
    if (cam.zoom >= FADE_END_ZOOM) return;

    // Linear fade between FADE_START_ZOOM (alpha 1) and FADE_END_ZOOM
    // (alpha 0). Anything below the start is fully opaque.
    let alpha = 1;
    if (cam.zoom > FADE_START_ZOOM) {
      alpha = 1 - (cam.zoom - FADE_START_ZOOM) / (FADE_END_ZOOM - FADE_START_ZOOM);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    // High-zoom antialiasing: when the camera is zoomed in close, the cloud
    // sprite is being scaled way up on screen and the soft white edge looks
    // much better with smoothing on. Below the threshold we keep the fast
    // nearest-neighbour path so the per-frame blit stays cheap.
    if (cam.zoom >= HIGH_ZOOM_AA_THRESHOLD) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    } else {
      ctx.imageSmoothingEnabled = false;
    }

    // Pass 1: drifting (free) cloud patches — normal white render.
    for (const p of this.patches) {
      if (p.orbitVulcanoIdx !== undefined) continue;
      for (const c of p.clouds) {
        const spr = getSprite(c.sprite);
        if (!spr) continue;
        const sx = viewW / 2 + (c.wx - cam.x) * cam.zoom;
        const sy = viewH / 2 + (c.wy - cam.y) * cam.zoom;
        const sz = c.size * cam.zoom;
        if (sx + sz / 2 < 0 || sx - sz / 2 > viewW) continue;
        if (sy + sz / 2 < 0 || sy - sz / 2 > viewH) continue;
        ctx.drawImage(spr, sx - sz / 2, sy - sz / 2, sz, sz);
      }
    }
    // Pass 2: captured (orbiting) clouds — render desaturated + dimmed
    // so they read as ash / storm clouds instead of fluffy whites. The
    // ctx.filter cost is paid once per active volcano patch, not per
    // cloud, so the per-frame overhead stays small.
    ctx.filter = "saturate(0.2) brightness(0.55)";
    for (const p of this.patches) {
      if (p.orbitVulcanoIdx === undefined) continue;
      for (const c of p.clouds) {
        const spr = getSprite(c.sprite);
        if (!spr) continue;
        const sx = viewW / 2 + (c.wx - cam.x) * cam.zoom;
        const sy = viewH / 2 + (c.wy - cam.y) * cam.zoom;
        const sz = c.size * cam.zoom;
        if (sx + sz / 2 < 0 || sx - sz / 2 > viewW) continue;
        if (sy + sz / 2 < 0 || sy - sz / 2 > viewH) continue;
        ctx.drawImage(spr, sx - sz / 2, sy - sz / 2, sz, sz);
      }
    }
    ctx.filter = "none";

    ctx.restore();
  }
}
