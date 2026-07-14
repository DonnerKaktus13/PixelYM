import type { Camera } from "./camera";
import type { GameState } from "../game/state";
import { getSprite } from "./textures";
import { getBuildingDef } from "../game/catalog";
import { getVesselDef } from "../game/vessels";

/**
 * Paint all placed structures + villagers as a camera-projected overlay.
 * Runs each frame on the user-facing ctx (i.e. AFTER the terrain pipeline
 * + SSAA composite), so it doesn't have to plug into the chunk system.
 *
 * Draw order: structures first (sorted by `y` ascending), then villagers
 * (also sorted by `y`). This gives the usual "lower-on-screen wins"
 * overlap ordering so villagers in front of a building cover the
 * building's lower edge, and one building south of another covers the
 * northerly one's footer.
 */
// Reusable per-frame scratch buffer for visible structures, so we
// don't allocate a fresh array (and trigger GC pressure) every frame.
// Indices into state.structures; reset on each call.
const _visStruct: number[] = [];
const _visVill: number[] = [];

/**
 * Spatial grid for buildings. Buildings are placed and destroyed
 * occasionally — much rarer than render frames — so we keep a grid of
 * structure indices and rebuild it only when the array changes. The
 * cull then walks only the cells the viewport overlaps instead of
 * iterating every structure in the world. Cell size is generous
 * (128 tiles) so a single padding ring covers any plausible footprint.
 */
const STRUCT_GRID_CELL = 128;
interface StructGrid {
  cellSize: number;
  cols: number;
  rows: number;
  cells: Int32Array[];
  /** Cached signals so we know when to rebuild. */
  cachedNextId: number;
  cachedLen: number;
  worldW: number;
  worldH: number;
}
let _structGrid: StructGrid | null = null;

function buildStructGrid(state: GameState): StructGrid {
  const w = state.world;
  const cols = Math.max(1, Math.ceil(w.width / STRUCT_GRID_CELL));
  const rows = Math.max(1, Math.ceil(w.height / STRUCT_GRID_CELL));
  const tmp: number[][] = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) tmp[i] = [];
  const structures = state.structures;
  for (let i = 0; i < structures.length; i++) {
    const s = structures[i];
    const cx = Math.max(0, Math.min(cols - 1, (s.x / STRUCT_GRID_CELL) | 0));
    const cy = Math.max(0, Math.min(rows - 1, (s.y / STRUCT_GRID_CELL) | 0));
    tmp[cy * cols + cx].push(i);
  }
  const cells: Int32Array[] = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) cells[i] = new Int32Array(tmp[i]);
  return {
    cellSize: STRUCT_GRID_CELL,
    cols,
    rows,
    cells,
    cachedNextId: state.nextStructureId,
    cachedLen: structures.length,
    worldW: w.width,
    worldH: w.height,
  };
}

function ensureStructGrid(state: GameState): StructGrid {
  const w = state.world;
  if (!_structGrid
      || _structGrid.cachedNextId !== state.nextStructureId
      || _structGrid.cachedLen !== state.structures.length
      || _structGrid.worldW !== w.width
      || _structGrid.worldH !== w.height) {
    _structGrid = buildStructGrid(state);
  }
  return _structGrid;
}

export function drawStructures(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  if (state.structures.length === 0 && state.villagers.length === 0) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  // World-space viewport bounds. Cheaper to compare in world coords
  // than to project every structure to screen-space just to discover
  // it's off-screen.
  const wHalfW = (viewW / 2) / cam.zoom;
  const wHalfH = (viewH / 2) / cam.zoom;
  const wMinX = cam.x - wHalfW;
  const wMaxX = cam.x + wHalfW;
  const wMinY = cam.y - wHalfH;
  const wMaxY = cam.y + wHalfH;

  // Buildings. Walk only the spatial-grid cells the viewport touches
  // instead of every structure — at thousands of buildings this drops
  // the per-frame cull cost from O(N_total) to O(N_visible). Cell size
  // is 128 tiles, so we widen the cell range by 1 on each side to catch
  // structures whose center sits in an adjacent cell but whose sprite
  // still extends into our viewport.
  _visStruct.length = 0;
  const structures = state.structures;
  const grid = ensureStructGrid(state);
  const cs = grid.cellSize;
  const c0 = Math.max(0, ((wMinX / cs) | 0) - 1);
  const c1 = Math.min(grid.cols - 1, ((wMaxX / cs) | 0) + 1);
  const r0 = Math.max(0, ((wMinY / cs) | 0) - 1);
  const r1 = Math.min(grid.rows - 1, ((wMaxY / cs) | 0) + 1);
  for (let r = r0; r <= r1; r++) {
    const base = r * grid.cols;
    for (let c = c0; c <= c1; c++) {
      const cell = grid.cells[base + c];
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k];
        const s = structures[i];
        if (s.x + s.size < wMinX || s.x - s.size > wMaxX) continue;
        if (s.y + s.size < wMinY || s.y - s.size > wMaxY) continue;
        _visStruct.push(i);
      }
    }
  }
  // Sort by y ascending so southern sprites overlap northern ones.
  _visStruct.sort((a, b) => structures[a].y - structures[b].y);
  for (let k = 0; k < _visStruct.length; k++) {
    const s = structures[_visStruct[k]];
    const def = getBuildingDef(s.defKey);
    if (!def) continue;
    const sprite = getSprite(def.sprite);
    if (!sprite) continue;
    const sxPx = viewW / 2 + (s.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (s.y - cam.y) * cam.zoom;
    // User-requested 0.30× scale on naval + airship ports. The catalog
    // keeps `size: 66` so placement / spacing math doesn't churn, but
    // the naval port sprite renders at 30 % of that footprint so the
    // dock reads as a hand-built building rather than dominating the
    // whole shoreline. Airship ports stay full size (user-reverted).
    const isNavalPort = s.defKey.startsWith("port_");
    const sz = (isNavalPort ? s.size * 0.30 : s.size) * 2 * cam.zoom;
    // Unfinished structures (buildProgress < 1) paint at lower opacity
    // so the player can see scaffolding-in-progress at a glance. Opacity
    // ramps from 30 % (just started) to 100 % (almost done) and a small
    // progress bar sits above the sprite for quick reading.
    const progress = s.buildProgress ?? 1;
    if (progress < 1) {
      const alpha = 0.3 + progress * 0.6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
      ctx.globalAlpha = 1;
      // Progress bar above the structure.
      const barW = Math.max(40, sz * 0.6);
      const barH = Math.max(4, cam.zoom * 1.2);
      const barX = sxPx - barW / 2;
      const barY = syPx - sz / 2 - barH - 2;
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#ffd23a";
      ctx.fillRect(barX + 1, barY + 1, (barW - 2) * progress, barH - 2);
    } else {
      ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
    }
  }

  // Vessels — ships sit on the sea next to a port (assigned x/y in
  // findShipSpawnNear at purchase time), airships hover above the hangar
  // (airshipDockSpot at purchase time). Shot-down vessels can render
  // their wreck sprite once the assets land.
  const SHIP_TILES = 14;
  // User-requested 0.30× scale on airships — both small and big halved
  // down so they read as approachable hand-built craft rather than
  // dominating the screen. Previous values were 22 / 132.
  const AIRSHIP_TILES_SMALL = 7;  // scout / recon — was 22
  const AIRSHIP_TILES_BIG = 40;   // heavy / patrol / cargo — was 132
  const AIRSHIP_BOB_AMP = 1.2;    // ± tiles of vertical bob
  const AIRSHIP_BOB_HZ = 0.35;    // bobs per second
  const SHADOW_OFFSET = 14;       // tiles below airship — drops a soft shadow on the ground
  const bobT = performance.now() / 1000;
  const vessels = state.vessels;
  for (let i = 0; i < vessels.length; i++) {
    const ve = vessels[i];
    if (ve.x === undefined || ve.y === undefined) continue;
    const def = getVesselDef(ve.defKey);
    if (!def) continue;
    const isAirship = def.category === "airship";
    // Ships skip the "flying" status (only airships fly), but airships
    // should still render while flying — they're literally airborne and
    // visible to other players. shotdown for either type renders the
    // wreck sprite at the last known position.
    if (!isAirship && ve.status === "flying") continue;
    // Big airships (those with crew/popCap) read as ~2× the airship-port
    // footprint; small scouts/recon stay compact.
    const isBigAirship = isAirship && ((def.popCap ?? 0) > 0 || (def.crew ?? 0) > 0);
    const tiles = isAirship
      ? (isBigAirship ? AIRSHIP_TILES_BIG : AIRSHIP_TILES_SMALL)
      : SHIP_TILES;
    const pad = tiles;
    if (ve.x + pad < wMinX || ve.x - pad > wMaxX) continue;
    if (ve.y + pad < wMinY || ve.y - pad > wMaxY) continue;
    const spriteName = ve.status === "shotdown" && def.shotDownSprite ? def.shotDownSprite : def.sprite;
    const sprite = getSprite(spriteName);
    if (!sprite) continue;
    // Airships bob gently in place — sin wave per-vessel phase so a row
    // of three at the same hangar isn't perfectly synchronised.
    let drawY = ve.y;
    if (isAirship && ve.status !== "shotdown") {
      const phase = (ve.id * 0.7) % (Math.PI * 2);
      drawY = ve.y + Math.sin(bobT * AIRSHIP_BOB_HZ * Math.PI * 2 + phase) * AIRSHIP_BOB_AMP;
    }
    const sxPx = viewW / 2 + (ve.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (drawY - cam.y) * cam.zoom;
    const sz = tiles * 2 * cam.zoom;
    if (isAirship && ve.status !== "shotdown") {
      // Soft elliptical shadow on the ground directly under the airship.
      // Drawn first so the dirigible covers it where they overlap. Scales
      // with the (bobbed) altitude — when the sin wave dips the shadow
      // sharpens slightly. Cheap ellipse via ctx.ellipse.
      const altitude = tiles + (ve.y - drawY); // larger when bobbed up
      const shadowR = (tiles * 0.55) * cam.zoom;
      const shadowY = viewH / 2 + (ve.y + SHADOW_OFFSET - cam.y) * cam.zoom;
      const shadowAlpha = Math.max(0.18, 0.35 - altitude * 0.005);
      ctx.fillStyle = `rgba(0, 0, 0, ${shadowAlpha})`;
      ctx.beginPath();
      ctx.ellipse(sxPx, shadowY, shadowR, shadowR * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
  }

  // Villagers. Same viewport pre-cull pattern as structures above —
  // at 1500+ villagers the sort cost was dominating the per-frame
  // overlay. Now we only sort the ~50 visible ones.
  const VILLAGER_TILES = 6;
  const CARRY_TILES = 4;
  const villPad = VILLAGER_TILES;        // padding so a half-on-screen sprite still draws
  _visVill.length = 0;
  const villagersAll = state.villagers;
  for (let i = 0; i < villagersAll.length; i++) {
    const v = villagersAll[i];
    if (v.insideStructureId !== undefined) continue;
    if (v.x + villPad < wMinX || v.x - villPad > wMaxX) continue;
    if (v.y + villPad < wMinY || v.y - villPad > wMaxY) continue;
    _visVill.push(i);
  }
  _visVill.sort((a, b) => villagersAll[a].y - villagersAll[b].y);
  for (let k = 0; k < _visVill.length; k++) {
    const v = villagersAll[_visVill[k]];
    const sprite = getSprite(v.sprite);
    if (!sprite) continue;
    const sxPx = viewW / 2 + (v.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (v.y - cam.y) * cam.zoom;
    const sz = VILLAGER_TILES * 2 * cam.zoom;
    const rot = v.rot ?? 0;
    if (rot !== 0) {
      // Rotate around the villager's "feet" (bottom of the sprite) so the
      // pivot looks like a person bending forwards, not spinning in place.
      ctx.save();
      ctx.translate(sxPx, syPx + sz / 2);
      ctx.rotate(rot);
      ctx.drawImage(sprite, -sz / 2, -sz, sz, sz);
      if (v.carryingSprite) {
        const carry = getSprite(v.carryingSprite);
        if (carry) {
          const cz = CARRY_TILES * 2 * cam.zoom;
          // Pivot frame for the rotated villager: feet at y=0, head at
          // y=-sz. Shoulders sit ~25% down from the head, so put the
          // TOP of the carried item at -0.75*sz — reads as held at
          // shoulder level rather than dropped at the feet.
          ctx.drawImage(carry, -cz / 2, -sz * 0.75, cz, cz);
        }
      }
      ctx.restore();
    } else {
      ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
      if (v.carryingSprite) {
        const carry = getSprite(v.carryingSprite);
        if (carry) {
          const cz = CARRY_TILES * 2 * cam.zoom;
          // Top of the carry sits at ~25% of villager height — i.e. at
          // shoulder level — so the stump reads as carried in front of
          // the chest, not dropped at the feet.
          ctx.drawImage(carry, sxPx - cz / 2, syPx - sz * 0.25, cz, cz);
        }
      }
    }
    // Weapon marker — a small coloured pip at the villager's hip so the
    // player can tell at a glance whether a villager is bow-armed
    // (default worker, slow auto-attack) or spear-armed (promoted
    // guard/army, fast auto-attack). Only drawn when zoomed in enough
    // for the dot to actually read; tiny LO-zoom view skips it.
    const weapon = v.weapon ?? "bow";
    if (weapon !== "bow" && !v.carryingSprite && cam.zoom > 2) {
      const dotR = Math.max(2, cam.zoom * 0.7);
      ctx.fillStyle = WEAPON_COLOR[weapon];
      ctx.beginPath();
      ctx.arc(sxPx + sz * 0.3, syPx + sz * 0.1, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

/** Colour key for the villager weapon marker. Picked so a quick glance
 *  at a tribe tells you spear (combat-ready) from torch / club / sling
 *  (specialist) from bow (default). */
const WEAPON_COLOR: Record<string, string> = {
  spear: "#e8e8ee",   // steel
  club:  "#a07050",   // wood
  torch: "#ff7a3a",   // fire
  sling: "#c8c0a0",   // hide
};

/**
 * Spatial grid for tree props. Built once per world (props are static
 * after gen) and reused forever. Without this every render frame
 * iterated all 50000+ props to test for `tree_` + viewport overlap —
 * at 240 fps that's 12M ops/sec on the cull alone. With the grid we
 * only walk the cells the viewport actually overlaps (~9–25 cells
 * regardless of zoom), so the cull cost is bounded by visible-tree
 * count, not total prop count.
 */
const TREE_GRID_CELL = 256;            // world-tiles per grid cell
interface TreeGrid {
  worldSeed: number;                   // invalidate on world swap
  cellSize: number;
  cols: number;
  rows: number;
  cells: Int32Array[];                 // flattened (row*cols + col) → prop indices
}
let _treeGrid: TreeGrid | null = null;

function buildTreeGrid(state: GameState): TreeGrid {
  const w = state.world;
  const cols = Math.ceil(w.width / TREE_GRID_CELL);
  const rows = Math.ceil(w.height / TREE_GRID_CELL);
  // Collect tree props per cell.
  const tmp: number[][] = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) tmp[i] = [];
  const props = w.props;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (!p.sprite.startsWith("tree_")) continue;
    const cx = (p.x / TREE_GRID_CELL) | 0;
    const cy = (p.y / TREE_GRID_CELL) | 0;
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    tmp[cy * cols + cx].push(i);
  }
  // Pack each cell into an Int32Array for cache-friendly iteration.
  const cells: Int32Array[] = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    cells[i] = new Int32Array(tmp[i]);
  }
  return { worldSeed: w.worldSeed, cellSize: TREE_GRID_CELL, cols, rows, cells };
}

// Reusable per-frame visible-tree scratch.
const _visTrees: number[] = [];

/**
 * Paint live trees as a camera-projected OVERLAY on top of structures +
 * villagers. Uses a per-world spatial grid (built lazily on first call)
 * so the cull cost scales with visible tile area, not total prop count.
 */
export function drawTrees(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  const w = state.world;
  if (!w.props || w.props.length === 0) return;
  if (!_treeGrid || _treeGrid.worldSeed !== w.worldSeed
      || _treeGrid.cols !== Math.ceil(w.width / TREE_GRID_CELL)) {
    _treeGrid = buildTreeGrid(state);
  }
  const grid = _treeGrid;
  // Viewport bounds in world coords. Pad by max tree size (≈16) so a
  // half-on-screen canopy still draws.
  const wHalfW = (viewW / 2) / cam.zoom;
  const wHalfH = (viewH / 2) / cam.zoom;
  const pad = 16;
  const wMinX = cam.x - wHalfW - pad;
  const wMaxX = cam.x + wHalfW + pad;
  const wMinY = cam.y - wHalfH - pad;
  const wMaxY = cam.y + wHalfH + pad;
  const c0 = Math.max(0, (wMinX / grid.cellSize) | 0);
  const c1 = Math.min(grid.cols - 1, (wMaxX / grid.cellSize) | 0);
  const r0 = Math.max(0, (wMinY / grid.cellSize) | 0);
  const r1 = Math.min(grid.rows - 1, (wMaxY / grid.cellSize) | 0);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  _visTrees.length = 0;
  const harvested = state.harvestedProps;
  const dying = state.dyingProps;
  const props = w.props;
  for (let r = r0; r <= r1; r++) {
    const rowOff = r * grid.cols;
    for (let c = c0; c <= c1; c++) {
      const cell = grid.cells[rowOff + c];
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k];
        if (harvested && harvested.has(i)) continue;
        // Skip dying trees — they're handled by the drawDyingProps
        // overlay so they can render the flip-over animation while
        // staying visible until the animation completes.
        if (dying && dying.has(i)) continue;
        const p = props[i];
        if (p.x + p.size < wMinX || p.x - p.size > wMaxX) continue;
        if (p.y + p.size < wMinY || p.y - p.size > wMaxY) continue;
        _visTrees.push(i);
      }
    }
  }
  // Sort by y so southern canopies overlap northern ones.
  _visTrees.sort((a, b) => props[a].y - props[b].y);
  for (let k = 0; k < _visTrees.length; k++) {
    const p = props[_visTrees[k]];
    const sprite = getSprite(p.sprite);
    if (!sprite) continue;
    const sxPx = viewW / 2 + (p.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (p.y - cam.y) * cam.zoom;
    const sz = p.size * 2 * cam.zoom;
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
  }
  ctx.restore();
}

// ============================================================
// Unified depth sort — drawAllProps
// ============================================================
//
// One pass that depth-sorts every visible "prop" (structures, ships,
// villagers, trees, dying props, animals) by sprite bottom in world
// coords. The entity with the larger bottom-Y is drawn LAST and so
// appears on top — matching the user's request that the lower sprite
// "wins the visibility battle".
//
// Airships skip the unified sort: they hover above the world and are
// drawn in a final overlay pass with shadows + bob, always on top.
//
// After the main draw, villagers + animals get a second-pass occlusion
// check: if any later-drawn entity (structure / tree / ship) overlaps
// their bbox, a coloured outline ring is drawn on top so the player
// can still tell where their unit is hiding.

const KIND_STRUCT = 0;
const KIND_SHIP = 1;
const KIND_VILLAGER = 2;
const KIND_TREE = 3;
const KIND_DYING = 4;
const KIND_ANIMAL = 5;

interface PropEntry {
  k: number;        // KIND_*
  i: number;        // index into the source array
  by: number;       // sprite bottom Y (sort key)
  x: number;
  y: number;
  half: number;     // bbox half-extent for occlusion test (square)
}

const _entries: PropEntry[] = [];
// Small pool to recycle PropEntry objects across frames — avoids
// thrashing the allocator at ~240 fps with hundreds of visible items.
const _entryPool: PropEntry[] = [];
function acquireEntry(): PropEntry {
  return _entryPool.pop() ?? { k: 0, i: 0, by: 0, x: 0, y: 0, half: 0 };
}

const VTILE = 6;           // VILLAGER_TILES — shared between draw + cull + occlusion bbox
const CARRY_TILES = 4;
const SHIP_TILES = 14;
const ANIMAL_TILES = 6;
const AIRSHIP_TILES_SMALL = 7;
const AIRSHIP_TILES_BIG = 40;
const AIRSHIP_BOB_AMP = 1.2;
const AIRSHIP_BOB_HZ = 0.35;
const AIRSHIP_SHADOW_OFFSET = 14;

export function drawAllProps(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  const wHalfW = (viewW / 2) / cam.zoom;
  const wHalfH = (viewH / 2) / cam.zoom;
  const wMinX = cam.x - wHalfW;
  const wMaxX = cam.x + wHalfW;
  const wMinY = cam.y - wHalfH;
  const wMaxY = cam.y + wHalfH;

  // Reset scratch — push live entries back into the pool first.
  for (let i = 0; i < _entries.length; i++) _entryPool.push(_entries[i]);
  _entries.length = 0;

  // --- Structures (uses spatial grid).
  const structures = state.structures;
  if (structures.length > 0) {
    const grid = ensureStructGrid(state);
    const cs = grid.cellSize;
    const c0 = Math.max(0, ((wMinX / cs) | 0) - 1);
    const c1 = Math.min(grid.cols - 1, ((wMaxX / cs) | 0) + 1);
    const r0 = Math.max(0, ((wMinY / cs) | 0) - 1);
    const r1 = Math.min(grid.rows - 1, ((wMaxY / cs) | 0) + 1);
    for (let r = r0; r <= r1; r++) {
      const base = r * grid.cols;
      for (let c = c0; c <= c1; c++) {
        const cell = grid.cells[base + c];
        for (let k = 0; k < cell.length; k++) {
          const i = cell[k];
          const s = structures[i];
          if (s.x + s.size < wMinX || s.x - s.size > wMaxX) continue;
          if (s.y + s.size < wMinY || s.y - s.size > wMaxY) continue;
          const e = acquireEntry();
          e.k = KIND_STRUCT; e.i = i;
          e.by = s.y + s.size; e.x = s.x; e.y = s.y; e.half = s.size;
          _entries.push(e);
        }
      }
    }
  }

  // --- Ships (airships go in the separate top-of-frame overlay).
  const vessels = state.vessels;
  for (let i = 0; i < vessels.length; i++) {
    const ve = vessels[i];
    if (ve.x === undefined || ve.y === undefined) continue;
    const def = getVesselDef(ve.defKey);
    if (!def || def.category !== "ship") continue;
    if (ve.status === "flying") continue;
    if (ve.x + SHIP_TILES < wMinX || ve.x - SHIP_TILES > wMaxX) continue;
    if (ve.y + SHIP_TILES < wMinY || ve.y - SHIP_TILES > wMaxY) continue;
    const e = acquireEntry();
    e.k = KIND_SHIP; e.i = i;
    e.by = ve.y + SHIP_TILES; e.x = ve.x; e.y = ve.y; e.half = SHIP_TILES;
    _entries.push(e);
  }

  // --- Villagers.
  const villagers = state.villagers;
  for (let i = 0; i < villagers.length; i++) {
    const v = villagers[i];
    if (v.insideStructureId !== undefined) continue;
    if (v.x + VTILE < wMinX || v.x - VTILE > wMaxX) continue;
    if (v.y + VTILE < wMinY || v.y - VTILE > wMaxY) continue;
    const e = acquireEntry();
    e.k = KIND_VILLAGER; e.i = i;
    e.by = v.y + VTILE; e.x = v.x; e.y = v.y; e.half = VTILE;
    _entries.push(e);
  }

  // --- Trees (uses tree grid).
  const w = state.world;
  if (w.props && w.props.length > 0) {
    if (!_treeGrid || _treeGrid.worldSeed !== w.worldSeed
        || _treeGrid.cols !== Math.ceil(w.width / TREE_GRID_CELL)) {
      _treeGrid = buildTreeGrid(state);
    }
    const tgrid = _treeGrid;
    const pad = 16;
    const tc0 = Math.max(0, ((wMinX - pad) / tgrid.cellSize) | 0);
    const tc1 = Math.min(tgrid.cols - 1, ((wMaxX + pad) / tgrid.cellSize) | 0);
    const tr0 = Math.max(0, ((wMinY - pad) / tgrid.cellSize) | 0);
    const tr1 = Math.min(tgrid.rows - 1, ((wMaxY + pad) / tgrid.cellSize) | 0);
    const harvested = state.harvestedProps;
    const dying = state.dyingProps;
    const props = w.props;
    for (let r = tr0; r <= tr1; r++) {
      const rowOff = r * tgrid.cols;
      for (let c = tc0; c <= tc1; c++) {
        const cell = tgrid.cells[rowOff + c];
        for (let k = 0; k < cell.length; k++) {
          const i = cell[k];
          if (harvested && harvested.has(i)) continue;
          if (dying && dying.has(i)) continue;
          const p = props[i];
          if (p.x + p.size < wMinX || p.x - p.size > wMaxX) continue;
          if (p.y + p.size < wMinY || p.y - p.size > wMaxY) continue;
          const e = acquireEntry();
          e.k = KIND_TREE; e.i = i;
          e.by = p.y + p.size; e.x = p.x; e.y = p.y; e.half = p.size;
          _entries.push(e);
        }
      }
    }
  }

  // --- Dying props.
  if (state.dyingProps && state.dyingProps.size > 0) {
    for (const [propIdx] of state.dyingProps) {
      const p = w.props[propIdx];
      if (!p) continue;
      if (p.x + p.size < wMinX || p.x - p.size > wMaxX) continue;
      if (p.y + p.size < wMinY || p.y - p.size > wMaxY) continue;
      const e = acquireEntry();
      e.k = KIND_DYING; e.i = propIdx;
      e.by = p.y + p.size; e.x = p.x; e.y = p.y; e.half = p.size;
      _entries.push(e);
    }
  }

  // --- Animals.
  const animals = state.animals;
  if (animals && animals.length > 0) {
    const half = ANIMAL_TILES / 2;
    for (let i = 0; i < animals.length; i++) {
      const a = animals[i];
      if (a.x + half < wMinX || a.x - half > wMaxX) continue;
      if (a.y + half < wMinY || a.y - half > wMaxY) continue;
      const e = acquireEntry();
      e.k = KIND_ANIMAL; e.i = i;
      e.by = a.y + half; e.x = a.x; e.y = a.y; e.half = half;
      _entries.push(e);
    }
  }

  // Sort by sprite bottom Y so the deeper one wins (drawn last → on top).
  _entries.sort(byBottomY);

  // Main draw pass.
  for (let n = 0; n < _entries.length; n++) {
    const e = _entries[n];
    switch (e.k) {
      case KIND_STRUCT:   drawOneStructure(ctx, viewW, viewH, cam, state, e.i); break;
      case KIND_SHIP:     drawOneShip(ctx, viewW, viewH, cam, state, e.i); break;
      case KIND_VILLAGER: drawOneVillager(ctx, viewW, viewH, cam, state, e.i); break;
      case KIND_TREE:     drawOneTree(ctx, viewW, viewH, cam, state, e.i); break;
      case KIND_DYING:    drawOneDyingProp(ctx, viewW, viewH, cam, state, e.i); break;
      case KIND_ANIMAL:   drawOneAnimal(ctx, viewW, viewH, cam, state, e.i); break;
    }
  }

  // Airships — always on top so they read as flying above the world.
  drawAirships(ctx, viewW, viewH, cam, state, wMinX, wMaxX, wMinY, wMaxY);

  ctx.restore();
}

function byBottomY(a: PropEntry, b: PropEntry): number {
  return a.by - b.by;
}

// ----------------------------------------------------------------
// Per-entity draw helpers used by drawAllProps. Each receives an index
// into its source array and inlines the original draw logic from the
// pre-refactor functions.
// ----------------------------------------------------------------

function drawOneStructure(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const s = state.structures[i];
  const def = getBuildingDef(s.defKey);
  if (!def) return;
  const sprite = getSprite(def.sprite);
  if (!sprite) return;
  const sxPx = viewW / 2 + (s.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (s.y - cam.y) * cam.zoom;
  // Naval ports keep their large footprint (size 66) for placement /
  // spacing math but render at 30 % visually so the dock reads as
  // hand-built rather than dominating the shoreline. Airship ports stay
  // full size (user-reverted).
  const isNavalPort = s.defKey.startsWith("port_");
  const sz = (isNavalPort ? s.size * 0.30 : s.size) * 2 * cam.zoom;
  const progress = s.buildProgress ?? 1;
  if (progress < 1) {
    const alpha = 0.3 + progress * 0.6;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
    ctx.globalAlpha = 1;
    const barW = Math.max(40, sz * 0.6);
    const barH = Math.max(4, cam.zoom * 1.2);
    const barX = sxPx - barW / 2;
    const barY = syPx - sz / 2 - barH - 2;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = "#ffd23a";
    ctx.fillRect(barX + 1, barY + 1, (barW - 2) * progress, barH - 2);
  } else {
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
  }
}

function drawOneShip(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const ve = state.vessels[i];
  if (ve.x === undefined || ve.y === undefined) return;
  const def = getVesselDef(ve.defKey);
  if (!def) return;
  const spriteName = ve.status === "shotdown" && def.shotDownSprite ? def.shotDownSprite : def.sprite;
  const sprite = getSprite(spriteName);
  if (!sprite) return;
  const sxPx = viewW / 2 + (ve.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (ve.y - cam.y) * cam.zoom;
  const sz = SHIP_TILES * 2 * cam.zoom;
  ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
}

function drawOneVillager(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const v = state.villagers[i];
  const sprite = getSprite(v.sprite);
  if (!sprite) return;
  const sxPx = viewW / 2 + (v.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (v.y - cam.y) * cam.zoom;
  const sz = VTILE * 2 * cam.zoom;
  const rot = v.rot ?? 0;
  if (rot !== 0) {
    ctx.save();
    ctx.translate(sxPx, syPx + sz / 2);
    ctx.rotate(rot);
    ctx.drawImage(sprite, -sz / 2, -sz, sz, sz);
    if (v.carryingSprite) {
      const carry = getSprite(v.carryingSprite);
      if (carry) {
        const cz = CARRY_TILES * 2 * cam.zoom;
        ctx.drawImage(carry, -cz / 2, -sz * 0.75, cz, cz);
      }
    }
    ctx.restore();
  } else {
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
    if (v.carryingSprite) {
      const carry = getSprite(v.carryingSprite);
      if (carry) {
        const cz = CARRY_TILES * 2 * cam.zoom;
        ctx.drawImage(carry, sxPx - cz / 2, syPx - sz * 0.25, cz, cz);
      }
    }
  }
  const weapon = v.weapon ?? "bow";
  if (weapon !== "bow" && !v.carryingSprite && cam.zoom > 2) {
    const dotR = Math.max(2, cam.zoom * 0.7);
    ctx.fillStyle = WEAPON_COLOR[weapon];
    ctx.beginPath();
    ctx.arc(sxPx + sz * 0.3, syPx + sz * 0.1, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOneTree(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const p = state.world.props[i];
  const sprite = getSprite(p.sprite);
  if (!sprite) return;
  const sxPx = viewW / 2 + (p.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (p.y - cam.y) * cam.zoom;
  const sz = p.size * 2 * cam.zoom;
  ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
}

const DEATH_TICKS = 10;
function drawOneDyingProp(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const startTick = state.dyingProps?.get(i);
  if (startTick === undefined) return;
  const p = state.world.props[i];
  if (!p) return;
  // Sub-tick interpolation — sim is 10 Hz but render is 60. Blend the
  // gap with performance.now since the last tick fired so the rotation
  // is smooth instead of stepping in 10 visible chunks.
  const subTick = state.lastTickMs !== undefined
    ? Math.min(1, (performance.now() - state.lastTickMs) / (state.config?.tickMs ?? 100))
    : 0;
  let progress = (state.tick - startTick + subTick) / DEATH_TICKS;
  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;
  // Gravity-ease (quadratic-in) — the prop tips slowly at first then
  // accelerates into the ground like a felled tree. Linear rotation
  // reads as a stiff "wipe"; this curve gives weight.
  const rotProgress = progress * progress;
  // Tiny horizontal shake during the last 15 % — reads as the thud on
  // impact without needing a dust asset.
  const impact = progress > 0.85 ? (1 - (progress - 0.85) / 0.15) : 0;
  const shakeX = impact * (Math.sin(progress * 80) * 0.6 * cam.zoom);
  // Darken sprite as it falls (max 35 %) — sells "no longer alive".
  const darkenAmt = 0.35 * progress;
  const rot = rotProgress * (Math.PI / 2);
  const alpha = 1 - progress;
  if (alpha <= 0.001) return;
  const sprite = getSprite(p.sprite);
  if (!sprite) return;
  const sxPx = viewW / 2 + (p.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (p.y - cam.y) * cam.zoom;
  const sz = p.size * 2 * cam.zoom;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(sxPx + shakeX, syPx + sz / 2);
  ctx.rotate(rot);
  ctx.drawImage(sprite, -sz / 2, -sz, sz, sz);
  if (darkenAmt > 0.001) {
    // Sprite-clipped darken via source-atop — multiplies a translucent
    // black overlay over only the pixels the sprite drew. Cheaper than
    // tinting through an off-screen canvas.
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = `rgba(0,0,0,${darkenAmt.toFixed(3)})`;
    ctx.fillRect(-sz / 2, -sz, sz, sz);
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
}

function drawOneAnimal(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState, i: number,
): void {
  const a = state.animals?.[i];
  if (!a) return;
  const sxPx = viewW / 2 + (a.x - cam.x) * cam.zoom;
  const syPx = viewH / 2 + (a.y - cam.y) * cam.zoom;
  const sz = ANIMAL_TILES * cam.zoom;
  const sprite = getSprite(a.sprite);
  if (sprite) {
    if (a.facing === -1) {
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

function drawAirships(
  ctx: CanvasRenderingContext2D,
  viewW: number, viewH: number,
  cam: Camera, state: GameState,
  wMinX: number, wMaxX: number, wMinY: number, wMaxY: number,
): void {
  const vessels = state.vessels;
  const bobT = performance.now() / 1000;
  // Polish pass: amplitude scales with airship size so big dirigibles
  // don't look like they're rocking violently while small scouts barely
  // move. Frequency stays per-vessel (de-synced via phase) so a row of
  // three doesn't look mechanically locked together.
  const BOB_FREQ_BASE = 0.32;       // Hz for the bob sine wave
  const BOB_FREQ_SPREAD = 0.10;     // ± per-vessel variation
  const DRIFT_AMP_FRACTION = 0.04;  // horizontal drift = this × tiles
  const DRIFT_FREQ = 0.12;          // slower than bob — reads as a gentle pendulum
  for (let i = 0; i < vessels.length; i++) {
    const ve = vessels[i];
    if (ve.x === undefined || ve.y === undefined) continue;
    const def = getVesselDef(ve.defKey);
    if (!def || def.category !== "airship") continue;
    const isBig = (def.popCap ?? 0) > 0 || (def.crew ?? 0) > 0;
    const tiles = isBig ? AIRSHIP_TILES_BIG : AIRSHIP_TILES_SMALL;
    if (ve.x + tiles < wMinX || ve.x - tiles > wMaxX) continue;
    if (ve.y + tiles < wMinY || ve.y - tiles > wMaxY) continue;
    const spriteName = ve.status === "shotdown" && def.shotDownSprite ? def.shotDownSprite : def.sprite;
    const sprite = getSprite(spriteName);
    if (!sprite) continue;
    let drawX = ve.x;
    let drawY = ve.y;
    if (ve.status !== "shotdown") {
      // Per-vessel phase + frequency keeps a row of airships out of sync
      // so the hangar reads as a living scene rather than a mechanical
      // clock face. id-derived; deterministic across saves.
      const phase = (ve.id * 0.7) % (Math.PI * 2);
      const driftPhase = (ve.id * 1.31 + 1.7) % (Math.PI * 2);
      const freqJitter = ((ve.id * 17) % 100) / 100 - 0.5; // -0.5..0.5
      const bobHz = BOB_FREQ_BASE + freqJitter * BOB_FREQ_SPREAD;
      // Amplitude scales with tiles → small scouts get a ~0.4-tile bob,
      // big dirigibles get ~2.0 tiles. Old fixed 1.2 made scouts wobble
      // like a boat and bigs look frozen.
      const bobAmp = tiles * 0.05;
      drawY = ve.y + Math.sin(bobT * bobHz * Math.PI * 2 + phase) * bobAmp;
      // Gentle horizontal drift — pendulum-like, slower than the bob.
      // Sells "tethered" rather than "rigidly mounted".
      drawX = ve.x + Math.sin(bobT * DRIFT_FREQ * Math.PI * 2 + driftPhase) * (tiles * DRIFT_AMP_FRACTION);
    }
    const sxPx = viewW / 2 + (drawX - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (drawY - cam.y) * cam.zoom;
    const sz = tiles * 2 * cam.zoom;
    if (ve.status !== "shotdown") {
      // Shadow tracks the airship's actual horizontal position (drawX),
      // not the parked one, so the shadow swings with the drift. The
      // alpha now uses a smoothstep curve on the bob altitude — gives a
      // softer "breath" instead of the harsh linear darkening.
      const altOffset = ve.y - drawY;            // positive when bobbed up
      const altT = Math.min(1, Math.abs(altOffset) / (tiles * 0.08));
      const altCurve = altT * altT * (3 - 2 * altT); // smoothstep
      const shadowAlpha = 0.30 - altCurve * 0.12;
      const shadowR = (tiles * 0.55) * cam.zoom;
      const shadowY = viewH / 2 + (ve.y + AIRSHIP_SHADOW_OFFSET - cam.y) * cam.zoom;
      const shadowX = viewW / 2 + (drawX - cam.x) * cam.zoom;
      ctx.fillStyle = `rgba(0, 0, 0, ${shadowAlpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(shadowX, shadowY, shadowR, shadowR * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.drawImage(sprite, sxPx - sz / 2, syPx - sz / 2, sz, sz);
  }
}

/** Death-animation overlay — renders every prop currently in
 *  `state.dyingProps` with a flip-over rotation and a fade-out. Runs
 *  AFTER drawStructures + drawTrees so the falling sprite sits visually
 *  on top of any villager / building underneath it (matches the live-
 *  tree overlay's draw order).
 *
 *  Animation parameters:
 *   - Rotation pivots around the prop's BOTTOM (feet) so the sprite
 *     reads as falling forward, not spinning in place. Rotates from
 *     0 → 90° over PROP_DEATH_TICKS, then the engine commits it to
 *     harvestedProps.
 *   - Alpha fades from 1.0 → 0 across the same window.
 *  Tick-fraction interpolation uses state.lastTickMs so the animation
 *  is smooth even at high render framerates. */
export function drawDyingProps(
  ctx: CanvasRenderingContext2D,
  viewW: number,
  viewH: number,
  cam: Camera,
  state: GameState,
): void {
  const dying = state.dyingProps;
  if (!dying || dying.size === 0) return;
  const w = state.world;
  // Match the per-tile death duration in state.ts. Keep this in sync.
  const DEATH_TICKS = 10;
  const wHalfW = (viewW / 2) / cam.zoom;
  const wHalfH = (viewH / 2) / cam.zoom;
  const pad = 16;
  const wMinX = cam.x - wHalfW - pad;
  const wMaxX = cam.x + wHalfW + pad;
  const wMinY = cam.y - wHalfH - pad;
  const wMaxY = cam.y + wHalfH + pad;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (const [propIdx, startTick] of dying) {
    const p = w.props[propIdx];
    if (!p) continue;
    if (p.x + p.size < wMinX || p.x - p.size > wMaxX) continue;
    if (p.y + p.size < wMinY || p.y - p.size > wMaxY) continue;
    // Tick-based progress (0..1). When the engine fires stepPropDeaths
    // it'll remove the entry; clamp here so a half-rendered tick still
    // looks correct.
    let progress = (state.tick - startTick) / DEATH_TICKS;
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;
    const rot = progress * (Math.PI / 2);
    const alpha = 1 - progress;
    if (alpha <= 0.001) continue;
    const sprite = getSprite(p.sprite);
    if (!sprite) continue;
    const sxPx = viewW / 2 + (p.x - cam.x) * cam.zoom;
    const syPx = viewH / 2 + (p.y - cam.y) * cam.zoom;
    const sz = p.size * 2 * cam.zoom;
    ctx.globalAlpha = alpha;
    // Pivot around the prop's feet — translate to bottom of sprite,
    // rotate, then draw the sprite with its origin offset above so the
    // pivot sits at the ground line.
    ctx.translate(sxPx, syPx + sz / 2);
    ctx.rotate(rot);
    ctx.drawImage(sprite, -sz / 2, -sz, sz, sz);
    ctx.rotate(-rot);
    ctx.translate(-sxPx, -(syPx + sz / 2));
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
