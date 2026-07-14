/**
 * Minimal texture loader. Each PNG is decoded once and stored as a 314×314
 * RGB byte array. The renderer samples one pixel per sub-pixel of the
 * offscreen canvas via `sampleTex(name, px, py, out)`.
 *
 * No GPU tricks, no caching, no bitmaps — just pixel data.
 */

// Accept HMR silently — no full reload on save, so an editor auto-save
// can't restart the world build loop.
if (import.meta.hot) import.meta.hot.accept();

// Doubled again (314 → 628 → 1256). Each texture stores ~4.7 MB of RGB
// data (1256² × 3); 10 assets ≈ 47 MB total — fine.
export const TEX_SIZE = 1256;
/** Low-quality companion size used at low zoom. Stored at 1/4 the linear
 *  resolution (1/16 the bytes) and sampled at 1/4 of the input coordinate
 *  so it covers the same world-area as the hi-res copy — the lookup just
 *  reads coarser data. */
export const TEX_SIZE_LO = TEX_SIZE >> 2;

interface Tex {
  data: Uint8Array; // RGB triples, length = N * N * 3, N = TEX_SIZE or TEX_SIZE_LO
}

const textures: Record<string, Tex> = {};
const texturesLo: Record<string, Tex> = {};
const sprites: Record<string, HTMLCanvasElement> = {};
let _ready = false;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

async function loadOne(name: string, file: string): Promise<void> {
  try {
    const img = await loadImage(`/IMG/GT/${encodeURI(file)}`);
    textures[name] = decodeAtSize(img, TEX_SIZE);
    texturesLo[name] = decodeAtSize(img, TEX_SIZE_LO);
  } catch (err) {
    console.warn(`Texture load failed (${name}):`, err);
  }
}

function decodeAtSize(img: HTMLImageElement, size: number): Tex {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Pixel-art mode: nearest-neighbour resampling, no bilinear blur.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size, size);
  const id = ctx.getImageData(0, 0, size, size).data;
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3]     = id[i * 4];
    rgb[i * 3 + 1] = id[i * 4 + 1];
    rgb[i * 3 + 2] = id[i * 4 + 2];
  }
  return { data: rgb };
}

const ASSETS: Array<[string, string]> = [
  ["sand",          "sand.png"],
  ["taiga",         "taigaground.png"],
  ["birch",         "grass.png"],
  ["forest",        "grass.png"],
  ["badlands",      "Meza1.png"],
  ["badlands2",     "Meza2.png"],
  ["desert",        "sand.png"],
  ["snow",          "snowygrass.png"],
  ["mountain",      "Mountains.png"],
  ["ocean_shallow", "shallowwater.png"],
  ["ocean_medium",  "mediumwater.png"],
  ["ocean_deep",    "deepwater.png"],
  // Farmland tile textures — 2×2 matrix of {wet, dry} × {pending,
  // harvested}. The renderer samples one of these for any tile whose
  // farmlandState > 0 based on coastDist + state.
  ["farm_dry_pending",   "drypending.png"],
  ["farm_dry_harvested", "dryharvested.png"],
  ["farm_wet_pending",   "wetpending.png"],
  ["farm_wet_harvested", "Wetharvested.png"],
];

/** Sprites are loaded as full RGBA canvases (alpha preserved) and drawn via
 *  drawImage rather than per-pixel sampled. Used for plateau / spire / rock
 *  props scattered over biomes. Path is relative to /IMG/. */
const SPRITE_ASSETS: Array<[string, string]> = [
  ["mesa_plateau1", "mezaplateu_no_bg_1sgec5w8.png"],
  ["mesa_plateau2", "mezaplateu2_no_bg_9wda14dx.png"],
  ["mesa_plateau3", "mezaplateu3_no_bg_823fn1yr.png"],
  ["mesa_plateau4", "mezaplateu4_no_bg_916xs0n5.png"],
  ["mesa_plateau5", "mezaplateu5_no_bg_aty38prm.png"],
  ["mesa_rock",     "rockmeza_no_bg_hj4am2os.png"],
  ["mesa_spire1",   "spiremeza_no_bg_2oyhph9y.png"],
  ["mesa_spire2",   "spire2meza_no_bg_j49hdw32.png"],
  // Trees + bushes shared across forest / birch / taiga.
  ["tree_taiga",    "taiga.png"],
  ["tree_birch",    "birch.png"],
  ["tree_oak",      "Oak.png"],
  ["bush",          "bush.png"],
  // Inactive plain/island volcano. Placed once at the centre of ~10% of the
  // procedural plate-junction islands, sitting on top of the terrain.
  // Snowy variant is swapped in for volcanoes that spawn in polar latitudes.
  ["vulcano_inactive",       "plainsorislandvulcanoinactive.png"],
  ["vulcano_inactive_snowy", "taigainactivesnowyvulcano.png"],
  // Active variants — sprite-swapped in at worldgen for ~half the
  // volcanoes. The engine treats active volcanoes as eruption emitters
  // (see stepVulcanos in engine.ts).
  ["vulcano_active",         "plainsorislandculvano.png"],
  ["vulcano_active_snowy",   "activesnowvulcaontaiga.png"],
  // Magma crater variants — created when erupted debris lands. The
  // engine pushes one of these into world.props at the impact point.
  ["vulcano_crater1",        "cratervulcano1.png"],
  ["vulcano_crater2",        "vulcanocrater.png"],
  ["vulcano_crater3",        "vulcanocrater.png2.png"],
  ["vulcano_crater4",        "vulcanocrater.png3.png"],
  ["vulcano_crater5",        "vulcanocrater.png4.png"],
  // Magma rocks scattered around active volcanoes at worldgen.
  ["magma_rock1",            "magmarocknearvulcano.png"],
  ["magma_rock2",            "magmarocknearvulcano2.png"],
  ["magma_rock3",            "magmarocknearvulcano3.png"],
  // Post-nuke uranium variants — used as the "cooled-down crater"
  // sprite. After a crater sits for a while the engine swaps the
  // sprite to one of these and adds the prop to harvestable rock
  // pool so the player can mine uranium from them.
  ["uranium_cooled1",        "Uraniumafternuke.png"],
  ["uranium_cooled2",        "Uraniumafternuke3.png"],
  ["uranium_cooled3",        "Uraniumafternuke4.png"],
  ["uranium_cooled_rock",    "Uraniumafternukerock.png"],
  ["uranium_cooled_spire",   "Uraniumafternukespire.png"],
  // --- Wildlife sprites. Filenames match what the user dropped into
  //     /IMG/Wildlife/. `wolf2.png` reads the file with the literal
  //     space + parens — encodeAssetPath handles the URL-escape via
  //     encodeURI.
  ["wildlife_blackbear", "Wildlife/blackbear.png"],
  ["wildlife_brownbear", "Wildlife/brownbear.png"],
  ["wildlife_chicken",   "Wildlife/chicken.png"],
  ["wildlife_chicken2",  "Wildlife/chicken2.png"],
  ["wildlife_cow",       "Wildlife/cow.png"],
  ["wildlife_cow2",      "Wildlife/cow2.png"],
  ["wildlife_goat",      "Wildlife/goat.png"],
  ["wildlife_sheep",     "Wildlife/sheep.png"],
  ["wildlife_wolf",      "Wildlife/wolf.png"],
  ["wildlife_wolf2",     "Wildlife/wolf (2).png"],
  // Standard rock formations — 5 base (gray/brown) shapes. Scattered
  // across forest / birch / taiga as small ground decoration. The
  // berry / mineral / snow / mesa variants share the same 5 shapes and
  // will be added later as their own pools.
  ["rock_arch",       "rockarch.png"],
  ["rock_mound",      "rockmound.png"],
  ["rock_rock",       "rockrock.png"],
  ["rock_spikebatch", "rockspikebatch.png"],
  ["rock_spire",      "rockspire.png"],
  // Epic-rare volcanic rocks. Only spawn on volcano-bearing islands —
  // placed by world.ts in a ring around each volcano sprite.
  ["rock_epic_rare1", "rockepicrare.png"],
  ["rock_epic_rare2", "rockepicrare.png2.png"],
  ["rock_epic_rare3", "rockepicrare.png3.png"],
  ["rock_epic_rare4", "rockepicrare.png4.png"],
  // --- Variant rock families. Each family scatters via its own pass in
  //     world.ts and the engine reads the sprite prefix at mine-deposit
  //     time to credit the appropriate resource. Naming convention:
  //     `<resource>_<shape>` where shape ∈ {arch,mound,rock,spikebatch,
  //     spire}. Yellow-berry has the extra `spike` (no batch). Iron has
  //     no `arch` shape in the source art. The "Uraniumafternuke" files
  //     are intentionally excluded — those land in a later phase. ---
  // Iron (universal, common — 4 shapes, no arch).
  ["iron_mound",      "ironmound.png"],
  ["iron_rock",       "ironrock.png"],
  ["iron_spikebatch", "ironspikebatch.png"],
  ["iron_spire",      "ironspire.png"],
  // Gold (universal, rare).
  ["gold_arch",       "goldarch.png"],
  ["gold_mound",      "goldmound.png"],
  ["gold_rock",       "goldrock.png"],
  ["gold_spikebatch", "goldspikebatch.png"],
  ["gold_spire",      "goldspire.png"],
  // Diamond (universal, very rare).
  ["diamond_arch",       "diamondarch.png"],
  ["diamond_mound",      "diamondmound.png"],
  ["diamond_rock",       "diamondrock.png"],
  ["diamond_spikebatch", "diamondspikebatch.png"],
  ["diamond_spire",      "diamondspire.png"],
  // Uranium — the regular variant. The "afternuke" set is deliberately
  // NOT registered yet per the user's spec.
  ["uranium_arch",       "Uraniumarch.png"],
  ["uranium_mound",      "Uraniummound.png"],    // renamed to drop the stray `#` Vite couldn't decode
  ["uranium_rock",       "Uraniumrock.png"],
  ["uranium_spikebatch", "Uraniumspikebatch.png"],
  ["uranium_spire",      "Uraniumspire.png"],
  // Snowy rocks — visual variant of the standard rock family for cold
  // biomes. Mining yields plain rock (no biome-tied special drop).
  ["rocksnowy_arch",       "rocksnowyarch.png"],
  ["rocksnowy_mound",      "rocksnowymound.png"],
  ["rocksnowy_rock",       "rocksnowyrock.png"],
  ["rocksnowy_spikebatch", "rocksnowyspikebatch.png"],
  ["rocksnowy_spire",      "rocksnowyspire.png"],
  // Berry-bearing rocks — drop one of their respective berries on mine.
  // Filename note: blueberry rocks are spelt "bleuberry" on disk.
  ["redberry_arch",       "redberryarch.png"],
  ["redberry_mound",      "redberrymound.png"],
  ["redberry_rock",       "redberryrock.png"],
  ["redberry_spikebatch", "redberryspikebatch.png"],
  ["redberry_spire",      "redberryspire.png"],
  ["blueberry_arch",       "bleuberryarch.png"],
  ["blueberry_mound",      "bleuberrymound.png"],
  ["blueberry_rock",       "bleuberryrock.png"],
  ["blueberry_spikebatch", "bleuberryspikebatch.png"],
  ["blueberry_spire",      "bleuberryspire.png"],
  ["yellowberry_arch",       "yellowberryarch.png"],
  ["yellowberry_mound",      "yellowberrymound.png"],
  ["yellowberry_rock",       "yellowberryrock.png"],
  ["yellowberry_spike",      "yellowberryspike.png"],
  ["yellowberry_spikebatch", "yellowberryspikebatch.png"],
  // White cloud sprites. Each cloud-patch picks one at random per cloud.
  // cloud3 deliberately omitted — that variant was removed.
  ["cloud1", "cloud.png"],
  ["cloud2", "cloud2.png"],
  ["cloud4", "cloud4.png"],
  ["cloud5", "cloud5.png"],
  // --- Tribal-era buildings (under /IMG/Buildings/). Keys match
  //     catalog.ts entries — `b_*` = base shelter, `wb_*` = workbench. ---
  ["b_tent",            "Buildings/tent.png"],
  ["b_thatch_building", "Buildings/thatchbuilding.png"],
  ["b_thatch_outpost",  "Buildings/thatchoutpost.png"],
  ["b_birch_hut",       "Buildings/birchhut.png"],
  ["b_desert_hut",      "Buildings/deserthut.png"],
  ["b_desert_outpost",  "Buildings/desertoutpost.png"],
  ["b_raft",            "Buildings/raft.png"],
  // Reserved for medieval-era unlocks; loaded now so swapping eras later
  // is free.
  ["b_cabin",           "Buildings/cabin.png"],
  ["b_cabin_alt",       "Buildings/cabin2.png"],
  ["b_cabin_hunters",   "Buildings/cabinhunters.png"],
  ["b_large_cabin",     "Buildings/largecabin.png"],
  ["b_medival_tower",   "Buildings/medivaltower.png"],
  ["b_castle_small",    "Buildings/castlesmall.png"],
  ["b_castle_big",      "Buildings/medivalcastlebig.png"],
  // --- Tribal-era crafting / training shops. All workbench-category
  //     buildings that produce specialty resources or unlock combat
  //     specialists. ---
  ["b_archery_shop",    "Buildings/archeryshop.png"],
  ["b_tool_shop",       "Buildings/toolshop.png"],
  ["b_weaponry",        "Buildings/weaponry.png"],
  ["b_stone_advanced",  "Buildings/stoneprocessingadvanced.png"],
  // --- Naval Ports: one biome-locked variant per architecture style,
  //     matching the galleon pattern. Each tribe sees only the port
  //     that fits their `originStyles`. ---
  ["b_port_birch",     "Buildings/birchport.png"],
  ["b_port_desert",    "Buildings/desertpot.png"],   // user-supplied filename
  ["b_port_thatch",    "Buildings/thatchport.png"],
  ["b_port_cabin",     "Buildings/taigaport.png"],   // forest tribes get the taiga-port aesthetic
  // --- Airship Ports: 4 biome-locked variants matching the ship pattern.
  //     Files don't have biome names in them (except taigaairport*) so
  //     the mapping is arbitrary — adjust if the art clearly belongs
  //     to a different style. ---
  ["b_airship_port_birch",  "Buildings/medivalairport2.png"],
  ["b_airship_port_desert", "Buildings/medivalairport3.png"],
  ["b_airship_port_cabin",  "Buildings/aishipportmedival4.png"],
  ["b_airship_port_thatch", "Buildings/taigaairportmedival.png"],
  // --- Shallow water hut + thatch cabin (other tribal shelters). ---
  ["b_shallow_water_hut", "Buildings/shallowfishinghut.png"],
  ["b_thatch_cabin",      "Buildings/thatchcabin.png"],
  // --- Mid-game production buildings (mills + bakery + trebuchet +
  //     waterwheel). Each is placeable via the build book; per-tick
  //     production is wired in engine.ts. Adjacency buffs (windmill →
  //     farm, woodmill → wood) and trebuchet 3-villager assignment are
  //     follow-ups. ---
  ["b_windmill",   "Buildings/windmill.png"],
  ["b_wheatmill",  "Buildings/wheatmill.png"],
  ["b_stonemill",  "Buildings/stonemill.png"],
  ["b_bakery",     "Buildings/bakery.png"],
  ["b_woodmill",   "Buildings/woodmill.png"],
  ["b_trebuchet",  "Buildings/trebuchet.png"],
  ["b_waterwheel", "Buildings/waterwheel.png"],
  // --- Tool sprites — PNGs now live in IMG/Tools/, so the WorkbenchWindow
  //     cards render real art instead of letter placeholders. ---
  ["tool_pickaxe", "Tools/pick.png"],
  ["tool_hoe",     "Tools/hoe.png"],
  ["tool_shovel",  "Tools/shovel.png"],
  ["tool_spear",   "Tools/spear.png"],
  // --- Galleon ships (4 biome-locked variants, sold at a naval Port). ---
  ["ship_birch",      "Buildings/galeonbirch.png"],
  ["ship_desert",     "Buildings/galeondesert.png"],
  ["ship_forest",     "Buildings/galeonforest.png"],
  ["ship_taiga",      "Buildings/galeontaiga.png"],
  // --- Airships (1 heavy + 4 small, sold at an Airship Port). ---
  ["airship_heavy",   "Buildings/airshipBig.png"],
  ["airship_scout",   "Buildings/airshipSmall.png"],
  ["airship_recon",   "Buildings/airshipSmall (2).png"],
  ["airship_patrol",  "Buildings/airshipSmall (3).png"],
  ["airship_cargo",   "Buildings/airshipSmall (4).png"],
  // --- Destroyed-vessel sprites under /IMG/destroyed/. One per vessel
  //     type so each wreckage reads differently. Used by the shot-down
  //     status in vessels.ts. ---
  ["airship_heavy_destroyed",  "destroyed/airshipBigdestroyed.png"],
  ["airship_scout_destroyed",  "destroyed/airshipsmalldestroyed.png"],
  ["airship_recon_destroyed",  "destroyed/airshipsmall(2)destroyed.png"],
  ["airship_patrol_destroyed", "destroyed/airshipsmall(3)destroyed.png"],
  ["airship_cargo_destroyed",  "destroyed/airshipSmall (4)destroyed.png"],
  // Naval galleon wrecks — one per biome variant, mirroring the live
  // ship sprites in this file.
  ["ship_birch_destroyed",     "destroyed/galeonbirchdestroyed.png"],
  ["ship_desert_destroyed",    "destroyed/galeondesertdestroyed.png"],
  ["ship_forest_destroyed",    "destroyed/galeonforestdestroyed.png"],
  ["ship_taiga_destroyed",     "destroyed/galeontaigadestroyed.png"],
  // --- Trebuchet. Universal anti-airship defensive building. Drop the
  //     PNG at IMG/Buildings/trebuchet.png to make it visible. ---
  ["b_trebuchet", "Buildings/trebuchet.png"],
  // --- Tribal-era workbenches (under /IMG/workbenches/). ---
  ["wb_campfire",   "workbenches/campfire.png"],
  ["wb_hide_prep",  "workbenches/hideprepstation.png"],
  ["wb_meat_prep",  "workbenches/meatprepstation.png"],
  ["wb_stonebench", "workbenches/stonebench.png"],
  ["wb_wood_chop",  "workbenches/woodchopingstation.png"],
  ["wb_wood_stack", "workbenches/woodstack.png"],
  ["wb_workbench", "workbenches/workbench.png"],
  // Carried-item sprites — shown in a villager's hands when they're
  // walking home with a harvest. The misspelt `treetump.png` is the
  // sprite the user wants for the wood-carry. Rockpile is the
  // "carrying a small pile of stones" art (used for every rock variant
  // — diamond / gold / uranium / iron / standard). Mushroom is the
  // catch-all "berry pile" sprite.
  ["treetump", "treetump.png"],
  ["rockpile", "rockpile.png"],
  ["mushroom", "mushrooms.png"],
  // Harvested-stub sprites — drawn in place of a chopped tree or mined
  // rock until the day rollover regrows the prop. Until these landed
  // the chunk repaint just erased the prop, which read as "the rock
  // disappeared". The sprite swap is wired in renderer.paintProps.
  ["treestump",       "treestump.png"],
  ["treestump_snowy", "snowytreestump.png"],
  ["harvested_arch",       "harvestedarch.png"],
  ["harvested_mound",      "harvestedmound.png"],
  ["harvested_rock",       "harvestedrock.png"],
  ["harvested_spikebatch", "harvestedspikebatc.png"], // filename misspelling preserved
  ["harvested_spire",      "harvestedspire.png"],
  // --- Villager humans (under /IMG/Humans/). The ChatGPT-generated
  //     filenames are stable so keys map 1:1 to files. ---
  ["human1", "Humans/ChatGPT Image 5. Juni 2026, 19_02_54 (1)_no_bg_c1s8gtnr.png"],
  ["human2", "Humans/ChatGPT Image 5. Juni 2026, 19_02_54 (2)_no_bg_xlndfxpy.png"],
  ["human3", "Humans/ChatGPT Image 5. Juni 2026, 19_02_56 (3)_no_bg_fbiax6q6.png"],
  ["human4", "Humans/ChatGPT Image 5. Juni 2026, 19_02_56 (4)_no_bg_likomnmp.png"],
  ["human5", "Humans/ChatGPT Image 5. Juni 2026, 19_02_56 (5)_no_bg_mn2vinq8.png"],
  ["human6", "Humans/ChatGPT Image 5. Juni 2026, 19_02_56 (6)_no_bg_5wfw1l7a.png"],
  ["human7", "Humans/ChatGPT Image 5. Juni 2026, 19_02_57 (7)_no_bg_t4epfi1h.png"],
  ["human8", "Humans/ChatGPT Image 5. Juni 2026, 19_02_57 (8)_no_bg_5hiys7cf.png"],
];

/** Sprite-key → public URL lookup. Lets UI code (BuildHUD cards) load
 *  the same PNG that the canvas renderer uses without having to
 *  duplicate the path-building logic from `loadSprite`. */
const SPRITE_PATHS: Record<string, string> = Object.fromEntries(
  SPRITE_ASSETS.map(([key, file]) => [key, `/IMG/${encodeAssetPath(file)}`])
);
export function getSpritePath(name: string): string | undefined {
  return SPRITE_PATHS[name];
}

/** All world props are normalised to this resolution at sprite-load time.
 *  Matches the ground-texture TEX_SIZE class — keeps sprite memory tiny
 *  (~0.4 MB per sprite vs ~6 MB at native 1254², a ~94% cut) and prevents
 *  drawImage from blowing up GPU memory when sprites are scaled wildly to
 *  match large world-space bboxes. Pixel-art look is preserved because the
 *  source PNGs are already coarse and we use nearest-neighbour resampling. */
const SPRITE_RES = 314;

/** encodeURI leaves `#` alone, but in a URL `#` starts the fragment, so
 *  a path like `workbenches/hideprepstation#.png` is silently truncated
 *  to `workbenches/hideprepstation` and the image 404s. We explicitly
 *  percent-encode `#` while leaving `/` intact. */
function encodeAssetPath(file: string): string {
  return encodeURI(file).replace(/#/g, "%23");
}

async function loadSprite(name: string, file: string): Promise<void> {
  try {
    const img = await loadImage(`/IMG/${encodeAssetPath(file)}`);
    const canvas = document.createElement("canvas");
    canvas.width = SPRITE_RES;
    canvas.height = SPRITE_RES;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, SPRITE_RES, SPRITE_RES);
    // Per-sprite post-process: the non-snowy birch sprite has a few near-
    // white bark highlights that pop hard against the surrounding scene
    // and visually distract. Soft-clamp peak channel value so those
    // pixels dim back into the rest of the tree. All three channels are
    // scaled by the same factor so hue is preserved.
    if (name === "tree_birch") {
      const PEAK_CAP = 180;
      const id = ctx.getImageData(0, 0, SPRITE_RES, SPRITE_RES);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const m = Math.max(d[i], d[i + 1], d[i + 2]);
        if (m > PEAK_CAP) {
          const k = PEAK_CAP / m;
          d[i]     = (d[i]     * k) | 0;
          d[i + 1] = (d[i + 1] * k) | 0;
          d[i + 2] = (d[i + 2] * k) | 0;
        }
      }
      ctx.putImageData(id, 0, 0);
    }
    sprites[name] = canvas;
  } catch (err) {
    console.warn(`Sprite load failed (${name}):`, err);
  }
}

export async function loadTextures(): Promise<void> {
  await Promise.all([
    ...ASSETS.map(([name, file]) => loadOne(name, file)),
    ...SPRITE_ASSETS.map(([name, file]) => loadSprite(name, file)),
  ]);
  _ready = true;
}

export function getSprite(name: string): HTMLCanvasElement | null {
  return sprites[name] ?? null;
}

export function texturesReady(): boolean {
  return _ready;
}

/** Sample texture `name` at sub-pixel `(px, py)`. Writes RGB into `out` and
 *  returns true on success, false if the texture isn't loaded. The lookup
 *  wraps modulo TEX_SIZE so neighbouring sub-pixels read neighbouring
 *  texture cells — adjacent tile sub-pixel blocks share an edge in the
 *  source texture. */
export function sampleTex(name: string, px: number, py: number, out: [number, number, number]): boolean {
  const tex = textures[name];
  if (!tex) return false;
  const x = ((px % TEX_SIZE) + TEX_SIZE) % TEX_SIZE;
  const y = ((py % TEX_SIZE) + TEX_SIZE) % TEX_SIZE;
  const off = (y * TEX_SIZE + x) * 3;
  out[0] = tex.data[off];
  out[1] = tex.data[off + 1];
  out[2] = tex.data[off + 2];
  return true;
}

/** Same world-coverage as `sampleTex` but reads from the 1/4-resolution
 *  copy: input coordinates are scaled by 1/4 before the wrap so the lo
 *  texture appears at the same world frequency as the hi version while
 *  using a 16th of the source data. Used by the low-zoom chunk layer. */
export function sampleTexLo(name: string, px: number, py: number, out: [number, number, number]): boolean {
  const tex = texturesLo[name];
  if (!tex) return false;
  const sx = px >> 2;
  const sy = py >> 2;
  const x = ((sx % TEX_SIZE_LO) + TEX_SIZE_LO) % TEX_SIZE_LO;
  const y = ((sy % TEX_SIZE_LO) + TEX_SIZE_LO) % TEX_SIZE_LO;
  const off = (y * TEX_SIZE_LO + x) * 3;
  out[0] = tex.data[off];
  out[1] = tex.data[off + 1];
  out[2] = tex.data[off + 2];
  return true;
}

/** Fast path for the renderer's hot inner loop: returns the raw byte
 *  buffer + size + coordinate shift for a texture, so the per-pixel
 *  paint can read directly with `data[off]` instead of going through
 *  `sampleTex` (function call + hash lookup + modulo per pixel). The
 *  caller is responsible for wrapping coordinates against `size` and
 *  shifting by `shift` (lo layer uses shift=2 to match the 1/4-res
 *  source). */
export interface TexHandle {
  data: Uint8Array;
  size: number;
  shift: number;
}
export function getTexHandle(name: string, lowRes: boolean): TexHandle | null {
  if (lowRes) {
    const t = texturesLo[name];
    return t ? { data: t.data, size: TEX_SIZE_LO, shift: 2 } : null;
  }
  const t = textures[name];
  return t ? { data: t.data, size: TEX_SIZE, shift: 0 } : null;
}
