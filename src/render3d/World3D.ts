import * as THREE from "three";
import { TileKind, UNOWNED } from "../game/types";
import type { GameState } from "../game/state";

// Accept HMR silently — same policy as the 2D renderer: no full reload on
// save so editing mid-session doesn't restart the world.
if (import.meta.hot) import.meta.hot.accept();

/**
 * A real WebGL 3D view of the live game world.
 *
 * The 2D game is a top-down chunked canvas renderer. This class takes the
 * SAME game state and lifts it into three dimensions: the world is sampled
 * onto a heightmap terrain mesh whose elevation comes from tile kind +
 * mountain density (oceans dip below sea level, mountains rise into ridges),
 * each vertex is coloured with the biome/ocean palette and tinted by the
 * owning tribe's colour, a translucent water plane sits at sea level, and
 * every built structure becomes a little 3D block standing on the terrain.
 *
 * It owns its own canvas + orbit camera; App toggles it on/off and calls
 * render() from the main rAF loop. The terrain geometry is built once; only
 * the vertex COLOURS + structure blocks refresh periodically so expanding
 * kingdoms stay current without re-uploading positions every frame.
 */

// ── Palette (mirrors src/render/renderer.ts so 3D reads like the 2D map) ──
const OCEAN_SHALLOW: RGB = [92, 165, 192];
const OCEAN_MEDIUM: RGB = [40, 96, 142];
const OCEAN_DEEP: RGB = [12, 32, 60];
const SAND: RGB = [224, 204, 144];
const C_MOUNTAIN: RGB = [96, 88, 80];
const C_SNOW: RGB = [232, 236, 240];
const C_ICE: RGB = [206, 222, 234];
const C_HOLE: RGB = [70, 50, 32];
// Cold → hot, matching the 2D BIOMES table (Desert outer / Badlands core).
const BIOMES: RGB[] = [
  [62, 110, 92],   // Taiga
  [148, 178, 108], // Birch
  [54, 104, 60],   // Forest
  [216, 196, 130], // Desert
  [168, 110, 78],  // Badlands
];
const BIOME_STOPS = [0, 28, 88, 180, 220, 256];

type RGB = [number, number, number];

// ── Mesh dimensions. The map is laid out on a MESH_W × MESH_D plane centred
// on the origin; vertical relief is exaggerated by VSCALE so ridges read
// clearly against the map's footprint. ──
const MESH_W = 200;
const VSCALE = 0.82;
// Terrain sampling grid. ~0.77 world-units per cell → square cells, ~34k
// verts for the default 7000×3500 world: plenty of relief, trivial for WebGL.
const GRID_COLS = 260;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export class World3DView {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private terrain: THREE.Mesh | null = null;
  private terrainGeo: THREE.BufferGeometry | null = null;
  private water: THREE.Mesh | null = null;
  private structureGroup: THREE.Group = new THREE.Group();
  private structureGeo = new THREE.BoxGeometry(1.7, 1, 1.7);
  // Villagers as instanced cones (one draw call), coloured per tribe and
  // updated every frame so the world visibly moves in 3D.
  private villagerGeo = new THREE.ConeGeometry(0.5, 1.7, 6);
  private villagerMesh!: THREE.InstancedMesh;
  // Trees from world.props (sprite tree_*), instanced conifer cones tinted
  // by species. This is what turns the terrain into the game's forested world.
  private treeGeo = new THREE.ConeGeometry(0.6, 2.4, 6);
  private treeMesh!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private static readonly MAX_VILLAGERS = 4000;
  private static readonly MAX_TREES = 32000;
  /** Smoothed per-vertex terrain height (mesh units) — the surface props,
   *  villagers, and structures are placed on via bilinear lookup. */
  private heightGrid: Float32Array | null = null;

  // Orbit camera state (spherical around `target`).
  private target = new THREE.Vector3(0, 1.5, 0);
  private radius = 190;
  private theta = 0.7;   // azimuth
  private phi = 0.92;    // polar angle from +Y
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private userInteracted = false;

  private meshD = 100;
  private gridRows = 130;
  private lastColorRefresh = 0;
  private disposed = false;

  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(0x8fbce6, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fbce6);
    this.scene.fog = new THREE.Fog(0x8fbce6, 210, 560);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 3000);

    // Sun + sky/ground fill so ridges catch light and valleys stay legible.
    const hemi = new THREE.HemisphereLight(0xcfe4fb, 0x40381f, 0.95);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
    sun.position.set(-120, 180, 90);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.35);
    fill.position.set(140, 80, -120);
    this.scene.add(fill);

    this.scene.add(this.structureGroup);

    const vmat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    this.villagerMesh = new THREE.InstancedMesh(this.villagerGeo, vmat, World3DView.MAX_VILLAGERS);
    this.villagerMesh.count = 0;
    this.villagerMesh.frustumCulled = false;
    this.scene.add(this.villagerMesh);

    const tmat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0, flatShading: true });
    this.treeMesh = new THREE.InstancedMesh(this.treeGeo, tmat, World3DView.MAX_TREES);
    this.treeMesh.count = 0;
    this.treeMesh.frustumCulled = false;
    this.scene.add(this.treeMesh);

    // Orbit controls — lightweight, self-contained (no OrbitControls import).
    this.onPointerDown = (e) => {
      this.dragging = true;
      this.userInteracted = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    };
    this.onPointerMove = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.theta -= dx * 0.005;
      this.phi = Math.max(0.16, Math.min(1.45, this.phi - dy * 0.005));
    };
    this.onPointerUp = () => { this.dragging = false; };
    this.onWheel = (e) => {
      e.preventDefault();
      this.userInteracted = true;
      this.radius = Math.max(45, Math.min(560, this.radius * (1 + e.deltaY * 0.0012)));
    };
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  setSize(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** Sample one terrain column: returns elevation (world-units, pre-VSCALE)
   *  and RGB colour (0..255). Mirrors the 2D renderer's palette choices. */
  private sample(state: GameState, tx: number, ty: number, out: RGB): number {
    const w = state.world;
    const idx = ty * w.width + tx;
    const kind = w.kind[idx];
    const owner = w.owner[idx];
    let h: number;
    let ownable = false;

    if (kind === TileKind.Sea) {
      const d = Math.min(w.coastDist[idx], 160) / 160;
      h = -(1.2 + d * 7.5);
      if (w.coastDist[idx] <= 8) { out[0] = OCEAN_SHALLOW[0]; out[1] = OCEAN_SHALLOW[1]; out[2] = OCEAN_SHALLOW[2]; }
      else if (w.coastDist[idx] <= 60) mix(OCEAN_SHALLOW, OCEAN_MEDIUM, (w.coastDist[idx] - 8) / 52, out);
      else if (w.coastDist[idx] <= 140) mix(OCEAN_MEDIUM, OCEAN_DEEP, (w.coastDist[idx] - 60) / 80, out);
      else { out[0] = OCEAN_DEEP[0]; out[1] = OCEAN_DEEP[1]; out[2] = OCEAN_DEEP[2]; }
    } else if (kind === TileKind.Ice) {
      h = 0.4; out[0] = C_ICE[0]; out[1] = C_ICE[1]; out[2] = C_ICE[2];
    } else if (kind === TileKind.Mountain) {
      const md = w.mountainDensity[idx] / 255;
      h = 7 + md * 16;
      out[0] = C_MOUNTAIN[0]; out[1] = C_MOUNTAIN[1]; out[2] = C_MOUNTAIN[2];
    } else if (kind === TileKind.Snow) {
      const md = w.mountainDensity[idx] / 255;
      h = 6 + md * 14;
      out[0] = C_SNOW[0]; out[1] = C_SNOW[1]; out[2] = C_SNOW[2];
    } else if (kind === TileKind.Hole) {
      h = -0.5 - Math.min(w.holeDepth[idx], 8) * 0.5;
      out[0] = C_HOLE[0]; out[1] = C_HOLE[1]; out[2] = C_HOLE[2];
    } else {
      // Land / Forest / Bush.
      const md = w.mountainDensity[idx] / 255;
      h = 1.0 + md * 6;
      ownable = true;
      if (w.coastDist[idx] <= 4) {
        out[0] = SAND[0]; out[1] = SAND[1]; out[2] = SAND[2];
      } else {
        biomeColor(w.heat[idx], out);
        if (kind === TileKind.Forest) mix(out, BIOMES[2], 0.4, out);
      }
    }

    // Owner tint — colour the terrain by tribe so kingdoms read in 3D.
    if (ownable && owner !== UNOWNED && state.players[owner]) {
      const rgb = state.players[owner].colorRgb;
      const pr = (rgb >> 16) & 0xff, pg = (rgb >> 8) & 0xff, pb = rgb & 0xff;
      out[0] = out[0] * 0.45 + pr * 0.55;
      out[1] = out[1] * 0.45 + pg * 0.55;
      out[2] = out[2] * 0.45 + pb * 0.55;
    }
    return h;
  }

  /** Area-average a grid cell instead of point-sampling one tile. Each mesh
   *  cell covers ~27×27 world tiles; a lone Mountain tile among Land tiles
   *  would otherwise spike into a needle. Averaging a STEPS×STEPS subgrid
   *  is a mip-map downsample — isolated peaks melt into gentle bumps while
   *  dense ranges stay tall, and territory/biome colours blend at edges. */
  private sampleRegion(
    state: GameState, txC: number, tyC: number, halfX: number, halfY: number, out: RGB,
  ): number {
    const w = state.world;
    const STEPS = 4;
    const tmp: RGB = [0, 0, 0];
    let hSum = 0, r = 0, g = 0, b = 0, n = 0;
    for (let a = 0; a < STEPS; a++) {
      const fx = a / (STEPS - 1);
      const tx = Math.max(0, Math.min(w.width - 1, Math.round(txC + (fx - 0.5) * 2 * halfX)));
      for (let bStep = 0; bStep < STEPS; bStep++) {
        const fy = bStep / (STEPS - 1);
        const ty = Math.max(0, Math.min(w.height - 1, Math.round(tyC + (fy - 0.5) * 2 * halfY)));
        hSum += this.sample(state, tx, ty, tmp);
        r += tmp[0]; g += tmp[1]; b += tmp[2]; n++;
      }
    }
    out[0] = r / n; out[1] = g / n; out[2] = b / n;
    return hSum / n;
  }

  /** Build (or rebuild) the whole scene from the given state. */
  build(state: GameState): void {
    const w = state.world;
    const cols = GRID_COLS;
    const rows = Math.max(2, Math.round(GRID_COLS * (w.height / w.width)));
    this.gridRows = rows;
    this.meshD = MESH_W * (w.height / w.width);

    const positions = new Float32Array(cols * rows * 3);
    const colors = new Float32Array(cols * rows * 3);
    const rgb: RGB = [0, 0, 0];

    const halfX = w.width / (cols - 1) / 2;
    const halfY = w.height / (rows - 1) / 2;
    for (let j = 0; j < rows; j++) {
      const tv = j / (rows - 1);
      const tyC = tv * (w.height - 1);
      const z = (tv - 0.5) * this.meshD;
      for (let i = 0; i < cols; i++) {
        const tu = i / (cols - 1);
        const txC = tu * (w.width - 1);
        const h = this.sampleRegion(state, txC, tyC, halfX, halfY, rgb);
        const vi = (j * cols + i) * 3;
        positions[vi] = (tu - 0.5) * MESH_W;
        positions[vi + 1] = h * VSCALE;
        positions[vi + 2] = z;
        colors[vi] = rgb[0] / 255;
        colors[vi + 1] = rgb[1] / 255;
        colors[vi + 2] = rgb[2] / 255;
      }
    }

    // Tame isolated needle peaks that survive the area-average: blend each
    // land vertex's height toward its neighbours. Two gentle passes round the
    // ridges without flattening broad mountain ranges (a lone spike has low
    // neighbours pulling it down hard; a range's neighbours are also high).
    this.smoothHeights(positions, cols, rows, 2);

    // Cache the smoothed surface so props/units sit exactly on the terrain.
    const heightGrid = new Float32Array(cols * rows);
    for (let k = 0; k < cols * rows; k++) heightGrid[k] = positions[k * 3 + 1];
    this.heightGrid = heightGrid;

    const indices: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    if (this.terrainGeo) this.terrainGeo.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.terrainGeo = geo;

    if (!this.terrain) {
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0.0, flatShading: false,
      });
      this.terrain = new THREE.Mesh(geo, mat);
      this.scene.add(this.terrain);
    } else {
      this.terrain.geometry = geo;
    }

    // Water plane at sea level (y = 0).
    if (!this.water) {
      const wmat = new THREE.MeshStandardMaterial({
        color: 0x2f6ea6, transparent: true, opacity: 0.72,
        roughness: 0.25, metalness: 0.2,
      });
      this.water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wmat);
      this.water.rotation.x = -Math.PI / 2;
      this.scene.add(this.water);
    }
    this.water.scale.set(MESH_W * 1.02, this.meshD * 1.02, 1);
    this.water.position.y = 0;

    this.buildStructures(state);
    this.buildTrees(state);
    // Frame the map with the camera's default angle.
    this.radius = MESH_W * 0.95;
  }

  /** Blur the vertex heightfield in place — `passes` gentle 5-tap averages.
   *  Uses a scratch copy per pass so the smoothing is symmetric (no bias
   *  from reading already-updated neighbours). */
  private smoothHeights(positions: Float32Array, cols: number, rows: number, passes: number): void {
    const src = new Float32Array(cols * rows);
    for (let p = 0; p < passes; p++) {
      for (let k = 0; k < cols * rows; k++) src[k] = positions[k * 3 + 1];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          let sum = src[idx], cnt = 1;
          if (i > 0) { sum += src[idx - 1]; cnt++; }
          if (i < cols - 1) { sum += src[idx + 1]; cnt++; }
          if (j > 0) { sum += src[idx - cols]; cnt++; }
          if (j < rows - 1) { sum += src[idx + cols]; cnt++; }
          // 55% neighbourhood mean, 45% original — keeps ranges, kills spikes.
          positions[idx * 3 + 1] = src[idx] * 0.45 + (sum / cnt) * 0.55;
        }
      }
    }
  }

  /** Bilinear terrain height (mesh units) at normalized world coords u,v in
   *  [0,1]. Props, villagers, and structures sit on this smoothed surface. */
  private meshHeightAt(u: number, v: number): number {
    const grid = this.heightGrid;
    if (!grid) return 0;
    const cols = GRID_COLS, rows = this.gridRows;
    const fx = Math.max(0, Math.min(cols - 1, u * (cols - 1)));
    const fy = Math.max(0, Math.min(rows - 1, v * (rows - 1)));
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
    const tx = fx - i0, ty = fy - j0;
    const a = grid[j0 * cols + i0] * (1 - tx) + grid[j0 * cols + i1] * tx;
    const b = grid[j1 * cols + i0] * (1 - tx) + grid[j1 * cols + i1] * tx;
    return a * (1 - ty) + b * ty;
  }

  /** Rebuild the structure blocks from state.structures. */
  private buildStructures(state: GameState): void {
    const w = state.world;
    // Dispose per-block materials (each carries its own tribe colour); the
    // box geometry is shared and lives for the view's lifetime.
    for (const child of this.structureGroup.children) {
      ((child as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.structureGroup.clear();
    const structures = state.structures ?? [];
    for (const s of structures) {
      const terrainH = this.meshHeightAt(s.x / w.width, s.y / w.height);
      const px = (s.x / w.width - 0.5) * MESH_W;
      const pz = (s.y / w.height - 0.5) * this.meshD;
      const player = state.players[s.ownerId];
      const col = player ? player.colorRgb : 0xdddddd;
      const mat = new THREE.MeshStandardMaterial({
        color: col, roughness: 0.7, metalness: 0.05,
        emissive: new THREE.Color(col).multiplyScalar(0.15),
      });
      const box = new THREE.Mesh(this.structureGeo, mat);
      const height = 1.4 + Math.min(4, (s.size || 1) * 0.5);
      box.scale.y = height;
      box.position.set(px, Math.max(0.2, terrainH) + height / 2, pz);
      this.structureGroup.add(box);
    }
  }

  /** (Re)build the forest: every live tree prop becomes an instanced cone,
   *  tinted by species. Harvested trees are skipped so clear-cut patches
   *  open up in 3D; if a world has more trees than MAX_TREES we stride-
   *  sample so the draw stays a single instanced call. */
  private buildTrees(state: GameState): void {
    const w = state.world;
    const props = w.props ?? [];
    const harvested = state.harvestedProps;
    const dummy = this.dummy, col = this.tmpColor;
    let total = 0;
    for (let i = 0; i < props.length; i++) {
      if (props[i].sprite.startsWith("tree_")) total++;
    }
    const stride = Math.max(1, Math.ceil(total / World3DView.MAX_TREES));
    let n = 0, seen = 0;
    for (let i = 0; i < props.length && n < World3DView.MAX_TREES; i++) {
      const pr = props[i];
      if (!pr.sprite.startsWith("tree_")) continue;
      if (harvested && harvested.has(i)) continue;
      if (++seen % stride !== 0) continue;
      const u = pr.x / w.width, v = pr.y / w.height;
      const y = this.meshHeightAt(u, v);
      const px = (u - 0.5) * MESH_W;
      const pz = (v - 0.5) * this.meshD;
      const th = 1.5 + Math.min(1.6, (pr.size || 12) * 0.06); // canopy height
      dummy.position.set(px, Math.max(0.25, y) + th / 2, pz);
      dummy.scale.set(1, th / 2.4, 1); // base cone geo is 2.4 tall
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      this.treeMesh.setMatrixAt(n, dummy.matrix);
      if (pr.sprite.startsWith("tree_taiga")) col.setRGB(0.15, 0.33, 0.29);
      else if (pr.sprite.startsWith("tree_birch")) col.setRGB(0.44, 0.62, 0.32);
      else col.setRGB(0.19, 0.42, 0.22);
      this.treeMesh.setColorAt(n, col);
      n++;
    }
    this.treeMesh.count = n;
    this.treeMesh.instanceMatrix.needsUpdate = true;
    if (this.treeMesh.instanceColor) this.treeMesh.instanceColor.needsUpdate = true;
  }

  /** Re-sample vertex colours in place (kingdoms expand between rebuilds). */
  private refreshColors(state: GameState): void {
    if (!this.terrainGeo) return;
    const w = state.world;
    const cols = GRID_COLS;
    const rows = this.gridRows;
    const attr = this.terrainGeo.getAttribute("color") as THREE.BufferAttribute;
    const colors = attr.array as Float32Array;
    const rgb: RGB = [0, 0, 0];
    const halfX = w.width / (cols - 1) / 2;
    const halfY = w.height / (rows - 1) / 2;
    for (let j = 0; j < rows; j++) {
      const tyC = (j / (rows - 1)) * (w.height - 1);
      for (let i = 0; i < cols; i++) {
        const txC = (i / (cols - 1)) * (w.width - 1);
        this.sampleRegion(state, txC, tyC, halfX, halfY, rgb);
        const vi = (j * cols + i) * 3;
        colors[vi] = rgb[0] / 255;
        colors[vi + 1] = rgb[1] / 255;
        colors[vi + 2] = rgb[2] / 255;
      }
    }
    attr.needsUpdate = true;
    this.buildStructures(state);
    this.buildTrees(state);
  }

  /** Push live villager positions into the instanced cone mesh. Cheap enough
   *  (one bilinear height lookup per villager) to run every frame, so units
   *  glide across the terrain as the simulation ticks underneath. Boarded
   *  villagers (inside a structure) are skipped. */
  private updateVillagers(state: GameState): void {
    const w = state.world;
    const villagers = state.villagers ?? [];
    let n = 0;
    for (let i = 0; i < villagers.length && n < World3DView.MAX_VILLAGERS; i++) {
      const v = villagers[i];
      if (v.insideStructureId != null) continue;
      const terrainH = this.meshHeightAt(v.x / w.width, v.y / w.height);
      const px = (v.x / w.width - 0.5) * MESH_W;
      const pz = (v.y / w.height - 0.5) * this.meshD;
      this.dummy.position.set(px, Math.max(0.3, terrainH) + 0.85, pz);
      this.dummy.scale.set(1, 1, 1); // shared dummy — reset (buildTrees scales y)
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.villagerMesh.setMatrixAt(n, this.dummy.matrix);
      const p = state.players[v.ownerId];
      this.tmpColor.set(p ? p.colorRgb : 0xffffff);
      this.villagerMesh.setColorAt(n, this.tmpColor);
      n++;
    }
    this.villagerMesh.count = n;
    this.villagerMesh.instanceMatrix.needsUpdate = true;
    if (this.villagerMesh.instanceColor) this.villagerMesh.instanceColor.needsUpdate = true;
  }

  render(state: GameState, now: number): void {
    if (this.disposed) return;
    if (!this.terrain) this.build(state);

    // Periodically refresh territory colours + structures (throttled).
    if (now - this.lastColorRefresh > 1500) {
      this.refreshColors(state);
      this.lastColorRefresh = now;
    }
    // Villager markers move every frame with the live simulation.
    this.updateVillagers(state);

    // Gentle auto-orbit until the user grabs the camera — makes the 3D
    // relief obvious at a glance (and gives a lively first screenshot).
    if (!this.userInteracted) this.theta += 0.0016;

    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sinPhi * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sinPhi * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.terrainGeo?.dispose();
    this.structureGeo.dispose();
    this.villagerGeo.dispose();
    this.treeGeo.dispose();
    this.renderer.dispose();
  }
}

/** Mix two RGB colours (0..255) into `out` by t in [0,1]. */
function mix(a: RGB, b: RGB, t: number, out: RGB): void {
  const s = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = lerp(a[0], b[0], s);
  out[1] = lerp(a[1], b[1], s);
  out[2] = lerp(a[2], b[2], s);
}

/** Continuous biome colour for a heat value 0..255 (matches renderer.ts). */
function biomeColor(heat: number, out: RGB): void {
  let i0 = 0;
  for (let i = 0; i < 5; i++) {
    if (heat < BIOME_STOPS[i + 1]) { i0 = i; break; }
    i0 = i;
  }
  const lo = BIOME_STOPS[i0];
  const hi = BIOME_STOPS[i0 + 1];
  const t = hi > lo ? (heat - lo) / (hi - lo) : 0;
  const i1 = i0 < 4 ? i0 + 1 : 4;
  mix(BIOMES[i0], BIOMES[i1], smooth(t), out);
}
