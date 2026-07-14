import { feature } from "topojson-client";
import { geoPath, geoEquirectangular } from "d3-geo";
import { TileKind, UNOWNED, isOwnable, type World, type WorldProp } from "./types";
import { rand, seedRng, freshWorldSeed } from "./rng";

// Accept HMR silently — no full reload on file save, so editing mid-gen
// doesn't restart the world build. Manual refresh applies real changes.
if (import.meta.hot) import.meta.hot.accept();

/**
 * Pipeline:
 *   1. Rasterize continent geometry (equirectangular).
 *   2. Blur the binary mask + threshold against high-freq coast noise so
 *      shorelines are jagged at close zoom.
 *   3. Carve rivers via particle simulation (smooth meanders, not boxy).
 *   4. Assign mountains / snow / ice based on elevation + latitude.
 *   5. Assign Voronoi biome cells (4 biomes) to ownable Land tiles.
 */
export async function buildWorld(width: number, height: number, worldSeed?: number): Promise<World> {
  if (width !== height * 2) {
    throw new Error(`Equirectangular world must be 2:1 (got ${width}x${height})`);
  }
  // Seed the module-global RNG so worldgen is deterministic per session
  // (and matches across a reload that supplies the same `worldSeed`).
  // Any callers that didn't pass a seed get a fresh random one — saved
  // sessions pass the seed they stored.
  const seed = (worldSeed === undefined || worldSeed === 0) ? freshWorldSeed() : worldSeed;
  seedRng(seed);
  // Stash the seed onto the resulting `World` so the caller can persist
  // it without having to thread it through createGame's signature.
  const _usedSeed = seed;

  const res = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json");
  if (!res.ok) throw new Error("Failed to fetch world map data");
  const topo = (await res.json()) as any;
  const land = feature(topo, topo.objects.land);

  // --- Step 1: Rasterize land polygons. ---
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true })!;
  baseCtx.fillStyle = "#000000";
  baseCtx.fillRect(0, 0, width, height);
  const scale = width / (2 * Math.PI);
  const projection = geoEquirectangular().scale(scale).translate([width / 2, height / 2]);
  const path = geoPath(projection, baseCtx);
  baseCtx.fillStyle = "#ffffff";
  baseCtx.beginPath();
  path(land as any);
  baseCtx.fill();

  // --- Step 2: Blur the mask, then noise-threshold for jagged coasts. ---
  const blurCanvas = document.createElement("canvas");
  blurCanvas.width = width;
  blurCanvas.height = height;
  const blurCtx = blurCanvas.getContext("2d", { willReadFrequently: true })!;
  blurCtx.filter = "blur(5px)";
  blurCtx.drawImage(baseCanvas, 0, 0);
  blurCtx.filter = "none";
  const img = blurCtx.getImageData(0, 0, width, height).data;

  const elevNoise = makeNoise(1337);
  const coastNoise = makeNoise(4242);

  function elevationAt(x: number, y: number): number {
    const v = y / height;
    const latRad = (1 - 2 * v) * (Math.PI / 2);
    const lonStretch = Math.max(0.3, Math.cos(latRad));
    const nx = (x / width) * 9 * lonStretch;
    const ny = v * 5;
    return fbm(elevNoise, nx, ny, 9);
  }

  const kind = new Uint8Array(width * height);
  for (let i = 0; i < kind.length; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const baseLandness = img[i * 4] / 255;
    const coastFine = fbm(coastNoise, x * 0.20, y * 0.20, 7);
    const coastBroad = fbm(coastNoise, x * 0.05 + 91, y * 0.05 + 91, 6);
    const perturb = (coastFine - 0.5) * 0.55 + (coastBroad - 0.5) * 0.25;
    kind[i] = baseLandness + perturb > 0.5 ? TileKind.Land : TileKind.Sea;
  }

  // --- Step 3: Particle-based rivers. ---
  // Tile-keyed mask: 1 where a river was carved through what used to be
  // land. Pathing uses this to let villagers ford rivers but not open sea.
  const riverMask = new Uint8Array(width * height);
  carveParticleRivers(kind, width, height, elevationAt, riverMask);
  // Smooth riverbanks: two passes of a majority filter that erode isolated
  // 1-tile land bumps poking into water. Removes the sharp zig-zag artefacts
  // produced by per-step widening.
  smoothShoreline(kind, width, height, 2);

  // --- Step 4.4: Continental plates + triple-junction islands. ---
  // Sprinkle N plate seeds at random across the world. Conceptually these
  // partition the map into Voronoi cells; we only need the cells' vertices,
  // i.e. the points where three cells meet (triple junctions of the
  // Voronoi diagram). Each candidate vertex is the circumcenter of three
  // seeds, validated as a real Voronoi vertex by checking that no fourth
  // seed is closer to it than those three. Junctions whose pixel falls in
  // open water become spawn points for a procedurally-shaped island —
  // small landmasses that didn't exist in the continent rasterizer, sitting
  // out in the deep where plate boundaries "collide". Each spawned island
  // has a 1-in-10 chance of also receiving an inactive volcano prop at its
  // centre — these are appended to the final props list below.
  const volcanoProps = carvePlateIslands(kind, width, height);

  // --- Step 4.5: Distance-to-coast field (chamfer Manhattan distance). ---
  // Used for shore shading + heat falloff into the interior.
  const coastDist = computeCoastDistance(kind, width, height);

  // (Mountain pass moved to Step 5.5 — after heat is computed so we can
  // filter by forest-biome band.)

  // --- Step 4.55 (placeholder field). ---
  // Subtle Sea-only channels carved through the deep seabed. Renderer paints
  // these with the shallow texture so they read as light ribbons winding
  // through the dark deep.
  // Underwater channels removed — keep a zero-filled array for compatibility
  // with the World shape so the renderer can still read it.
  const seaChannel = new Uint8Array(width * height);

  // --- Step 4.6: Ocean-floor heightmap (Voronoi × FBM noise). ---
  // The Voronoi component gives broad seabed cells / ridges / basins; the
  // noise component breaks up the cell shapes and adds finer detail. Used
  // by the renderer to vary brightness within each depth band so the sea
  // floor has hills and trenches rather than being flat.
  const oceanHeight = new Uint8Array(width * height);
  const voronoi = makeWorleyF1(13579, 90);
  const seabedNoise = makeNoise(31415);
  // Per-Sea-tile jitter added to coastDist before depth-band selection. Two
  // FBM octaves at different frequencies are combined so the resulting
  // band edges have both broad meanders (low freq) AND fine fringing
  // (high freq), masking the diamond iso-curves of the underlying
  // chamfer Manhattan distance. Magnitude ~±40 — large enough to fully
  // break the 50-tile-wide shallow→medium transition, leaving no straight
  // band edges visible at any zoom.
  const oceanDistJitter = new Int8Array(width * height);
  const jitterNoiseLo = makeNoise(60606);
  const jitterNoiseHi = makeNoise(60607);
  for (let i = 0; i < oceanHeight.length; i++) {
    if (kind[i] !== TileKind.Sea) continue;
    const x = i % width;
    const y = (i / width) | 0;
    const v = voronoi(x, y);                 // 0..1, F1 distance from nearest seed
    const n = fbm(seabedNoise, x * 0.02, y * 0.02, 5); // 0..1
    const h = v * n;                          // multiply: cellular × organic
    let q = (h * 280) | 0;                    // mild gain so mid values aren't all dark
    if (q > 255) q = 255;
    oceanHeight[i] = q;

    // Combined jitter: 0.7 weight on broad meanders, 0.3 on fine fringe.
    const lo = fbm(jitterNoiseLo, x * 0.008, y * 0.008, 4) - 0.5;
    const hi = fbm(jitterNoiseHi, x * 0.035, y * 0.035, 3) - 0.5;
    let j = (lo * 0.7 + hi * 0.3) * 80; // 80 = 2 × peak amplitude (±40)
    if (j > 40) j = 40; else if (j < -40) j = -40;
    oceanDistJitter[i] = j | 0;
  }

  // --- Step 5: Continuous biome heatmap (smooth FBM + histogram equalization). ---
  // Raw FBM output is gaussian-ish (clusters around 0.5), which makes the two
  // middle biomes dominate. We equalize the per-land histogram so all four
  // biomes get ~25% of the area.
  const heat = new Uint8Array(width * height);
  const heatNoise = makeNoise(20251);
  for (let i = 0; i < heat.length; i++) {
    if (kind[i] !== TileKind.Land) {
      heat[i] = 0;
      continue;
    }
    const x = i % width;
    const y = (i / width) | 0;
    // X frequency divided by 1.75 → horizontal features are 1.75× wider than vertical.
    const raw = fbm(heatNoise, x * (0.0048 / 1.75), y * 0.0048, 7);
    heat[i] = Math.max(0, Math.min(255, (raw * 255) | 0));
  }
  // Histogram-equalize so every biome band ends up with the same area.
  // Build CDF over land tiles only, then remap each tile's heat by its
  // percentile rank.
  const histogram = new Uint32Array(256);
  let landCount = 0;
  for (let i = 0; i < heat.length; i++) {
    if (kind[i] === TileKind.Land) {
      histogram[heat[i]]++;
      landCount++;
    }
  }
  if (landCount > 0) {
    const cdf = new Uint8Array(256);
    let cumulative = 0;
    for (let v = 0; v < 256; v++) {
      cumulative += histogram[v];
      cdf[v] = Math.min(255, Math.floor((cumulative / landCount) * 255));
    }
    for (let i = 0; i < heat.length; i++) {
      if (kind[i] === TileKind.Land) heat[i] = cdf[heat[i]];
    }
  }

  // Heat biases on top of the equalised noise:
  //   1. Equator hot, poles cold (broad gradient).
  //   2. A boost peaked at the tropics (lat ≈ 0.26 = ~23.5°) so desert
  //      forms there.
  //   3. Inland = drier (higher heat → Badlands/Desert), coasts = greener
  //      (lower heat → Forest/Birch).
  // Heat biases dialled WAY down so the world stays mostly green/humid —
  // smaller equator-to-pole gradient, a much smaller tropic spike, and a
  // gentle inland dryness instead of pushing every interior into desert.
  const TEMP_STRENGTH = 45;
  const TROPIC_LAT = 0.26;
  const TROPIC_PEAK = 25;
  const TROPIC_WIDTH = 180;
  const INLAND_MAX = 20;
  const INLAND_PER_TILE = 0.12;
  for (let i = 0; i < heat.length; i++) {
    if (kind[i] !== TileKind.Land) continue;
    const y = (i / width) | 0;
    const lat = Math.abs(1 - 2 * (y / height)); // 0 at equator, 1 at pole

    // 1) Equator-to-pole gradient.
    let bias = (0.5 - lat) * 2 * TEMP_STRENGTH;

    // 2) Tropic boost — bell-curve peaked at TROPIC_LAT.
    const tropicDist = Math.abs(lat - TROPIC_LAT);
    bias += Math.max(0, TROPIC_PEAK - tropicDist * TROPIC_WIDTH);

    // 3) Inland → drier. Distance-from-coast pushes heat up.
    bias += Math.min(INLAND_MAX, coastDist[i] * INLAND_PER_TILE);

    const v = heat[i] + bias;
    heat[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }

  // --- Step 5.4: Random "no grass" patch. ---
  // With NO_GRASS_CHANCE probability, push a vulcano-island-sized region
  // of heat into the badlands band so the renderer paints it as bare
  // rock with no green. Runs BEFORE mountains so mountains can't form
  // inside the patch (mountain pass requires forest-band heat). The
  // membership uses the same FBM-perturbed radial mask as carveIsland to
  // keep the patch outline organic, and blends the heat toward the target
  // proportional to distance from the edge so the border isn't a hard ring.
  const NO_GRASS_CHANCE = 0.5;
  if (rand() < NO_GRASS_CHANCE) {
    let cx = -1;
    let cy = -1;
    for (let tries = 0; tries < 200; tries++) {
      const rx = (rand() * width) | 0;
      const ry = (rand() * height) | 0;
      if (kind[ry * width + rx] === TileKind.Land) { cx = rx; cy = ry; break; }
    }
    if (cx >= 0) {
      const baseR = 40 + rand() * 50;     // matches ISLAND_R range
      const radius = baseR * 7;                  // vulcano-island-sized
      const maxR = Math.ceil(radius * 1.35);
      const patchNoise = makeNoise(54321);
      const targetHeat = 235;                    // mid-badlands → rocky / no grass
      for (let dy = -maxR; dy <= maxR; dy++) {
        const ty = cy + dy;
        if (ty < 0 || ty >= height) continue;
        for (let dx = -maxR; dx <= maxR; dx++) {
          const tx = cx + dx;
          if (tx < 0 || tx >= width) continue;
          const idx = ty * width + tx;
          if (kind[idx] !== TileKind.Land) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const n = fbm(patchNoise, tx * 0.04, ty * 0.04, 4);
          const threshold = radius * (0.50 + n * 0.75);
          if (d >= threshold) continue;
          // Smooth fade near the edge so the boundary dissolves into
          // the surrounding biome rather than forming a hard ring.
          const fade = Math.min(1, (threshold - d) / 30);
          const t = fade * fade * (3 - 2 * fade);
          heat[idx] = (heat[idx] * (1 - t) + targetHeat * t) | 0;
        }
      }
    }
  }

  // --- Step 5.5: Mountains (density field). ---
  // Mountains only form where ALL of the following are true:
  //   - Tile is land at least 8 from the coast.
  //   - Latitude is mid-range — "top end of a continent" — between 0.30 and 0.65.
  //   - Heat is in the Forest band (after biases).
  //   - A mid-frequency noise field is above threshold.
  // The noise gives a continuous density 0..255 per tile. Tiles with
  // density > 128 become impassable Mountain; tiles with 0..128 stay Land
  // but the renderer fades the mountain texture in by `density / 128`, so
  // the range edges smoothly dissolve into the surrounding biome.
  const mountainDensity = new Uint8Array(width * height);
  const mountainNoise = makeNoise(75319);
  const MOUNT_LAT_MIN = 0.30;
  const MOUNT_LAT_MAX = 0.65;
  const MOUNT_HEAT_MIN = 100;
  const MOUNT_HEAT_MAX = 160;
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] !== TileKind.Land) continue;
    if (coastDist[i] < 8) continue;
    const y = (i / width) | 0;
    const lat = Math.abs(1 - 2 * (y / height));
    if (lat < MOUNT_LAT_MIN || lat > MOUNT_LAT_MAX) continue;
    const h = heat[i];
    if (h < MOUNT_HEAT_MIN || h > MOUNT_HEAT_MAX) continue;
    const x = i % width;
    // Frequency 0.025 → noise feature size ~40 tiles → patches under ~100 px.
    const n = fbm(mountainNoise, x * 0.025, y * 0.025, 3);
    // Density curve: 0 below 0.40, 1 above 0.80, smooth in between.
    let d = (n - 0.40) / 0.40;
    if (d < 0) d = 0;
    else if (d > 1) d = 1;
    mountainDensity[i] = (d * 255) | 0;
    if (d > 0.5) kind[i] = TileKind.Mountain;
  }

  // Polar Snow biome.
  //
  // Identify any landmass that touches the top or bottom edge of the map
  // (i.e. extends to a pole) via flood-fill. Tiles in such a landmass become
  // snow according to latitude:
  //   - Inside the Arctic Circle (|lat| > ARCTIC_LAT): fully snow.
  //   - Outside the Arctic Circle: probabilistic snow patches whose density
  //     falls off (quadratically) the further from the pole you go. Patch
  //     shapes come from a mid-frequency FBM noise so the snow line is
  //     visibly broken up rather than a clean band.
  // Arctic Circle bumped ~3 Germanys higher: full-snow threshold moves from
  // lat 0.70 → 0.93, and a new FALLOFF_START at lat 0.60 means the patchy
  // band sits roughly between 0.60 and 0.93 — closer to the actual polar cap.
  const ARCTIC_LAT = 0.93;
  const FALLOFF_START = 0.60;
  const polarMass = new Uint8Array(width * height);
  const stack: number[] = [];
  // Seed flood-fill from every land tile inside the Arctic / Antarctic Circle
  // (|lat| > ARCTIC_LAT) — not just tiles literally touching the top or
  // bottom row of the map. Otherwise high-arctic islands like Greenland
  // (which doesn't reach y=0) get missed.
  for (let i = 0; i < kind.length; i++) {
    if (polarMass[i]) continue;
    if (!isOwnable(kind[i])) continue;
    const y = (i / width) | 0;
    const lat = Math.abs(1 - 2 * (y / height));
    if (lat > ARCTIC_LAT) {
      polarMass[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const x = idx % width;
    const y = (idx / width) | 0;
    const candidates: number[] = [];
    if (x > 0) candidates.push(idx - 1);
    if (x < width - 1) candidates.push(idx + 1);
    if (y > 0) candidates.push(idx - width);
    if (y < height - 1) candidates.push(idx + width);
    for (const nIdx of candidates) {
      if (polarMass[nIdx]) continue;
      if (!isOwnable(kind[nIdx])) continue;
      polarMass[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  const snowPatchNoise = makeNoise(11211);
  for (let i = 0; i < kind.length; i++) {
    if (!polarMass[i]) continue;
    if (!isOwnable(kind[i])) continue;
    const y = (i / width) | 0;
    const lat = Math.abs(1 - 2 * (y / height));
    if (lat > ARCTIC_LAT) {
      kind[i] = TileKind.Snow;
    } else if (lat > FALLOFF_START) {
      // Patchy falloff between FALLOFF_START and ARCTIC_LAT. Quadratic density
      // → snow line at the lower edge is sparse, gets dense approaching the
      // full-snow threshold.
      const t = (lat - FALLOFF_START) / (ARCTIC_LAT - FALLOFF_START);
      const density = t * t;
      const x = i % width;
      const patch = fbm(snowPatchNoise, x * 0.04, y * 0.04, 4);
      if (patch < density) kind[i] = TileKind.Snow;
    }
    // lat ≤ FALLOFF_START: no snow at all.
  }

  const owner = new Uint16Array(width * height).fill(UNOWNED);
  const troops = new Float32Array(width * height);
  const ownedCount = new Uint32Array(0);

  // --- Step 6: Scatter biome props (trees, plateaus, undergrowth). ---
  // Shared non-overlap claim list. Pre-seeded with the volcano cones so no
  // tree / rock / plateau spawns underneath one; each subsequent scatter
  // pass appends its placements so later passes also avoid them.
  const claimed: Array<{ x: number; y: number; r: number }> = [];
  for (const v of volcanoProps) claimed.push({ x: v.x, y: v.y, r: v.size });
  // Step 5.9: Noise-peak arches. A coarse FBM is sampled on a grid; every
  // local maximum becomes a 2×-size rock arch landmark. Each arch reserves
  // a generous exclusion disk in `claimed` so biome scatter clears the area
  // around it (trees + rocks visibly stand back from the arch).
  const peakArches = placePeakArches(kind, mountainDensity, width, height);
  for (const a of peakArches) claimed.push({ x: a.x, y: a.y, r: a.size * 1.5 });
  const props = placeBiomeProps(kind, heat, mountainDensity, width, height, claimed);
  for (const a of peakArches) props.push(a);
  // Step 6.5: Epic-rare volcanic rocks ringing each volcano-island. Done
  // before appending the volcanoes themselves so the volcano sprite draws
  // on top of any rock that happened to clip behind it.
  for (const r of placeEpicRareVolcanoRocks(volcanoProps, kind, mountainDensity, width, height, claimed)) {
    props.push(r);
  }
  // Promote ~10% of volcanoes to active at worldgen, with a hard floor
  // of one active cone per world. Active volcanoes periodically launch
  // flying debris (engine: stepVulcanos) which lands in a ring around
  // the cone and stamps a crater prop. Each active cone also gets a
  // ring of decorative magma rocks so the danger zone reads at a glance.
  const activeFlags = volcanoProps.map(() => rand() < 0.1);
  if (volcanoProps.length > 0 && !activeFlags.some((b) => b)) {
    // Floor: pick a random index and force-activate it so the player
    // always has at least one eruption to interact with.
    activeFlags[(rand() * activeFlags.length) | 0] = true;
  }
  for (let i = 0; i < volcanoProps.length; i++) {
    if (!activeFlags[i]) continue;
    const v = volcanoProps[i];
    // Keep the sprite as the active variant initially so createGame's
    // detection loop can seed vulcanoDeactivateOnDay correctly. The
    // engine's sprite-sync step then swaps to inactive during the day
    // and back to active at night.
    v.sprite = v.sprite.endsWith("_snowy") ? "vulcano_active_snowy" : "vulcano_active";
    const count = 6 + ((rand() * 5) | 0);
    const rocks = ["magma_rock1", "magma_rock2", "magma_rock3"];
    for (let j = 0; j < count; j++) {
      const ang = rand() * Math.PI * 2;
      const r = v.size * (0.85 + rand() * 0.8);
      const mx = v.x + Math.cos(ang) * r;
      const my = v.y + Math.sin(ang) * r;
      if (mx < 0 || my < 0 || mx >= width || my >= height) continue;
      const idx = (my | 0) * width + (mx | 0);
      if (kind[idx] !== TileKind.Land) continue;
      props.push({
        sprite: rocks[(rand() * rocks.length) | 0],
        x: mx, y: my,
        size: 4 + rand() * 4,
      });
    }
  }
  // Append volcano props from step 4.4 last so they draw on top of any biome
  // scatter that happened to land on the same island tiles.
  for (const v of volcanoProps) props.push(v);

  // Build the per-tile prop-blocked mask. Only volcanoes (active +
  // inactive variants, including snowy) and their craters count as
  // impassable — the player's villagers and bots both route around
  // them through pathfind's isWalkable check. Other props (rocks,
  // trees, mesa decor) stay walkable so harvest paths still work.
  const blockedByProp = new Uint8Array(width * height);
  for (const p of props) {
    if (!isImpassableProp(p.sprite)) continue;
    // Use a slightly tighter footprint than the visual size — the
    // sprite extends past the volcano's actual rocky base, and we
    // don't want villagers blocked by what looks like clear ground.
    const r = Math.max(1, Math.floor(p.size * 0.75));
    const x0 = Math.max(0, Math.floor(p.x - r));
    const x1 = Math.min(width - 1, Math.ceil(p.x + r));
    const y0 = Math.max(0, Math.floor(p.y - r));
    const y1 = Math.min(height - 1, Math.ceil(p.y + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - p.y;
      const base = y * width;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - p.x;
        if (dx * dx + dy * dy <= r2) blockedByProp[base + x] = 1;
      }
    }
  }

  return {
    width,
    height,
    kind,
    heat,
    coastDist,
    oceanHeight,
    seaChannel,
    mountainDensity,
    oceanDistJitter,
    riverMask,
    owner,
    troops,
    borders: [],
    ownedCount,
    props,
    blockedByProp,
    farmlandState: new Uint8Array(width * height),
    farmlandOwner: new Uint16Array(width * height).fill(0xffff),
    holeDepth: new Uint8Array(width * height),
    waterLevel: new Float32Array(width * height),
    worldSeed: _usedSeed,
  };
}

/** Sprites whose footprint should block walking. Volcanoes (both biomes,
 *  active and inactive) are the only impassable family for now — the
 *  pathfind walks around them via `world.blockedByProp`. */
function isImpassableProp(sprite: string): boolean {
  return sprite.startsWith("vulcano");
}

/**
 * Scatter biome-specific decorative props (trees, plateaus, bushes).
 *
 * Heat bands aligned with Renderer.BIOME_STOPS [0, 28, 88, 180, 220, 256]:
 *   taiga    =   0..28
 *   birch    =  28..88
 *   forest   =  88..180
 *   desert   = 180..220   ← no props
 *   badlands = 220..256
 *
 * Ranges below extend ±a few units past their band edges so the prop scatter
 * fades into the neighbouring biome instead of stopping at a hard line.
 *
 * Each call picks one prop per cell from a weighted pool, accepts it only
 * when the centre tile + a small ring around it are mostly in-band, so
 * props stay inside their biome's core instead of bleeding onto edges.
 */
/**
 * Place epic-rare volcanic rocks in a ring around each volcano-island
 * volcano. The three sprites (rare2/3/4) only spawn here — they're flagged
 * as exclusive to volcano islands. Each volcano gets 3..6 rocks within a
 * radius scaled by the volcano sprite size; candidates that fall on water,
 * outside the world, or on a mountain-blend tile are silently retried up
 * to MAX_ATTEMPTS times per rock.
 */
/**
 * Sample a coarse FBM on a grid and emit one 2×-size `rock_arch` at every
 * local maximum of the noise. Cells are ~ARCH_CELL tiles across, so peaks
 * are naturally spaced by roughly that distance; a 3×3 non-max-suppression
 * step ensures we never place two arches in adjacent cells. Candidates
 * that fall on sea or on a mountain-blend tile are dropped. The caller
 * adds a 1.5×-radius claim disk per arch so subsequent biome scatter
 * carves out the area around each arch.
 */
function placePeakArches(
  kind: Uint8Array,
  mountainDensity: Uint8Array,
  width: number,
  height: number
): WorldProp[] {
  const ARCH_CELL = 400;          // grid cell side, tiles
  const NOISE_FREQ = 0.0025;      // ~one bump per ~400 tiles, matches CELL
  const noise = makeNoise(54321);
  const cols = Math.floor(width / ARCH_CELL);
  const rows = Math.floor(height / ARCH_CELL);

  // Sample noise at each cell centre once.
  const samples = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * ARCH_CELL;
      const cy = (r + 0.5) * ARCH_CELL;
      samples[r * cols + c] = fbm(noise, cx * NOISE_FREQ, cy * NOISE_FREQ, 4);
    }
  }

  const out: WorldProp[] = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const v = samples[r * cols + c];
      // Strictly-greater-than 3×3 neighbours = a clean local maximum.
      let isPeak = true;
      for (let dr = -1; dr <= 1 && isPeak; dr++) {
        for (let dc = -1; dc <= 1 && isPeak; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (samples[(r + dr) * cols + (c + dc)] >= v) isPeak = false;
        }
      }
      if (!isPeak) continue;

      // Slight jitter inside the cell so arches aren't on a perfect grid.
      const jx = (rand() - 0.5) * 0.4;
      const jy = (rand() - 0.5) * 0.4;
      const x = ((c + 0.5 + jx) * ARCH_CELL) | 0;
      const y = ((r + 0.5 + jy) * ARCH_CELL) | 0;
      if (x < 80 || x >= width - 80) continue;
      if (y < 80 || y >= height - 80) continue;
      const idx = y * width + x;
      if (kind[idx] !== TileKind.Land) continue;
      if (mountainDensity[idx] > 0) continue;

      // Standard arch size after the 3× rock pass = 18..36. 2× landmark
      // sizing → 36..72 tile-wide arches.
      const size = 36 + rand() * 36;
      out.push({ sprite: "rock_arch", x, y, size });
    }
  }
  return out;
}

function placeEpicRareVolcanoRocks(
  volcanoes: WorldProp[],
  kind: Uint8Array,
  mountainDensity: Uint8Array,
  width: number,
  height: number,
  claimed: Array<{ x: number; y: number; r: number }>
): WorldProp[] {
  // Variants 1 and 4 always sit on the LEFT side of the volcano (negative
  // x offset); variants 2 and 3 always sit on the RIGHT (positive x). Pick
  // variant first per rock then constrain the spawn angle to the matching
  // hemisphere so the side rule is hard, not probabilistic.
  const LEFT_VARIANTS  = ["rock_epic_rare1", "rock_epic_rare4"] as const;
  const RIGHT_VARIANTS = ["rock_epic_rare2", "rock_epic_rare3"] as const;
  const MAX_ATTEMPTS = 12;
  const out: WorldProp[] = [];
  for (const v of volcanoes) {
    const count = 3 + ((rand() * 4) | 0); // 3..6 rocks per volcano
    const innerR = v.size * 0.6;                 // skip the volcano's footprint
    const outerR = v.size * 2.2;                 // ring extends just past it
    for (let n = 0; n < count; n++) {
      // Coin-flip side, then pick a variant from the matching pair so the
      // placement count stays balanced left/right across the ring.
      const leftSide = rand() < 0.5;
      const sprite = leftSide
        ? LEFT_VARIANTS[(rand() * LEFT_VARIANTS.length) | 0]
        : RIGHT_VARIANTS[(rand() * RIGHT_VARIANTS.length) | 0];
      for (let a = 0; a < MAX_ATTEMPTS; a++) {
        // Angle restricted to the chosen hemisphere:
        //   left  → [π/2,  3π/2)  → cos < 0
        //   right → [-π/2, π/2)   → cos > 0
        const ang = leftSide
          ? Math.PI / 2 + rand() * Math.PI
          : -Math.PI / 2 + rand() * Math.PI;
        const r = innerR + rand() * (outerR - innerR);
        const x = (v.x + Math.cos(ang) * r) | 0;
        const y = (v.y + Math.sin(ang) * r) | 0;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const idx = y * width + x;
        if (kind[idx] !== TileKind.Land) continue;
        if (mountainDensity[idx] > 0) continue;
        // 7× the old 4..8 → 28..56 tile-wide epic rocks.
        const size = 28 + rand() * 28;
        // Skip if this rock's disk would overlap any already-placed prop
        // (including the volcano itself + biome props placed before us).
        let collide = false;
        for (const d of claimed) {
          const dx = x - d.x;
          const dy = y - d.y;
          const sum = size + d.r;
          if (dx * dx + dy * dy < sum * sum) { collide = true; break; }
        }
        if (collide) continue;
        out.push({ sprite, x, y, size });
        claimed.push({ x, y, r: size });
        break;
      }
    }
  }
  return out;
}

function placeBiomeProps(
  kind: Uint8Array,
  heat: Uint8Array,
  mountainDensity: Uint8Array,
  width: number,
  height: number,
  claimed: Array<{ x: number; y: number; r: number }>
): WorldProp[] {
  const props: WorldProp[] = [];

  // Per-biome density noise. Each biome gets its OWN FBM seed so dense /
  // sparse patches in forest don't line up with patches in birch or
  // taiga — every biome carves out its own characteristic groves and
  // clearings instead of all three sharing the same geography.
  //
  // Frequencies (~0.005..0.006) give patches ~165..200 tiles across, so the
  // formations are clearly visible at the zoom levels the player is likely
  // to pan at. The remap is wide (0× clearings up to 7× dense groves) with
  // an average of 2.0, so the visual contrast between dense and sparse
  // patches is unmistakable rather than "all sort of dense".
  const makeDensity = (
    seed: number,
    freq: number,
    mult: number = 1
  ): ((cx: number, cy: number) => number) => {
    const noise = makeNoise(seed);
    return (cx, cy) => {
      const n = fbm(noise, cx * freq, cy * freq, 5);
      const base = n < 0.5
        ? 4.0 * n                  // 0..0.5 → 0..2.0 (clearings → average)
        : 2.0 + 10.0 * (n - 0.5);  // 0.5..1.0 → 2..7  (dense groves)
      return base * mult;
    };
  };
  // 3× tree-biome density so forest/birch/taiga read as thickly wooded
  // rather than spaced-out. Bushes scale alongside; they're a small minority
  // of each pool so the dominant visual change is more trees.
  const forestDensity = makeDensity(70707, 0.005, 3);
  const birchDensity  = makeDensity(80808, 0.006, 3);
  const taigaDensity  = makeDensity(90909, 0.0055, 3);

  // --- Badlands: mesa plateaus + small rocks/spires. ---
  // Split into TWO scatter passes so the large landmarks and the small
  // clutter can have independent spawn rates. Previously both shared one
  // pool, so adjusting one rate dragged the other along.
  //
  // Rate maths (relative to the old combined cell=220 with pool weights
  // 10 plateaus / 3 smalls, where total candidate rate is 1 per cell²):
  //   - Old plateau rate: 10/13 per cell² → at cell 220, ≈ 1.59e-5 per
  //     tile². Target 1.5× → cell = sqrt(13/(10×1.5)) × 220 ≈ 205.
  //   - Old small rate:    3/13 per cell² → target 3× → cell =
  //     sqrt(13/(3×3)) × 220 ≈ 265.
  const MESA_PLATEAU_POOL = [
    "mesa_plateau1", "mesa_plateau2", "mesa_plateau3",
    "mesa_plateau4", "mesa_plateau5",
  ];
  const MESA_SMALL_POOL = ["mesa_rock", "mesa_spire1", "mesa_spire2"];
  // Plateaus and small props at 3× scale — half-sizes tripled. Both passes
  // share the world-wide `claimed` disk list (pre-seeded with volcanoes by
  // the caller) so plateaus don't overlap each other, mesa smalls don't sit
  // inside a plateau, and nothing in this biome lands on a volcano. Mesa
  // appends to the list; later biome scatters check it read-only.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 218, heatMax: 256, cell: 90, ring: 6, edgeFade: 12,
    pool: MESA_PLATEAU_POOL, claimed, noWaterOverlap: true,
    sizeFor: () => 45 + rand() * 30, // 90..150 tile-wide plateaus (3×)
  });
  scatter(props, kind, heat, mountainDensity, width, height, {
    // cell 80 → 179: side ×√5 so the mesa rock + spire density drops 5×.
    heatMin: 218, heatMax: 256, cell: 179, ring: 6, edgeFade: 12,
    pool: MESA_SMALL_POOL, claimed, noWaterOverlap: true,
    sizeFor: (sprite) => {
      // Spires get an extra 2× over the surrounding mesa-rock baseline so
      // they read as proper landmarks.
      if (sprite.startsWith("mesa_spire")) return 42 + rand() * 30; // 84..144 (2×)
      return 21 + rand() * 15; // 42..72 tile-wide rocks (3×)
    },
  });

  // --- Standard rock formations (4 shapes) across the tree biomes. ---
  // Runs BEFORE trees and APPENDS to `claimed` so subsequent tree scatters
  // displace away from rock placements — the user wants rocks to win when
  // a rock and a tree would land in the same spot.
  const ROCK_POOL = [
    "rock_arch", "rock_mound", "rock_spikebatch", "rock_spire",
  ];
  scatter(props, kind, heat, mountainDensity, width, height, {
    // cell 38 → 85: side ×√5 so the standard rock-scatter density drops 5×.
    heatMin: 0, heatMax: 184, cell: 85, ring: 3, edgeFade: 10,
    // spriteChance 0.2 → ~1/5 the rock sprites emit, but the claim disks
    // append at full rate so trees still displace around the ghost-rock
    // spots even where no rock actually spawns.
    // spriteChance bumped 0.2 → 0.4 → 2× the standard-rock count. Claim
    // disks still append at full rate so trees displace cleanly.
    pool: ROCK_POOL, claimed, noWaterOverlap: true, spriteChance: 0.4,
    sizeFor: (sprite) => {
      // Stone spires get a 2× landmark sizing over the other rock shapes.
      if (sprite === "rock_spire") return 36 + rand() * 36; // 72..144 (2×)
      return 18 + rand() * 18; // 36..72 tile-wide rock formations (3×)
    },
  });

  // --- Variant rock families. Each family is its own scatter pass with
  //     cell size tuned to the rarity tier: snowy rocks are cold-biome
  //     reskins of standard, iron is moderately rare, gold rarer, diamond
  //     and uranium very rare. Berry rocks are biome-tied to their colour
  //     band (red ↔ forest, yellow ↔ plains, blue ↔ taiga). All passes
  //     reuse the standard rock size formula and the existing claimed
  //     non-overlap list so they push trees / structures away. ---
  const variantSize = (sprite: string): number => {
    if (sprite.endsWith("_spire") || sprite.endsWith("_spike")) {
      return 36 + rand() * 36;
    }
    return 18 + rand() * 18;
  };

  // --- Variant rarity tiers. Cell size monotonically increases through
  //     iron → gold → diamond → uranium so the chain reads as a clear
  //     "more common → rarer" ladder, and berries match iron at the
  //     "moderately common" tier. Tightened from the previous values
  //     to make rocks generally more abundant and put uranium clearly
  //     above diamond on the rarity scale. ---

  // Iron rocks — universal, moderately rare.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 200, cell: 180, ring: 3, edgeFade: 10,
    pool: ["iron_mound", "iron_spikebatch", "iron_spire"],
    claimed, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // Gold rocks — universal, rare (rarer than iron).
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 220, cell: 320, ring: 3, edgeFade: 10,
    pool: ["gold_arch", "gold_mound", "gold_spikebatch", "gold_spire"],
    claimed, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // Diamond rocks — very rare (rarer than gold).
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 256, cell: 480, ring: 3, edgeFade: 10,
    pool: ["diamond_arch", "diamond_mound", "diamond_spikebatch", "diamond_spire"],
    claimed, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // Uranium rocks — rarest, biased toward the dry / badlands band.
  // The post-nuke variant is intentionally not scattered yet.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 160, heatMax: 256, cell: 620, ring: 3, edgeFade: 10,
    pool: ["uranium_arch", "uranium_mound", "uranium_spikebatch", "uranium_spire"],
    claimed, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // Snowy rock variant — cold biomes only (taiga band). Yields plain
  // rock on mine; this is a visual reskin so taiga zones don't look
  // identical to temperate ones.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 32, cell: 130, ring: 3, edgeFade: 10,
    pool: ["rocksnowy_arch", "rocksnowy_mound", "rocksnowy_spikebatch", "rocksnowy_spire"],
    claimed, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // Berry rocks — tied to the colour-coded biomes (red ↔ forest, yellow
  // ↔ plains, blue ↔ taiga). Density matches iron at cell 180 so a
  // tribe sees roughly as many berry rocks as iron rocks in their
  // biome. CRUCIAL: berries use `noClaimAppend: true` so they don't
  // push trees out of their spawn cells — berries fit AROUND trees
  // instead of replacing them, which is what the user wants.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 88, heatMax: 184, cell: 180, ring: 3, edgeFade: 12,
    pool: ["redberry_arch", "redberry_mound", "redberry_spikebatch", "redberry_spire"],
    claimed, noClaimAppend: true, noWaterOverlap: true,
    sizeFor: variantSize,
  });
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 28, heatMax: 92, cell: 180, ring: 3, edgeFade: 12,
    pool: ["yellowberry_arch", "yellowberry_mound", "yellowberry_spike", "yellowberry_spikebatch"],
    claimed, noClaimAppend: true, noWaterOverlap: true,
    sizeFor: variantSize,
  });
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 36, cell: 180, ring: 3, edgeFade: 12,
    pool: ["blueberry_arch", "blueberry_mound", "blueberry_spikebatch", "blueberry_spire"],
    claimed, noClaimAppend: true, noWaterOverlap: true,
    sizeFor: variantSize,
  });

  // --- Forest: oaks + bushes. ---
  const FOREST_POOL = [
    "tree_oak", "tree_oak", "tree_oak", "tree_oak",
    "bush", "bush",
  ];
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 85, heatMax: 184, cell: 54, ring: 4, edgeFade: 18,
    pool: FOREST_POOL, density: forestDensity,
    claimed, noClaimAppend: true,
    sizeFor: (sprite) => {
      if (sprite.startsWith("tree_")) return 12 + rand() * 9; // 3×
      return 7.5 + rand() * 4.5; // bush (3×)
    },
  });

  // --- Birch: birches only + bushes. ---
  const BIRCH_POOL = [
    "tree_birch", "tree_birch", "tree_birch", "tree_birch",
    "bush", "bush",
  ];
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 25, heatMax: 92, cell: 54, ring: 4, edgeFade: 12,
    pool: BIRCH_POOL, density: birchDensity,
    claimed, noClaimAppend: true,
    sizeFor: (sprite) => {
      if (sprite.startsWith("tree_")) return 12 + rand() * 9; // 3×
      return 7.5 + rand() * 4.5; // bush (3×)
    },
  });

  // --- Taiga: dense conifers + occasional bushes. ---
  const TAIGA_POOL = [
    "tree_taiga", "tree_taiga", "tree_taiga", "tree_taiga", "tree_taiga",
    "bush",
  ];
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 32, cell: 48, ring: 4, edgeFade: 8,
    pool: TAIGA_POOL, density: taigaDensity,
    claimed, noClaimAppend: true,
    sizeFor: (sprite) => {
      if (sprite.startsWith("tree_")) return 15 + rand() * 9; // 3×
      return 7.5 + rand() * 4.5; // bush (3×)
    },
  });

  // --- Natural tree stumps. Decorative-only — same biome bands as the
  //     tree scatters so stumps read as "this forest used to be a bit
  //     bigger." Tiny footprint (matches the harvested-stub draw size)
  //     and noClaimAppend so they don't push trees away. Taiga gets the
  //     snowy stump variant.
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 28, heatMax: 184, cell: 220, ring: 2, edgeFade: 10,
    pool: ["treestump"],
    claimed, noClaimAppend: true, noWaterOverlap: true,
    sizeFor: () => 3 + rand() * 1.5, // 3..4.5 tile-wide stump
  });
  scatter(props, kind, heat, mountainDensity, width, height, {
    heatMin: 0, heatMax: 32, cell: 220, ring: 2, edgeFade: 8,
    pool: ["treestump_snowy"],
    claimed, noClaimAppend: true, noWaterOverlap: true,
    sizeFor: () => 3 + rand() * 1.5,
  });

  return props;
}

interface ScatterParams {
  heatMin: number;
  heatMax: number;
  /** Grid cell width in tiles. By default one candidate per cell; if
   *  `density` is supplied the candidate count per cell is multiplied by
   *  the density sample (floor + fractional probability), so the same cell
   *  can place 0, 1, 2, or 3 props depending on the local density value. */
  cell: number;
  /** Ring half-width for the "mostly in-band" purity check. */
  ring: number;
  /** Fade-in width at the cool edge of the band (avoids hard biome lines). */
  edgeFade: number;
  pool: string[];
  sizeFor: (sprite: string) => number;
  /** Optional density multiplier sampled at the cell centre. Should return
   *  a value in [0.25, 3.0] — 1.0 = unmodulated current density. */
  density?: (cx: number, cy: number) => number;
  /** Optional non-overlap claim list. If provided, scatter rejects any
   *  candidate whose bounding disk (cx, cy, r=size) intersects a disk
   *  already in this array. Successful placements are appended unless
   *  `noClaimAppend` is set. Pass the SAME array across multiple scatter
   *  calls to enforce non-overlap across them. */
  claimed?: Array<{ x: number; y: number; r: number }>;
  /** If true, scatter checks `claimed` for collisions but does NOT append
   *  its own placements. Use this for dense biome props (trees, rocks)
   *  that should avoid landmarks without bloating the claim list into
   *  an O(n²) cliff. */
  noClaimAppend?: boolean;
  /** If true, reject any candidate whose bounding box bumps into a
   *  non-Land tile. Samples the 4 corners + 4 edge midpoints of the
   *  size×size bbox so any visible portion of the sprite landing in
   *  water (or off-map) is caught. Used by rocks — they look out of
   *  place poking into the ocean. */
  noWaterOverlap?: boolean;
  /** Probability ∈ (0, 1] that a passing candidate actually emits a
   *  sprite. The candidate's claim disk is STILL appended either way
   *  (when `claimed` is provided and `noClaimAppend` is false), so
   *  later scatter passes still avoid the "would-be" spot — letting
   *  rocks be rare landmarks while keeping their tree-displacement
   *  footprint at the original density. Default 1 (always emit). */
  spriteChance?: number;
}

function scatter(
  out: WorldProp[],
  kind: Uint8Array,
  heat: Uint8Array,
  mountainDensity: Uint8Array,
  width: number,
  height: number,
  p: ScatterParams
): void {
  const cols = Math.floor(width / p.cell);
  const rows = Math.floor(height / p.cell);
  const MIN_IN_BAND_RATIO = 0.55;
  const ringStep = Math.max(2, (p.ring / 3) | 0);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      // Density is sampled once at the cell centre — gives a stable count
      // for the whole cell so candidates within a low-density patch don't
      // briefly burst high.
      let attempts = 1;
      if (p.density) {
        const ccx = (gx + 0.5) * p.cell;
        const ccy = (gy + 0.5) * p.cell;
        const d = p.density(ccx, ccy);
        attempts = Math.floor(d) + (rand() < d - Math.floor(d) ? 1 : 0);
        if (attempts === 0) continue;
      }

      for (let a = 0; a < attempts; a++) {
        const jx = 0.15 + rand() * 0.70;
        const jy = 0.15 + rand() * 0.70;
        const cx = ((gx + jx) * p.cell) | 0;
        const cy = ((gy + jy) * p.cell) | 0;
        if (cx < p.ring || cx >= width - p.ring) continue;
        if (cy < p.ring || cy >= height - p.ring) continue;

        const ci = cy * width + cx;
        if (kind[ci] !== TileKind.Land) continue;
        // Reject any tile with mountain-blending — props should never sit on
        // foothills or peaks, only on pure biome terrain.
        if (mountainDensity[ci] > 0) continue;
        const ch = heat[ci];
        if (ch < p.heatMin || ch > p.heatMax) continue;

        let inBand = 0;
        let total = 0;
        for (let dy = -p.ring; dy <= p.ring; dy += ringStep) {
          for (let dx = -p.ring; dx <= p.ring; dx += ringStep) {
            const ni = (cy + dy) * width + (cx + dx);
            total++;
            if (kind[ni] !== TileKind.Land) continue;
            const nh = heat[ni];
            if (nh >= p.heatMin && nh <= p.heatMax) inBand++;
          }
        }
        if (inBand / total < MIN_IN_BAND_RATIO) continue;

        // Fade in near both edges of the band so the boundary with the
        // neighbouring biome looks gradual rather than a hard prop-line.
        const lowEdge = Math.min(1, (ch - p.heatMin) / p.edgeFade);
        const highEdge = Math.min(1, (p.heatMax - ch) / p.edgeFade);
        if (rand() > lowEdge * highEdge) continue;

        const sprite = p.pool[(rand() * p.pool.length) | 0];
        const size = p.sizeFor(sprite);

        // Water-overlap check (rocks): sample 4 corners + 4 edge mids of
        // the bbox; if any is non-Land or off-map, the sprite would poke
        // into water, so skip.
        if (p.noWaterOverlap) {
          const s = Math.ceil(size);
          const offsets: ReadonlyArray<readonly [number, number]> = [
            [-s, -s], [s, -s], [-s, s], [s, s],
            [0, -s], [0, s], [-s, 0], [s, 0],
          ];
          let waterHit = false;
          for (const [ox, oy] of offsets) {
            const px = cx + ox;
            const py = cy + oy;
            if (px < 0 || px >= width || py < 0 || py >= height) { waterHit = true; break; }
            if (kind[py * width + px] !== TileKind.Land) { waterHit = true; break; }
          }
          if (waterHit) continue;
        }

        // Non-overlap check: reject if this disk would intersect any
        // already-claimed disk. Quadratic in the number of claimed disks,
        // so we only APPEND for sparse-landmark passes (mesa plateaus,
        // volcanoes). Dense biome scatter (trees, biome rocks) sets
        // `noClaimAppend` so it consults the list without growing it.
        if (p.claimed) {
          let collide = false;
          for (const d of p.claimed) {
            const dx = cx - d.x;
            const dy = cy - d.y;
            const sum = size + d.r;
            if (dx * dx + dy * dy < sum * sum) { collide = true; break; }
          }
          if (collide) continue;
          if (!p.noClaimAppend) p.claimed.push({ x: cx, y: cy, r: size });
        }

        // Spritechance: candidate has claimed its disk above (so later
        // scatters keep avoiding the spot), but only sometimes does it
        // actually emit a visible prop. Lets rocks be 5× rarer landmarks
        // while preserving the original-density displacement field.
        if (p.spriteChance !== undefined && rand() >= p.spriteChance) continue;

        out.push({ sprite, x: cx, y: cy, size });
      }
    }
  }
}

/**
 * Generate procedural islands at Voronoi triple-junctions of N plate seeds.
 *
 * Algorithm:
 *  1. Scatter NUM_PLATES seed points across the world, biased away from the
 *     polar caps (where they'd just become ice/snow).
 *  2. For every (i,j,k) triple, compute the circumcenter and verify it's
 *     actually a Voronoi vertex — i.e. no fourth seed is strictly closer
 *     to that point.
 *  3. Reject vertices that fall on land (we only want oceanic islands).
 *  4. Reject vertices too close to existing coastline so islands don't fuse
 *     into nearby continents — they should be standalone landmasses.
 *  5. At each surviving vertex, flip Sea→Land in a noise-perturbed radial
 *     blob. The shape's outer edge is jittered by an FBM-noise threshold so
 *     islands look organic rather than circular.
 */
function carvePlateIslands(kind: Uint8Array, width: number, height: number): WorldProp[] {
  const NUM_PLATES = 22;
  const POLE_MARGIN = 0.08;
  const MIN_COAST_CLEARANCE = 60;
  const ISLAND_R_MIN = 40;
  const ISLAND_R_MAX = 90;
  const ISLAND_NOISE_FREQ = 0.04;
  // Exactly two volcano-islands per world: the first eligible triple-
  // junction in each hemisphere gets the 7×-radius volcano-island treatment
  // (with a 4× volcano cone). Once a hemisphere's slot is filled the
  // remaining junctions there spawn as ordinary small islands.
  let needWestVolcano = true;
  let needEastVolcano = true;
  const volcanoes: WorldProp[] = [];

  // Seed plates. Polar margin keeps seeds away from the top/bottom edges so
  // the bulk of useful triple-junctions land in temperate / tropical oceans.
  const plates: Array<{ x: number; y: number }> = [];
  const yLo = height * POLE_MARGIN;
  const ySpan = height * (1 - 2 * POLE_MARGIN);
  for (let i = 0; i < NUM_PLATES; i++) {
    plates.push({
      x: rand() * width,
      y: yLo + rand() * ySpan,
    });
  }

  const islandNoise = makeNoise(98765);
  const N = plates.length;

  for (let a = 0; a < N - 2; a++) {
    for (let b = a + 1; b < N - 1; b++) {
      for (let c = b + 1; c < N; c++) {
        const A = plates[a];
        const B = plates[b];
        const C = plates[c];
        const cc = circumcenter(A.x, A.y, B.x, B.y, C.x, C.y);
        if (!cc) continue;
        if (cc.x < 0 || cc.x >= width || cc.y < 0 || cc.y >= height) continue;

        // Real Voronoi vertex test: every other seed must be at least as
        // far as A, B, C are. Squared distance to keep it cheap.
        const dxA = cc.x - A.x;
        const dyA = cc.y - A.y;
        const r2 = dxA * dxA + dyA * dyA;
        let isVertex = true;
        for (let k = 0; k < N; k++) {
          if (k === a || k === b || k === c) continue;
          const dxK = cc.x - plates[k].x;
          const dyK = cc.y - plates[k].y;
          if (dxK * dxK + dyK * dyK < r2 - 1) { isVertex = false; break; }
        }
        if (!isVertex) continue;

        const ix = cc.x | 0;
        const iy = cc.y | 0;
        if (kind[iy * width + ix] !== TileKind.Sea) continue;

        // Volcano-bearing islands are 7× larger than normal procedural
        // islands, with the volcano cone itself 4× its old size. The first
        // eligible junction in each hemisphere takes the volcano slot for
        // that side; once both slots are filled, every later junction
        // spawns as an ordinary small island.
        const baseR = ISLAND_R_MIN + rand() * (ISLAND_R_MAX - ISLAND_R_MIN);
        const inWest = ix < (width >> 1);
        const hasVolcano = inWest ? needWestVolcano : needEastVolcano;
        const radius = hasVolcano ? baseR * 7 : baseR;

        // Standalone-island guard: bail if existing land sits within the
        // clearance radius (scales with island size). Quick stride sample.
        // Volcano islands tolerate tiny offshore landmasses (≤ 50 tiles)
        // inside their clearance — only continent-class neighbours block.
        const guard = Math.max(MIN_COAST_CLEARANCE, radius + 20);
        const step = Math.max(6, (guard / 20) | 0);
        const bigSeen = new Set<number>();
        const smallSeen = new Set<number>();
        const LANDMASS_LIMIT = 50;
        let nearLand = false;
        for (let dy = -guard; dy <= guard && !nearLand; dy += step) {
          const ty = iy + dy;
          if (ty < 0 || ty >= height) continue;
          for (let dx = -guard; dx <= guard; dx += step) {
            const tx = ix + dx;
            if (tx < 0 || tx >= width) continue;
            const li = ty * width + tx;
            if (kind[li] !== TileKind.Land) continue;
            if (smallSeen.has(li)) continue;
            if (!hasVolcano) { nearLand = true; break; }
            if (bigSeen.has(li)) { nearLand = true; break; }
            // Volcano-island case: bounded flood-fill (limit LANDMASS_LIMIT+1).
            // If the component fits in the limit it's a small offshore islet
            // and we keep scanning; otherwise this is a continent and we bail.
            const visited = floodFillBounded(kind, width, height, li, LANDMASS_LIMIT);
            if (visited.exceeded) {
              for (const t of visited.tiles) bigSeen.add(t);
              nearLand = true;
              break;
            }
            for (const t of visited.tiles) smallSeen.add(t);
          }
        }
        // Failing clearance on a volcano attempt must NOT consume the
        // hemisphere's volcano slot — keep trying further junctions until
        // a 7×-radius spot fits.
        if (nearLand) continue;

        carveIsland(kind, width, height, islandNoise, ix, iy, radius, ISLAND_NOISE_FREQ);
        if (hasVolcano) {
          if (inWest) needWestVolcano = false;
          else needEastVolcano = false;
          // Polar volcanoes use the snowy variant so the cone reads as
          // ice-capped rather than barren. Threshold matches the patchy-
          // snow band entry point (FALLOFF_START = 0.60).
          const lat = Math.abs(1 - 2 * (iy / height));
          const sprite = lat > 0.60 ? "vulcano_inactive_snowy" : "vulcano_inactive";
          volcanoes.push({
            sprite,
            x: ix,
            y: iy,
            // Old volcano size = baseR * 0.5; 4× that → baseR * 2.
            size: baseR * 2,
          });
        }
      }
    }
  }
  return volcanoes;
}

/** Bounded 4-connected flood-fill over Land tiles starting at `start`.
 *  Stops early once `limit` Land tiles have been visited, returning
 *  `exceeded: true` (so callers know the component is "big"). Returns the
 *  set of tiles visited so far either way — callers can union these into a
 *  memoization set to avoid re-scanning the same component. */
function floodFillBounded(
  kind: Uint8Array,
  width: number,
  height: number,
  start: number,
  limit: number
): { exceeded: boolean; tiles: number[] } {
  if (kind[start] !== TileKind.Land) return { exceeded: false, tiles: [] };
  const tiles: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [start];
  seen.add(start);
  while (stack.length > 0) {
    const idx = stack.pop()!;
    tiles.push(idx);
    if (tiles.length > limit) return { exceeded: true, tiles };
    const x = idx % width;
    const y = (idx / width) | 0;
    const tryPush = (n: number) => {
      if (seen.has(n)) return;
      if (kind[n] !== TileKind.Land) return;
      seen.add(n);
      stack.push(n);
    };
    if (x > 0) tryPush(idx - 1);
    if (x < width - 1) tryPush(idx + 1);
    if (y > 0) tryPush(idx - width);
    if (y < height - 1) tryPush(idx + width);
  }
  return { exceeded: false, tiles };
}

/** Circumcenter of three 2D points, or null if collinear. */
function circumcenter(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): { x: number; y: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  return {
    x: (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d,
    y: (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d,
  };
}

/** Flip a noise-perturbed blob of Sea→Land centred at (cx,cy). The radial
 *  threshold is modulated by FBM noise so the outline is organic. */
function carveIsland(
  kind: Uint8Array,
  width: number,
  height: number,
  noise: (x: number, y: number) => number,
  cx: number,
  cy: number,
  radius: number,
  noiseFreq: number
): void {
  const maxR = Math.ceil(radius * 1.35);
  for (let dy = -maxR; dy <= maxR; dy++) {
    const ty = cy + dy;
    if (ty < 0 || ty >= height) continue;
    for (let dx = -maxR; dx <= maxR; dx++) {
      const tx = cx + dx;
      if (tx < 0 || tx >= width) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      const n = fbm(noise, tx * noiseFreq, ty * noiseFreq, 4);
      // n maps 0..1 → threshold radius 0.50×R..1.25×R.
      const threshold = radius * (0.50 + n * 0.75);
      if (d < threshold) {
        const idx = ty * width + tx;
        if (kind[idx] === TileKind.Sea) kind[idx] = TileKind.Land;
      }
    }
  }
}

/** Majority erosion: any land tile with ≥ 3 water neighbours becomes water.
 *  Smooths jagged riverbanks (and coastlines) by removing single-tile
 *  protrusions. Operates iteratively for a few passes. */
function smoothShoreline(kind: Uint8Array, width: number, height: number, passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const snapshot = new Uint8Array(kind);
    for (let i = 0; i < kind.length; i++) {
      if (snapshot[i] !== TileKind.Land) continue;
      const x = i % width;
      const y = (i / width) | 0;
      let waterN = 0;
      if (x > 0 && snapshot[i - 1] === TileKind.Sea) waterN++;
      if (x < width - 1 && snapshot[i + 1] === TileKind.Sea) waterN++;
      if (y > 0 && snapshot[i - width] === TileKind.Sea) waterN++;
      if (y < height - 1 && snapshot[i + width] === TileKind.Sea) waterN++;
      if (waterN >= 3) kind[i] = TileKind.Sea;
    }
  }
}

/** Worley F1: distance from (x,y) to the nearest cell-seed, normalised to ~[0,1]. */
function makeWorleyF1(seed: number, cellSize: number): (x: number, y: number) => number {
  function h(ix: number, iy: number, salt: number): number {
    let r = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)
           + Math.imul(seed, 982451653) + Math.imul(salt, 252331913)) | 0;
    r = Math.imul(r ^ (r >>> 13), 1274126177);
    r = r ^ (r >>> 16);
    return ((r >>> 0) % 1000000) / 1000000;
  }
  return function (x: number, y: number): number {
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ncx = cx + dx;
        const ncy = cy + dy;
        const sx = (ncx + h(ncx, ncy, 1)) * cellSize;
        const sy = (ncy + h(ncx, ncy, 2)) * cellSize;
        const ddx = sx - x;
        const ddy = sy - y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < bestD) bestD = d2;
      }
    }
    const dist = Math.sqrt(bestD) / cellSize; // typically 0..0.9
    return dist > 1 ? 1 : dist;
  };
}

/**
 * Two-pass chamfer Manhattan distance from every tile to the nearest
 * land/water boundary. Coast tiles (those adjacent to a tile of opposite
 * kind) are 0; deeper inland or further out at sea, the value grows.
 * Capped at 250 to leave room in Uint8 for INF=255.
 */
function computeCoastDistance(kind: Uint8Array, width: number, height: number): Uint8Array {
  const N = width * height;
  const INF = 255;
  const CAP = 250;
  const dist = new Uint8Array(N).fill(INF);

  // Mark coast tiles (boundary between water and ownable land).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const water = kind[i] === TileKind.Sea;
      let onCoast = false;
      if (x > 0 && (kind[i - 1] === TileKind.Sea) !== water) onCoast = true;
      else if (x < width - 1 && (kind[i + 1] === TileKind.Sea) !== water) onCoast = true;
      else if (y > 0 && (kind[i - width] === TileKind.Sea) !== water) onCoast = true;
      else if (y < height - 1 && (kind[i + width] === TileKind.Sea) !== water) onCoast = true;
      if (onCoast) dist[i] = 0;
    }
  }

  // Forward pass: each tile inherits min(self, neighbor_up_or_left + 1).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let d = dist[i];
      if (x > 0) {
        const v = dist[i - 1];
        if (v < INF && v + 1 < d) d = v + 1;
      }
      if (y > 0) {
        const v = dist[i - width];
        if (v < INF && v + 1 < d) d = v + 1;
      }
      dist[i] = d > CAP ? CAP : d;
    }
  }
  // Backward pass.
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let d = dist[i];
      if (x < width - 1) {
        const v = dist[i + 1];
        if (v < INF && v + 1 < d) d = v + 1;
      }
      if (y < height - 1) {
        const v = dist[i + width];
        if (v < INF && v + 1 < d) d = v + 1;
      }
      dist[i] = d > CAP ? CAP : d;
    }
  }
  return dist;
}

/**
 * Particle river simulation. Each river must START coast-adjacent and END at
 * water — i.e., the path traverses land between two water tiles. The path is
 * traced first into a buffer; it's only committed to the world if the
 * particle actually reaches water again at the far end. Failed traces leave
 * the map untouched.
 */
function carveParticleRivers(
  kind: Uint8Array,
  width: number,
  height: number,
  elevAt: (x: number, y: number) => number,
  riverMask: Uint8Array
): void {
  const TARGET_RIVERS = 80;
  const MAX_ATTEMPTS = TARGET_RIVERS * 12;
  // Outer iteration count cut to 1/5 of what it was; each iteration now
  // advances 5× further. Rivers reach across continents in 1/5 the time.
  const MAX_STEPS = 700;
  const MIN_STEPS_BEFORE_EXIT = 32;
  const STEP_DELTA = 2.75;
  const FORCE = 0.45;
  const DAMP = 0.985;
  const MEANDER = 0.06;
  const WIDEN_PROB = 0.42;
  const MERGE_COS = 0.45;
  const DIRS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  // Per-tile flow vector for carved rivers (quantized to int8 in [-100,100]).
  // Original sea tiles stay 0,0 — that's how we distinguish ocean from river.
  const flowX = new Int8Array(width * height);
  const flowY = new Int8Array(width * height);

  let committed = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && committed < TARGET_RIVERS; attempt++) {
    // Find a land tile that has at least one sea neighbor.
    let sx = -1;
    let sy = -1;
    let inDx = 0;
    let inDy = 0;
    for (let pick = 0; pick < 250; pick++) {
      const x = (rand() * width) | 0;
      const y = (height * 0.14 + rand() * height * 0.70) | 0;
      const idx = y * width + x;
      if (kind[idx] !== TileKind.Land) continue;
      let seaDx = 0;
      let seaDy = 0;
      let foundSea = false;
      for (const [dx, dy] of DIRS) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        let nx = x + dx;
        if (nx < 0) nx += width;
        else if (nx >= width) nx -= width;
        if (kind[ny * width + nx] === TileKind.Sea) {
          foundSea = true;
          seaDx = dx;
          seaDy = dy;
          break;
        }
      }
      if (!foundSea) continue;
      sx = x;
      sy = y;
      // Initial velocity points away from the sea — into the land.
      inDx = -seaDx;
      inDy = -seaDy;
      break;
    }
    if (sx < 0) continue;

    // Trace into local buffers — each entry stores tile index plus the flow
    // direction at that tile (unit vector), so we can stamp flowX/flowY on
    // commit and reject T-/head-on merges with existing rivers.
    type Step = { idx: number; dx: number; dy: number };
    const path: Step[] = [];
    const widen: Step[] = [];
    let px = sx + 0.5;
    let py = sy + 0.5;
    let vx = inDx * 0.8;
    let vy = inDy * 0.8;
    let lastIdx = -1;
    let prevIx = sx;
    let prevIy = sy;
    let reachedWater = false;
    let aborted = false;

    for (let step = 0; step < MAX_STEPS && !aborted; step++) {
      const eL = elevAt(px - 0.5, py);
      const eR = elevAt(px + 0.5, py);
      const eU = elevAt(px, py - 0.5);
      const eD = elevAt(px, py + 0.5);
      const gx = eR - eL;
      const gy = eD - eU;

      vx = vx * DAMP - gx * FORCE;
      vy = vy * DAMP - gy * FORCE;
      vx += (rand() - 0.5) * MEANDER;
      vy += (rand() - 0.5) * MEANDER;

      const speed0 = Math.sqrt(vx * vx + vy * vy);
      if (speed0 > 1.0) {
        vx /= speed0;
        vy /= speed0;
      } else if (speed0 < 0.05) {
        vx += (rand() - 0.5) * 0.4;
        vy += (rand() - 0.5) * 0.4;
      }

      px += vx * STEP_DELTA;
      py += vy * STEP_DELTA;
      if (px < 0) px += width;
      else if (px >= width) px -= width;
      if (py < 0 || py >= height) break;

      const newIx = px | 0;
      const newIy = py | 0;

      // Bresenham line walk from (prevIx, prevIy) to (newIx, newIy). Every
      // intermediate tile is processed, so the river is dense even though
      // each outer iteration physically advances STEP_DELTA tiles.
      let cx = prevIx;
      let cy = prevIy;
      const adx = Math.abs(newIx - prevIx);
      const ady = Math.abs(newIy - prevIy);
      const stx = prevIx < newIx ? 1 : -1;
      const sty = prevIy < newIy ? 1 : -1;
      let err = adx - ady;
      const sp = Math.sqrt(vx * vx + vy * vy) + 1e-6;
      const ndx = vx / sp;
      const ndy = vy / sp;
      const pdx1 = Math.round(-ndy);
      const pdy1 = Math.round(ndx);
      const doWiden2 = rand() < 0.5;

      while (true) {
        const idx = cy * width + cx;
        if (idx !== lastIdx) {
          lastIdx = idx;
          if (kind[idx] === TileKind.Sea) {
            if (step >= MIN_STEPS_BEFORE_EXIT) {
              const ofx = flowX[idx];
              const ofy = flowY[idx];
              if (ofx === 0 && ofy === 0) {
                reachedWater = true;
              } else {
                const ovx = ofx / 100;
                const ovy = ofy / 100;
                if (ndx * ovx + ndy * ovy >= MERGE_COS) reachedWater = true;
              }
            }
            aborted = true;
            break;
          }
          if (kind[idx] !== TileKind.Land) { aborted = true; break; }

          path.push({ idx, dx: ndx, dy: ndy });

          // Always widen ±1, sometimes ±2.
          for (const side of [1, -1]) {
            const wy = cy + pdy1 * side;
            if (wy < 0 || wy >= height) continue;
            let wx = cx + pdx1 * side;
            if (wx < 0) wx += width;
            else if (wx >= width) wx -= width;
            widen.push({ idx: wy * width + wx, dx: ndx, dy: ndy });
          }
          if (doWiden2) {
            for (const side of [2, -2]) {
              const wy = cy + pdy1 * side;
              if (wy < 0 || wy >= height) continue;
              let wx = cx + pdx1 * side;
              if (wx < 0) wx += width;
              else if (wx >= width) wx -= width;
              widen.push({ idx: wy * width + wx, dx: ndx, dy: ndy });
            }
          }
        }

        if (cx === newIx && cy === newIy) break;
        const e2 = err * 2;
        if (e2 > -ady) { err -= ady; cx += stx; }
        if (e2 < adx) { err += adx; cy += sty; }
      }

      prevIx = newIx;
      prevIy = newIy;
    }
    void WIDEN_PROB;

    if (!reachedWater) continue;
    for (const s of path) {
      if (kind[s.idx] === TileKind.Land) {
        kind[s.idx] = TileKind.Sea;
        flowX[s.idx] = Math.round(s.dx * 100);
        flowY[s.idx] = Math.round(s.dy * 100);
      }
      riverMask[s.idx] = 1;
    }
    for (const s of widen) {
      if (kind[s.idx] === TileKind.Land) {
        kind[s.idx] = TileKind.Sea;
        flowX[s.idx] = Math.round(s.dx * 100);
        flowY[s.idx] = Math.round(s.dy * 100);
      }
      riverMask[s.idx] = 1;
    }
    committed++;
  }
}

// --- Border helpers (unchanged behaviour) ---

/** 4-direction neighbors. Left/right edges are world boundaries (no wrap). */
export function neighbors(w: World, idx: number, out: number[]): number {
  const x = idx % w.width;
  const y = (idx / w.width) | 0;
  let n = 0;
  if (x > 0) out[n++] = idx - 1;
  if (x < w.width - 1) out[n++] = idx + 1;
  if (y > 0) out[n++] = idx - w.width;
  if (y < w.height - 1) out[n++] = idx + w.width;
  return n;
}

export function isBorderTile(w: World, idx: number, ownerId: number): boolean {
  const x = idx % w.width;
  const y = (idx / w.width) | 0;
  const W = w.width;
  if (x > 0) {
    const ln = idx - 1;
    if (isOwnable(w.kind[ln]) && w.owner[ln] !== ownerId) return true;
  }
  if (x < W - 1) {
    const rn = idx + 1;
    if (isOwnable(w.kind[rn]) && w.owner[rn] !== ownerId) return true;
  }
  if (y > 0) {
    const un = idx - W;
    if (isOwnable(w.kind[un]) && w.owner[un] !== ownerId) return true;
  }
  if (y < w.height - 1) {
    const dn = idx + W;
    if (isOwnable(w.kind[dn]) && w.owner[dn] !== ownerId) return true;
  }
  return false;
}

// --- Noise helpers ---

function makeNoise(seed: number): (x: number, y: number) => number {
  function hash(ix: number, iy: number): number {
    let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 1000000) / 999999;
  }
  return function (x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const v00 = hash(x0, y0);
    const v10 = hash(x0 + 1, y0);
    const v01 = hash(x0, y0 + 1);
    const v11 = hash(x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  };
}

function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let v = 0;
  let amp = 1;
  let freq = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    v += noise(x * freq, y * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / max;
}
