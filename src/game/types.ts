// Accept HMR silently — module updates are swapped in but no full page
// reload, so editing a file mid-gen doesn't restart the world build. To
// actually apply a code change, hit reload manually.
if (import.meta.hot) import.meta.hot.accept();

export const enum TileKind {
  Sea = 0,
  Ice = 1,
  Mountain = 2,
  Land = 3,
  Forest = 4,
  Bush = 5,
  Snow = 6,
  /** Player-dug pit. Not walkable, not ownable. Holds water via
   *  `world.holeDepth` (max water) and `world.waterLevel` (current).
   *  Holes adjacent to natural Sea draw water from it (infinite source);
   *  other holes only fill via neighbour spread. */
  Hole = 7,
}

export const UNOWNED = 0xffff;

/** True if a player can own / move through this tile. Sea, ice, mountain,
 *  and player-dug holes are impassable. */
export function isOwnable(kind: number): boolean {
  return kind >= TileKind.Land && kind !== TileKind.Hole;
}

/** Biome ids for the Voronoi heat-map. Visual only for now. */
export const enum Biome {
  Desert = 0,
  Forest = 1,
  Taiga = 2,
  Birch = 3,
}
export const BIOME_COUNT = 4;

export interface World {
  width: number;
  height: number;
  /** TileKind per tile, length = width*height. */
  kind: Uint8Array;
  /** Continuous biome heat per tile, 0..255. Renderer blends biome colors. */
  heat: Uint8Array;
  /** Manhattan distance to the nearest coast tile, capped at 250. Used for
   *  shoreline/depth shading: shallow water, sand beaches, deep ocean, etc. */
  coastDist: Uint8Array;
  /** Per-tile ocean floor height (0..255). Voronoi × noise composite —
   *  modulates ocean color brightness within each depth band so the seabed
   *  has underwater hills/trenches instead of being flat. 0 on non-Sea tiles. */
  oceanHeight: Uint8Array;
  /** Unused — kept for compatibility, always zero. Underwater channels were
   *  removed. */
  seaChannel: Uint8Array;
  /** Per-tile mountain density 0..255. Tiles with density > 128 are flipped
   *  to TileKind.Mountain (impassable). Tiles with density 0..128 stay
   *  TileKind.Land but the renderer blends in the mountain texture
   *  proportionally so the ranges fade smoothly into surrounding terrain. */
  mountainDensity: Uint8Array;
  /** Per-Sea-tile distance jitter, signed bytes in roughly ±40. Added to
   *  `coastDist` before the renderer chooses an ocean depth band, so the
   *  shallow / medium / deep transitions follow an organic noisy edge
   *  instead of the diamond iso-curves of the underlying Manhattan
   *  distance. Zero on non-Sea tiles. */
  oceanDistJitter: Int8Array;
  /** 1 = tile is a carved river (Sea kind but villager-passable), 0 = open
   *  ocean. Used by pathing so villagers can ford rivers but not the open
   *  sea, and so the wood-bridge mechanic only converts proper sea tiles
   *  (and not already-passable river tiles) into Land when wood is placed. */
  riverMask: Uint8Array;
  /** Player index per tile, or UNOWNED. */
  owner: Uint16Array;
  /** Garrisoned troops per tile (defenders). */
  troops: Float32Array;
  /** Set of border tile indices for each player (tiles adjacent to non-own ownable or impassable). */
  borders: Set<number>[];
  /** Owned tile count per player. */
  ownedCount: Uint32Array;
  /** Decorative props placed at world-gen (mesa plateaus, spires, rocks). */
  props: WorldProp[];
  /** 1 = tile sits under an impassable prop (volcano / volcano crater).
   *  Pathfinding treats it as blocked so villagers route around the
   *  cone instead of walking through it. Other props (rocks, trees,
   *  mesa decor) are still passable — only the volcano family blocks. */
  blockedByProp: Uint8Array;
  /** Farmland state per tile.
   *   0 = none, 1 = pending (claimed, not yet fertilized), 2 = farmed
   *  (ash-deposited, produces wheat). Tiles flip 1 → 2 when a villager
   *  carrying ash from the home campfire walks onto them. */
  farmlandState: Uint8Array;
  /** Player id that owns this farmland tile, UNOWNED when state == 0. */
  farmlandOwner: Uint16Array;
  /** Per-tile dig depth, 0 means not a hole. Set by the shovel paint
   *  tool, cleared by the shift-fill tool. Depth is computed from the
   *  brushed tile's distance to the nearest non-hole tile, capped at
   *  MAX_HOLE_DEPTH — so deep pits naturally form in the middle of a
   *  large excavation and shallow rims at the edges. */
  holeDepth: Uint8Array;
  /** Per-tile water amount, 0..holeDepth. Filled by `stepWaterFlow`
   *  (engine.ts) — holes adjacent to natural Sea draw from the infinite
   *  ocean; other holes only fill via neighbour-to-neighbour equalisation.
   *  Stored as Float32 so the cellular automaton can transfer fractional
   *  amounts each tick without quantisation jitter. */
  waterLevel: Float32Array;
  /** Seed used to generate this world. Saved to disk so a reload can
   *  regenerate the identical terrain + prop layout via `buildWorld`. */
  worldSeed: number;
}

export interface WorldProp {
  /** Sprite name as registered in textures.ts (e.g. "mesa_plateau1"). */
  sprite: string;
  /** Centre position in tile coordinates. */
  x: number;
  y: number;
  /** Half-width in tiles — sprite spans [x-size, x+size] × [y-size, y+size]. */
  size: number;
}

/** A wild animal wandering the world. Drop-in-place AI:
 *   - idle: stay still for `idleTicks` then pick a fresh nearby goal
 *   - wander: walk straight toward (goalX, goalY) at a slow speed; on
 *             arrival flip back to idle
 *  No combat, no harvesting — wildlife is decorative ambient life. The
 *  sprite is loaded from /IMG/Wildlife/ at worldgen time. */
export interface Animal {
  id: number;
  /** Sprite key registered in textures.ts (e.g. "wildlife_deer"). */
  sprite: string;
  /** Position in tile coords. */
  x: number;
  y: number;
  /** Half-width in tiles — drives both the render bbox and the per-tile
   *  goal-reach check. */
  size: number;
  /** Current behaviour phase. */
  phase: "idle" | "wander";
  /** Random idle countdown when phase === "idle"; on hit-zero the animal
   *  picks a new goal and switches to wander. */
  idleTicks: number;
  /** Wander target in tile coords. */
  goalX: number;
  goalY: number;
  /** Sprite facing: -1 means flipped horizontally so the animal "faces"
   *  its current direction of travel. */
  facing: -1 | 1;
}

/** A piece of volcanic debris in flight. Launched by active volcanoes
 *  in stepVulcanos, ticked each frame, and converted to a crater prop
 *  on landing. Position is interpolated start → target so we get a
 *  natural arc with the visual y-offset computed by the renderer. */
export interface Debris {
  id: number;
  /** Volcano-centre launch position (tile coords). */
  startX: number;
  startY: number;
  /** Where the debris will impact. */
  targetX: number;
  targetY: number;
  /** Sprite drawn while in flight (small rock variant). */
  sprite: string;
  /** Ticks elapsed since launch. */
  age: number;
  /** Total flight duration in ticks. */
  flightTicks: number;
  /** Peak arc height (in render pixels) — used by the renderer for the
   *  parabolic y-offset. */
  peakHeight: number;
  /** Sprite key to stamp at the landing point (a crater variant). */
  landingSprite: string;
  /** Footprint radius of the landing crater in tiles. */
  landingSize: number;
}

/** All resource types harvested or produced in the tribal / medieval eras.
 *  Stored as a Record on each Player so every resource always has a
 *  numeric value (zero by default). Order here drives the BuildHUD pill
 *  layout. */
export const RESOURCE_KEYS = [
  "wood", "rock", "iron", "gold", "diamond",
  "redcrystal", "bluecrystal", "uranium",
  "redberry", "yellowberry", "blueberry",
  "mushroom", "leaves", "ash",
  // Meat workflow: boats + shallow-water huts produce `unpreped_meat`
  // first; a Meat Prep workbench consumes that and emits `meat`. Only
  // `meat` counts as a real food resource — `unpreped_meat` is the
  // pre-processed inventory that the prep stations turn over.
  "meat", "unpreped_meat",
  // Mid-game grain / fruit / baked goods. Wheat is harvested farmland
  // (wheatmill stub for now), processedfruit comes from running berries
  // through a wheatmill, bread comes from running wheat through a
  // bakery.
  "wheat", "processedfruit", "bread",
] as const;
export type ResourceKind = typeof RESOURCE_KEYS[number];

/** Sparse map: only resources with non-zero values need to be present.
 *  Used for building costs + per-tick production tables in catalog.ts. */
export type ResourceMap = Partial<Record<ResourceKind, number>>;

/** Architecture styles. A tribe is locked to its origin-biome's style
 *  set for the rest of the medieval era, so its buildings stay visually
 *  consistent with where it started.
 *  - thatch: dry / cold biomes (desert outer ring, mesa, taiga snowfields).
 *  - desert: hot dry biomes (desert + badlands/mesa).
 *  - birch:  open plains, grassland, beach.
 *  - cabin:  full forest.
 *
 *  A building tagged with no styles is "universal" (any tribe can build
 *  it) — tents, workbenches, and transport sit in that bucket. */
export type ArchStyle = "thatch" | "desert" | "birch" | "cabin";

export interface Player {
  id: number;
  name: string;
  color: string;
  /** Packed RGB for pixel fills, 0xRRGGBB. */
  colorRgb: number;
  isHuman: boolean;
  alive: boolean;
  /** Stockpile of every resource. All RESOURCE_KEYS entries are present;
   *  unharvested resources stay at 0 rather than being undefined. */
  resources: Record<ResourceKind, number>;
  /** Architecture styles unlocked at spawn, decided by the biome the tribe
   *  was founded in. Locked for the entire medieval era — a desert tribe
   *  builds thatch + desert variants for the rest of the game. Empty until
   *  the player has spawned. */
  originStyles: ArchStyle[];
  /** Crafted tools the tribe has produced. Key matches a ToolDef entry
   *  in tools.ts (e.g. "pickaxe", "hoe"). Value = count owned. Villager
   *  pickup logic will pull from this stockpile in a later pass. */
  tools: Record<string, number>;
  /** Total mobile troops the player can deploy in attacks. */
  troopReserve: number;
  /** 0..1 — how much of reserve to commit in an attack. */
  attackRatio: number;
  /** Active outgoing attacks. */
  attacks: Attack[];
  /** Eliminated tick (or -1). */
  eliminatedAt: number;
}

export interface Attack {
  attackerId: number;
  /** Defender id, or UNOWNED for neutral expansion. */
  defenderId: number;
  /** Remaining troops still committed to the attack. */
  remaining: number;
  /** Tiles currently being contested — front of the wave. */
  front: Set<number>;
}

export interface GameConfig {
  worldWidth: number;
  worldHeight: number;
  numBots: number;
  tickMs: number;
}

/** A built structure placed by a player. Stationary, drawn over terrain.
 *  Mirrors WorldProp at the renderer level but lives on game state so it
 *  can be added / removed / tick-updated during play. */
export interface Structure {
  id: number;
  /** Building catalog key (see catalog.ts). */
  defKey: string;
  ownerId: number;
  /** Centre position in tile coordinates. */
  x: number;
  y: number;
  /** Half-width in tiles (sprite extent = ±size). */
  size: number;
  /** Construction progress 0..1. 1 = finished and producing. Missing /
   *  undefined is treated as 1 for back-compat with structures saved
   *  before the build queue landed. */
  buildProgress?: number;
  /** How many worker villagers must be standing inside the build radius
   *  for the construction tick to advance. Default 3 — the user-stated
   *  rule that "the player and ai has to assign 3 or more people to a
   *  build to make it finish". */
  buildersNeeded?: number;
  /** Per-campfire resource stockpile. Populated only on campfire
   *  structures — every other building leaves this undefined. The
   *  player's global `player.resources` is a CACHE that holds the sum
   *  of every campfire inventory, kept fresh by
   *  recomputeAggregateCache() after every credit / debit. Production
   *  credits the nearest campfire to the producing structure; build
   *  costs greedy-drain across campfires so the visible
   *  player.resources value still reflects what's spendable. */
  inventory?: Record<import("./types").ResourceKind, number>;
}

/** Job phase for a villager. Mutated in place by the engine each tick.
 *  Rock mining mirrors the chop loop: walkToRock → mining → walkHome →
 *  deposit. The renderer reuses the chop swing animation for mining so
 *  the player still sees the villager working when they're at the rock. */
export type VillagerJobKind =
  | "idle"
  | "walkToTree" | "chopping"
  | "walkToRock" | "mining"
  | "walkToFarm" | "farming"
  | "walkHome"
  /** Free movement — set by clicking the villager then clicking a
   *  destination. Walks to (targetX, targetY) and goes idle on arrival;
   *  no deposit, no harvest, no patch-follow-up. */
  | "moveTo"
  /** Walking to an unfinished friendly structure to help build it. The
   *  villager joins the build crew once they're within the structure's
   *  build radius; engine increments buildProgress while >= buildersNeeded
   *  workers stand in range. */
  | "walkToBuild" | "building"
  /** Fertilizing the player's pending farmland. Single job kind that
   *  drives a two-phase loop internally: empty-handed → walk to home
   *  campfire to grab ash → carrying ash → walk to nearest pending
   *  farmland tile and flip it to "farmed" on arrival. Repeats until
   *  there are no pending tiles left, then drops to idle. */
  | "fertilizing"
  /** Hunting a wild animal. State machine:
   *  walkToHunt — chase the target animal id; on reach → killHunt for
   *  a few ticks (swing animation) → animal removed from state.animals
   *  + villager gains unpreped_meat in their inventory → walkHome. */
  | "walkToHunt" | "huntingAnimal"
  /** Walking up to a port / airship-port to board. Set by boardVillagerIn*
   *  helpers — instead of teleporting the villager into the dock,
   *  the engine walks them to the structure's entrance and flips
   *  insideStructureId on arrival. boardTargetStructureId stores which
   *  port to head for. */
  | "walkToBoard";

/** Civilian / military assignment for a villager. Workers do harvest jobs
 *  (the existing job state machine); guards stay near home and absorb
 *  incoming-attack damage; army villagers stand by until a tribal attack
 *  is launched at a target, at which point they're consumed by the
 *  combat resolver. Default for newly-spawned villagers is "worker". */
export type VillagerRole = "worker" | "guard" | "army";

/** Weapon a villager fights with. Drives auto-attack cooldown + a small
 *  damage modifier in the per-tick combat scan. Workers default to "bow"
 *  (ranged but slow); guards / army villagers are armed with spears when
 *  promoted (consumes one spear from the tribe's tool pool). The three
 *  wood-unlock specialists ship with their dedicated weapon — torch /
 *  club / sling — instead of the default bow. */
export type VillagerWeapon = "bow" | "spear" | "club" | "torch" | "sling";

/** Pairwise tribal relation. Stored as a signed-byte matrix on GameState
 *  indexed by `[a * playerCount + b]`. */
export const RELATION_WAR = -1;
export const RELATION_NEUTRAL = 0;
export const RELATION_TRUCE = 1;
export const RELATION_ALLY = 2;

/** What the villager is currently harvesting. `walkHome` consults this
 *  on deposit to decide which resource bag to credit. Defaults to wood
 *  for back-compat with existing villager records. `berry` mints a
 *  uniformly-random pick of redberry / blueberry / yellowberry. */
export type HarvestType = "wood" | "rock" | "berry";

/** A villager belonging to a tribe. Has a simple state-machine job that
 *  drives walking, chopping, and depositing wood. All fields are present
 *  even when idle so the engine can branch on `job` cleanly. */
export interface Villager {
  id: number;
  ownerId: number;
  /** Display name. Generated at spawn time from the tribal-name lists in
   *  state.ts; persists across save/load so a villager's identity is
   *  stable for the player. */
  name: string;
  /** Human sprite name (one of the IMG/Humans entries). */
  sprite: string;
  /** Position in tile coords. */
  x: number;
  y: number;
  /** Current job phase. */
  job: VillagerJobKind;
  /** Tree prop being harvested, or -1 when idle/no target. */
  targetPropIdx: number;
  /** World-tile destination when walking. */
  targetX: number;
  targetY: number;
  /** Centre of the current harvest patch — used to find the NEXT tree
   *  after a deposit so the villager keeps clearing the area the player
   *  originally clicked. */
  patchX: number;
  patchY: number;
  /** Ticks of chop work remaining on the current tree. The renderer
   *  swings the villager ±25° every tick during chopping. */
  chopsLeft: number;
  /** Sprite rotation in radians (chop animation). */
  rot: number;
  /** Sprite name to draw in the villager's hands (e.g. "treetump" while
   *  carrying wood back). Omitted when empty-handed. Doubles as the
   *  "has wood in inventory" flag for bridge placement. */
  carryingSprite?: string;
  /** What resource the current harvest job will deposit. Set by
   *  assignTreeChop / assignRockMine at dispatch and read by walkHome's
   *  deposit arm to credit the right resource bag. Defaults to wood
   *  for villagers created before the rock-mining loop landed. */
  harvestType?: HarvestType;
  /** Structure ID the villager is currently inside (e.g. boarded an
   *  airship at the airship port). When set, the villager is not
   *  rendered in the world and is excluded from idle-villager picks.
   *  Disembark by clearing this field. */
  insideStructureId?: number;
  /** A* path the villager is currently following (tile indices). Cleared
   *  when the goal changes; the engine recomputes on demand. */
  pathTiles?: number[];
  /** Index of the next waypoint to walk toward in `pathTiles`. */
  pathIdx?: number;
  /** End-tile of the cached path. Used to detect "goal moved, need a
   *  new path" without comparing the whole array. */
  pathTargetTile?: number;
  /** Civilian / military assignment. Workers harvest, guards defend,
   *  army villagers are stockpiled for offensive attacks. Default
   *  "worker" if unset. */
  role?: VillagerRole;
  /** Weapon used by the per-tick auto-attack scan. Bow is the default
   *  for freshly-spawned villagers; promoting a villager into guard /
   *  army flips this to "spear" while consuming one from the tribe's
   *  tool pool. Wood-unlock specialists (torch / club / sling) ship
   *  with their dedicated weapon. */
  weapon?: VillagerWeapon;
  /** Tick at which this villager is next allowed to fire an auto-attack.
   *  Read by stepCombat — when state.tick >= attackCooldown the villager
   *  scans for the nearest enemy within VILLAGER_ATTACK_RANGE and (if
   *  found) kills it, then sets the next cooldown based on weapon. */
  attackCooldown?: number;
  /** Unfinished structure id this villager is currently helping to build.
   *  Set when job switches to walkToBuild / building; cleared on idle. */
  buildTargetId?: number;
  /** Queue of structure ids the villager will help build NEXT once the
   *  current `buildTargetId` finishes. Each time another build is
   *  dispatched to a villager who's already mid-build, the new target
   *  is appended here instead of interrupting the current one. When a
   *  build completes the engine pops the next id off the queue; only
   *  once the queue is empty does the villager fall back to its
   *  resume-task (original chop / mine / farm). */
  buildQueueIds?: number[];
  /** Animal id this villager is currently chasing / killing. Set when
   *  job switches to walkToHunt / huntingAnimal; cleared on completion. */
  huntTargetAnimalId?: number;
  /** Who put this villager on their current task.
   *   "player" = explicit click by the human, must not be auto-overridden.
   *   "auto"   = dispatched by the Auto-Assign button (or a future
   *              auto-routine); a fresh player click can re-task them.
   *  Cleared on idle. The player-facing dispatch helpers consult this
   *  via findClosestReassignableVillager so a "click a rock" command
   *  steals from auto-assigned workers but never from manually-tasked
   *  ones. */
  assignedBy?: "player" | "auto";
  /** Snapshot of the villager's prior production task — set when they
   *  get pulled off it to help with a build. When the build completes
   *  (or the structure is destroyed) the engine restores these fields
   *  so the villager goes back to harvesting whatever they were doing
   *  before, instead of dropping to idle and standing around. */
  resumeJob?: VillagerJobKind;
  resumeTargetX?: number;
  resumeTargetY?: number;
  resumePatchX?: number;
  resumePatchY?: number;
  resumeHarvestType?: HarvestType;
  /** Set when the villager is `walkToBoard` — the structureId of the
   *  port / airship-port they're heading to. On arrival the engine flips
   *  insideStructureId to this value and clears the field. */
  boardTargetStructureId?: number;
  /** Per-villager inventory bag. Filled by harvest jobs (chop, mine,
   *  farm) and drained only when the villager arrives at their home
   *  base on a walkHome. Items survive task switches — if the player
   *  re-tasks a villager mid-harvest, anything they've already gathered
   *  stays with them until they reach the campfire to deposit. Total
   *  capacity per villager is bounded by VILLAGER_INVENTORY_CAP (20)
   *  units summed across every resource key. */
  inventory?: Partial<Record<ResourceKind, number>>;
}

/** Game era. Drives which buildings are available + which tick rules run.
 *  Tribal: 5-villager spawn, thatch buildings, workbench income.
 *  Medieval / Modern reserved for later phases. */
export const enum Era {
  Tribal = 0,
  Medieval = 1,
  Modern = 2,
}
