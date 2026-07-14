import {
  UNOWNED, isOwnable, Era, RESOURCE_KEYS, TileKind,
  RELATION_WAR, RELATION_NEUTRAL, RELATION_TRUCE, RELATION_ALLY,
  type Animal, type ArchStyle, type Attack, type GameConfig, type Player, type ResourceKind,
  type Structure, type Villager, type VillagerJobKind, type VillagerRole, type World,
  type WorldProp,
} from "./types";
import { isBorderTile, neighbors } from "./world";
import { getBuildingDef, HUMAN_SPRITES } from "./catalog";
import { getVesselDef } from "./vessels";

/** A purchased vessel — ship or airship. Tracks ownership, which port
 *  it's docked at, and the slot inside that port (0 = the single parked
 *  spot, 1-3 = rope-tether slots). Boarded villagers are listed by id;
 *  while docked or flying their world position is hidden. Status flips
 *  to "shotdown" when a trebuchet hits a flying airship. */
export interface Vessel {
  id: number;
  defKey: string;
  ownerId: number;
  /** Structure id of the dock this vessel is attached to. -1 once it's
   *  taken off (still owned, no longer at a port). */
  portStructureId: number;
  /** Dock slot. 0 = the parked spot at the port itself, 1-3 = rope
   *  tether slots. Max 1 parked + 3 tethered per port. */
  slot: number;
  status: "docked" | "flying" | "shotdown";
  /** Villager ids on board. */
  boardedVillagerIds: number[];
  /** World position. Ships spawn in the nearest sea tile to the port
   *  on purchase and are drawn at that spot by the structures overlay.
   *  Airships and legacy saves may leave this undefined — the renderer
   *  skips draw when missing. */
  x?: number;
  y?: number;
  /** Locomotion target. Set when an airship launches into flight; the
   *  per-tick step walks (x, y) toward (targetX, targetY) and rerolls
   *  a fresh wander target once the vessel arrives. Stays undefined on
   *  docked or shotdown vessels. */
  targetX?: number;
  targetY?: number;
  /** Cargo hold. Resources loaded onto the vessel at the Load Cargo
   *  page of the PortWindow live here; on Unload (or future
   *  arrive-at-port hook) they get drained back into the player's
   *  resource pool. Defaults to zero on every entry — created lazily
   *  by ensureVesselInventory() so legacy saves keep working. */
  inventory?: Record<ResourceKind, number>;
  /** Ordered waypoints the vessel follows after launch. Per-waypoint
   *  `deboard` flag (true on at most one entry) marks where half of the
   *  boarded crew drops out and the vessel turns around to head back to
   *  its home port. Undefined for vessels without a planned route — the
   *  legacy random-wander behaviour kicks in then. */
  flightPath?: { x: number; y: number; deboard?: boolean }[];
  /** Index into `flightPath` that the vessel is currently heading
   *  toward. Incremented on arrival; once it passes the end, the vessel
   *  turns and returns to `homePortId`. */
  flightPathIdx?: number;
  /** Port the vessel will dock at when its flight ends — captured at
   *  launch time. portStructureId is set to -1 once flying, so this is
   *  the only surviving link back to "where I came from." */
  homePortId?: number;
  /** True once the deboard waypoint has been reached and half the crew
   *  has been ejected. The vessel ignores remaining waypoints in this
   *  state and steers straight for the home port. */
  returningHome?: boolean;
}

/** Total capacity of the vessel cargo hold (sum across all resource
 *  kinds). Tuned so a single Heavy Airship is genuinely useful for
 *  trade without trivialising production. */
export function vesselCargoCap(defKey: string): number {
  const def = getVesselDef(defKey);
  if (!def) return 0;
  if (def.category === "airship") return def.key === "airship_heavy" || def.key === "airship_cargo" ? 400 : 120;
  // Galleon ships carry more bulk than airships.
  if (def.key === "raft") return 60;
  return 600;
}

/** Lazily allocate the cargo hold on a vessel that doesn't have one
 *  yet (older saves). Returns the inventory object so callers can
 *  mutate it directly. */
export function ensureVesselInventory(v: Vessel): Record<ResourceKind, number> {
  if (!v.inventory) v.inventory = makeResourceBag();
  return v.inventory;
}

/** Sum of every resource kind currently aboard the vessel. */
export function vesselCargoUsed(v: Vessel): number {
  if (!v.inventory) return 0;
  let n = 0;
  for (const k of RESOURCE_KEYS) n += v.inventory[k] ?? 0;
  return n;
}

/** Transfer `amount` of `kind` from the player's stockpile onto the
 *  docked vessel. Caps the move by both the player's holdings and the
 *  vessel's remaining cargo space. Returns the actual amount moved. */
export function loadCargoOntoVessel(
  state: GameState, vesselId: number, kind: ResourceKind, amount: number,
): number {
  const v = state.vessels.find((vv) => vv.id === vesselId);
  if (!v || v.status !== "docked") return 0;
  // Pull from the campfire nearest the port the vessel sits at — that's
  // the city the player is loading from. tryDebitFromCampfire makes the
  // debit atomic and updates the player.resources cache.
  const port = state.structuresById?.get(v.portStructureId);
  if (!port) return 0;
  const fire = findNearestCampfire(state, v.ownerId, port.x, port.y);
  if (!fire) return 0;
  const have = fire.inventory?.[kind] ?? 0;
  const cap = vesselCargoCap(v.defKey);
  const used = vesselCargoUsed(v);
  const space = Math.max(0, cap - used);
  const move = Math.min(amount, have, space);
  if (move <= 0) return 0;
  const inv = ensureVesselInventory(v);
  inv[kind] += move;
  tryDebitFromCampfire(state, fire.id, kind, move);
  return move;
}

/** Drain `amount` of `kind` (or all of it if amount === Infinity) off a
 *  docked vessel back into the player's stockpile. Returns the actual
 *  amount unloaded. */
export function unloadCargoFromVessel(
  state: GameState, vesselId: number, kind: ResourceKind, amount: number,
): number {
  const v = state.vessels.find((vv) => vv.id === vesselId);
  if (!v || v.status !== "docked") return 0;
  if (!v.inventory) return 0;
  const have = v.inventory[kind];
  const move = Math.min(amount, have);
  if (move <= 0) return 0;
  // Cargo unloads into the campfire nearest THIS port — so a ship that
  // sailed to City B's port deposits there, completing the inter-city
  // transfer.
  const port = state.structuresById?.get(v.portStructureId);
  if (!port) return 0;
  const fire = findNearestCampfire(state, v.ownerId, port.x, port.y);
  if (!fire) return 0;
  v.inventory[kind] -= move;
  creditToCampfire(state, fire.id, kind, move);
  return move;
}

/** Unload every resource kind on the vessel in one batch. Handy "Unload
 *  All" button hook. */
export function unloadAllCargo(state: GameState, vesselId: number): void {
  const v = state.vessels.find((vv) => vv.id === vesselId);
  if (!v) return;
  for (const k of RESOURCE_KEYS) {
    unloadCargoFromVessel(state, vesselId, k, Infinity);
  }
}

/** Per-port slot capacity. The single parked slot must be filled before
 *  any tether slot is used. */
export const PORT_PARKED_SLOTS = 1;
export const PORT_TETHER_SLOTS = 3;
export const PORT_TOTAL_SLOTS = PORT_PARKED_SLOTS + PORT_TETHER_SLOTS;

/** Empty resource bag — every RESOURCE_KEYS entry initialised to zero. */
function makeResourceBag(): Record<ResourceKind, number> {
  const out = {} as Record<ResourceKind, number>;
  for (const k of RESOURCE_KEYS) out[k] = 0;
  return out;
}

// ----------------------------------------------------------------------
// Per-campfire inventory helpers. Every resource the player has lives
// in one of their campfires' inventories; player.resources is a CACHE
// that sums those inventories so the HUD can keep reading it directly.
// ----------------------------------------------------------------------

/** Find the closest campfire owned by `playerId` to (x, y). Returns
 *  null if the player has no campfires (e.g. before they've spawned). */
export function findNearestCampfire(state: GameState, playerId: number, x: number, y: number): Structure | null {
  let best: Structure | null = null;
  let bestD2 = Infinity;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if (s.defKey !== "campfire") continue;
    const dx = s.x - x;
    const dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best;
}

/** Sum every campfire inventory the player owns into player.resources.
 *  Called after every credit / debit so the HUD reads stay accurate. */
export function recomputeAggregateCache(state: GameState, playerId: number): void {
  const player = state.players[playerId];
  if (!player) return;
  for (const k of RESOURCE_KEYS) player.resources[k] = 0;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if (s.defKey !== "campfire") continue;
    if (!s.inventory) continue;
    for (const k of RESOURCE_KEYS) player.resources[k] += s.inventory[k];
  }
}

/** Add `amount` of `kind` to the campfire NEAREST to (x, y) owned by
 *  `playerId`. Updates the aggregate cache. If the player has no
 *  campfires yet, the credit goes straight to player.resources so
 *  pre-spawn dev-panel grants still work. */
export function creditNearestCampfire(
  state: GameState, playerId: number, x: number, y: number,
  kind: ResourceKind, amount: number,
): void {
  if (amount <= 0) return;
  const fire = findNearestCampfire(state, playerId, x, y);
  if (!fire) {
    state.players[playerId].resources[kind] += amount;
    return;
  }
  if (!fire.inventory) fire.inventory = makeResourceBag();
  fire.inventory[kind] += amount;
  recomputeAggregateCache(state, playerId);
}

/** Try to remove `amount` of `kind` from the aggregate across every
 *  campfire owned by `playerId`. Drains greedily, nearest entries first
 *  in the structure list. Returns true on success — no campfire is
 *  touched if the total isn't enough. Falls through to player.resources
 *  when there are zero campfires (legacy / pre-spawn paths). */
export function tryDebitAggregate(
  state: GameState, playerId: number, kind: ResourceKind, amount: number,
): boolean {
  if (amount <= 0) return true;
  const player = state.players[playerId];
  let total = 0;
  const fires: Structure[] = [];
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if (s.defKey !== "campfire") continue;
    fires.push(s);
    total += s.inventory?.[kind] ?? 0;
  }
  if (fires.length === 0) {
    if (player.resources[kind] < amount) return false;
    player.resources[kind] -= amount;
    return true;
  }
  if (total < amount) return false;
  let remaining = amount;
  for (const s of fires) {
    if (!s.inventory) s.inventory = makeResourceBag();
    const have = s.inventory[kind];
    const take = Math.min(have, remaining);
    if (take > 0) {
      s.inventory[kind] -= take;
      remaining -= take;
    }
    if (remaining <= 0) break;
  }
  recomputeAggregateCache(state, playerId);
  return true;
}

/** Debit `amount` of `kind` from a SPECIFIC campfire by structure id —
 *  used by the cargo loader so the resources actually leave the city
 *  the port belongs to. Returns true if the campfire had enough. */
export function tryDebitFromCampfire(
  state: GameState, structureId: number, kind: ResourceKind, amount: number,
): boolean {
  if (amount <= 0) return true;
  const s = state.structuresById?.get(structureId);
  if (!s || s.defKey !== "campfire") return false;
  const have = s.inventory?.[kind] ?? 0;
  if (have < amount) return false;
  if (!s.inventory) s.inventory = makeResourceBag();
  s.inventory[kind] -= amount;
  recomputeAggregateCache(state, s.ownerId);
  return true;
}

/** Credit `amount` of `kind` to a SPECIFIC campfire by structure id —
 *  used by the cargo unloader so the resources land in the destination
 *  city, not in the player's aggregate. */
export function creditToCampfire(
  state: GameState, structureId: number, kind: ResourceKind, amount: number,
): boolean {
  if (amount <= 0) return false;
  const s = state.structuresById?.get(structureId);
  if (!s || s.defKey !== "campfire") return false;
  if (!s.inventory) s.inventory = makeResourceBag();
  s.inventory[kind] += amount;
  recomputeAggregateCache(state, s.ownerId);
  return true;
}

export interface GameState {
  config: GameConfig;
  world: World;
  players: Player[];
  tick: number;
  /** Tiles whose owner changed this tick — for incremental rendering. */
  dirtyTiles: Set<number>;
  /** Pending end-of-game banner state. */
  winner: number | null;
  /** True once the local human has spawned. */
  humanSpawned: boolean;
  /** Local human player id. */
  humanId: number;
  /** All placed structures, append-only IDs. */
  structures: Structure[];
  /** O(1) id → Structure lookup mirroring the `structures` array. Kept in
   *  sync by every push/splice path so the per-villager engine code (and
   *  the build-queue helpers, port-window flows, etc.) can replace the
   *  prior O(N) `structures.find(s => s.id === X)` with a Map.get — a
   *  noticeable saving once ≥ 200 structures are live across all tribes.
   *  Optional so legacy save shapes don't crash before normalizeResumedState
   *  populates it. */
  structuresById?: Map<number, Structure>;
  /** Per-(ownerId, defKey) bucket index used by the mill-buff lookup
   *  (`countNearbyStructures` in engine.ts). Keyed by `${ownerId}|${defKey}`,
   *  value is the array of matching structures. Maintained by the same
   *  buildStructure / destroyStructure paths as `structuresById`;
   *  rebuilt on resume. Lets the per-tick wood / berry production loops
   *  iterate only the player's own mills (~3 per owner) instead of every
   *  structure on the map (~200 across all tribes). */
  structuresByOwnerKey?: Map<string, Structure[]>;
  /** Indices of farmland tiles currently in `state === 1` (pending the
   *  ash fertilizer). Maintained by paintFarmTile (adds) and the engine's
   *  fertilizing job (deletes when state flips 1 → 2). Lets the per-
   *  villager fertilize dispatch iterate a tiny Set instead of scanning
   *  the entire 7000 × 3500 farmland grid every dispatch. */
  pendingFarmlandTiles?: Set<number>;
  /** Set of farmland tile indices currently considered "wet" — either
   *  within 10 tiles of natural water, or connected via the fine
   *  irrigation-tunnel grid to a wet seed tile (chain of adjacent
   *  farmland propagates the wet flag outward). Used by the renderer to
   *  pick the wet texture variant and by waterFertility to grant full
   *  yield. Maintained incrementally by paintFarmTile + rebuilt on
   *  resume. */
  wetFarmlandTiles?: Set<number>;
  /** Flat xy pairs (Float32) for every volcano cone in world.props, built
   *  once at game-start + resume. Lets the per-structure fertility lookup
   *  iterate ~50 floats instead of scanning the entire world.props array
   *  (which can be 50k+ entries with trees / rocks / etc.) on every
   *  production tick. Stale-on-eruption is fine — new craters don't add
   *  fertility, the original cone keeps providing it. */
  volcanoCenters?: Float32Array;
  /** All villagers across all tribes. */
  villagers: Villager[];
  /** Monotonic IDs for new structures / villagers. */
  nextStructureId: number;
  nextVillagerId: number;
  /** Current game era — drives which buildings are unlocked. */
  era: Era;
  /** Indices into world.props of tree props that have been chopped down.
   *  The renderer skips these on next chunk repaint; the tile box of each
   *  harvested prop is added to dirtyTiles to trigger that repaint. */
  harvestedProps: Set<number>;
  /** Players that have already triggered the "first wood obtained"
   *  unlock — spawning the three specialist villagers exactly once each. */
  unlockedWoodVillagers: Set<number>;
  /** performance.now() at createGame. Used together with the visual
   *  day-night cycle length to detect day rollovers so harvested
   *  biological props (trees, bushes) respawn each new day. */
  startedAtMs: number;
  /** Day count since game start. Engine compares this against the
   *  computed currentDay each tick; when currentDay advances, the
   *  harvestedProps set is cleared and the chunks holding those props
   *  are dirty-marked to repaint them. */
  dayIndex: number;
  /** Pairwise relation matrix, length playerCount². Indexed by
   *  `a * playerCount + b`. Values are RELATION_WAR(-1) /
   *  RELATION_NEUTRAL(0) / RELATION_TRUCE(1) / RELATION_ALLY(2). The
   *  matrix is kept symmetric — `setRelation` writes both sides. */
  relations: Int8Array;
  /** Bot AI cooldown timers (per bot). The bot AI ticks every N game
   *  ticks per-bot to decide on building / harvesting / attacking, and
   *  this array holds the next tick at which each bot is allowed to act
   *  again on that decision lane. Indexed by playerId; humans entries
   *  exist but are ignored. */
  botNextActionTick: Int32Array;
  /** All purchased vessels (ships + airships), append-only by id.
   *  Vessel ownership and dock-slot membership live here rather than on
   *  the Structure record so a single port can hold up to PORT_TOTAL_SLOTS
   *  vessels. */
  vessels: Vessel[];
  /** Monotonic id allocator for new vessels. */
  nextVesselId: number;
  /** Flying volcanic debris currently mid-arc. Spawned by stepVulcanos
   *  from each active volcano on a per-tick chance, ticked forward via
   *  age, and on landing pushed into world.props as a crater prop. */
  debris?: import("./types").Debris[];
  nextDebrisId?: number;
  /** Map propIdx (stringified) → dayIndex at which an active volcano
   *  flips back to inactive. Populated by the daily activation rollover
   *  in engine.ts. Plain object so structured-clone persists it. */
  vulcanoDeactivateOnDay?: Record<string, number>;
  /** Map propIdx (stringified) → tick at which a fresh crater cools to
   *  a mineable uranium variant. Crater props are added to this map by
   *  stepVulcanos when debris lands; once the tick passes, the engine
   *  swaps the sprite to a Uraniumafternuke variant. */
  craterCoolAt?: Record<string, number>;
  /** propIdx of every prop spawned by a volcano (crater + cooled
   *  uranium). The day-rollover regrow pass skips these so volcanic
   *  resources don't replenish daily — they only appear when an
   *  eruption fires fresh ones. */
  volcanicProps?: Set<number>;
  /** Wandering wildlife. Spawned by seedWildlife() at game start and
   *  ticked every frame by stepWildlife(). */
  animals?: import("./types").Animal[];
  nextAnimalId?: number;
  /** Per-tree harvester sets. Map<propIdx, Set<villagerId>>. A tree can
   *  be harvested up to MAX_HARVESTERS_PER_TREE times, but each villager
   *  can only contribute once — so up to four villagers can share one
   *  tree (the user-requested "work together on one tree" rule). When
   *  the set reaches MAX size the tree is added to harvestedProps and
   *  visually removed; the map is cleared on day rollover alongside
   *  harvestedProps so respawned trees are pristine again. */
  treeHarvesters?: Map<number, Set<number>>;
  /** Per-rock remaining mine counter. Map<propIdx, mines_left>. Created
   *  lazily on first mine — absence means the rock is still pristine
   *  (MAX_MINES_PER_ROCK left). The mining-completion handler decrements
   *  the count; when it hits 0 the rock is pushed to harvestedProps and
   *  visually removed. */
  rockMinesLeft?: Map<number, number>;
  /** Props that USED to be berry rocks but have been fully harvested.
   *  Their sprite gets swapped to the equivalent plain `rock_*` variant
   *  on conversion, but they're flagged here so the mining helpers
   *  refuse to dispatch a villager back to them — the empty husk stays
   *  on the map as scenery only. */
  spentRocks?: Set<number>;
  /** Set of tile indices that are currently player-dug holes. Maintained
   *  by paintHole / paintFill so the per-tick water-flow simulation only
   *  walks the (typically small) terraformed set instead of scanning the
   *  whole world. Rebuilt from world.kind on resume. */
  holeTiles?: Set<number>;
  /** Subset of `holeTiles` whose water level is still equilibrating —
   *  either currently wet (waterLevel > 0) or adjacent to a Sea-kind
   *  neighbour (so they'll draw inflow next tick). stepWaterFlow only
   *  iterates this set instead of every dug tile, so a huge dry
   *  excavation that's nowhere near water costs ~zero per tick.
   *  Maintained incrementally by paintHole / paintFill / the flow step
   *  (neighbours of a tile that changes get re-added). Rebuilt on resume. */
  activeWaterTiles?: Set<number>;
  /** When true, the engine recomputes connected-component classification
   *  for hole tiles on the next stepWaterFlow tick. Set by every flow-
   *  changing path: paintHole / paintFill / commitShovelStroke / the
   *  flood-to-Sea promotion in the sim itself. The recompute splits
   *  hole tiles into sea-connected vs isolated bodies so the sim can
   *  skip the expensive volume-conserving redistribute for bodies that
   *  draw from the infinite ocean. */
  waterBodiesDirty?: boolean;
  /** Connected components of hole tiles that DON'T touch natural sea —
   *  finite reservoirs whose water has to be conserved. The sim
   *  redistributes their `volume` across `tiles` each cycle by binary-
   *  searching the surface elevation. Rebuilt by recomputeWaterBodies
   *  whenever waterBodiesDirty is true. */
  isolatedBodies?: { tiles: number[]; capacity: number }[];
  /** Connected components of hole tiles that DO touch natural sea, plus
   *  the count of sea-edge tiles in each body. The sim adds
   *  (seaEdgeCount × SEA_INFLOW_RATE) volume per cycle then runs the
   *  same volume-conservation redistribute as for isolated bodies — so
   *  the deepest tile fills first, matching the user's realistic-fill
   *  request. Rebuilt whenever waterBodiesDirty is true. */
  seaConnectedBodies?: { tiles: number[]; capacity: number; seaEdgeCount: number }[];
  /** Set of tile indices that belong to an isolated (non-sea-connected)
   *  body. Used as a fast filter in the cellular per-tile flow step so
   *  it can SKIP isolated tiles (which are settled by the volume
   *  redistribute, not the cellular pair-wise transfer). */
  isolatedHoleTiles?: Set<number>;
  /** Props currently animating their death — propIdx → startTick. Set
   *  by killProp() instead of writing straight to harvestedProps, so the
   *  renderer can play a flip-and-fade pass before the prop disappears.
   *  Once the animation runs to completion (DEATH_TICKS), the engine's
   *  stepPropDeaths moves the entry to harvestedProps and dirty-marks
   *  the prop's chunks. */
  dyingProps?: Map<number, number>;
  /** performance.now() at the start of the most recent stepGame call.
   *  Lets the renderer interpolate sub-tick animation progress (e.g.
   *  the prop-death flip) instead of stepping in discrete 100 ms chunks
   *  — the difference between a smooth fall at 60 fps and a 10-step
   *  staircase. Optional so legacy saves don't break before resume. */
  lastTickMs?: number;
  /** Per-bot strategic memory. Indexed by playerId; human entries exist
   *  but are ignored. Populated on createGame + normalizeResumedState
   *  for new save shapes, but old saves will hit the lazy-init in the
   *  engine. */
  botMemory?: BotMemory[];
}

/** Strategic personality picked at game start. Drives a bot's lane
 *  weighting for the entire run — aggressors lean military / attack,
 *  builders lean economy / pop cap, traders lean ports + alliances,
 *  opportunists oscillate based on the world state. */
export type BotPersonality = "aggressor" | "builder" | "trader" | "opportunist";

/** Game-phase classifier for a single bot. Drives how botAct weighs
 *  lanes — bootstrap tribes ignore late-game options, imperial tribes
 *  start spending on ports + airships. */
export type BotPhase = "bootstrap" | "industrial" | "military" | "imperial";

export interface BotMemory {
  personality: BotPersonality;
  /** Last tick at which this bot got attacked. Used to ramp defensive
   *  builds (trebuchet, promotions) for a while after a hit. */
  lastAttackedTick: number;
  /** Tick at which this bot's scout cooldown expires — bots roll new
   *  diplomatic actions on a slow cycle so the world doesn't churn. */
  nextScoutTick: number;
  /** Tick of the last successful attack this bot launched. Discourages
   *  re-attacking every tick when an enemy is decimated. */
  lastAttackLaunchedTick: number;
  /** Cached "I am current pursuing this target" id — set by the
   *  diplomacy lane and consumed by the combat lane so the bot focuses
   *  one nation at a time instead of randomly swinging between targets. */
  focusTargetId: number;
}

/** Max number of distinct villagers that can chop a single tree before
 *  it's fully harvested and disappears. The user-requested rule —
 *  "one tree can be harvested 4 times but once per person so that the
 *  villagers can work together on one tree". */
export const MAX_HARVESTERS_PER_TREE = 4;
/** Mines per rock + yield per mine. Rocks now take many smaller bites
 *  instead of a single big swing — 30 mines × 5 yield = 150 total
 *  output per rock, but each individual mine completes faster and
 *  feels less like one villager hogging a giant pile. */
export const MAX_MINES_PER_ROCK = 30;
export const ROCK_YIELD_PER_MINE = 5;
/** Per-villager carrying capacity, summed across every resource line in
 *  their inventory. 20 items ≈ two full trees' worth of wood, so the
 *  natural cap drives the "try to get 2 trees before returning"
 *  behaviour the user asked for without a special-case counter. */
export const VILLAGER_INVENTORY_CAP = 20;

const BOT_NAMES = [
  "Iron Wolves", "Crimson Tide", "Black Lotus", "Azure Star",
  "Stone Order", "Verdant Pact", "Golden Sun", "Frost Horde",
  "Silver Eagle", "Obsidian Guard", "Scarlet Hand", "Jade Throne",
  "Solar Republic", "Vorian League", "Ash Dominion", "Coral Bloc",
];

const PALETTE = [
  "#3aa0ff", "#ff5c5c", "#5ce05c", "#ffd23a",
  "#c34eff", "#ff8a3a", "#00d4c8", "#ff5cb4",
  "#9ad15c", "#5c8aff", "#ff7a7a", "#8a5cff",
  "#3ad1a0", "#ffaa5c", "#5cffd1", "#ff5c8a",
];

export function hexToRgb(hex: string): number {
  const h = hex.replace("#", "");
  return parseInt(h, 16);
}

export function makePlayer(id: number, name: string, color: string, isHuman: boolean): Player {
  return {
    id,
    name,
    color,
    colorRgb: hexToRgb(color),
    isHuman,
    alive: true,
    resources: makeResourceBag(),
    originStyles: [],
    tools: {},
    troopReserve: 0,
    attackRatio: 0.5,
    attacks: [],
    eliminatedAt: -1,
  };
}

/** Read the biome at world (x, y) and return the architecture style set
 *  a tribe founded here gets locked into for the rest of the medieval era.
 *  Mapping:
 *    Snow (kind)           -> thatch          (cold / taiga primitives)
 *    Beach (coastDist <= 5) -> birch          (plains-style wooden shelter)
 *    heat   0.. 28          -> thatch          (taiga)
 *    heat  28.. 88          -> birch           (open plains / grassland)
 *    heat  88..180          -> cabin           (full forest)
 *    heat 180..256          -> thatch + desert (desert + mesa / badlands)
 */
export function styleForTile(world: World, idx: number): ArchStyle[] {
  if (world.kind[idx] === TileKind.Snow) return ["thatch"];
  // Beach + plains birch tribes get the cabin (forest) catalog too —
  // birch on its own has by far the fewest buildings, so they share
  // the forest style for variety. Forest tribes still only get cabin.
  if (world.coastDist[idx] <= 5) return ["birch", "cabin"];
  const heat = world.heat[idx];
  if (heat < 28) return ["thatch"];
  if (heat < 88) return ["birch", "cabin"];
  if (heat < 180) return ["cabin"];
  return ["thatch", "desert"];
}

/** Build the flat xy table of volcano-cone positions from `world.props`.
 *  Used by `state.volcanoCenters` so volcanoFertility can iterate ~50
 *  floats instead of scanning the full prop array. Filtering on the
 *  `vulcano` prefix matches both active + inactive variants. */
function buildVolcanoCenterCache(props: WorldProp[]): Float32Array {
  let n = 0;
  for (const p of props) if (p.sprite.startsWith("vulcano")) n++;
  const out = new Float32Array(n * 2);
  let i = 0;
  for (const p of props) {
    if (!p.sprite.startsWith("vulcano")) continue;
    out[i++] = p.x;
    out[i++] = p.y;
  }
  return out;
}

export function createGame(config: GameConfig, world: World): GameState {
  const numPlayers = config.numBots + 1;
  const players: Player[] = [];
  players.push(makePlayer(0, "You", PALETTE[0], true));
  for (let i = 1; i < numPlayers; i++) {
    players.push(makePlayer(i, BOT_NAMES[(i - 1) % BOT_NAMES.length], PALETTE[i % PALETTE.length], false));
  }
  world.borders = players.map(() => new Set<number>());
  world.ownedCount = new Uint32Array(players.length);
  // Diplomacy: roll initial relations between human and each bot using
  // the user's rules:
  //   - default 50/50 chance of starting at truce vs neutral
  //   - 75% truce chance if the player has more score than the bot
  //   - if the bot is "bigger", still 50/50
  // At game-start everyone is at zero score / size, so the conditional
  // arms collapse to the base 50/50. The conditions kick in dynamically
  // when scouts propose a truce later — see acceptTruceRoll().
  // Bot-vs-bot pairs start neutral; they'll declare war on each other
  // through the AI tick.
  const N = players.length;
  const rel = new Int8Array(N * N);
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      let v: number = RELATION_NEUTRAL;
      const aHuman = players[a].isHuman;
      const bHuman = players[b].isHuman;
      if (aHuman || bHuman) {
        // Human/bot pair: 50/50 baseline truce vs neutral.
        v = Math.random() < 0.5 ? RELATION_TRUCE : RELATION_NEUTRAL;
      }
      rel[a * N + b] = v;
      rel[b * N + a] = v;
    }
  }
  // Seed vulcanoDeactivateOnDay with every initially-active volcano so
  // the sprite-sync step in engine.ts treats them as "logically active"
  // (which lets it swap the sprite to inactive during the day). A very
  // large deactivate-day keeps them effectively permanent — only the
  // dynamic-week rollover entries actually time out.
  const vulcanoDeactivateOnDay: Record<string, number> = {};
  for (let i = 0; i < world.props.length; i++) {
    const s = world.props[i].sprite;
    if (s === "vulcano_active" || s === "vulcano_active_snowy") {
      vulcanoDeactivateOnDay[i] = Number.MAX_SAFE_INTEGER;
    }
  }
  return {
    config,
    world,
    players,
    tick: 0,
    dirtyTiles: new Set(),
    winner: null,
    humanSpawned: false,
    humanId: 0,
    structures: [],
    structuresById: new Map(),
    structuresByOwnerKey: new Map(),
    pendingFarmlandTiles: new Set(),
    wetFarmlandTiles: new Set(),
    volcanoCenters: buildVolcanoCenterCache(world.props),
    villagers: [],
    nextStructureId: 1,
    nextVillagerId: 1,
    era: Era.Tribal,
    harvestedProps: new Set(),
    unlockedWoodVillagers: new Set(),
    startedAtMs: performance.now(),
    dayIndex: 0,
    relations: rel,
    botNextActionTick: new Int32Array(N),
    vessels: [],
    nextVesselId: 1,
    treeHarvesters: new Map(),
    vulcanoDeactivateOnDay,
    craterCoolAt: {},
    volcanicProps: new Set(),
    botMemory: makeBotMemory(players),
    rockMinesLeft: new Map(),
    holeTiles: new Set(),
    activeWaterTiles: new Set(),
    isolatedBodies: [],
    isolatedHoleTiles: new Set(),
    waterBodiesDirty: false,
    dyingProps: new Map(),
    animals: [],
    nextAnimalId: 1,
  };
}

/** One BotMemory per player slot. Humans get a placeholder so the index
 *  matches by id. Personalities are uniformly distributed but biased
 *  toward "opportunist" (the most reactive style) so the world doesn't
 *  feel like every bot is the same monolithic adversary. */
function makeBotMemory(players: Player[]): BotMemory[] {
  const personalities: BotPersonality[] = ["aggressor", "builder", "trader", "opportunist"];
  return players.map((p) => ({
    personality: p.isHuman
      ? "opportunist"  // unused — humans bypass the bot lanes
      : personalities[(Math.random() * personalities.length) | 0],
    lastAttackedTick: -10_000,
    nextScoutTick: 0,
    lastAttackLaunchedTick: -10_000,
    focusTargetId: -1,
  }));
}

/** Normalise a freshly-loaded GameState so the in-memory invariants
 *  match a brand-new game. Resumed sessions need this because:
 *   - `state.startedAtMs` was captured against the OLD page session's
 *     `performance.now()` clock and is meaningless now — left untouched
 *     the day-rollover check computes a wild day index, which on the
 *     first tick triggers respawnBiologicals on the entire harvested
 *     prop set and freezes the frame.
 *   - `state.botNextActionTick` may be out of sync. Zeroing every
 *     entry makes bots act on the first post-resume tick instead of
 *     waiting out a stale cooldown that never advances during the page
 *     reload pause. Without this bots looked completely stuck on
 *     resume.
 *   - `state.treeHarvesters` + `inventory` were added in this round;
 *     ensure they exist so the new code doesn't crash on a legacy
 *     save shape. Safe to call on a fresh state too (idempotent). */
export function normalizeResumedState(state: GameState): void {
  state.startedAtMs = performance.now() - (state.dayIndex ?? 0) * 60 * 60 * 1000;
  const N = state.players.length;
  if (!(state.botNextActionTick instanceof Int32Array) || state.botNextActionTick.length !== N) {
    state.botNextActionTick = new Int32Array(N);
  } else {
    state.botNextActionTick.fill(0);
  }
  if (!state.treeHarvesters) state.treeHarvesters = new Map();
  if (!state.rockMinesLeft) state.rockMinesLeft = new Map();
  if (!state.spentRocks) state.spentRocks = new Set();
  if (!state.harvestedProps) state.harvestedProps = new Set();
  if (!state.unlockedWoodVillagers) state.unlockedWoodVillagers = new Set();
  if (!state.dirtyTiles) state.dirtyTiles = new Set();
  // Terraform arrays — present from worldgen now, but legacy saves
  // serialised before the feature shipped won't carry them. Reallocate
  // empty arrays of the right size so the engine + renderer can index
  // safely on the first post-resume tick.
  const T = state.world.width * state.world.height;
  if (!state.world.holeDepth || state.world.holeDepth.length !== T) {
    state.world.holeDepth = new Uint8Array(T);
  }
  if (!state.world.waterLevel || state.world.waterLevel.length !== T) {
    state.world.waterLevel = new Float32Array(T);
  }
  // holeTiles is the fast-iterate set the engine's water-flow step uses.
  // Always rebuild it from world.kind on resume — cheaper than trusting
  // whatever's on disk, and guarantees consistency if the kind array was
  // edited externally (e.g. a save-format upgrade).
  state.holeTiles = new Set();
  for (let i = 0; i < T; i++) {
    if (state.world.kind[i] === TileKind.Hole) state.holeTiles.add(i);
  }
  // activeWaterTiles = hole tiles that are wet (waterLevel > 0) or
  // adjacent to a Sea neighbour. Rebuilt from scratch so the flow step
  // can pick up exactly where it left off, with no stale entries that
  // would force iteration on unreachable inland pits.
  state.dyingProps = new Map();
  state.activeWaterTiles = new Set();
  const W = state.world.width;
  const H = state.world.height;
  for (const idx of state.holeTiles) {
    if (state.world.waterLevel[idx] > 0) {
      state.activeWaterTiles.add(idx);
      continue;
    }
    const tx = idx % W;
    const ty = (idx / W) | 0;
    if (tx > 0       && state.world.kind[idx - 1] === TileKind.Sea) { state.activeWaterTiles.add(idx); continue; }
    if (tx < W - 1   && state.world.kind[idx + 1] === TileKind.Sea) { state.activeWaterTiles.add(idx); continue; }
    if (ty > 0       && state.world.kind[idx - W] === TileKind.Sea) { state.activeWaterTiles.add(idx); continue; }
    if (ty < H - 1   && state.world.kind[idx + W] === TileKind.Sea) { state.activeWaterTiles.add(idx); }
  }
  // structuresById is a derived index — never serialised, always rebuilt
  // here from the canonical structures array so id → Structure lookups
  // are O(1) for the rest of the session. Same story for the per-
  // (owner | defKey) bucket — small enough to rebuild cheaply.
  state.structuresById = new Map();
  state.structuresByOwnerKey = new Map();
  for (const s of state.structures) {
    state.structuresById.set(s.id, s);
    const okKey = s.ownerId + "|" + s.defKey;
    let bucket = state.structuresByOwnerKey.get(okKey);
    if (!bucket) { bucket = []; state.structuresByOwnerKey.set(okKey, bucket); }
    bucket.push(s);
  }
  // Volcano-centre cache for volcanoFertility(). Worldgen places cones
  // first in world.props but the array also accumulates eruption craters
  // and decorative props — filter once here so the fertility loop iterates
  // a tiny xy table instead of a 50k-prop array.
  state.volcanoCenters = buildVolcanoCenterCache(state.world.props);
  // Same story for pendingFarmlandTiles — rebuild from the farmland
  // arrays so findClosestPendingFarmland doesn't have to scan the entire
  // world looking for state===1 tiles.
  state.pendingFarmlandTiles = new Set();
  for (let i = 0; i < T; i++) {
    if (state.world.farmlandState[i] === 1) state.pendingFarmlandTiles.add(i);
  }
  // Rebuild the wet-farmland set: BFS from every shore-adjacent farmland
  // tile (coastDist ≤ 10) outward through 4-neighbour farmland chains
  // of the same owner. Lets the renderer + waterFertility read the
  // "tunnel network is wet" answer in O(1) without re-flooding every
  // tick.
  state.wetFarmlandTiles = new Set();
  const W2 = state.world.width;
  const H2 = state.world.height;
  const queue: number[] = [];
  for (let i = 0; i < T; i++) {
    if (state.world.farmlandState[i] === 0) continue;
    if (state.world.coastDist[i] <= 10) {
      state.wetFarmlandTiles.add(i);
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const q = queue[head++];
    const qx = q % W2;
    const qy = (q / W2) | 0;
    const owner = state.world.farmlandOwner[q];
    const nbs = [
      qx > 0       ? q - 1 : -1,
      qx < W2 - 1  ? q + 1 : -1,
      qy > 0       ? q - W2 : -1,
      qy < H2 - 1  ? q + W2 : -1,
    ];
    for (const n of nbs) {
      if (n < 0) continue;
      if (state.wetFarmlandTiles.has(n)) continue;
      if (state.world.farmlandState[n] === 0) continue;
      if (state.world.farmlandOwner[n] !== owner) continue;
      state.wetFarmlandTiles.add(n);
      queue.push(n);
    }
  }
  for (const v of state.villagers) {
    if (!v.inventory) v.inventory = {};
  }
  // Bot memory was added after the original save schema. Backfill for
  // legacy saves AND resize to match the current player count.
  if (!state.botMemory || state.botMemory.length !== state.players.length) {
    state.botMemory = makeBotMemory(state.players);
  } else {
    for (const m of state.botMemory) {
      m.nextScoutTick = 0;        // act on the first post-resume scout window
      // Don't reset focusTargetId — preserve any war the bot was pursuing.
    }
  }
}

/** Read the relation between two players. Symmetric — order doesn't
 *  matter. Returns RELATION_NEUTRAL for self-pairs. */
export function getRelation(state: GameState, a: number, b: number): number {
  if (a === b) return RELATION_NEUTRAL;
  const N = state.players.length;
  return state.relations[a * N + b];
}

/** Set the relation between two players. Writes both sides of the matrix
 *  so future reads in either direction agree. */
export function setRelation(state: GameState, a: number, b: number, v: number): void {
  if (a === b) return;
  const N = state.players.length;
  state.relations[a * N + b] = v;
  state.relations[b * N + a] = v;
}

/** Sum of villager-class strengths for one tribe. Each role contributes
 *  a base attack/defense value; tools and unit specialisation will scale
 *  these in a later pass. */
export function getArmyStrength(state: GameState, playerId: number): number {
  let s = 0;
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if ((v.role ?? "worker") === "army") s += 10;
  }
  return s;
}
export function getGuardStrength(state: GameState, playerId: number): number {
  let s = 0;
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if ((v.role ?? "worker") === "guard") s += 8;
  }
  return s;
}

/** Score for "how well a tribe is doing" — used by the InfoBook display
 *  and the truce-acceptance roll. Resources are intentionally NOT
 *  counted: a stockpile of wood doesn't mean a kingdom is strong, and
 *  including them made bots with huge hoards look like superpowers
 *  while their actual footprint was tiny. The components are the things
 *  that actually represent tribe strength:
 *    - villagers ×  5 each (population is the core engine)
 *    - structures × 10 each finished build (territorial / industrial reach)
 *    - vessels ×    15 each docked or flying (fleet projection)
 *    - owned tile count × 0.05 (territory; small per-tile weight because
 *      the count is in the thousands for any decent tribe)
 *  Tunable per-tribe-strength metric — adjust the weights here, not in
 *  the call sites. */
export function getPlayerScore(state: GameState, playerId: number): number {
  let total = 0;
  const villagerCount = state.villagers.filter((v) => v.ownerId === playerId).length;
  total += villagerCount * 5;
  let finishedStructures = 0;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if ((s.buildProgress ?? 1) < 1) continue;
    finishedStructures++;
  }
  total += finishedStructures * 10;
  let vesselCount = 0;
  for (const v of state.vessels) {
    if (v.ownerId !== playerId) continue;
    if (v.status === "shotdown") continue;
    vesselCount++;
  }
  total += vesselCount * 15;
  // Owned-tile count lives on world.ownedCount[playerId]. Fall back to
  // 0 if that field hasn't been populated yet (very early in worldgen).
  const owned = state.world.ownedCount?.[playerId] ?? 0;
  total += owned * 0.05;
  return total;
}

/** Roll for a scout-proposed truce/alliance accept by `botId` toward
 *  `proposerId`. Implements the user-specified rules:
 *    - default chance: 50%
 *    - if proposer has more score than bot: 75%
 *    - if bot is bigger (more villagers): clamp at 50% even if score-rule
 *      would push it higher
 */
export function acceptTruceRoll(state: GameState, botId: number, proposerId: number): boolean {
  let p = 0.5;
  const proposerScore = getPlayerScore(state, proposerId);
  const botScore = getPlayerScore(state, botId);
  if (proposerScore > botScore) p = 0.75;
  const proposerVillagers = state.villagers.filter((v) => v.ownerId === proposerId).length;
  const botVillagers = state.villagers.filter((v) => v.ownerId === botId).length;
  if (botVillagers > proposerVillagers) p = Math.min(p, 0.5);
  return Math.random() < p;
}

/** Player-initiated scout actions. War declarations always succeed (and
 *  hand the attacker a damage boost on the next tribal attack, applied
 *  inside launchTribalAttack). Truces and alliances roll
 *  `acceptTruceRoll` against the target bot; on a miss the relation
 *  stays where it was. Returns the new relation state for UI feedback. */
export function scoutDeclareWar(state: GameState, fromId: number, targetId: number): number {
  setRelation(state, fromId, targetId, RELATION_WAR);
  return RELATION_WAR;
}
export function scoutProposeTruce(state: GameState, fromId: number, targetId: number): number {
  if (acceptTruceRoll(state, targetId, fromId)) {
    setRelation(state, fromId, targetId, RELATION_TRUCE);
    return RELATION_TRUCE;
  }
  return getRelation(state, fromId, targetId);
}
export function scoutProposeAlliance(state: GameState, fromId: number, targetId: number): number {
  // Alliance is a stricter version of the truce roll — proposer needs to
  // be doing well enough that the bot wants to bind itself. We just reuse
  // the truce roll and only succeed if it does AND a second coin flip
  // passes, so alliances are roughly half as common as truces.
  if (acceptTruceRoll(state, targetId, fromId) && Math.random() < 0.5) {
    setRelation(state, fromId, targetId, RELATION_ALLY);
    return RELATION_ALLY;
  }
  return getRelation(state, fromId, targetId);
}

/** Count villagers a player has in each role. Used by the info-book UI. */
export function countRoles(state: GameState, playerId: number): Record<VillagerRole, number> {
  const out: Record<VillagerRole, number> = { worker: 0, guard: 0, army: 0 };
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    out[v.role ?? "worker"]++;
  }
  return out;
}

/** Cycle a villager's role on click: worker → guard → army → worker.
 *  Promoting INTO guard or army arms the villager with a spear, consuming
 *  one from the tribe's tool pool (player.tools.spear). Returns:
 *   - "ok"        — role flipped successfully
 *   - "no_spear"  — caller asked to promote but the tribe has no spear
 *                   available; role is left unchanged so the UI can
 *                   surface a "Requires Spear" toast. Demotion back to
 *                   worker is always free and never fails. The villager's
 *                   weapon resets to "bow" on demotion (the spear is
 *                   spent, not returned). */
export type RoleCycleResult = "ok" | "no_spear";
export function cycleVillagerRole(state: GameState, v: Villager): RoleCycleResult {
  const cur = v.role ?? "worker";
  const owner = state.players[v.ownerId];
  const next = cur === "worker" ? "guard" : cur === "guard" ? "army" : "worker";
  if (next === "guard" && cur === "worker") {
    // worker → guard: consume one spear from the pool. The previous
    // weapon (typically a bow) is dropped — combatants only fight with
    // spears in the tribal era.
    const have = owner.tools.spear ?? 0;
    if (have <= 0) return "no_spear";
    owner.tools.spear = have - 1;
    v.weapon = "spear";
  }
  // guard → army keeps the existing spear (no extra consumption); the
  // weapon doesn't change between the two combat roles.
  if (next === "worker") {
    // army → worker: the spear is spent / lost. Reset to bow so the
    // demoted villager auto-attacks at the worker cooldown.
    v.weapon = "bow";
  }
  v.role = next;
  return "ok";
}

/** Find the villager whose body the click landed on, if any. Used by App
 *  to wire the click-to-cycle-role gesture. */
export function villagerAt(state: GameState, wx: number, wy: number, radius: number = 6): Villager | null {
  let best: Villager | null = null;
  let bestD2 = radius * radius;
  for (const v of state.villagers) {
    if (v.insideStructureId !== undefined) continue;
    const dx = wx - v.x;
    const dy = wy - v.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = v; }
  }
  return best;
}

/** Issue a free-move order to a specific villager. Sets job=moveTo
 *  with (x, y) as destination, clears the harvest type so walkHome's
 *  deposit logic doesn't fire on the way. Returns true if the villager
 *  was found and the order accepted. Used by the click-villager →
 *  click-world player gesture. */
export function moveVillagerTo(state: GameState, villagerId: number, x: number, y: number): boolean {
  const v = state.villagers.find((vv) => vv.id === villagerId);
  if (!v) return false;
  if (v.insideStructureId !== undefined) return false;
  v.job = "moveTo";
  v.targetX = x;
  v.targetY = y;
  v.targetPropIdx = -1;
  v.harvestType = undefined;
  // moveTo is explicitly player-driven — tagged as such so the next
  // Auto-Assign click won't yank them off this destination.
  v.assignedBy = "player";
  // Inventory + carry sprite are PRESERVED across the task switch — if
  // the player re-tasks a villager mid-chop the wood they've already
  // gathered stays with them until they reach the campfire to deposit.
  return true;
}

/** Cancel whatever the villager is currently doing and drop them back to
 *  idle. Used by the "Stop Task" button on the SelectedVillagerCard so
 *  the player can re-task a busy worker without having to wait for the
 *  chop / mine / farm loop to finish. */
export function stopVillagerTask(state: GameState, villagerId: number): boolean {
  const v = state.villagers.find((vv) => vv.id === villagerId);
  if (!v) return false;
  if (v.insideStructureId !== undefined) return false;
  v.job = "idle";
  v.targetPropIdx = -1;
  v.targetX = v.x;
  v.targetY = v.y;
  v.patchX = v.x;
  v.patchY = v.y;
  v.chopsLeft = 0;
  v.rot = 0;
  v.harvestType = undefined;
  v.assignedBy = undefined;
  // Inventory + carry sprite stay — Stop Task interrupts the loop but
  // the player doesn't lose what's already been gathered.
  v.pathTiles = undefined;
  v.pathIdx = undefined;
  v.pathTargetTile = undefined;
  return true;
}

/** Tribal-era combat resolver. The attacker spends a fraction of their
 *  army strength against the defender's guards + half the defender's
 *  army (defenders fight at home with a guard bonus). Casualties are
 *  realised by removing villagers from `state.villagers` — roles consumed
 *  proportionally so a tribe with mostly army takes army losses, etc.
 *  Returns true if the attack landed (won), false if it bounced. */
export function launchTribalAttack(state: GameState, attackerId: number, defenderId: number): boolean {
  if (attackerId === defenderId) return false;
  const atk = getArmyStrength(state, attackerId);
  const def = getGuardStrength(state, defenderId) + getArmyStrength(state, defenderId) * 0.5;
  if (atk <= 0) return false;
  const atWar = getRelation(state, attackerId, defenderId) === RELATION_WAR;
  // Declared-war attackers hit 25% harder. Sneak attacks (no war flag)
  // still go through but don't get the bonus.
  const atkPower = atk * (atWar ? 1.25 : 1.0);
  const won = atkPower > def;
  // Casualty share: winner takes 20% losses, loser 50%.
  const atkLossFrac = won ? 0.2 : 0.5;
  const defLossFrac = won ? 0.5 : 0.2;
  killVillagers(state, attackerId, atkLossFrac);
  killVillagers(state, defenderId, defLossFrac);
  // Sneak-attacking a truced/allied tribe drops you to war automatically.
  if (!atWar) setRelation(state, attackerId, defenderId, RELATION_WAR);
  // Strategic-memory hooks for the AI: defender remembers being hit so
  // its botAct ramps reactive defense; attacker logs when it landed
  // a swing so it doesn't spam attacks every tick.
  if (state.botMemory) {
    const dm = state.botMemory[defenderId];
    if (dm) dm.lastAttackedTick = state.tick;
    const am = state.botMemory[attackerId];
    if (am) am.lastAttackLaunchedTick = state.tick;
  }
  return won;
}

function killVillagers(state: GameState, playerId: number, frac: number): void {
  // Remove `frac` of the player's villagers (rounded). Prefer army first,
  // then guard, then workers — combatants take the hit.
  const owned = state.villagers
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.ownerId === playerId);
  if (owned.length === 0) return;
  const toKill = Math.min(owned.length, Math.ceil(owned.length * frac));
  const priority = (v: Villager): number =>
    v.role === "army" ? 0 : v.role === "guard" ? 1 : 2;
  owned.sort((a, b) => priority(a.v) - priority(b.v));
  const killSet = new Set<number>();
  for (let k = 0; k < toKill; k++) killSet.add(owned[k].i);
  state.villagers = state.villagers.filter((_, i) => !killSet.has(i));
}

export function claimTile(state: GameState, idx: number, newOwner: number, garrison: number): void {
  const w = state.world;
  if (!isOwnable(w.kind[idx])) return;
  const prev = w.owner[idx];
  if (prev === newOwner) {
    w.troops[idx] += garrison;
    return;
  }
  if (prev !== UNOWNED) {
    w.ownedCount[prev]--;
    w.borders[prev].delete(idx);
  }
  w.owner[idx] = newOwner;
  w.troops[idx] = garrison;
  w.ownedCount[newOwner]++;
  state.dirtyTiles.add(idx);

  const nbuf: number[] = [];
  const nlen = neighbors(w, idx, nbuf);

  if (isBorderTile(w, idx, newOwner)) {
    w.borders[newOwner].add(idx);
  } else {
    w.borders[newOwner].delete(idx);
  }

  for (let i = 0; i < nlen; i++) {
    const n = nbuf[i];
    if (!isOwnable(w.kind[n])) continue;
    const o = w.owner[n];
    if (o === UNOWNED) continue;
    if (isBorderTile(w, n, o)) {
      w.borders[o].add(n);
    } else {
      w.borders[o].delete(n);
    }
  }
}

/** Tribal-era spawn: plant a tent at the chosen tile and stand 5 villagers
 *  around it in a small ring. No tile claim — territory in the tribal era
 *  is implied by the convex hull of a tribe's buildings (a later phase
 *  will compute and enforce that). Returns true if successful. */
/** Minimum coast-distance the founding campfire tile must clear so the
 *  ring of 4 villagers (RING_R = 14) plus a small safety margin all
 *  sit on land. `coastDist` is measured in tiles, so 25 puts the
 *  campfire well clear of any beach / shallow-water tile. */
export const SPAWN_MIN_COAST_DIST = 25;

// ----------------------------------------------------------------------
// Wildlife — decorative wandering animals scattered at game-start in
// each tree biome. No combat / harvest / collisions; the AI is just a
// 2-phase wander (idle → pick goal → walk → idle). Engine calls
// stepWildlife() once per tick.
// ----------------------------------------------------------------------
const WILDLIFE_SPRITES_BY_HEAT: Array<{ heatMin: number; heatMax: number; sprites: string[] }> = [
  // Taiga: predators + bears that read against snow.
  { heatMin: 0,  heatMax: 32,  sprites: ["wildlife_wolf", "wildlife_wolf2", "wildlife_brownbear", "wildlife_blackbear"] },
  // Birch (plains): farm-style herd animals — sheep, cows, goats, hens.
  { heatMin: 28, heatMax: 92,  sprites: ["wildlife_sheep", "wildlife_cow", "wildlife_cow2", "wildlife_goat", "wildlife_chicken", "wildlife_chicken2"] },
  // Forest: bears + wolves + a few foraging goats/chickens.
  { heatMin: 85, heatMax: 184, sprites: ["wildlife_blackbear", "wildlife_brownbear", "wildlife_wolf", "wildlife_goat", "wildlife_chicken"] },
];
const WILDLIFE_DENSITY = 0.000004;  // animals per tile, world-wide
const WILDLIFE_IDLE_TICKS_MIN = 80;
const WILDLIFE_IDLE_TICKS_MAX = 300;
const WILDLIFE_WANDER_RADIUS_MIN = 8;
const WILDLIFE_WANDER_RADIUS_MAX = 24;
/** Wander speed in tiles per tick. Roughly 1/4 villager speed — animals
 *  meander rather than dash. */
const WILDLIFE_SPEED = 0.4;

/** Seed wildlife at game-start. Scans random tiles and drops an animal
 *  if the tile is ownable land in a heat band that supports wildlife.
 *  Cap the total around WILDLIFE_DENSITY × world area. */
export function seedWildlife(state: GameState): void {
  if (!state.animals) state.animals = [];
  if (!state.nextAnimalId) state.nextAnimalId = 1;
  const w = state.world;
  const target = Math.floor(w.width * w.height * WILDLIFE_DENSITY);
  const attempts = target * 30;
  for (let i = 0; i < attempts && state.animals.length < target; i++) {
    const tx = (Math.random() * w.width) | 0;
    const ty = (Math.random() * w.height) | 0;
    const idx = ty * w.width + tx;
    if (!isOwnable(w.kind[idx])) continue;
    if (w.blockedByProp && w.blockedByProp[idx]) continue;
    const heat = w.heat[idx];
    const band = WILDLIFE_SPRITES_BY_HEAT.find((b) => heat >= b.heatMin && heat <= b.heatMax);
    if (!band) continue;
    const sprite = band.sprites[(Math.random() * band.sprites.length) | 0];
    state.animals.push({
      id: state.nextAnimalId++,
      sprite,
      x: tx + 0.5,
      y: ty + 0.5,
      size: 4,
      phase: "idle",
      idleTicks: WILDLIFE_IDLE_TICKS_MIN + ((Math.random() * (WILDLIFE_IDLE_TICKS_MAX - WILDLIFE_IDLE_TICKS_MIN)) | 0),
      goalX: tx + 0.5,
      goalY: ty + 0.5,
      facing: Math.random() < 0.5 ? -1 : 1,
    });
  }
}

/** Advance every animal by one tick. Idle → countdown to 0 → pick a
 *  fresh random goal within WILDLIFE_WANDER_RADIUS and switch to
 *  wander. Wander → step `WILDLIFE_SPEED` toward goal; on arrival,
 *  back to idle with a new random countdown. */
export function stepWildlife(state: GameState): void {
  if (!state.animals || state.animals.length === 0) return;
  const w = state.world;
  for (const a of state.animals) {
    if (a.phase === "idle") {
      a.idleTicks--;
      if (a.idleTicks <= 0) {
        const ang = Math.random() * Math.PI * 2;
        const r = WILDLIFE_WANDER_RADIUS_MIN + Math.random() * (WILDLIFE_WANDER_RADIUS_MAX - WILDLIFE_WANDER_RADIUS_MIN);
        const gx = Math.max(0, Math.min(w.width  - 1, a.x + Math.cos(ang) * r));
        const gy = Math.max(0, Math.min(w.height - 1, a.y + Math.sin(ang) * r));
        // If the candidate goal lands on impassable terrain, abandon the
        // pick and keep idling — we'll try again next tick.
        const gidx = (gy | 0) * w.width + (gx | 0);
        if (!isOwnable(w.kind[gidx]) || (w.blockedByProp && w.blockedByProp[gidx])) {
          a.idleTicks = WILDLIFE_IDLE_TICKS_MIN + ((Math.random() * (WILDLIFE_IDLE_TICKS_MAX - WILDLIFE_IDLE_TICKS_MIN)) | 0);
          continue;
        }
        a.goalX = gx;
        a.goalY = gy;
        a.facing = Math.cos(ang) >= 0 ? 1 : -1;
        a.phase = "wander";
      }
      continue;
    }
    // wander
    const dx = a.goalX - a.x;
    const dy = a.goalY - a.y;
    const d = Math.hypot(dx, dy);
    if (d <= WILDLIFE_SPEED) {
      a.x = a.goalX;
      a.y = a.goalY;
      a.phase = "idle";
      a.idleTicks = WILDLIFE_IDLE_TICKS_MIN + ((Math.random() * (WILDLIFE_IDLE_TICKS_MAX - WILDLIFE_IDLE_TICKS_MIN)) | 0);
    } else {
      a.x += (dx / d) * WILDLIFE_SPEED;
      a.y += (dy / d) * WILDLIFE_SPEED;
    }
  }
}

/** Maximum tile distance from the spawn tile to the nearest tree.
 *  Auto-spawn (timer fallback) and bot seeding both enforce this so
 *  every starting tribe has fuel + lumber within easy reach. The
 *  human's manual click bypasses the check via the `requireTreeNearby`
 *  flag on `spawnTribe`. */
export const SPAWN_MAX_TREE_DIST = 250;

export function spawnTribe(state: GameState, playerId: number, tileIdx: number, requireTreeNearby: boolean = false): boolean {
  const w = state.world;
  if (!isOwnable(w.kind[tileIdx])) return false;
  // Reject tiles too close to water — without this, the campfire lands
  // on a thin spit of land and 1-2 villagers in the ring spawn into the
  // sea. coastDist is in tiles, matching the world-space units used by
  // the ring (RING_R = 14), so 25 covers the ring plus a margin.
  if (w.coastDist[tileIdx] < SPAWN_MIN_COAST_DIST) return false;
  // Tree-proximity gate for auto/bot spawns. The player's manual
  // founding click skips this so they can still drop a tribe wherever
  // they want.
  if (requireTreeNearby) {
    const tx0 = tileIdx % w.width;
    const ty0 = (tileIdx / w.width) | 0;
    if (findClosestTree(state, tx0, ty0, SPAWN_MAX_TREE_DIST) < 0) return false;
  }
  const tx = tileIdx % w.width;
  const ty = (tileIdx / w.width) | 0;
  // Lock the tribe's architecture style by the biome it spawned in. Must
  // happen BEFORE the tent is placed because buildStructure now consults
  // the player's styles to gate non-universal buildings.
  state.players[playerId].originStyles = styleForTile(w, tileIdx);
  // Plant the founding campfire at the chosen point. Bypass cost so the
  // tribe can spawn with zero starting resources — the campfire is the
  // first thing they're given, not the first thing they buy.
  if (!buildStructure(state, playerId, "campfire", tx, ty, true)) return false;
  // Four founding villagers — fixed sprite slots so every tribe starts
  // with the same cast. Specialist villager classes (torch, sling, club)
  // are unlocked the first time the tribe deposits wood; see engine.ts.
  const RING_R = 14;
  for (let i = 0; i < STARTER_VILLAGER_SPRITES.length; i++) {
    const ang = (i / STARTER_VILLAGER_SPRITES.length) * Math.PI * 2;
    const vx = tx + Math.cos(ang) * RING_R;
    const vy = ty + Math.sin(ang) * RING_R;
    state.villagers.push(makeVillager(state, playerId, STARTER_VILLAGER_SPRITES[i], vx, vy));
  }
  // Tribal era starts with NO resources — every wood / rock / iron has
  // to be earned. (Workbenches still need a cost to place, so the player
  // must chop trees first.)
  return true;
}

/** Sprite roster for a brand-new tribe. Pinned to four specific sprites
 *  per spec — the other four human variants unlock later (e.g. torch /
 *  sling / club after first wood). */
const STARTER_VILLAGER_SPRITES = ["human1", "human3", "human4", "human7"];

/** Find a valid land tile that maximises the minimum distance to every
 *  existing tribe's founding structure. Used by the spawn-screen auto
 *  timer — if the human hasn't clicked within 60 seconds we drop them
 *  on the world's most-isolated land tile so they don't spawn on top
 *  of a bot tribe.
 *
 *  Implementation is a random-sample + argmax(min-distance) rather than
 *  an exhaustive scan: at 7000×3500 = 24M tiles the exact search would
 *  block the main thread. 800 samples gives a tile that's empirically
 *  within ~5% of the true farthest on this world size. */
export function findFarthestSpawnTile(state: GameState, samples: number = 800): number {
  const w = state.world;
  // Each tribe's "anchor" position — the founding campfire (current
  // spawnTribe puts one at the click point) or tent (legacy spawns).
  const anchors: Array<{ x: number; y: number }> = [];
  for (const s of state.structures) {
    if (s.defKey === "campfire" || s.defKey === "tent") {
      anchors.push({ x: s.x, y: s.y });
    }
  }
  // Founding campfire footprint. Anything closer than this to a prop
  // will be rejected by buildStructure's prop-overlap check, so reject
  // it here too — otherwise findFarthestSpawnTile returns a tile that
  // spawnTribe then refuses to build on and auto-spawn silently fails.
  const campfireDef = getBuildingDef("campfire");
  const campfireSize = campfireDef?.size ?? 12;
  let bestIdx = -1;
  let bestMinD2 = -1;
  for (let i = 0; i < samples; i++) {
    const tx = (Math.random() * w.width) | 0;
    const ty = (Math.random() * w.height) | 0;
    const idx = ty * w.width + tx;
    if (!isOwnable(w.kind[idx])) continue;
    // Same coast-distance guard as spawnTribe — otherwise the auto-spawn
    // could pick a tile where the campfire is on land but the villager
    // ring touches the sea.
    if (w.coastDist[idx] < SPAWN_MIN_COAST_DIST) continue;
    // Skip tiles whose surrounding footprint would clip a world prop
    // (volcano, mesa, rock, tree). Cheap pre-check using the closest
    // prop only — full overlap is still verified by buildStructure.
    if (hasPropWithin(state, tx, ty, campfireSize + 8)) continue;
    let minD2 = Infinity;
    for (const a of anchors) {
      const dx = tx - a.x;
      const dy = ty - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
    }
    if (minD2 > bestMinD2) {
      bestMinD2 = minD2;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

/** True if any non-harvested world prop's centre is within `radius` of
 *  (x, y). Linear scan — only used at spawn time, so it doesn't need a
 *  spatial index. */
function hasPropWithin(state: GameState, x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  const props = state.world.props;
  for (let i = 0; i < props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    const p = props[i];
    const dx = x - p.x;
    const dy = y - p.y;
    const minD = radius + p.size;
    if (dx * dx + dy * dy < minD * minD) return true;
  }
  void r2;
  return false;
}

/** Specialist villager sprites unlocked once a tribe has obtained their
 *  first wood. Tagged for future combat / role logic. */
const WOOD_UNLOCK_VILLAGERS: Array<{ sprite: string; role: string }> = [
  { sprite: "human2", role: "woodclub" },
  { sprite: "human7", role: "torch" },
  { sprite: "human6", role: "slingshot" },
];

function makeVillager(state: GameState, ownerId: number, sprite: string, x: number, y: number): Villager {
  return {
    id: state.nextVillagerId++,
    ownerId,
    name: randomVillagerName(),
    sprite,
    x,
    y,
    job: "idle",
    targetPropIdx: -1,
    targetX: 0,
    targetY: 0,
    patchX: 0,
    patchY: 0,
    chopsLeft: 0,
    rot: 0,
    // Default armament for fresh villagers is the bow — a slow ranged
    // sidearm. Specialist villagers (torch / club / sling) and promoted
    // guard / army villagers override this in their respective spawn /
    // promotion paths.
    weapon: weaponForSprite(sprite),
    attackCooldown: 0,
    inventory: {},
  };
}

// ----------------------------------------------------------------------
// Inventory helpers — every harvest credits the villager's bag, every
// deposit drains it. Cap is total units across keys (a villager can
// mix wood + iron in the same bag up to VILLAGER_INVENTORY_CAP).
// ----------------------------------------------------------------------
/** Sum of every entry in a villager's inventory. Treats missing
 *  `inventory` (old save) as empty. */
export function inventoryTotal(v: Villager): number {
  const inv = v.inventory;
  if (!inv) return 0;
  let n = 0;
  for (const k in inv) n += inv[k as ResourceKind] ?? 0;
  return n;
}
/** True if the villager has hit the per-villager carry cap. */
export function inventoryFull(v: Villager): boolean {
  return inventoryTotal(v) >= VILLAGER_INVENTORY_CAP;
}
/** Credit `amount` of `kind` to the villager's bag, clamped at the cap.
 *  Returns the amount actually credited (= amount - overflow). */
export function inventoryAdd(v: Villager, kind: ResourceKind, amount: number): number {
  if (amount <= 0) return 0;
  if (!v.inventory) v.inventory = {};
  const room = VILLAGER_INVENTORY_CAP - inventoryTotal(v);
  if (room <= 0) return 0;
  const credit = Math.min(amount, room);
  v.inventory[kind] = (v.inventory[kind] ?? 0) + credit;
  return credit;
}
/** Drain the villager's inventory into the player's resource pool and
 *  reset the bag to empty. Returns the snapshot (caller can read it for
 *  side-effects like the first-wood unlock check). */
export function depositInventory(v: Villager, player: Player, state?: GameState): Partial<Record<ResourceKind, number>> {
  const out: Partial<Record<ResourceKind, number>> = {};
  const inv = v.inventory;
  if (!inv) return out;
  for (const k in inv) {
    const amt = inv[k as ResourceKind] ?? 0;
    if (amt <= 0) continue;
    // Drop the haul at the campfire the villager is closest to (which
    // is the home tent they walked back to). Per-campfire routing puts
    // the resources into the right city's stockpile instead of the
    // global aggregate.
    if (state) {
      creditNearestCampfire(state, player.id, v.x, v.y, k as ResourceKind, amt);
    } else {
      player.resources[k as ResourceKind] += amt;
    }
    out[k as ResourceKind] = amt;
  }
  v.inventory = {};
  return out;
}

// ----------------------------------------------------------------------
// Tree multi-harvest helpers. A tree can be chopped by up to
// MAX_HARVESTERS_PER_TREE different villagers; each one yields a full
// HARVEST_YIELD share. After the last share the tree is also pushed
// into harvestedProps so the renderer drops it.
// ----------------------------------------------------------------------
/** Can `villagerId` chop tree `propIdx` right now? False if the tree
 *  has been fully harvested (in `harvestedProps`) or if this specific
 *  villager already took a share. */
export function canHarvestTree(state: GameState, propIdx: number, villagerId: number): boolean {
  if (state.harvestedProps.has(propIdx)) return false;
  const harvesters = state.treeHarvesters?.get(propIdx);
  if (!harvesters) return true;
  if (harvesters.size >= MAX_HARVESTERS_PER_TREE) return false;
  if (harvesters.has(villagerId)) return false;
  return true;
}
/** Record that `villagerId` just took a share of tree `propIdx`. If the
 *  tree now has MAX_HARVESTERS_PER_TREE distinct villagers on its
 *  ledger it's flipped to fully-harvested. Returns true when the tree
 *  became fully harvested on THIS call (so the caller can dirty-mark
 *  the chunk to repaint it as gone). */
export function recordTreeHarvest(state: GameState, propIdx: number, villagerId: number): boolean {
  if (!state.treeHarvesters) state.treeHarvesters = new Map();
  let set = state.treeHarvesters.get(propIdx);
  if (!set) {
    set = new Set();
    state.treeHarvesters.set(propIdx, set);
  }
  set.add(villagerId);
  if (set.size >= MAX_HARVESTERS_PER_TREE) {
    killProp(state, propIdx);
    return true;
  }
  return false;
}

/** Find the nearest live animal to (x, y) within `maxDist`. Used by
 *  the hunt dispatch (auto-assign + bot AI). Returns the index into
 *  state.animals, or -1 if no animal in range. */
export function findClosestAnimal(state: GameState, x: number, y: number, maxDist: number): number {
  const animals = state.animals;
  if (!animals || animals.length === 0) return -1;
  let bestIdx = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < animals.length; i++) {
    const a = animals[i];
    const dx = a.x - x;
    const dy = a.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
  }
  return bestIdx;
}

/** Dispatch villager `v` to hunt the animal at index `animalIdx`. The
 *  engine state machine handles the chase + kill. */
export function assignHuntForVillager(state: GameState, v: Villager, animalIdx: number): boolean {
  const animals = state.animals;
  if (!animals) return false;
  const animal = animals[animalIdx];
  if (!animal) return false;
  v.job = "walkToHunt";
  v.huntTargetAnimalId = animal.id;
  v.targetX = animal.x;
  v.targetY = animal.y;
  v.patchX = animal.x;
  v.patchY = animal.y;
  v.targetPropIdx = -1;
  v.harvestType = undefined;
  v.carryingSprite = undefined;
  v.pathTiles = undefined;
  v.pathIdx = undefined;
  v.pathTargetTile = undefined;
  v.rot = 0;
  return true;
}

/** Remove the animal at index `idx` from state.animals. O(1) swap-pop
 *  keeps the array compact. */
export function removeAnimalAt(state: GameState, idx: number): void {
  const animals = state.animals;
  if (!animals || idx < 0 || idx >= animals.length) return;
  animals[idx] = animals[animals.length - 1];
  animals.pop();
}

/** Record one swing of the pickaxe on rock `propIdx`. Returns true when
 *  the rock has just been fully depleted (the caller should then push it
 *  into harvestedProps + dirty-mark the tile). On every call the rock's
 *  remaining-mines counter ticks down by one. */
export function recordRockMine(state: GameState, propIdx: number): boolean {
  if (!state.rockMinesLeft) state.rockMinesLeft = new Map();
  let left = state.rockMinesLeft.get(propIdx);
  if (left === undefined) left = MAX_MINES_PER_ROCK;
  left -= 1;
  if (left <= 0) {
    state.rockMinesLeft.delete(propIdx);
    // Berry rocks don't get removed from the world — they're "milked"
    // dry and turn into a plain (un-mineable) rock variant so the
    // landscape keeps its decoration. Strip the berry prefix to find
    // the matching plain rock sprite, mark as spent, dirty-mark the
    // tile so the next chunk repaint draws the new sprite.
    const p = state.world.props[propIdx];
    const berryPrefix =
      p && p.sprite.startsWith("redberry_")    ? "redberry_"
      : p && p.sprite.startsWith("yellowberry_") ? "yellowberry_"
      : p && p.sprite.startsWith("blueberry_")   ? "blueberry_"
      : null;
    if (berryPrefix && p) {
      p.sprite = "rock_" + p.sprite.slice(berryPrefix.length);
      if (!state.spentRocks) state.spentRocks = new Set();
      state.spentRocks.add(propIdx);
      const w = state.world;
      const x0 = Math.max(0, Math.floor(p.x - p.size));
      const x1 = Math.min(w.width - 1, Math.ceil(p.x + p.size));
      const y0 = Math.max(0, Math.floor(p.y - p.size));
      const y1 = Math.min(w.height - 1, Math.ceil(p.y + p.size));
      for (let y = y0; y <= y1; y++) {
        const base = y * w.width;
        for (let x = x0; x <= x1; x++) state.dirtyTiles.add(base + x);
      }
    } else {
      // Non-berry rocks vanish via the death animation.
      killProp(state, propIdx);
    }
    return true;
  }
  state.rockMinesLeft.set(propIdx, left);
  return false;
}

/** Same as `findClosestTree`, but additionally skips any tree this
 *  specific villager has already taken a share from. Returns -1 when
 *  no eligible tree exists within `maxDist`. */
export function findClosestTreeFor(
  state: GameState, villagerId: number, x: number, y: number, maxDist: number,
): number {
  const props = state.world.props;
  let bestIdx = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < props.length; i++) {
    if (!props[i].sprite.startsWith("tree_")) continue;
    if (!canHarvestTree(state, i, villagerId)) continue;
    const p = props[i];
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Pick the default weapon a freshly-spawned villager carries based on
 *  their sprite. The three wood-unlock specialists (human2 club,
 *  human7 torch, human6 sling) come with their identity weapon; everyone
 *  else gets a bow. Called by makeVillager so save/load + dev spawns
 *  pick up the same mapping. */
function weaponForSprite(sprite: string): "bow" | "club" | "torch" | "sling" {
  switch (sprite) {
    case "human2": return "club";
    case "human6": return "sling";
    case "human7": return "torch";
    default:       return "bow";
  }
}

/** Tribal first-name pool. Short, vaguely paleolithic / fantasy-tribal
 *  syllables — picked to feel of-a-piece across all four biome styles
 *  without leaning into any real-world culture. */
const VILLAGER_FIRST_NAMES = [
  "Ash", "Bor", "Cael", "Drek", "Eda", "Fenn", "Gort", "Hex", "Iggy", "Jor",
  "Kael", "Lir", "Mok", "Nira", "Orin", "Pell", "Quen", "Ros", "Sten", "Tark",
  "Una", "Vex", "Wira", "Xan", "Yor", "Zen", "Bram", "Cilo", "Dren", "Esh",
  "Faro", "Garn", "Halu", "Ilo", "Joen", "Kuri", "Loma", "Mira", "Nox", "Oma",
  "Pax", "Qira", "Reka", "Sira", "Tova", "Ujo", "Velm", "Wyr", "Xira", "Yul",
];

/** Tribal surname pool — single-syllable epithets that read like
 *  warrior / clan descriptors. Combined with a first name they produce
 *  ~50 × ~30 = 1500 unique combinations, plenty for any one session. */
const VILLAGER_LAST_NAMES = [
  "Stoneborn", "Ashwalker", "Ironhand", "Mossfoot", "Reedwise",
  "Spearbreaker", "Sunkeeper", "Thornwood", "Wolfheart", "Skyclaw",
  "Embertongue", "Frostmane", "Greybark", "Hollowfist", "Riverkin",
  "Saltbeard", "Tideborn", "Vinecaller", "Wildmark", "Stormeye",
  "Boneflute", "Dustsoul", "Goldvein", "Mistwalker", "Pineshade",
  "Quickshot", "Redleaf", "Steeltooth", "Twinmoon", "Wyrmtongue",
];

/** Random villager name = "First Last". Uses Math.random for now (not
 *  the world RNG) so names stay varied across reloads of the same
 *  worldSeed — names are stored on the villager record and persist via
 *  save data, so this only matters for the very first spawn. */
function randomVillagerName(): string {
  const f = VILLAGER_FIRST_NAMES[(Math.random() * VILLAGER_FIRST_NAMES.length) | 0];
  const l = VILLAGER_LAST_NAMES[(Math.random() * VILLAGER_LAST_NAMES.length) | 0];
  return `${f} ${l}`;
}

/** Food cost in `meat` per new villager. Spawn checks the player's stock
 *  AND the population cap before producing the villager. Tribal-era only;
 *  later eras will scale the cost up. */
export const VILLAGER_MEAT_COST = 0;

/** Sum every owned structure's popCap (see catalog.ts) plus the popCap
 *  bonus of any of this player's vessels currently docked at one of
 *  their ports. Big ships / airships contribute +8 while parked. */
export function getPopulationCap(state: GameState, playerId: number): number {
  let cap = 0;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    const def = getBuildingDef(s.defKey);
    if (!def) continue;
    cap += def.popCap ?? 0;
  }
  for (const v of state.vessels) {
    if (v.ownerId !== playerId) continue;
    if (v.status !== "docked") continue;
    const def = getVesselDef(v.defKey);
    cap += def?.popCap ?? 0;
  }
  return cap;
}

// ----------------------------------------------------------------------
// Vessel helpers — purchase / board / launch / shootdown.
// ----------------------------------------------------------------------

/** Count how many vessels are docked at the given port (any slot). */
export function vesselsAtPort(state: GameState, portStructureId: number): Vessel[] {
  return state.vessels.filter(
    (v) => v.portStructureId === portStructureId && v.status === "docked"
  );
}

/** Find the lowest unoccupied slot index (0..PORT_TOTAL_SLOTS-1) for the
 *  given port. Returns -1 if the port is full. Slot 0 (the parked spot)
 *  must be filled first. */
export function nextFreeDockSlot(state: GameState, portStructureId: number): number {
  const occupied = new Set<number>();
  for (const v of state.vessels) {
    if (v.portStructureId === portStructureId && v.status === "docked") {
      occupied.add(v.slot);
    }
  }
  for (let i = 0; i < PORT_TOTAL_SLOTS; i++) {
    if (!occupied.has(i)) return i;
  }
  return -1;
}

/** Find a sea tile near (px, py) to drop a freshly-purchased ship onto.
 *  Spiral-out search for the nearest sea tile. `slot` offsets multiple
 *  ships at the same port so they don't stack on the exact same spot —
 *  slots 1+ get nudged 6 tiles per slot in the same direction the first
 *  sea tile sat from the port. */
export function findShipSpawnNear(
  state: GameState, px: number, py: number, slot: number,
): { x: number; y: number } | null {
  const w = state.world;
  const cx = Math.round(px);
  const cy = Math.round(py);
  for (let r = 1; r <= 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || tx >= w.width || ty < 0 || ty >= w.height) continue;
        const k = w.kind[ty * w.width + tx];
        if (k !== TileKind.Sea) continue;
        const nx = dx / r;
        const ny = dy / r;
        const ox = tx + 0.5 + nx * slot * 6;
        const oy = ty + 0.5 + ny * slot * 6;
        return { x: ox, y: oy };
      }
    }
  }
  return null;
}

/** Slot-offset for a freshly-docked airship — sits a fixed distance
 *  above the port's centre, fanned slightly per slot so multiple
 *  airships at the same hangar don't stack on a single pixel. The
 *  "above" convention is because dirigibles read as sky vehicles, and
 *  putting them over the port hides any sea/land interaction the way
 *  ships have to worry about. */
function airshipDockSpot(px: number, py: number, slot: number): { x: number; y: number } {
  // Hover just above the port's roof. Port size is 66 so size + a small
  // margin lands the airship clearly over the structure. Each extra slot
  // fans 14 tiles further along the X axis, alternating sides so the
  // hangar reads as a balanced row of dirigibles.
  const ABOVE = 38;        // tiles above the port centre
  // SLOT_SPACING raised 14 → 90 because AIRSHIP_TILES_BIG=40 means a
  // big-airship sprite spans 80 tiles — the old 14-tile fan resulted
  // in heavy overlap once two heavy/patrol/cargo airships docked at
  // the same hangar. 90 leaves a small gap between adjacent bigs.
  const SLOT_SPACING = 90; // x-offset per slot
  const side = slot % 2 === 0 ? 1 : -1;
  const fanIdx = Math.ceil(slot / 2);
  return { x: px + side * fanIdx * SLOT_SPACING, y: py - ABOVE };
}

/** Purchase a vessel and dock it at `portStructureId`. Caller is
 *  responsible for resource deduction (it lives in the PortWindow
 *  click handler). Returns the new vessel or null if the port is full. */
export function purchaseVesselAtPort(
  state: GameState, ownerId: number, portStructureId: number, defKey: string
): Vessel | null {
  const slot = nextFreeDockSlot(state, portStructureId);
  if (slot < 0) return null;
  const def = getVesselDef(defKey);
  // Ships float on the water next to the port. Airships hover above the
  // hangar's roof so the player can see them parked instead of having
  // them only live inside the PortWindow.
  let spawn: { x: number; y: number } | null = null;
  if (def && def.category === "ship") {
    const port = state.structuresById?.get(portStructureId);
    if (port) spawn = findShipSpawnNear(state, port.x, port.y, slot);
  } else if (def && def.category === "airship") {
    const port = state.structuresById?.get(portStructureId);
    if (port) spawn = airshipDockSpot(port.x, port.y, slot);
  }
  const vessel: Vessel = {
    id: state.nextVesselId++,
    defKey,
    ownerId,
    portStructureId,
    slot,
    status: "docked",
    x: spawn?.x,
    y: spawn?.y,
    boardedVillagerIds: [],
  };
  state.vessels.push(vessel);
  return vessel;
}

/** Add a villager to a vessel's roster. Refuses if the vessel is full
 *  (per its `crew` capacity), already flying / shot down, or owned by
 *  someone else. Returns true on success. */
export function boardVillager(state: GameState, vesselId: number, villagerId: number): boolean {
  const vessel = state.vessels.find((v) => v.id === vesselId);
  if (!vessel || vessel.status !== "docked") return false;
  const villager = state.villagers.find((v) => v.id === villagerId);
  if (!villager || villager.ownerId !== vessel.ownerId) return false;
  if (vessel.boardedVillagerIds.includes(villagerId)) return false;
  const def = getVesselDef(vessel.defKey);
  const cap = def?.crew ?? 0;
  if (vessel.boardedVillagerIds.length >= cap) return false;
  vessel.boardedVillagerIds.push(villagerId);
  return true;
}

/** Remove a villager from a vessel's roster. */
export function unboardVillager(state: GameState, vesselId: number, villagerId: number): boolean {
  const vessel = state.vessels.find((v) => v.id === vesselId);
  if (!vessel) return false;
  const idx = vessel.boardedVillagerIds.indexOf(villagerId);
  if (idx < 0) return false;
  vessel.boardedVillagerIds.splice(idx, 1);
  return true;
}

/** Resample a user-edited flight path into a dense Catmull-Rom curve
 *  approximation. Inputs: the launch anchor (port or vessel position
 *  the curve starts from) and the user's control points. Output: an
 *  ordered list of `SAMPLES_PER_SEGMENT` points along each segment of
 *  the curve, with the deboard flag attached to the sample closest to
 *  the original deboard waypoint.
 *
 *  Catmull-Rom passes through every control point with C¹ continuity
 *  — natural fit for "the player drew these waypoints, draw a smooth
 *  arc through them." For each pair (P1, P2) of consecutive waypoints
 *  we interpolate using the neighbouring P0 + P3 to determine the
 *  curve's tangent. End-clamps duplicate the first / last waypoint so
 *  the curve still starts + ends at exactly the user's chosen points. */
function samplePathAsCurve(
  anchorX: number, anchorY: number,
  waypoints: { x: number; y: number; deboard?: boolean }[],
): { x: number; y: number; deboard?: boolean }[] {
  const n = waypoints.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: waypoints[0].x, y: waypoints[0].y, deboard: waypoints[0].deboard }];
  // Prepend the anchor as P[-1] equivalent so the first segment's
  // tangent points away from where the airship started, instead of
  // snapping to the user's first waypoint.
  const ctrl: { x: number; y: number }[] = [{ x: anchorX, y: anchorY }, ...waypoints];
  const SAMPLES_PER_SEGMENT = 12;     // 12 sub-samples → smooth at zoom-in
  const out: { x: number; y: number; deboard?: boolean }[] = [];
  // Pre-locate the original deboard waypoint so we can attach the flag
  // to the closest sample on the output curve.
  let deboardWp: { x: number; y: number } | null = null;
  for (const w of waypoints) if (w.deboard) { deboardWp = w; break; }
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p0 = i > 0 ? ctrl[i - 1] : p1;
    const p3 = i < ctrl.length - 2 ? ctrl[i + 2] : p2;
    for (let s = 0; s < SAMPLES_PER_SEGMENT; s++) {
      // Skip s=0 on segments after the first — it'd duplicate the
      // previous segment's last sample.
      if (i > 0 && s === 0) continue;
      const t = s / SAMPLES_PER_SEGMENT;
      const t2 = t * t;
      const t3 = t2 * t;
      // Standard Catmull-Rom basis (tension 0.5).
      const x = 0.5 * (
        (2 * p1.x)
        + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        (2 * p1.y)
        + (-p0.y + p2.y) * t
        + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
        + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      out.push({ x, y });
    }
  }
  // Always end exactly on the last waypoint — the loop above stops a
  // step short of t=1 so the seam between segments is clean. Push the
  // final control point to close the curve at the user's last click.
  const last = waypoints[n - 1];
  out.push({ x: last.x, y: last.y });
  // Attach the deboard flag to whichever sample is closest to the
  // original deboard waypoint. Squared-distance compare; only one
  // sample carries the flag.
  if (deboardWp) {
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < out.length; i++) {
      const dx = out[i].x - deboardWp.x;
      const dy = out[i].y - deboardWp.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) out[bestIdx].deboard = true;
  }
  return out;
}

/** Launch a vessel into flight (airships) or out to sea (ships).
 *  ANY vessel with a non-zero `crew` requirement must be filled before
 *  it can leave the dock — covers airships and the galleon ships now.
 *  Crafting / purchasing a vessel still requires zero villagers; the
 *  crew gate only kicks in at takeoff. Returns true on success. */
export function launchVessel(state: GameState, vesselId: number): boolean {
  const vessel = state.vessels.find((v) => v.id === vesselId);
  if (!vessel || vessel.status !== "docked") return false;
  const def = getVesselDef(vessel.defKey);
  if (!def) return false;
  const crewNeeded = def.crew ?? 0;
  if (crewNeeded > 0 && vessel.boardedVillagerIds.length < crewNeeded) return false;
  vessel.status = "flying";
  // Pin the departure point: if the vessel never had a world spawn
  // (legacy airship before the spawn field), drop it at the launching
  // port so step logic has something to lerp from. Roll a first wander
  // destination so it heads somewhere visible immediately.
  if (vessel.x === undefined || vessel.y === undefined) {
    const port = state.structures.find((s) => s.id === vessel.portStructureId);
    if (port) { vessel.x = port.x; vessel.y = port.y; }
  }
  if (def.category === "airship" && vessel.x !== undefined && vessel.y !== undefined) {
    const dest = rollAirshipDestination(state, vessel.x, vessel.y);
    vessel.targetX = dest.x;
    vessel.targetY = dest.y;
  }
  // Capture the launch port as the home base BEFORE clearing
  // portStructureId — after the flight is done (or after dropping crew
  // at the deboard waypoint), the engine routes the vessel back to
  // homePortId.
  if (vessel.portStructureId !== -1) vessel.homePortId = vessel.portStructureId;
  vessel.returningHome = false;
  // If a flight path is queued, set the first waypoint as the active
  // target and reset the index. Otherwise the legacy random wander
  // continues to run (existing behaviour).
  if (vessel.flightPath && vessel.flightPath.length > 0) {
    // Resample the user-drawn waypoints as a Catmull-Rom curve so the
    // airship arcs smoothly between them instead of zig-zagging. The
    // anchor is the current vessel position (the dock) — the curve
    // starts straight from there, then bends through the player's
    // chosen control points. The deboard flag is transferred to the
    // sample nearest the original deboard waypoint so the half-crew
    // drop fires at the same world spot the player marked.
    const anchorX = vessel.x ?? 0;
    const anchorY = vessel.y ?? 0;
    vessel.flightPath = samplePathAsCurve(anchorX, anchorY, vessel.flightPath);
    vessel.flightPathIdx = 0;
    vessel.targetX = vessel.flightPath[0].x;
    vessel.targetY = vessel.flightPath[0].y;
  }
  vessel.portStructureId = -1;
  vessel.slot = -1;
  return true;
}

/** Locate the vessel under a world-space click point. Used by the
 *  flight-path editor to detect "did the player click an airship" —
 *  matches the same hit radius the renderer uses for the sprite. */
export function vesselAtPoint(state: GameState, wx: number, wy: number): Vessel | null {
  for (let i = state.vessels.length - 1; i >= 0; i--) {
    const v = state.vessels[i];
    if (v.x === undefined || v.y === undefined) continue;
    const def = getVesselDef(v.defKey);
    if (!def) continue;
    // Hit radius matches the renderer's tile-size approximation. Big
    // airships register a wider tap area than scouts, so the player
    // doesn't miss when clicking a tiny scout sprite.
    let r = 14;
    if (def.category === "airship") {
      const isBig = (def.popCap ?? 0) > 0 || (def.crew ?? 0) > 0;
      r = isBig ? 40 : 7;
    }
    const dx = wx - v.x;
    const dy = wy - v.y;
    if (dx * dx + dy * dy <= r * r) return v;
  }
  return null;
}

/** Append a waypoint to a vessel's planned route. Used by the App's
 *  path-edit click handler — the vessel must be docked + owned by the
 *  caller. Returns true if the waypoint was added. */
export function addVesselWaypoint(
  state: GameState, playerId: number, vesselId: number,
  x: number, y: number, deboard: boolean = false,
): boolean {
  const v = state.vessels.find((vv) => vv.id === vesselId);
  if (!v || v.ownerId !== playerId) return false;
  if (v.status !== "docked") return false;
  if (!v.flightPath) v.flightPath = [];
  // Only one deboard waypoint is meaningful — replace any prior one so
  // the player can right-click again to move the drop point. This
  // matches the user's "right click the line to set the deboard
  // location" semantics — a second right-click moves it.
  if (deboard) {
    for (const wp of v.flightPath) wp.deboard = false;
  }
  v.flightPath.push({ x, y, deboard });
  return true;
}

/** Clear a vessel's planned route. Called by App.tsx on Esc / cancel
 *  during path editing. */
export function clearVesselPath(state: GameState, playerId: number, vesselId: number): boolean {
  const v = state.vessels.find((vv) => vv.id === vesselId);
  if (!v || v.ownerId !== playerId) return false;
  v.flightPath = undefined;
  v.flightPathIdx = undefined;
  return true;
}

/** Pick a wander destination for a flying airship. Stays inside world
 *  bounds and roughly 80–280 tiles from the current position so the
 *  airship makes a meaningful traversal before turning. The angle is
 *  uniform random; only the world-bounds clamp constrains the result. */
export function rollAirshipDestination(
  state: GameState, fromX: number, fromY: number,
): { x: number; y: number } {
  const w = state.world;
  const ang = Math.random() * Math.PI * 2;
  const dist = 80 + Math.random() * 200;
  const tx = Math.max(8, Math.min(w.width - 8, fromX + Math.cos(ang) * dist));
  const ty = Math.max(8, Math.min(w.height - 8, fromY + Math.sin(ang) * dist));
  return { x: tx, y: ty };
}

/** Per-tick airship locomotion. Walks each flying airship toward its
 *  current target at AIRSHIP_SPEED tiles/tick; on arrival, rolls a new
 *  wander destination so the airship keeps drifting until shot down.
 *  Ships skip this — naval locomotion is its own thing. */
export const AIRSHIP_SPEED = 1.4;
/** Tile-distance within which the airship considers itself arrived at
 *  a waypoint / home port. Larger than AIRSHIP_SPEED so the final step
 *  doesn't overshoot and oscillate. */
const AIRSHIP_ARRIVE_REACH = 8;
export function stepAirships(state: GameState): void {
  for (const v of state.vessels) {
    if (v.status !== "flying") continue;
    const def = getVesselDef(v.defKey);
    if (!def || def.category !== "airship") continue;
    if (v.x === undefined || v.y === undefined) continue;

    // ----- Planned-route mode -----
    // Vessel has a flightPath: walk waypoints in order, drop half crew
    // at the deboard waypoint, then return to homePortId. If anything in
    // this state machine goes sideways (port destroyed mid-flight, no
    // home), fall through to the wander branch.
    if (v.flightPath && v.flightPath.length > 0 && !v.returningHome) {
      const idx = v.flightPathIdx ?? 0;
      if (idx >= v.flightPath.length) {
        // Path complete with no deboard fired (player didn't set one).
        // Head home as if returningHome was already set.
        v.returningHome = true;
      } else {
        const wp = v.flightPath[idx];
        v.targetX = wp.x;
        v.targetY = wp.y;
        const dx = wp.x - v.x;
        const dy = wp.y - v.y;
        const d = Math.hypot(dx, dy);
        if (d <= AIRSHIP_ARRIVE_REACH) {
          // Arrived. If this is the deboard waypoint, eject half the
          // crew right here and pivot to returning home.
          if (wp.deboard) {
            ejectHalfCrew(state, v);
            v.returningHome = true;
          } else {
            v.flightPathIdx = idx + 1;
          }
        } else {
          v.x += (dx / d) * AIRSHIP_SPEED;
          v.y += (dy / d) * AIRSHIP_SPEED;
        }
        continue;
      }
    }

    // ----- Returning home -----
    // Steer toward homePortId. On arrival, dock the vessel there + clear
    // the path so the player can crew it up again and re-launch.
    if (v.returningHome && v.homePortId !== undefined) {
      const port = state.structuresById?.get(v.homePortId);
      if (port) {
        const dx = port.x - v.x;
        const dy = port.y - v.y;
        const d = Math.hypot(dx, dy);
        if (d <= AIRSHIP_ARRIVE_REACH) {
          // Re-dock: status flips back to docked, slot reclaimed (use
          // the same dock spot helper that purchaseVesselAtPort uses).
          // The boarded survivors stay on the vessel as crew — they
          // wait for the player to top up via Crew Up / Board villager.
          v.status = "docked";
          v.portStructureId = v.homePortId;
          v.returningHome = false;
          v.flightPath = undefined;
          v.flightPathIdx = undefined;
          const slot = nextFreeDockSlot(state, v.homePortId);
          v.slot = slot >= 0 ? slot : 0;
          const spot = airshipDockSpot(port.x, port.y, v.slot);
          v.x = spot.x;
          v.y = spot.y;
          continue;
        }
        v.x += (dx / d) * AIRSHIP_SPEED;
        v.y += (dy / d) * AIRSHIP_SPEED;
        continue;
      }
      // Home port destroyed — fall through to wander so the airship
      // doesn't freeze.
      v.returningHome = false;
      v.homePortId = undefined;
    }

    // ----- Legacy wander (no path, no return) -----
    if (v.targetX === undefined || v.targetY === undefined) {
      const dest = rollAirshipDestination(state, v.x, v.y);
      v.targetX = dest.x;
      v.targetY = dest.y;
      continue;
    }
    const dx = v.targetX - v.x;
    const dy = v.targetY - v.y;
    const d = Math.hypot(dx, dy);
    if (d <= AIRSHIP_SPEED) {
      v.x = v.targetX;
      v.y = v.targetY;
      const dest = rollAirshipDestination(state, v.x, v.y);
      v.targetX = dest.x;
      v.targetY = dest.y;
      continue;
    }
    v.x += (dx / d) * AIRSHIP_SPEED;
    v.y += (dy / d) * AIRSHIP_SPEED;
  }
}

/** Eject half of a vessel's boarded crew at the vessel's current world
 *  position. The deboarded villagers re-enter `state.villagers` as
 *  idle workers around the drop point so the player can re-task them.
 *  Used by the "right-click waypoint" feature: at the deboard waypoint
 *  the airship drops half its crew and turns around. */
function ejectHalfCrew(state: GameState, vessel: Vessel): void {
  if (!vessel.boardedVillagerIds || vessel.boardedVillagerIds.length === 0) return;
  if (vessel.x === undefined || vessel.y === undefined) return;
  const half = Math.floor(vessel.boardedVillagerIds.length / 2);
  if (half === 0) return;
  // Pop the first `half` ids off the manifest — order doesn't matter
  // gameplay-wise. Each ejected villager spawns as idle in a small
  // ring around the vessel.
  const ejected = vessel.boardedVillagerIds.splice(0, half);
  for (let i = 0; i < ejected.length; i++) {
    const id = ejected[i];
    const v = state.villagers.find((vv) => vv.id === id);
    if (!v) continue;
    const ang = (i / ejected.length) * Math.PI * 2;
    v.x = vessel.x + Math.cos(ang) * 3;
    v.y = vessel.y + Math.sin(ang) * 3;
    v.job = "idle";
    v.insideStructureId = undefined;
  }
}

/** Mark a flying vessel as shot down. All boarded villagers are removed
 *  from state.villagers (they're lost with the ship). Caller is
 *  responsible for any visual debris placement using the def's
 *  `shotDownSprite`. */
export function shootDownVessel(state: GameState, vesselId: number): boolean {
  const vessel = state.vessels.find((v) => v.id === vesselId);
  if (!vessel || vessel.status !== "flying") return false;
  const lostIds = new Set(vessel.boardedVillagerIds);
  state.villagers = state.villagers.filter((v) => !lostIds.has(v.id));
  vessel.status = "shotdown";
  vessel.boardedVillagerIds = [];
  return true;
}

/** Living villager count owned by playerId. Used as the population
 *  "used" value vs `getPopulationCap`. */
export function getPopulationUsed(state: GameState, playerId: number): number {
  let n = 0;
  for (const v of state.villagers) if (v.ownerId === playerId) n++;
  return n;
}

/** True if `playerId` can afford to spawn a new villager — both the meat
 *  cost AND room under the population cap. */
export function canSpawnVillager(state: GameState, playerId: number): boolean {
  const p = state.players[playerId];
  if (!p || !p.alive) return false;
  if (p.resources.meat < VILLAGER_MEAT_COST) return false;
  if (getPopulationUsed(state, playerId) >= getPopulationCap(state, playerId)) return false;
  return true;
}

/** Spawn one fresh villager near (x, y) for `playerId`, debiting meat
 *  + occupying a pop slot. Caller is responsible for the canSpawnVillager
 *  precheck — this just does the place + debit so the bot AI can call
 *  it once it's verified affordability. */
export function spawnVillagerAtHome(
  state: GameState, playerId: number, x: number, y: number,
): boolean {
  if (!canSpawnVillager(state, playerId)) return false;
  // Rotate through the starter sprites so the tribe stays visually
  // diverse instead of every spawn looking identical.
  const sprite = STARTER_VILLAGER_SPRITES[
    (state.players[playerId] ? state.villagers.filter((v) => v.ownerId === playerId).length : 0)
      % STARTER_VILLAGER_SPRITES.length
  ];
  state.players[playerId].resources.meat -= VILLAGER_MEAT_COST;
  state.villagers.push(makeVillager(state, playerId, sprite, x, y));
  return true;
}

/** Spawn the three specialist villagers (woodclub / torch / sling) at
 *  the player's founding tent. Called exactly once per player on the
 *  tick they first deposit wood. Now gated by the population cap +
 *  meat cost — each specialist consumes VILLAGER_MEAT_COST meat and
 *  takes one population slot. Specialists that can't fit are dropped. */
export function spawnWoodUnlockVillagers(state: GameState, playerId: number): void {
  const home = findHomeTent(state, playerId);
  if (!home) return;
  const RING_R = 18;
  for (let i = 0; i < WOOD_UNLOCK_VILLAGERS.length; i++) {
    const ang = ((i + 0.5) / WOOD_UNLOCK_VILLAGERS.length) * Math.PI * 2;
    const vx = home.x + Math.cos(ang) * RING_R;
    const vy = home.y + Math.sin(ang) * RING_R;
    // Population + meat gate — skip specialists that don't fit. The
    // founding 4 villagers are already past this; these wood-unlock
    // bonus spawns are subject to normal rules.
    if (!canSpawnVillager(state, playerId)) continue;
    state.players[playerId].resources.meat -= VILLAGER_MEAT_COST;
    state.villagers.push(makeVillager(state, playerId, WOOD_UNLOCK_VILLAGERS[i].sprite, vx, vy));
  }
}

/** Locate a tribe's founding tent (the first tent structure that player
 *  owns). Used as the deposit point for chop jobs. */
/** Find the tribe's home base — the founding campfire. Named "tent" for
 *  historical reasons (the founder used to be a tent); now plants a
 *  campfire instead, but the engine still calls this to locate the
 *  villagers' deposit + respawn point. */
export function findHomeTent(state: GameState, playerId: number): Structure | null {
  for (const s of state.structures) {
    if (s.ownerId === playerId && s.defKey === "campfire") return s;
  }
  return null;
}

// ----------------------------------------------------------------------
// Farmland: the "MS Paint rectangle" mechanic. Player selects the farm
// build-tool, clicks two corners, and we mark every tile in the rect as
// pending farmland (state=1). A villager carrying ash from the home
// campfire walks onto pending tiles and flips them to farmed (state=2),
// after which they passively produce wheat. Engine.ts owns the
// production loop + the fertilize villager job.
// ----------------------------------------------------------------------

/** Cap on the rectangle's per-side dimension so a careless second click
 *  doesn't claim 1000×1000 tiles by accident. */
export const FARM_MAX_DIM = 60;

/** Mark every land tile in the axis-aligned rectangle between
 *  (x0, y0) and (x1, y1) as pending farmland for `playerId`. Tiles
 *  already farmland, under a prop, or non-ownable terrain are skipped.
 *  Returns the count of tiles newly claimed. */
/** Ash cost per painted tile. 1/25 means 25 tiles cost 1 ash — the
 *  fractional debit accumulates against the player's float-tracked ash
 *  stockpile, so painting feels free in short bursts but adds up over
 *  a big farm. */
export const FARM_ASH_PER_TILE = 1 / 25;

/** Result of a single-tile paint attempt — discriminated so the UI can
 *  pick a specific toast for each failure. */
export type FarmPaintResult =
  | { ok: true }
  | { ok: false; reason: "no_hoe" | "no_shovel" | "no_ash" | "not_paintable" };

/** Result of a single shovel-brush stamp. The UI uses the discriminator
 *  to show a meaningful toast. `tilesAffected` is 0 when nothing in the
 *  brush passed the territory + terrain filters — common during a drag
 *  that crosses the kingdom border, so it's a silent no-op. */
export type ShovelPaintResult =
  | { ok: true; tilesAffected: number }
  | { ok: false; reason: "no_shovel" | "out_of_bounds" };

/** Brush radius (in tiles) for the shovel paint tool. Each click/drag
 *  stamps a circular disk of this radius centred on the cursor. */
export const SHOVEL_BRUSH_RADIUS = 4;
/** Max distance (tiles) the shovel can reach away from one of the
 *  player's own structures. Holds the terraform tool to the kingdom's
 *  immediate neighbourhood so a player can't shape ocean trenches in
 *  enemy territory. */
export const SHOVEL_RANGE_FROM_BASE = 300;
export function pointNearOwnedBase(
  state: GameState, playerId: number, px: number, py: number, radius: number,
): boolean {
  const r2 = radius * radius;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    const dx = s.x - px;
    const dy = s.y - py;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
/** Maximum hole depth in tile units. A tile sitting deep inside a large
 *  excavation can reach this depth; tiles at the rim of the brushed area
 *  end up shallow (1–2). Caps both the visual darkening and the water-
 *  capacity per tile. */
export const MAX_HOLE_DEPTH = 8;

/** Dig a hole at (cx, cy) with the standard shovel brush radius.
 *  Only owned-by-`playerId` tiles within the brush become holes. Natural
 *  Sea, Mountain, and tiles inside other players' borders are skipped.
 *  Trees / bushes / rocks inside the brush are cleared (harvestedProps),
 *  so the excavated pit reads as bare ground. Depth per tile is the
 *  tile's distance (chebyshev) to the nearest non-hole tile in the brush
 *  AFTER painting, clamped to MAX_HOLE_DEPTH — so the centre of a wide
 *  brush stroke is deepest and the rim is shallow. */
export function paintHole(
  state: GameState, playerId: number, cx: number, cy: number,
): ShovelPaintResult {
  const player = state.players[playerId];
  if ((player.tools.shovel ?? 0) <= 0) return { ok: false, reason: "no_shovel" };
  const w = state.world;
  if (cx < 0 || cy < 0 || cx >= w.width || cy >= w.height) {
    return { ok: false, reason: "out_of_bounds" };
  }
  // Range gate — the brush must hit somewhere within SHOVEL_RANGE_FROM_BASE
  // of an owned structure. Silent no-op outside that ring so a drag that
  // strays past the kingdom border just stops painting cleanly.
  if (!pointNearOwnedBase(state, playerId, cx, cy, SHOVEL_RANGE_FROM_BASE)) {
    return { ok: true, tilesAffected: 0 };
  }
  const r = SHOVEL_BRUSH_RADIUS;
  const r2 = r * r;
  const x0 = Math.max(0, (cx - r) | 0);
  const x1 = Math.min(w.width - 1, (cx + r) | 0);
  const y0 = Math.max(0, (cy - r) | 0);
  const y1 = Math.min(w.height - 1, (cy + r) | 0);
  let tilesAffected = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const idx = y * w.width + x;
      const k = w.kind[idx];
      // Already a hole? Just dirty-mark in case depth needs to deepen.
      if (k === TileKind.Hole) { state.dirtyTiles.add(idx); continue; }
      // Don't dig natural water or sheer mountain. Other land tile
      // kinds (Land/Forest/Bush/Snow) all convert.
      if (k === TileKind.Sea || k === TileKind.Mountain || k === TileKind.Ice) continue;
      w.kind[idx] = TileKind.Hole;
      w.waterLevel[idx] = 0;
      if (!state.holeTiles) state.holeTiles = new Set();
      state.holeTiles.add(idx);
      state.waterBodiesDirty = true;
      // Live destruction only — terrain flips to Hole immediately so the
      // player sees the dig as they drag. Water flow stays GATED until
      // `commitShovelStroke` fires on mouseup, which scans the player's
      // holes once and activates any with a Sea neighbour. The intent is
      // that the player can carve a long channel and only watch the
      // water rush in when they release the mouse.
      state.dirtyTiles.add(idx);
      tilesAffected++;
    }
  }
  // Clear trees / bushes / rocks that the dug area swallows. Volcano
  // and mesa-plateau props are NOT cleared — they're terrain features
  // the shovel can't undo. Berry-rock variants reset to normal rock
  // before clearing so save state stays consistent (the rock would have
  // counted as still-minable otherwise).
  removePropsInDisk(state, cx, cy, r);
  // Depth pass — for each tile inside the brushed disk that's now a
  // hole, compute its chebyshev distance to the nearest non-hole tile
  // in the SAME brush bbox and store it as holeDepth, clamped to
  // MAX_HOLE_DEPTH. This gives a natural "deepest in the middle" profile
  // when the player paints a wide area. Re-painting an existing hole
  // refreshes the depth too, so the centre can deepen as the brush
  // expands the excavation outward.
  recomputeHoleDepths(state, x0, y0, x1, y1);
  return { ok: true, tilesAffected };
}

/** Raise terrain — the shift-shovel mode. Converts Hole tiles in the
 *  brush back to Land and resets water + depth. Owned-by-`playerId` gate
 *  applies here too so a player can't bulldoze a rival's pits. */
export function paintFill(
  state: GameState, playerId: number, cx: number, cy: number,
): ShovelPaintResult {
  const player = state.players[playerId];
  if ((player.tools.shovel ?? 0) <= 0) return { ok: false, reason: "no_shovel" };
  const w = state.world;
  if (cx < 0 || cy < 0 || cx >= w.width || cy >= w.height) {
    return { ok: false, reason: "out_of_bounds" };
  }
  if (!pointNearOwnedBase(state, playerId, cx, cy, SHOVEL_RANGE_FROM_BASE)) {
    return { ok: true, tilesAffected: 0 };
  }
  const r = SHOVEL_BRUSH_RADIUS;
  const r2 = r * r;
  const x0 = Math.max(0, (cx - r) | 0);
  const x1 = Math.min(w.width - 1, (cx + r) | 0);
  const y0 = Math.max(0, (cy - r) | 0);
  const y1 = Math.min(w.height - 1, (cy + r) | 0);
  // First sweep: find the MAX hole depth inside the brush. The fill
  // layer goes deepest-first — each stamp only converts the tiles at
  // that max depth so the pit gets shallower in successive passes
  // (centre → rim) instead of the rim collapsing inward. Shallow Sea
  // (carved rivers, beach-fringe) only fills once no holes remain in
  // the brush — same "fill the bottom of the cavity first" intuition.
  let maxDepth = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const idx = y * w.width + x;
      if (w.kind[idx] !== TileKind.Hole) continue;
      const d = w.holeDepth[idx] ?? 0;
      if (d > maxDepth) maxDepth = d;
    }
  }
  let tilesAffected = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const idx = y * w.width + x;
      const k = w.kind[idx];
      const isHole = k === TileKind.Hole;
      const isShallowSea = k === TileKind.Sea && w.coastDist[idx] <= 6;
      if (!isHole && !isShallowSea) continue;
      // Deeper-first: when holes are in the brush, only fill the layer
      // at maxDepth this stamp. Shallow Sea waits until all holes here
      // are gone (maxDepth === -1).
      if (isHole && (w.holeDepth[idx] ?? 0) !== maxDepth) continue;
      if (isShallowSea && maxDepth >= 0) continue;
      w.kind[idx] = TileKind.Land;
      w.holeDepth[idx] = 0;
      w.waterLevel[idx] = 0;
      w.riverMask[idx] = 0;
      state.holeTiles?.delete(idx);
      state.activeWaterTiles?.delete(idx);
      state.waterBodiesDirty = true;
      state.dirtyTiles.add(idx);
      tilesAffected++;
    }
  }
  // Refresh neighbouring depths — filling an inner hole can leave the
  // surrounding holes structurally shallower (their nearest non-hole
  // neighbour is now closer). Recompute over the brush bbox plus one
  // extra ring of slack so the rim correctly drops.
  recomputeHoleDepths(state, x0 - 2, y0 - 2, x1 + 2, y1 + 2);
  return { ok: true, tilesAffected };
}

/** Commit a finished shovel stroke. Run on mouseup to activate the
 *  water-flow simulation for any hole tile that now sits next to natural
 *  sea — until the player releases the mouse, dug tiles only "destroy
 *  terrain live"; the rush of water is gated on the commit so a long
 *  channel doesn't start flowing halfway through being drawn. Returns
 *  the number of tiles activated. */
export function commitShovelStroke(state: GameState): number {
  const holes = state.holeTiles;
  if (!holes || holes.size === 0) return 0;
  if (!state.activeWaterTiles) state.activeWaterTiles = new Set();
  const w = state.world;
  const W = w.width;
  const H = w.height;
  let activated = 0;
  for (const idx of holes) {
    if (state.activeWaterTiles.has(idx)) continue;
    const tx = idx % W;
    const ty = (idx / W) | 0;
    if ((tx > 0       && w.kind[idx - 1] === TileKind.Sea) ||
        (tx < W - 1   && w.kind[idx + 1] === TileKind.Sea) ||
        (ty > 0       && w.kind[idx - W] === TileKind.Sea) ||
        (ty < H - 1   && w.kind[idx + W] === TileKind.Sea)) {
      state.activeWaterTiles.add(idx);
      activated++;
    }
  }
  // Always recompute component classification on commit — even a stroke
  // that didn't add any sea-adjacent tile may have changed the topology
  // (e.g. by extending an existing isolated body further inland).
  state.waterBodiesDirty = true;
  return activated;
}

/** Recompute the per-component classification of player-dug hole tiles.
 *  Walks every hole tile via BFS, grouping connected tiles into bodies,
 *  and tags each body as `seaConnected` if any of its tiles has an
 *  orthogonal Sea-kind neighbour. Sea-connected bodies are LEFT OUT of
 *  the isolated-body list — they're handled by the existing cellular
 *  flow (draws from infinite ocean). Isolated bodies populate
 *  `state.isolatedBodies` for the volume-conserving redistribute pass.
 *
 *  Called by the sim step when `state.waterBodiesDirty` is true, which
 *  every flow-changing path (paint / fill / flood / shovel commit) sets.
 *  Cost is O(|holeTiles|) — one visit per tile via BFS. */
export function recomputeWaterBodies(state: GameState): void {
  state.waterBodiesDirty = false;
  if (!state.isolatedHoleTiles) state.isolatedHoleTiles = new Set();
  state.isolatedHoleTiles.clear();
  state.isolatedBodies = [];
  state.seaConnectedBodies = [];
  const holes = state.holeTiles;
  if (!holes || holes.size === 0) return;
  const w = state.world;
  const W = w.width;
  const H = w.height;
  const visited = new Set<number>();
  // BFS uses an array-as-queue with an index head — push to the end,
  // pop from the head — so we don't pay the O(N) cost of Array.shift().
  const queue: number[] = [];
  for (const startIdx of holes) {
    if (visited.has(startIdx)) continue;
    if (w.kind[startIdx] !== TileKind.Hole) continue;
    const bodyTiles: number[] = [];
    let capacity = 0;
    let seaEdgeCount = 0;
    queue.length = 0;
    queue.push(startIdx);
    let head = 0;
    visited.add(startIdx);
    while (head < queue.length) {
      const idx = queue[head++];
      bodyTiles.push(idx);
      capacity += w.holeDepth[idx];
      const tx = idx % W;
      const ty = (idx / W) | 0;
      // Check 4 neighbours: extend BFS through other holes, count sea
      // edges so the sim knows how much inflow this body draws.
      const nbs = [
        tx > 0       ? idx - 1 : -1,
        tx < W - 1   ? idx + 1 : -1,
        ty > 0       ? idx - W : -1,
        ty < H - 1   ? idx + W : -1,
      ];
      let touchesSea = false;
      for (const n of nbs) {
        if (n < 0) continue;
        const nk = w.kind[n];
        if (nk === TileKind.Sea) { touchesSea = true; continue; }
        if (nk !== TileKind.Hole) continue;
        if (visited.has(n)) continue;
        visited.add(n);
        queue.push(n);
      }
      if (touchesSea) seaEdgeCount++;
    }
    if (seaEdgeCount === 0) {
      state.isolatedBodies.push({ tiles: bodyTiles, capacity });
      for (const idx of bodyTiles) state.isolatedHoleTiles.add(idx);
    } else {
      state.seaConnectedBodies.push({ tiles: bodyTiles, capacity, seaEdgeCount });
    }
  }
}

/** Duration (in ticks) of the prop death animation — flip 90° and fade
 *  out. At tickMs=100 this is 10 ticks ≈ 1.0 s, which is long enough to
 *  read as a deliberate fall and short enough that a player chopping
 *  several trees isn't waiting around. */
export const PROP_DEATH_TICKS = 10;

/** Mark a prop as dying — the renderer plays the flip + fade animation
 *  for PROP_DEATH_TICKS, then `stepPropDeaths` commits the entry to
 *  harvestedProps and dirty-marks its chunks. Idempotent: a second call
 *  on an already-dying prop is a no-op (the original animation start
 *  tick is preserved). Use this for ALL prop-removal paths — shovel
 *  dig, tree chop, rock mining, explosion debris — so the player sees
 *  a consistent fall-over animation instead of an instant disappear. */
export function killProp(state: GameState, propIdx: number): void {
  if (state.harvestedProps.has(propIdx)) return;
  if (!state.dyingProps) state.dyingProps = new Map();
  if (state.dyingProps.has(propIdx)) return;
  state.dyingProps.set(propIdx, state.tick);
  // Clear harvest bookkeeping so any villager still targeting the prop
  // releases it on the next tick. Doing this at "kill" time (not
  // "fully harvested") prevents new dispatches from being assigned to
  // a tree/rock that's already on its way out.
  state.treeHarvesters?.delete(propIdx);
  state.rockMinesLeft?.delete(propIdx);
}

/** Walk the props array and mark every prop whose centre lies inside the
 *  brush disk as harvested. Mirrors the per-prop hide flow used by tree-
 *  chopping / rock-mining — the prop stays in the array (so save shapes
 *  don't need to shift) but the renderer + path code skip it. Volcano
 *  and mesa props are preserved: they're terrain, not loose decor. */
function removePropsInDisk(state: GameState, cx: number, cy: number, r: number): void {
  const w = state.world;
  const r2 = r * r;
  for (let i = 0; i < w.props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    if (state.dyingProps?.has(i)) continue;
    const p = w.props[i];
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (dx * dx + dy * dy > r2) continue;
    if (p.sprite.startsWith("vulcano") || p.sprite.startsWith("mesa_")) continue;
    // Use the unified killProp path so the prop animates a fall-over
    // before disappearing. stepPropDeaths handles the eventual flip to
    // harvestedProps + chunk dirty-mark after PROP_DEATH_TICKS.
    killProp(state, i);
    state.spentRocks?.add(i);
  }
}

/** Recompute holeDepth across a bbox. For each Hole tile inside the box,
 *  do a bounded chebyshev BFS outward (capped at MAX_HOLE_DEPTH) and use
 *  the radius of the first non-hole tile encountered as the depth.
 *  Sea / off-map count as non-hole boundaries too. Cheap because the cap
 *  is small (≤ MAX_HOLE_DEPTH iterations per tile) and the bbox is the
 *  brush radius plus slack. */
function recomputeHoleDepths(
  state: GameState, x0: number, y0: number, x1: number, y1: number,
): void {
  const w = state.world;
  const W = w.width;
  const H = w.height;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(W - 1, x1); y1 = Math.min(H - 1, y1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = y * W + x;
      if (w.kind[idx] !== TileKind.Hole) continue;
      let depth = MAX_HOLE_DEPTH;
      for (let r = 1; r <= MAX_HOLE_DEPTH; r++) {
        let foundEdge = false;
        // Ring at chebyshev distance r — check whether ANY tile in that
        // ring is a non-hole. The first such ring determines the depth.
        const ry0 = y - r, ry1 = y + r;
        const rx0 = x - r, rx1 = x + r;
        for (let oy = ry0; oy <= ry1 && !foundEdge; oy++) {
          // Only the outer edge of the ring — interior tiles were checked
          // by smaller r values already.
          const isEdgeRow = (oy === ry0 || oy === ry1);
          for (let ox = rx0; ox <= rx1; ox++) {
            const isEdgeCol = (ox === rx0 || ox === rx1);
            if (!isEdgeRow && !isEdgeCol) continue;
            if (oy < 0 || oy >= H || ox < 0 || ox >= W) { foundEdge = true; break; }
            const nidx = oy * W + ox;
            if (w.kind[nidx] !== TileKind.Hole) { foundEdge = true; break; }
          }
        }
        if (foundEdge) { depth = r; break; }
      }
      w.holeDepth[idx] = depth;
      // Clamp existing water to the new depth — filling neighbours can
      // shrink this tile's capacity and we don't want stale overflow.
      if (w.waterLevel[idx] > depth) w.waterLevel[idx] = depth;
      state.dirtyTiles.add(idx);
    }
  }
}

/** Paint a single farmland tile at world-position (x, y). The new
 *  brush-style farm tool calls this once per click and again for each
 *  tile the cursor crosses while the mouse button stays held. Costs
 *  FARM_ASH_PER_TILE ash per successful paint. */
export function paintFarmTile(
  state: GameState, playerId: number, x: number, y: number,
): FarmPaintResult {
  const w = state.world;
  const player = state.players[playerId];
  if ((player.tools.hoe ?? 0) <= 0) return { ok: false, reason: "no_hoe" };
  if ((player.tools.shovel ?? 0) <= 0) return { ok: false, reason: "no_shovel" };
  if (player.resources.ash < FARM_ASH_PER_TILE) return { ok: false, reason: "no_ash" };
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || xi >= w.width || yi < 0 || yi >= w.height) return { ok: false, reason: "not_paintable" };
  const idx = yi * w.width + xi;
  if (w.farmlandState[idx] !== 0) return { ok: false, reason: "not_paintable" };
  if (!isOwnable(w.kind[idx])) return { ok: false, reason: "not_paintable" };
  if (w.blockedByProp && w.blockedByProp[idx]) return { ok: false, reason: "not_paintable" };
  w.farmlandState[idx] = 1;
  w.farmlandOwner[idx] = playerId;
  if (!state.pendingFarmlandTiles) state.pendingFarmlandTiles = new Set();
  state.pendingFarmlandTiles.add(idx);
  // Wet-farmland network: a new tile is wet if it's directly inside the
  // 10-tile shore band OR adjacent (4-neighbour) to an existing wet
  // farmland tile. When THIS tile becomes wet, it also wets all
  // previously-isolated farmland it now connects to — a BFS spreads the
  // flag through the orthogonal-adjacency graph until no more dry
  // farmland tiles connect.
  if (!state.wetFarmlandTiles) state.wetFarmlandTiles = new Set();
  const W = w.width;
  const H = w.height;
  let tileWet = w.coastDist[idx] <= 10;
  if (!tileWet) {
    const tx = idx % W;
    const ty = (idx / W) | 0;
    const nbs = [
      tx > 0       ? idx - 1 : -1,
      tx < W - 1   ? idx + 1 : -1,
      ty > 0       ? idx - W : -1,
      ty < H - 1   ? idx + W : -1,
    ];
    for (const n of nbs) {
      if (n >= 0 && state.wetFarmlandTiles.has(n)) { tileWet = true; break; }
    }
  }
  if (tileWet) {
    state.wetFarmlandTiles.add(idx);
    state.dirtyTiles.add(idx);
    // Flood-fill outward through connected farmland that hadn't been
    // wet before — the new tile may have bridged an inland pocket to a
    // wet seed.
    const queue: number[] = [idx];
    let head = 0;
    while (head < queue.length) {
      const q = queue[head++];
      const qx = q % W;
      const qy = (q / W) | 0;
      const qnbs = [
        qx > 0       ? q - 1 : -1,
        qx < W - 1   ? q + 1 : -1,
        qy > 0       ? q - W : -1,
        qy < H - 1   ? q + W : -1,
      ];
      for (const n of qnbs) {
        if (n < 0) continue;
        if (state.wetFarmlandTiles.has(n)) continue;
        if (w.farmlandState[n] === 0) continue;          // not farmland
        if (w.farmlandOwner[n] !== playerId) continue;   // someone else's plot
        state.wetFarmlandTiles.add(n);
        state.dirtyTiles.add(n);
        queue.push(n);
      }
    }
  }
  state.dirtyTiles.add(idx);
  // Dirty-mark the 8 surrounding tiles — the corner-rounding renderer
  // reads each tile's 4 neighbours to decide which corners are exposed,
  // so any tile sharing an edge with the new farmland needs to repaint
  // to drop the rounding from its now-interior corner. Diagonals are
  // included for forward-compat with any 8-neighbour smoothing rule.
  {
    const W2 = w.width;
    const H2 = w.height;
    const fx = idx % W2;
    const fy = (idx / W2) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ny = fy + oy;
      if (ny < 0 || ny >= H2) continue;
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = fx + ox;
        if (nx < 0 || nx >= W2) continue;
        state.dirtyTiles.add(ny * W2 + nx);
      }
    }
  }
  // Drain the fractional ash cost from across every campfire.
  tryDebitAggregate(state, playerId, "ash", FARM_ASH_PER_TILE);
  return { ok: true };
}

/** Linear scan for the closest pending-farmland tile owned by
 *  `playerId` to (x, y). Returns -1 if nothing pending. Called per
 *  villager fertilize-step; cheap because the search is bounded by
 *  the per-player farmland set so even a 5000-tile farm stays fast. */
export function findClosestPendingFarmland(
  state: GameState, playerId: number,
  x: number, y: number,
): number {
  // Iterate the maintained pending-tile set instead of scanning the
  // full world arrays. The set is populated by paintFarmTile and drained
  // by the fertilize-complete site in engine.ts; on resume it's rebuilt
  // from world.farmlandState in normalizeResumedState. Set sizes are
  // typically a few hundred tiles even on heavy farms — orders of
  // magnitude smaller than the 24M-tile world scan this replaces.
  const w = state.world;
  const fo = w.farmlandOwner;
  const W = w.width;
  const pend = state.pendingFarmlandTiles;
  if (!pend || pend.size === 0) return -1;
  let bestIdx = -1;
  let bestD2 = Infinity;
  for (const i of pend) {
    if (fo[i] !== playerId) continue;
    // Defensive: the set may carry a stale entry if the farmland state
    // was ever zeroed externally. Skip it instead of returning a tile
    // that's no longer pending.
    if (w.farmlandState[i] !== 1) continue;
    const tx = i % W;
    const ty = (i / W) | 0;
    const dx = tx + 0.5 - x;
    const dy = ty + 0.5 - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Pick an idle worker villager owned by `playerId` and put them in the
 *  fertilize loop. Returns true if a worker was found + assigned. */
export function assignFertilize(state: GameState, playerId: number, by: "player" | "auto" = "auto"): boolean {
  // Only run if there's actually pending farmland to fertilize — saves
  // the auto-assist tick from scanning idle workers for nothing.
  let hasPending = false;
  const fs = state.world.farmlandState;
  const fo = state.world.farmlandOwner;
  for (let i = 0; i < fs.length; i++) {
    if (fs[i] === 1 && fo[i] === playerId) { hasPending = true; break; }
  }
  if (!hasPending) return false;
  const v = by === "player"
    ? findClosestReassignableVillager(state, playerId, 0, 0)
    : findClosestIdleVillager(state, playerId, 0, 0);
  if (!v) return false;
  v.job = "fertilizing";
  v.targetPropIdx = -1;
  v.carryingSprite = undefined;
  v.harvestType = undefined;
  v.pathTiles = undefined;
  v.pathIdx = undefined;
  v.pathTargetTile = undefined;
  v.assignedBy = by;
  return true;
}

/** Find the closest unharvested tree prop to (x, y) within `maxDist`.
 *  Returns the prop index into world.props, or -1 if no tree found. */
export function findClosestTree(state: GameState, x: number, y: number, maxDist: number): number {
  const props = state.world.props;
  let bestIdx = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    const p = props[i];
    if (!p.sprite.startsWith("tree_")) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Find the closest IDLE villager owned by `playerId` to (x, y). Used to
 *  pick which villager handles a player's tree-chop click. */
export function findClosestIdleVillager(state: GameState, playerId: number, x: number, y: number): Villager | null {
  let best: Villager | null = null;
  let bestD2 = Infinity;
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if (v.job !== "idle") continue;
    // Skip villagers currently boarded inside a structure (e.g. an
    // airship at the port). They're invisible and unavailable.
    if (v.insideStructureId !== undefined) continue;
    const dx = v.x - x;
    const dy = v.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = v;
    }
  }
  return best;
}

/** Batch auto-assign every idle worker the player owns. Triggered by
 *  the HUD button. Each villager is dispatched to a UNIQUE target —
 *  no two workers converge on the same tree, rock, build, or farm
 *  tile within a single auto-assign call. We do this by maintaining a
 *  set of claimed target keys during the dispatch and skipping any
 *  candidate already in the set.
 *
 *  Target categories (in priority order — the first viable category
 *  with capacity for this villager wins):
 *   - BUILD-HELP: the player's unfinished structures (one villager per
 *     missing builder slot, capped at buildersNeeded each)
 *   - FERTILIZE:  pending farmland tiles, one villager per tile
 *   - CHOP:       unharvested trees, one villager per tree
 *   - MINE:       unharvested rocks, one villager per rock (gated on
 *                 owning a pickaxe)
 *  Returns the count of villagers that received a task. */
export function autoAssignIdleWorkers(state: GameState, playerId: number): number {
  const home = findHomeTent(state, playerId);
  const idle: Villager[] = [];
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if (v.job !== "idle") continue;
    if ((v.role ?? "worker") !== "worker") continue;
    if (v.insideStructureId !== undefined) continue;
    idle.push(v);
  }
  if (idle.length === 0) return 0;

  const player = state.players[playerId];
  const pickaxePool = player.tools.pickaxe ?? 0;
  const hoePool = player.tools.hoe ?? 0;
  // Tool slots already in use by existing miners / farmers / fertilisers.
  // The dispatch loop below increments these as it hands out new tasks,
  // so we stop dispatching once the pool's empty.
  let pickaxeUsed = countActiveToolUsers(state, playerId, "pickaxe");
  let hoeUsed = countActiveToolUsers(state, playerId, "hoe");
  const w = state.world;
  // Claim sets for each target kind. Keys are propIdx or structureId,
  // build counts track per-structure how many we've already dispatched.
  const claimedTrees = new Set<number>();
  const claimedRocks = new Set<number>();
  const claimedFarms = new Set<number>();
  const buildDispatched = new Map<number, number>();

  // Pre-build farm tile list — one O(n) scan up front instead of per-
  // villager during dispatch.
  const pendingFarms: { idx: number; x: number; y: number }[] = [];
  if (w.farmlandState) {
    const fs = w.farmlandState;
    const fo = w.farmlandOwner;
    for (let i = 0; i < fs.length; i++) {
      if (fs[i] === 1 && fo[i] === playerId) {
        const tx = (i % w.width) + 0.5;
        const ty = ((i / w.width) | 0) + 0.5;
        pendingFarms.push({ idx: i, x: tx, y: ty });
      }
    }
  }
  // Pre-build unfinished build list.
  const unfinishedBuilds = state.structures.filter(
    (s) => s.ownerId === playerId && (s.buildProgress ?? 1) < 1,
  );

  /** Closest unclaimed pending build with capacity. */
  const pickBuild = (v: Villager) => {
    let best: typeof state.structures[number] | null = null;
    let bestD2 = 220 * 220;
    for (const s of unfinishedBuilds) {
      const cap = s.buildersNeeded ?? 3;
      if ((buildDispatched.get(s.id) ?? 0) >= cap) continue;
      const dx = s.x - v.x;
      const dy = s.y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  };

  /** Closest unclaimed pending farm tile. */
  const pickFarm = (v: Villager) => {
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (const f of pendingFarms) {
      if (claimedFarms.has(f.idx)) continue;
      const dx = f.x - v.x;
      const dy = f.y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = f.idx; }
    }
    return bestIdx;
  };

  /** Closest unclaimed tree this villager can still harvest. */
  const pickTree = (v: Villager) => {
    const props = w.props;
    let bestIdx = -1;
    let bestD2 = 600 * 600;        // wider than PATCH_RADIUS — pull from across the territory
    for (let i = 0; i < props.length; i++) {
      if (claimedTrees.has(i)) continue;
      if (!props[i].sprite.startsWith("tree_")) continue;
      if (!canHarvestTree(state, i, v.id)) continue;
      const dx = props[i].x - v.x;
      const dy = props[i].y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return bestIdx;
  };

  /** Closest unclaimed rock prop. */
  const pickRock = (v: Villager) => {
    const props = w.props;
    const spent = state.spentRocks;
    let bestIdx = -1;
    let bestD2 = 600 * 600;
    for (let i = 0; i < props.length; i++) {
      if (claimedRocks.has(i)) continue;
      if (state.harvestedProps.has(i)) continue;
      if (spent && spent.has(i)) continue;        // empty berry-rock husks
      const sprite = props[i].sprite;
      if (!sprite.startsWith("rock_") && !sprite.startsWith("rocksnowy_")
          && !sprite.startsWith("mesa_rock") && !sprite.startsWith("mesa_spire")
          && !sprite.startsWith("iron_") && !sprite.startsWith("gold_")
          && !sprite.startsWith("diamond_") && !sprite.startsWith("uranium_")
          && !sprite.startsWith("redberry_") && !sprite.startsWith("blueberry_")
          && !sprite.startsWith("yellowberry_")) continue;
      const dx = props[i].x - v.x;
      const dy = props[i].y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return bestIdx;
  };
  /** Closest unclaimed animal — picks by ANIMAL ID since the animals
   *  array is mutated (swap-remove) when one dies. The claim set is
   *  keyed off animal.id to stay stable. */
  const claimedAnimals = new Set<number>();
  const pickAnimal = (v: Villager): number => {
    const animals = state.animals;
    if (!animals || animals.length === 0) return -1;
    let bestIdx = -1;
    let bestD2 = 500 * 500;
    for (let i = 0; i < animals.length; i++) {
      const a = animals[i];
      if (claimedAnimals.has(a.id)) continue;
      const dx = a.x - v.x;
      const dy = a.y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    return bestIdx;
  };

  /** Direct dispatch of a specific villager onto a tree / rock without
   *  going through the assign* helpers (which find their own villager).
   *  Mirrors what assignTreeChop / assignRockMine do internally. */
  const dispatchToTree = (v: Villager, propIdx: number) => {
    const tree = w.props[propIdx];
    v.job = "walkToTree";
    v.targetPropIdx = propIdx;
    v.targetX = tree.x;
    v.targetY = tree.y;
    v.patchX = tree.x;
    v.patchY = tree.y;
    v.harvestType = "wood";
    v.assignedBy = "auto";
    v.pathTiles = undefined;
    v.pathIdx = undefined;
    v.pathTargetTile = undefined;
  };
  const dispatchToRock = (v: Villager, propIdx: number) => {
    const rock = w.props[propIdx];
    v.job = "walkToRock";
    v.targetPropIdx = propIdx;
    v.targetX = rock.x;
    v.targetY = rock.y;
    v.patchX = rock.x;
    v.patchY = rock.y;
    v.harvestType = "rock";
    v.assignedBy = "auto";
    v.pathTiles = undefined;
    v.pathIdx = undefined;
    v.pathTargetTile = undefined;
  };
  const dispatchToFarm = (v: Villager) => {
    // The fertilizing job handles its own ash-grab + nearest-tile pick
    // internally — we just put the villager into that state and let
    // the engine drive the rest.
    v.job = "fertilizing";
    v.targetPropIdx = -1;
    v.carryingSprite = undefined;
    v.harvestType = undefined;
    v.assignedBy = "auto";
    v.pathTiles = undefined;
    v.pathIdx = undefined;
    v.pathTargetTile = undefined;
  };

  // Sort idle workers by distance to home so the closest worker gets
  // the closest task — keeps the dispatch visually local instead of
  // sending a worker across the world to fertilize when there's a
  // tree at their feet.
  if (home) {
    idle.sort((a, b) => {
      const da2 = (a.x - home.x) ** 2 + (a.y - home.y) ** 2;
      const db2 = (b.x - home.x) ** 2 + (b.y - home.y) ** 2;
      return da2 - db2;
    });
  }

  let assigned = 0;
  for (let i = 0; i < idle.length; i++) {
    const v = idle[i];
    // 50% HUNT SPLIT: every other villager gets hunting first. If
    // there's no animal in range OR a critical build needs help, they
    // fall through to the normal lane order. Even-indexed villagers
    // (i % 2 === 0) take the hunt slot; odd-indexed go production
    // first. Net effect: ~50% of idle workers chase animals when
    // wildlife is around.
    const huntFirst = (i % 2 === 0);

    // Build help always wins — half-built structures stall the economy
    // until they finish, that takes priority over food.
    const bld = pickBuild(v);
    if (bld) {
      if (assignBuildHelp(state, v.id, bld.id, "auto")) {
        buildDispatched.set(bld.id, (buildDispatched.get(bld.id) ?? 0) + 1);
        assigned++;
        continue;
      }
    }

    if (huntFirst) {
      const aIdx = pickAnimal(v);
      if (aIdx >= 0) {
        const aId = state.animals![aIdx].id;
        if (assignHuntForVillager(state, v, aIdx)) {
          v.assignedBy = "auto";
          claimedAnimals.add(aId);
          assigned++;
          continue;
        }
      }
      // No huntable animal — fall through to production lanes.
    }

    const farm = pickFarm(v);
    if (farm >= 0 && hoeUsed < hoePool) {
      dispatchToFarm(v);
      claimedFarms.add(farm);
      hoeUsed++;
      assigned++;
      continue;
    }
    const tree = pickTree(v);
    if (tree >= 0) {
      dispatchToTree(v, tree);
      claimedTrees.add(tree);
      assigned++;
      continue;
    }
    if (pickaxeUsed < pickaxePool) {
      const rock = pickRock(v);
      if (rock >= 0) {
        dispatchToRock(v, rock);
        claimedRocks.add(rock);
        pickaxeUsed++;
        assigned++;
        continue;
      }
    }
  }
  return assigned;
}

/** Player-click dispatch helper. Returns the CLOSEST worker villager
 *  that is either truly idle OR currently doing an Auto-Assign-issued
 *  task (assignedBy == "auto"). Never overrides a villager the player
 *  tasked directly (assignedBy == "player") — those are off-limits.
 *
 *  Single-pass closest-wins over the union of both pools so the user's
 *  expectation "click reassigns the worker nearest to where I clicked"
 *  holds even when a stray idle villager is across the map. The old
 *  behaviour preferred idle regardless of distance, which made clicks
 *  feel non-responsive when a worker was right next to the clicked
 *  prop but happened to be auto-tasked. */
export function findClosestReassignableVillager(
  state: GameState, playerId: number, x: number, y: number,
): Villager | null {
  let best: Villager | null = null;
  let bestD2 = Infinity;
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if (v.insideStructureId !== undefined) continue;
    if ((v.role ?? "worker") !== "worker") continue;
    // Eligible: idle (no current task) OR auto-assigned (Auto-Assign
    // button or background dispatch). assignedBy === "player" is the
    // hard line — those villagers were explicitly directed and stay put.
    const eligible = v.job === "idle" || v.assignedBy === "auto";
    if (!eligible) continue;
    const dx = v.x - x;
    const dy = v.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = v;
    }
  }
  return best;
}

/** Send the closest idle villager of `playerId` aboard the player's
 *  first airship port. Sets `insideStructureId` so the renderer skips
 *  the sprite and the idle-villager pool excludes them. Returns:
 *    "ok"                — boarded successfully
 *    "no_idle_villager"  — no available villager
 *    "no_structure"      — player owns no airship port
 */
export type BoardResult = "ok" | "no_idle_villager" | "no_structure";
export function boardVillagerInAirshipPort(state: GameState, playerId: number): BoardResult {
  let port: Structure | null = null;
  for (const s of state.structures) {
    if (s.ownerId === playerId && s.defKey.startsWith("airship_port")) { port = s; break; }
  }
  if (!port) return "no_structure";
  const v = findClosestIdleVillager(state, playerId, port.x, port.y);
  if (!v) return "no_idle_villager";
  // Walk-up animation: instead of teleporting the villager into the
  // dock, send them to the port entrance and flip insideStructureId on
  // arrival. The engine's stepVillagers walkToBoard case handles the
  // arrival check. Clears any in-progress harvest target.
  v.job = "walkToBoard";
  v.boardTargetStructureId = port.id;
  v.targetX = port.x;
  v.targetY = port.y;
  v.targetPropIdx = -1;
  return "ok";
}

/** Send the nearest idle villager into one of this player's naval
 *  ports. Symmetric with `boardVillagerInAirshipPort` so the PortWindow's
 *  Crew & Boarding page can offer the same "+ Board villager" button on
 *  both dock kinds. From a boarded port the player can then click
 *  "Crew up" on a docked vessel (assignDockCrewToVessel) to commit the
 *  pool toward a specific ship.
 *
 *  Return values mirror the airship variant:
 *    "ok"                — boarded the closest idle villager
 *    "no_idle_villager"  — every villager is mid-task
 *    "no_structure"      — player owns no naval port */
export function boardVillagerInNavalPort(state: GameState, playerId: number): BoardResult {
  let port: Structure | null = null;
  for (const s of state.structures) {
    if (s.ownerId === playerId && s.defKey.startsWith("port_")) { port = s; break; }
  }
  if (!port) return "no_structure";
  const v = findClosestIdleVillager(state, playerId, port.x, port.y);
  if (!v) return "no_idle_villager";
  // Walk-up animation — same flow as the airship variant. Villager
  // walks to the port entrance and the engine commits insideStructureId
  // on arrival.
  v.job = "walkToBoard";
  v.boardTargetStructureId = port.id;
  v.targetX = port.x;
  v.targetY = port.y;
  v.targetPropIdx = -1;
  return "ok";
}

/** Count villagers currently boarded inside a given structure. */
export function countBoardedVillagers(state: GameState, structureId: number): number {
  let n = 0;
  for (const v of state.villagers) if (v.insideStructureId === structureId) n++;
  return n;
}

/** Pull villagers boarded inside the player's airship-port docks onto a
 *  specific docked vessel until that vessel's crew requirement is met
 *  (or the dock pool runs out). Each villager is removed from the port
 *  (cleared `insideStructureId`) and pushed into `vessel.boardedVillagerIds`.
 *  Returns the number actually assigned. The vessel must be the same
 *  owner as the player calling, must be `status === "docked"`, and must
 *  belong to a port (`portStructureId`) that's an airship_port — naval
 *  ships use the per-port-side crew flow on the ship itself.
 *
 *  This is the helper behind the "send 8 boarded villagers to this
 *  airship" button on the PortWindow board page — the user wants to
 *  fill up the dock with idle workers, then commit a batch onto a
 *  specific airship for takeoff. */
export function assignDockCrewToVessel(
  state: GameState, playerId: number, vesselId: number,
): number {
  const vessel = state.vessels.find((v) => v.id === vesselId);
  if (!vessel || vessel.ownerId !== playerId) return 0;
  if (vessel.status !== "docked") return 0;
  const def = getVesselDef(vessel.defKey);
  if (!def) return 0;
  const crewNeeded = def.crew ?? 0;
  const already = vessel.boardedVillagerIds.length;
  const slotsLeft = Math.max(0, crewNeeded - already);
  if (slotsLeft === 0) return 0;
  // Collect candidate villagers boarded inside one of the player's
  // airship ports. Cap collection at slotsLeft so the loop bails early
  // on a player with thousands of villagers.
  const candidates: Villager[] = [];
  for (const v of state.villagers) {
    if (candidates.length >= slotsLeft) break;
    if (v.ownerId !== playerId) continue;
    if (v.insideStructureId === undefined) continue;
    const port = state.structuresById?.get(v.insideStructureId);
    if (!port || !port.defKey.startsWith("airship_port")) continue;
    candidates.push(v);
  }
  let assigned = 0;
  for (const v of candidates) {
    if (boardVillager(state, vessel.id, v.id)) {
      // boardVillager pushed the id into vessel.boardedVillagerIds.
      // We also clear insideStructureId so the villager is no longer
      // counted as dock-boarded — they're committed to the vessel now.
      v.insideStructureId = undefined;
      assigned++;
    }
  }
  return assigned;
}

/** Disembark every villager currently boarded inside `structureId` —
 *  drops them next to the structure as idle. */
export function disembarkAll(state: GameState, structureId: number): number {
  const target = state.structuresById?.get(structureId);
  if (!target) return 0;
  let n = 0;
  for (const v of state.villagers) {
    if (v.insideStructureId !== structureId) continue;
    v.insideStructureId = undefined;
    v.x = target.x + (Math.random() - 0.5) * 8;
    v.y = target.y + (Math.random() - 0.5) * 8;
    v.job = "idle";
    n++;
  }
  return n;
}

/** Player clicks a world point — find the nearest tree, find an idle
 *  villager, assign the chop job. Returns true if a villager was
 *  dispatched. Patch centre is the tree's position, so subsequent
 *  trees within `PATCH_RADIUS` get harvested in the same job chain. */
export const TREE_PICK_DIST = 120;
export const PATCH_RADIUS = 80;
/** Patch-chain fallback radius: when a villager finishes their current
 *  patch and looks for the next tree/rock to keep harvesting, we let
 *  them search the entire world rather than stopping. The closest
 *  candidate still wins, so local patches always drain first — this
 *  only kicks in once nothing in PATCH_RADIUS remains. Sized larger
 *  than any plausible map diagonal so it functions as "infinite". */
export const INFINITE_PATCH_RADIUS = 1e9;
export function assignTreeChop(state: GameState, playerId: number, x: number, y: number, by: "player" | "auto" = "player"): boolean {
  // Pick the closest idle villager near the click first, so we can use
  // their id to filter the tree-search to "trees this villager hasn't
  // already chopped". Without the per-villager filter we'd hand the same
  // worker back the same tree forever and walkToTree would just abort.
  // When the player initiates the dispatch we also allow stealing
  // auto-assigned workers; an auto-trigger only takes idle workers.
  const villager = by === "player"
    ? findClosestReassignableVillager(state, playerId, x, y)
    : findClosestIdleVillager(state, playerId, x, y);
  if (!villager) {
    // No idle worker — check that at least SOMETHING in range matters,
    // otherwise the click was on empty grass and the caller can fall
    // through to other dispatch paths.
    return findClosestTree(state, x, y, TREE_PICK_DIST) >= 0 ? false : false;
  }
  const treeIdx = findClosestTreeFor(state, villager.id, x, y, TREE_PICK_DIST);
  if (treeIdx < 0) return false;
  const tree = state.world.props[treeIdx];
  villager.job = "walkToTree";
  villager.targetPropIdx = treeIdx;
  villager.targetX = tree.x;
  villager.targetY = tree.y;
  villager.patchX = tree.x;
  villager.patchY = tree.y;
  villager.harvestType = "wood";
  villager.assignedBy = by;
  // Drop the stale path so stepAlongPath recomputes against the new
  // target on the next tick instead of finishing the prior route.
  villager.pathTiles = undefined;
  villager.pathIdx = undefined;
  villager.pathTargetTile = undefined;
  return true;
}

/** Find the closest unharvested rock prop to (x, y) within `maxDist`.
 *  "Rock" covers the standard rock pool (rock_arch / mound / spire /
 *  spikebatch), the mesa-rock + mesa-spire family, and the epic-rare
 *  volcano rocks. Returns -1 if nothing nearby qualifies. */
/** Every prop sprite prefix the mining loop treats as "rock". Covers
 *  the standard rock family, mesa rocks/spires, the snowy reskin, and
 *  every variant family that drops a special resource (iron / gold /
 *  diamond / uranium / berry-bearing). Keep this in sync with the
 *  scatter passes in world.ts AND the yield table in engine.ts. */
const MINEABLE_PREFIXES = [
  "rock_",
  "mesa_rock", "mesa_spire",
  "rocksnowy_",
  "iron_", "gold_", "diamond_", "uranium_",
  "redberry_", "yellowberry_", "blueberry_",
];
function isMineableSprite(sprite: string): boolean {
  for (const p of MINEABLE_PREFIXES) {
    if (sprite.startsWith(p)) return true;
  }
  return false;
}

export function findClosestRock(state: GameState, x: number, y: number, maxDist: number): number {
  const props = state.world.props;
  const spent = state.spentRocks;
  let bestIdx = -1;
  let bestD2 = maxDist * maxDist;
  for (let i = 0; i < props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    // Spent berry rocks were converted to plain `rock_*` sprites for the
    // visual but must NOT be mineable again — skip them here so the
    // dispatch + bot-AI rock searches never re-target them.
    if (spent && spent.has(i)) continue;
    if (!isMineableSprite(props[i].sprite)) continue;
    const p = props[i];
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Result of an attempted rock-mine dispatch. The UI uses the discriminator
 *  to decide whether to forceUpdate (`ok`) or show the "Requires Pickaxe"
 *  toast (`no_pickaxe`). All other failure modes are silent — the player
 *  probably clicked a tile that wasn't actually a rock. */
export type MineResult = "ok" | "no_pickaxe" | "no_rock_nearby" | "no_idle_villager";

/** Result of an attempted beach-farm dispatch. Same discriminator
 *  pattern as the rock mine — UI shows the "Requires Hoe" toast for
 *  `no_hoe`; other failure modes are silent. */
export type FarmResult = "ok" | "no_hoe" | "not_beach" | "no_idle_villager";

/** Click-on-beach handler. Validates the tile is actually beach sand
 *  (Land within 5 of the coast — same threshold styleForTile uses
 *  for the birch beach style), checks the tribe has a hoe, then
 *  dispatches the closest idle villager to farm that tile. */
export function assignFarm(state: GameState, playerId: number, x: number, y: number, by: "player" | "auto" = "player"): FarmResult {
  const w = state.world;
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || xi >= w.width || yi < 0 || yi >= w.height) return "not_beach";
  const idx = yi * w.width + xi;
  if (w.kind[idx] !== TileKind.Land) return "not_beach";
  if (w.coastDist[idx] > 5) return "not_beach";
  const player = state.players[playerId];
  if ((player.tools.hoe ?? 0) <= 0) return "no_hoe";
  const villager = by === "player"
    ? findClosestReassignableVillager(state, playerId, x, y)
    : findClosestIdleVillager(state, playerId, x, y);
  if (!villager) return "no_idle_villager";
  // Slot gate — bounds the AUTO-assign batch so a tribe with N hoes
  // can run at most N parallel farmers. Player clicks bypass the gate:
  // the user wanted explicit clicks to always be able to pull from the
  // auto-assigned worker pool, even when every hoe is already busy.
  if (by === "auto"
      && !villagerHoldsTool(villager, "hoe")
      && countActiveToolUsers(state, playerId, "hoe") >= (player.tools.hoe ?? 0)) {
    return "no_hoe";
  }
  villager.job = "walkToFarm";
  villager.targetPropIdx = -1;
  villager.targetX = x;
  villager.targetY = y;
  villager.patchX = x;
  villager.patchY = y;
  villager.harvestType = "berry";
  villager.assignedBy = by;
  villager.pathTiles = undefined;
  villager.pathIdx = undefined;
  villager.pathTargetTile = undefined;
  return "ok";
}

export const ROCK_PICK_DIST = 120;

/** Count villagers of `playerId` currently using a given tool. A villager
 *  occupies a tool slot for the WHOLE harvest cycle (walk-out → work →
 *  walk-home), so a tribe with N pickaxes can keep at most N miners
 *  active at once. Buying more pickaxes lets more villagers mine in
 *  parallel — that's the user's "tool count actually matters" request.
 *
 *  Supported tools: "pickaxe" (mining), "hoe" (farming + fertilising).
 *  Shovel is a player-driven brush, not a per-villager job, and spear
 *  is consumed at promotion time — both stay on the simple-existence
 *  gate elsewhere. */
export function countActiveToolUsers(
  state: GameState, playerId: number, tool: "pickaxe" | "hoe",
): number {
  let n = 0;
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if (v.insideStructureId !== undefined) continue;
    if (tool === "pickaxe") {
      if (v.job === "walkToRock" || v.job === "mining") n++;
      else if (v.job === "walkHome" && v.harvestType === "rock") n++;
    } else {
      if (v.job === "walkToFarm" || v.job === "farming" || v.job === "fertilizing") n++;
      else if (v.job === "walkHome" && v.harvestType === "berry") n++;
    }
  }
  return n;
}

/** True if `v` already occupies a tool slot for `tool`. Used by the
 *  click-dispatch helpers so reassigning an existing user to a new
 *  target doesn't count against the pool (the pickaxe stays in their
 *  hands the whole time). */
function villagerHoldsTool(v: Villager, tool: "pickaxe" | "hoe"): boolean {
  if (v.insideStructureId !== undefined) return false;
  if (tool === "pickaxe") {
    if (v.job === "walkToRock" || v.job === "mining") return true;
    if (v.job === "walkHome" && v.harvestType === "rock") return true;
    return false;
  }
  if (v.job === "walkToFarm" || v.job === "farming" || v.job === "fertilizing") return true;
  if (v.job === "walkHome" && v.harvestType === "berry") return true;
  return false;
}

/** Pickaxe is only required for stone-yielding mineables. Ore deposits
 *  (iron / gold / diamond / uranium) and berry-bearing rocks are
 *  hand-harvested, otherwise tree-clicks near a stray iron rock would
 *  trip the pickaxe gate even though nothing the player wanted to do
 *  needed a tool. */
function mineRequiresPickaxe(sprite: string): boolean {
  // Every mineable prop is now pickaxe-gated. The original carve-out for
  // ore + berry rocks existed so tree-clicks near a stray iron deposit
  // wouldn't false-toast — that's solved differently now (the click
  // handler picks rock vs tree by proximity), so we can hold the gate
  // uniformly without the side effect.
  return sprite.startsWith("rock_")
    || sprite.startsWith("rocksnowy_")
    || sprite.startsWith("mesa_rock")
    || sprite.startsWith("mesa_spire")
    || sprite.startsWith("iron_")
    || sprite.startsWith("gold_")
    || sprite.startsWith("diamond_")
    || sprite.startsWith("uranium_")
    || sprite.startsWith("redberry_")
    || sprite.startsWith("blueberry_")
    || sprite.startsWith("yellowberry_");
}

export function assignRockMine(state: GameState, playerId: number, x: number, y: number, by: "player" | "auto" = "player"): MineResult {
  const rockIdx = findClosestRock(state, x, y, ROCK_PICK_DIST);
  if (rockIdx < 0) return "no_rock_nearby";
  // Tool gate — only stone deposits require a pickaxe. Everything else
  // (ore, berry rocks) gets dispatched without the check.
  const sprite = state.world.props[rockIdx].sprite;
  const needsPickaxe = mineRequiresPickaxe(sprite);
  if (needsPickaxe) {
    const player = state.players[playerId];
    if ((player.tools.pickaxe ?? 0) <= 0) return "no_pickaxe";
  }
  const rock = state.world.props[rockIdx];
  const villager = by === "player"
    ? findClosestReassignableVillager(state, playerId, rock.x, rock.y)
    : findClosestIdleVillager(state, playerId, rock.x, rock.y);
  if (!villager) return "no_idle_villager";
  // Slot gate — bounds the AUTO-assign batch so a tribe with N
  // pickaxes runs at most N parallel miners. Player clicks bypass so
  // the user can always reassign an auto-tasked worker onto a fresh
  // rock even when every pickaxe is in someone else's hands.
  if (needsPickaxe && by === "auto") {
    const player = state.players[playerId];
    if (!villagerHoldsTool(villager, "pickaxe")
        && countActiveToolUsers(state, playerId, "pickaxe") >= (player.tools.pickaxe ?? 0)) {
      return "no_pickaxe";
    }
  }
  villager.job = "walkToRock";
  villager.targetPropIdx = rockIdx;
  villager.targetX = rock.x;
  villager.targetY = rock.y;
  villager.patchX = rock.x;
  villager.patchY = rock.y;
  villager.harvestType = "rock";
  villager.assignedBy = by;
  villager.pathTiles = undefined;
  villager.pathIdx = undefined;
  villager.pathTargetTile = undefined;
  return "ok";
}

/** How many worker villagers must stand inside a build site for the
 *  construction tick to advance. The user-stated rule is "3 or more
 *  people to a build to make it finish" — kept as a per-structure field
 *  so we can later vary it by building size if needed. */
export const DEFAULT_BUILDERS_NEEDED = 3;
/** Radius (tiles) around an unfinished structure inside which a worker
 *  villager is counted toward the build crew, and inside which an idle
 *  worker walking up automatically transitions from "walkToBuild" into
 *  "building". Sized larger than the typical structure footprint so a
 *  loose ring of workers around the site all contribute. */
export const BUILD_HELP_RADIUS = 30;

/** Place a building of `defKey` at world tile (x, y) for `playerId`.
 *  Returns true on success. Validation: ownable terrain, no existing
 *  structure too close, player can afford every resource in def.cost.
 *  All cost resources are deducted on success. */
export function buildStructure(state: GameState, playerId: number, defKey: string, x: number, y: number, free: boolean = false): boolean {
  const def = getBuildingDef(defKey);
  if (!def) return false;
  const w = state.world;
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || xi >= w.width || yi < 0 || yi >= w.height) return false;
  const idx = yi * w.width + xi;
  // Permissive placement. The only hard blockers are:
  //   - Mountain terrain (impassable cone)
  //   - Rock props        (rocks must be mined first)
  //   - Mesa props        (mesa_rock / mesa_spire — terrain features)
  //   - Volcano props     (vulcano_* cones — terrain features)
  // Everything else — Sea, Ice, dug Holes, other structures, foliage,
  // ore deposits, berry rocks — is allowed.
  if (w.kind[idx] === TileKind.Mountain) return false;
  const player = state.players[playerId];
  // Architecture gate: a building with non-empty `styles` requires at
  // least one matching entry in the player's originStyles. Universal
  // buildings (workbenches, tent, transport) skip this check.
  if (def.styles && def.styles.length > 0) {
    const ok = def.styles.some((s) => player.originStyles.includes(s));
    if (!ok) return false;
  }
  // Affordability: every resource line in def.cost must be covered.
  // `free=true` (starter spawn) skips both the check and the deduction.
  if (!free) {
    for (const k in def.cost) {
      const need = def.cost[k as ResourceKind] ?? 0;
      if (player.resources[k as ResourceKind] < need) return false;
    }
  }
  // `placementSize` (when set) overrides `size` for the prop-overlap math —
  // ports have huge decorative sprites (size 66) but a smaller actual
  // body (placementSize 24), so rocks just outside the body don't bounce
  // the placement.
  const myFootprint = def.placementSize ?? def.size;
  // Spacing check between structures intentionally removed — buildings
  // can overlap each other. Only rock / mesa / volcano props and Mountain
  // terrain still block.
  // Prop overlap. Two passes:
  //   1. Hard-block on rock / mesa / volcano props in the footprint.
  //      Ore deposits + berry rocks fall through — they no longer block.
  //   2. After the block check, walk again and auto-harvest any tree /
  //      bush inside the footprint (no refund).
  const overlappingFoliage: number[] = [];
  for (let i = 0; i < w.props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    const p = w.props[i];
    const ddx = x - p.x;
    const ddy = y - p.y;
    const dd2 = ddx * ddx + ddy * ddy;
    const minDp = myFootprint + p.size;
    if (dd2 >= minDp * minDp) continue;
    const sp = p.sprite;
    if (sp.startsWith("tree_") || sp.startsWith("bush_")) {
      overlappingFoliage.push(i);
      continue;
    }
    if (sp.startsWith("rock_") || sp.startsWith("rocksnowy_")
        || sp.startsWith("mesa_") || sp.startsWith("vulcano")) {
      return false;
    }
    // Other props (ore, berry rocks, …) pass through.
  }
  // Auto-clear the foliage we collected — route through killProp so the
  // tree/bush plays the same flip-over animation as any other prop
  // destruction path.
  for (const i of overlappingFoliage) killProp(state, i);
  // Free-built structures (the founding campfire seeded by spawnTribe,
  // dev-panel spawns) bypass the build queue and ship finished. Every
  // other placement starts at progress 0 and needs >= buildersNeeded
  // worker villagers in range for stepBuilds to advance it.
  const newStructure: Structure = {
    id: state.nextStructureId++,
    defKey,
    ownerId: playerId,
    x,
    y,
    size: def.size,
    buildProgress: free ? 1 : 0,
    buildersNeeded: free ? 0 : DEFAULT_BUILDERS_NEEDED,
    // Campfires get their per-city inventory bag allocated up front so
    // the production / cost helpers can start crediting + debiting
    // them immediately.
    inventory: defKey === "campfire" ? makeResourceBag() : undefined,
  };
  state.structures.push(newStructure);
  // Mirror into the id → structure Map so the engine's per-villager
  // build-target / port lookups stay O(1) instead of scanning the array.
  if (!state.structuresById) state.structuresById = new Map();
  state.structuresById.set(newStructure.id, newStructure);
  // Add to the (ownerId | defKey) bucket so countNearbyStructures can
  // walk a tiny per-owner list instead of every structure.
  if (!state.structuresByOwnerKey) state.structuresByOwnerKey = new Map();
  const okKey = newStructure.ownerId + "|" + newStructure.defKey;
  let bucket = state.structuresByOwnerKey.get(okKey);
  if (!bucket) { bucket = []; state.structuresByOwnerKey.set(okKey, bucket); }
  bucket.push(newStructure);
  if (!free) {
    for (const k in def.cost) {
      // Spend the build cost across every campfire the player owns.
      // The aggregate check above already confirmed they could afford
      // it, so we don't expect tryDebitAggregate to fail here.
      tryDebitAggregate(state, playerId, k as ResourceKind, def.cost[k as ResourceKind] ?? 0);
    }
    // FORCE-DISPATCH: immediately yank the N closest available worker
    // villagers onto the new site so build progress starts the moment
    // the player places the structure — without this they had to wait
    // for stepAutoAssist's 24-tick wake-up loop, which feels like the
    // build is stuck.
    const newStruct = state.structures[state.structures.length - 1];
    autoDispatchBuilders(state, playerId, newStruct.id, DEFAULT_BUILDERS_NEEDED);
  }
  return true;
}

/** Pull up to `count` of this player's closest available worker
 *  villagers and re-task them onto structure `structureId`. "Available"
 *  means: role is worker (guards / army stay on duty), the villager
 *  isn't already helping with another build, and they're not boarded
 *  inside a vessel / port. The pick prefers idle villagers (cheapest
 *  to interrupt) but falls through to walking + harvesting villagers
 *  if there aren't enough idlers — the user asked for "force auto
 *  allocate", so we forcibly redirect mid-task workers rather than
 *  letting the new build languish. */
export function autoDispatchBuilders(
  state: GameState, playerId: number, structureId: number, count: number,
): number {
  const target = state.structuresById?.get(structureId);
  if (!target) return 0;
  // Tier the candidates by how disruptive it is to re-task them so the
  // sorter prefers stealing idlers over interrupting active harvest.
  const tier = (v: Villager): number => {
    if (v.job === "idle")    return 0;
    if (v.job === "moveTo")  return 1;
    if (v.job === "walkToTree" || v.job === "walkToRock" || v.job === "walkToFarm") return 2;
    if (v.job === "walkHome") return 3;
    return 4; // chopping / mining / farming
  };
  // Free candidates: workers not already on a build job. Sorted by
  // (tier, distance) so the cheapest-to-interrupt + closest wins.
  const free: { v: Villager; t: number; d2: number }[] = [];
  // Busy candidates: workers already on a build. These will get the
  // new target ENQUEUED behind their current build (assignBuildHelp's
  // queue behaviour) — they won't be interrupted, they'll just pick
  // up the new site after the current one finishes.
  const busy: { v: Villager; d2: number }[] = [];
  for (const v of state.villagers) {
    if (v.ownerId !== playerId) continue;
    if ((v.role ?? "worker") !== "worker") continue;
    if (v.insideStructureId !== undefined) continue;
    const dx = target.x - v.x;
    const dy = target.y - v.y;
    const d2 = dx * dx + dy * dy;
    if (v.job === "walkToBuild" || v.job === "building") {
      busy.push({ v, d2 });
    } else {
      free.push({ v, t: tier(v), d2 });
    }
  }
  free.sort((a, b) => (a.t - b.t) || (a.d2 - b.d2));
  busy.sort((a, b) => a.d2 - b.d2);
  let dispatched = 0;
  for (const c of free) {
    if (dispatched >= count) break;
    if (assignBuildHelp(state, c.v.id, structureId)) dispatched++;
  }
  // If we still need more builders, enqueue onto the closest busy
  // workers. They'll finish their current build then walk here next.
  for (const c of busy) {
    if (dispatched >= count) break;
    if (assignBuildHelp(state, c.v.id, structureId)) dispatched++;
  }
  return dispatched;
}

/** Remove a structure by id. Returns true if a structure was found and
 *  removed. The caller is responsible for any tile-dirty marking needed
 *  to repaint the chunk that contained it. */
/** Remove a structure by id and refund half of its build cost (rounded
 *  down per resource) to the owning player. Returns true if a structure
 *  was found and removed. The caller is responsible for dirty-marking
 *  the tiles the sprite covered so the chunk repaints without it. */
export function destroyStructure(state: GameState, id: number): boolean {
  const idx = state.structures.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const s = state.structures[idx];
  const def = getBuildingDef(s.defKey);
  if (def) {
    const owner = state.players[s.ownerId];
    for (const k in def.cost) {
      const c = def.cost[k as ResourceKind] ?? 0;
      owner.resources[k as ResourceKind] += Math.floor(c / 2);
    }
  }
  state.structures.splice(idx, 1);
  state.structuresById?.delete(s.id);
  // Drop the entry from the (ownerId | defKey) bucket as well — leaving
  // a stale ref would make countNearbyStructures return a phantom
  // mill that no longer exists.
  const okKey = s.ownerId + "|" + s.defKey;
  const bucket = state.structuresByOwnerKey?.get(okKey);
  if (bucket) {
    const bi = bucket.indexOf(s);
    if (bi >= 0) bucket.splice(bi, 1);
    if (bucket.length === 0) state.structuresByOwnerKey?.delete(okKey);
  }
  return true;
}

/** Locate a click in world coords against the structure list. Returns the
 *  topmost (last-added) structure whose disk contains the click point, or
 *  null. Used by the App to detect when the player tapped on a building. */
export function structureAt(state: GameState, wx: number, wy: number): Structure | null {
  for (let i = state.structures.length - 1; i >= 0; i--) {
    const s = state.structures[i];
    const dx = wx - s.x;
    const dy = wy - s.y;
    if (dx * dx + dy * dy <= s.size * s.size) return s;
  }
  return null;
}

export function tileAt(world: World, x: number, y: number): number {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return -1;
  return (y | 0) * world.width + (x | 0);
}

// ----------------------------------------------------------------------
// Tool crafting + build-queue helpers — shared between the player UI
// (WorkbenchWindow) and the bot AI (engine.ts).
// ----------------------------------------------------------------------

/** Craft one of `toolKey` for `playerId`. Validation:
 *   - the player must own at least one FINISHED workbench
 *     (catalog `workbench` key) — half-built workbenches don't craft
 *   - every resource line in the tool's cost must be covered
 *  On success debits the cost and pushes the tool count up by one.
 *  Returns the same discriminated result string the UI uses. */
export type CraftToolResult = "ok" | "no_workbench" | "unaffordable" | "unknown";
export function craftTool(state: GameState, playerId: number, toolKey: string): CraftToolResult {
  // Local import to avoid a circular dep with tools.ts (state.ts is
  // already imported by tools-side modules transitively).
  const def = TOOL_BY_KEY.get(toolKey);
  if (!def) return "unknown";
  const player = state.players[playerId];
  let hasWorkbench = false;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if (s.defKey !== "workbench") continue;
    if ((s.buildProgress ?? 1) < 1) continue;
    hasWorkbench = true;
    break;
  }
  if (!hasWorkbench) return "no_workbench";
  for (const k in def.cost) {
    const need = def.cost[k as ResourceKind] ?? 0;
    if (player.resources[k as ResourceKind] < need) return "unaffordable";
  }
  for (const k in def.cost) {
    tryDebitAggregate(state, playerId, k as ResourceKind, def.cost[k as ResourceKind] ?? 0);
  }
  player.tools[toolKey] = (player.tools[toolKey] ?? 0) + 1;
  return "ok";
}
/** Tool catalog snapshot. tools.ts owns the canonical TOOLS array, but
 *  state.ts can't import from tools.ts without inverting the dep graph
 *  (engine.ts imports state.ts; tools.ts is consumed by UI only). We
 *  keep a tiny shadow here that gets populated by registerTools() on
 *  module init — see tools.ts for the call site. */
type ToolShape = { cost: Partial<Record<ResourceKind, number>>; };
const TOOL_BY_KEY = new Map<string, ToolShape>();
export function registerCraftableTool(key: string, cost: Partial<Record<ResourceKind, number>>): void {
  TOOL_BY_KEY.set(key, { cost });
}

/** Find the closest unfinished structure owned by `playerId` near (x, y).
 *  Used by both the bot's worker-dispatch lane and the player's "idle
 *  workers gravitate to your half-built tent" auto-help. Returns null
 *  when every owned structure is finished. */
export function findClosestUnfinishedOwnStructure(
  state: GameState, playerId: number, x: number, y: number,
): Structure | null {
  let best: Structure | null = null;
  let bestD2 = Infinity;
  for (const s of state.structures) {
    if (s.ownerId !== playerId) continue;
    if ((s.buildProgress ?? 1) >= 1) continue;
    const dx = s.x - x;
    const dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best;
}

/** Dispatch an idle worker villager to help build a friendly unfinished
 *  structure. Sets job=walkToBuild, target = structure centre, and stores
 *  the structure id on `buildTargetId` so the engine can detect mid-walk
 *  that the structure finished (or was destroyed) and stop the villager.
 *  Returns true if the order was accepted. */
export function assignBuildHelp(state: GameState, villagerId: number, structureId: number, by: "player" | "auto" = "player"): boolean {
  const v = state.villagers.find((vv) => vv.id === villagerId);
  if (!v) return false;
  if (v.insideStructureId !== undefined) return false;
  const s = state.structuresById?.get(structureId);
  if (!s) return false;
  if ((s.buildProgress ?? 1) >= 1) return false;
  // QUEUE BEHAVIOUR: if the villager is ALREADY helping with a build
  // (walkToBuild or building) and this is a different structure, append
  // to their queue instead of interrupting. They finish their current
  // build first, then move to the next one in the queue, and only
  // resume their original task once the queue empties out. Same target
  // dispatched again is a no-op (don't double-queue the same id).
  if (
    (v.job === "walkToBuild" || v.job === "building")
    && v.buildTargetId !== undefined
    && v.buildTargetId !== structureId
  ) {
    if (!v.buildQueueIds) v.buildQueueIds = [];
    if (!v.buildQueueIds.includes(structureId)) v.buildQueueIds.push(structureId);
    return true;
  }
  // Snapshot the villager's CURRENT production task so we can restore
  // it on build completion. Only resume from production-class jobs —
  // restoring "moveTo" or "walkToBuild" would re-trigger the build
  // queue immediately, defeating the purpose. Idle villagers don't
  // carry a resume target either; they just go back to idle.
  if (v.resumeJob === undefined && isProductionJob(v.job)) {
    v.resumeJob = v.job;
    v.resumeTargetX = v.targetX;
    v.resumeTargetY = v.targetY;
    v.resumePatchX = v.patchX;
    v.resumePatchY = v.patchY;
    v.resumeHarvestType = v.harvestType;
  }
  v.job = "walkToBuild";
  v.targetX = s.x;
  v.targetY = s.y;
  v.targetPropIdx = -1;
  v.harvestType = undefined;
  v.carryingSprite = undefined;
  v.buildTargetId = structureId;
  v.pathTiles = undefined;
  v.pathIdx = undefined;
  v.pathTargetTile = undefined;
  v.assignedBy = by;
  return true;
}

/** Pop the next queued build target off the villager's `buildQueueIds`
 *  (if any) and re-task them onto it. Returns true if a queued target
 *  was popped; false means the queue was empty and the caller should
 *  fall back to resumeAfterBuild. */
export function advanceBuildQueue(state: GameState, v: Villager): boolean {
  while (v.buildQueueIds && v.buildQueueIds.length > 0) {
    const nextId = v.buildQueueIds.shift()!;
    const next = state.structuresById?.get(nextId);
    if (!next || (next.buildProgress ?? 1) >= 1) continue;        // skip stale entries
    v.job = "walkToBuild";
    v.targetX = next.x;
    v.targetY = next.y;
    v.targetPropIdx = -1;
    v.harvestType = undefined;
    v.carryingSprite = undefined;
    v.buildTargetId = nextId;
    v.pathTiles = undefined;
    v.pathIdx = undefined;
    v.pathTargetTile = undefined;
    return true;
  }
  if (v.buildQueueIds && v.buildQueueIds.length === 0) v.buildQueueIds = undefined;
  return false;
}

/** True for the harvest / production jobs we want to resume after a
 *  build-help interruption. Walk + work phases both qualify — if a
 *  villager was on their way to a tree when we pulled them, sending
 *  them back to the same tree feels right. */
function isProductionJob(job: VillagerJobKind): boolean {
  return job === "walkToTree" || job === "chopping" ||
         job === "walkToRock" || job === "mining"   ||
         job === "walkToFarm" || job === "farming"  ||
         job === "walkHome";
}

/** Restore a villager's stashed pre-build task. Called from the engine
 *  when a build target finishes (or is destroyed) — falls through to
 *  idle if there was nothing to resume. Clears the resume slot in both
 *  cases so a future build-help → finish cycle gets a fresh snapshot. */
export function resumeAfterBuild(v: Villager): void {
  if (v.resumeJob !== undefined) {
    v.job = v.resumeJob;
    v.targetX = v.resumeTargetX ?? v.x;
    v.targetY = v.resumeTargetY ?? v.y;
    v.patchX = v.resumePatchX ?? v.x;
    v.patchY = v.resumePatchY ?? v.y;
    v.harvestType = v.resumeHarvestType;
    v.targetPropIdx = -1;
    v.pathTiles = undefined;
    v.pathIdx = undefined;
    v.pathTargetTile = undefined;
  } else {
    v.job = "idle";
    v.assignedBy = undefined;
  }
  v.buildTargetId = undefined;
  v.resumeJob = undefined;
  v.resumeTargetX = undefined;
  v.resumeTargetY = undefined;
  v.resumePatchX = undefined;
  v.resumePatchY = undefined;
  v.resumeHarvestType = undefined;
}
