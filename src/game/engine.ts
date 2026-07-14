import {
  findHomeTent, findClosestTree, findClosestRock, PATCH_RADIUS,
  spawnWoodUnlockVillagers, buildStructure, assignTreeChop, assignRockMine,
  getArmyStrength, getGuardStrength,
  launchTribalAttack, getRelation, setRelation,
  shootDownVessel, getPopulationCap, getPopulationUsed,
  craftTool, findClosestUnfinishedOwnStructure, assignBuildHelp,
  resumeAfterBuild, advanceBuildQueue, BUILD_HELP_RADIUS,
  inventoryAdd, inventoryFull, inventoryTotal, depositInventory,
  canHarvestTree, recordTreeHarvest, findClosestTreeFor,
  recordRockMine, ROCK_YIELD_PER_MINE,
  findClosestAnimal, assignHuntForVillager, removeAnimalAt,
  findClosestPendingFarmland, assignFertilize,
  INFINITE_PATCH_RADIUS,
  purchaseVesselAtPort,
  canSpawnVillager, spawnVillagerAtHome, paintFarmTile,
  assignFarm, boardVillager, launchVessel, destroyStructure,
  stepWildlife,
  creditNearestCampfire, tryDebitAggregate,
  stepAirships,
  PROP_DEATH_TICKS,
  recomputeWaterBodies,
  killProp,
  type GameState,
} from "./state";
import {
  Era, TileKind, RELATION_WAR, RELATION_ALLY, RELATION_TRUCE,
  type ResourceKind, type Villager, type VillagerWeapon,
} from "./types";
import { BUILDINGS, getBuildingDef } from "./catalog";
import { getVesselDef } from "./vessels";
import { findPath, firstBlocker, tileIdx, isWalkable } from "./pathfind";
// Side-effect import: tools.ts registers each tool's cost into state.ts
// for craftTool() to consult. Without this the bot's tool-crafting
// branch in botAct() can't validate / debit a craft. tools.ts is a
// no-deps catalog module so importing it here just runs the bottom
// `for (const t of TOOLS) registerCraftableTool` loop.
import "./tools";

/** Movement speed in tiles per tick. With tickMs=100 that's 20 tiles/sec —
 *  brisk enough that a villager crosses a 60-tile patch in ~3 seconds but
 *  slow enough to read as walking, not teleporting. */
const VILLAGER_SPEED = 2;
/** How close a villager must get to a tree before they can start chopping. */
const CHOP_REACH = 12;
/** How close a villager must get to the home tent to deposit. */
const DEPOSIT_REACH = 18;
/** Ticks of chopping per tree. At ±25° per tick this is roughly 4 visible
 *  swings — short enough to keep the harvest loop snappy. */
const CHOPS_PER_TREE = 8;
/** Mining a rock takes 2× the time of chopping a tree. The yield per
 *  successful mine is much higher (10 units instead of 1), so the
 *  effective throughput per tick is still ~5× the wood-chop rate. */
const CHOPS_PER_ROCK = 16;
const CHOP_ANGLE_RAD = (25 * Math.PI) / 180;
/** Multiplier applied at deposit time to every harvested resource —
 *  trees give 10× wood, rock mines give 10× their resource, farms give
 *  10× berries. Workbench income is scaled in catalog.ts directly. */
const HARVEST_YIELD = 10;

/**
 * Advance the simulation by one tick.
 *
 * Tribal era (current):
 *   - Each placed workbench-class building contributes goldPerTick to its
 *     owner's reserve. Shelters do not produce gold by themselves.
 *   - No tile-claim income, no garrison growth, no border math — territory
 *     in this era is implicit from the convex hull of a tribe's buildings
 *     (will be enforced + visualised in a later phase).
 *   - No automatic AI expansion. Bots have their starter tribes placed at
 *     world creation; a follow-up phase will give them a per-tick "build
 *     a workbench" routine.
 *
 * Medieval / Modern eras are stubbed and trigger later.
 */
/** Mirrors the visual day-night cycle in src/render/dayNight.ts. Kept as
 *  a local constant rather than imported so the engine has no dependency
 *  on the render module (engine.ts is meant to stay headless / testable). */
const DAY_LENGTH_MS = 60 * 60 * 1000;

export function stepGame(state: GameState): void {
  state.tick++;
  // Record wall-clock start of this tick so the renderer can interpolate
  // sub-tick animation progress between ticks (e.g. the prop death fall
  // reads smooth at 60 fps instead of stepping every 100 ms).
  state.lastTickMs = performance.now();

  // Day rollover: every full DAY_LENGTH_MS of wall-clock since game
  // start, respawn biological props (trees, bushes) that were harvested
  // by clearing `harvestedProps` and dirty-marking each prop's bbox so
  // the chunk repaints with the sprite back in place.
  const now = performance.now();
  const currentDay = Math.floor((now - state.startedAtMs) / DAY_LENGTH_MS);
  if (currentDay > state.dayIndex) {
    respawnBiologicals(state);
    state.dayIndex = currentDay;
    // Roll volcano activations / deactivations on every day rollover.
    // 10% chance per inactive cone to wake up for one in-game week.
    stepVulcanoActivationRollover(state);
  }

  if (state.era === Era.Tribal) {
    stepTribalEra(state);
    stepFarmland(state);
    stepBuilds(state);
    stepVillagers(state);
    stepAutoAssist(state);
    stepCombat(state);
    stepTrebuchets(state);
    stepVulcanos(state);
    stepWildlife(state);
    stepBotAi(state);
    stepWaterFlow(state);
    stepAirships(state);
    stepHumanSpawn(state);
    stepHumanAutoExpand(state);
    stepPropDeaths(state);
  }

  // Win check is disabled while the tribal-era win conditions are being
  // designed. The renderer / HUD won't show a winner banner until the
  // late-game territory rules land.
}

/** Per-day regrowth: clear every harvested biological prop and dirty-mark
 *  the tiles it covered so the next chunk repaint draws the sprite back
 *  in. All entries currently in `harvestedProps` are tree / bush props
 *  (the only harvestable props in the tribal era) — when other prop
 *  categories become harvestable, gate this loop on the sprite class. */
function respawnBiologicals(state: GameState): void {
  const w = state.world;
  const volcanic = state.volcanicProps;
  // Carve volcanic props out before the regrowth pass — uranium / crater
  // props don't regenerate on the day cycle, only when the volcano
  // shoots fresh debris. We keep them in harvestedProps until the day
  // they're mined so they stay visually mined.
  const stillHarvested = new Set<number>();
  for (const propIdx of state.harvestedProps) {
    const prop = w.props[propIdx];
    if (!prop) continue;
    if (volcanic?.has(propIdx)) {
      stillHarvested.add(propIdx);
      continue;
    }
    const x0 = Math.max(0, Math.floor(prop.x - prop.size));
    const x1 = Math.min(w.width - 1, Math.ceil(prop.x + prop.size));
    const y0 = Math.max(0, Math.floor(prop.y - prop.size));
    const y1 = Math.min(w.height - 1, Math.ceil(prop.y + prop.size));
    for (let y = y0; y <= y1; y++) {
      const base = y * w.width;
      for (let x = x0; x <= x1; x++) state.dirtyTiles.add(base + x);
    }
  }
  state.harvestedProps = stillHarvested;
  // Reset per-tree harvester ledgers too — regrown trees are pristine
  // and any villager can take a share again.
  state.treeHarvesters?.clear();
}

/** Per-tick income rates for the raw-meat sources. Raft is the baseline;
 *  the Shallow Water Hut runs at 2× because it's a fixed fishing
 *  platform rather than a tribal raft. The Meat Prep workbench consumes
 *  the accumulated unpreped_meat at a slightly higher rate so a
 *  player's preped meat outpaces a single source if they invest in
 *  enough prep capacity. All rates scaled 10× alongside the harvest
 *  yields so the meat workflow stays balanced relative to wood / rock. */
const RAFT_UNPREPED_MEAT_PER_TICK = 0.5;
const SHALLOW_HUT_UNPREPED_MEAT_PER_TICK = 1.0;
const MEAT_PREP_CONVERT_PER_TICK = 0.8;

// --- Mill / bakery / windmill rates. Input-gated: a Stonemill that
//     can't find rock to debit just sits idle this tick. ---
/** Stonemill consumes this much rock from the player's stockpile per
 *  tick and rolls a small chance of upgrading the output to iron,
 *  gold, or diamond — simulating a refining process that occasionally
 *  picks up a precious flake. */
const STONEMILL_ROCK_CONSUMED_PER_TICK = 1.0;
const STONEMILL_IRON_CHANCE = 0.30;
const STONEMILL_GOLD_CHANCE = 0.05;
const STONEMILL_DIAMOND_CHANCE = 0.01;
/** Wheatmill berry → processedfruit conversion rate. Pulls from any of
 *  the three berry types in proportion to availability. */
const WHEATMILL_BERRIES_PER_TICK = 0.5;
/** Bakery wheat → bread conversion rate. One bread per wheat. */
const BAKERY_WHEAT_PER_TICK = 0.4;

/** Radius around a volcano sprite (in tiles) within which buildings get
 *  a fertility bonus. Same scale as the existing MILL_BUFF_RADIUS so
 *  the buff zone is roughly one workbench cluster wide.
 *
 *  The bonus is proximity-scaled: at the radius edge the multiplier is
 *  1.0 (no effect) and at the volcano's centre it peaks. Soil-tagged
 *  buildings get a much bigger peak than other workbenches because
 *  the volcanic ash genuinely makes wheat / berries / forests grow — a
 *  stonemill near a volcano just gets a modest "warm rock" trickle. */
const VOLCANO_FERTILE_RADIUS = 260;
const VOLCANO_SOIL_PEAK_MULT = 5.0;   // farm-side max: 5× at the cone
const VOLCANO_OTHER_PEAK_MULT = 2.0;  // everything else: 2× at the cone
const VOLCANO_HARVEST_PEAK_MULT = 4.0; // chop/mine/farm deposit max
/** Buildings whose output should ride the high "soil" track of the
 *  volcano fertility bonus. Anything wheat / bread / berry / wood
 *  related — the ash + warmth genuinely helps the crop. Others get
 *  the gentler "other workbench" track. */
const SOIL_BOOSTED_KEYS = new Set<string>([
  "windmill", "wheatmill", "bakery", "woodmill", "waterwheel",
]);

/** Water-proximity fertility. Reads `world.coastDist` (Manhattan
 *  distance to the nearest coast in tiles) and returns a [0, 1] weight
 *  that peaks at the shoreline and fades out around WATER_FERTILE_REACH.
 *  Gentler curve than the volcano bonus — being near water helps but
 *  isn't a game-changer on its own. */
const WATER_FERTILE_REACH = 18;
/** Distance (tiles) inside which a farmland tile counts as "fully wet"
 *  — gets the maximum water-fertility multiplier even if the gradient
 *  computation would normally still be ramping. Matches the user's
 *  "all farmland within 10 tiles of water is wet" rule and aligns with
 *  the renderer's wet-texture threshold. Farmland tiles further out
 *  still get a fade-out via the existing 18-tile gradient, plus any
 *  wet-farmland-network propagation. */
const FARMLAND_WATER_FULL_REACH = 10;
const WATER_SOIL_PEAK_MULT = 2.0;
const WATER_OTHER_PEAK_MULT = 1.4;
const WATER_HARVEST_PEAK_MULT = 1.8;
function waterFertility(state: GameState, x: number, y: number): number {
  const w = state.world;
  const xi = Math.max(0, Math.min(w.width - 1, x | 0));
  const yi = Math.max(0, Math.min(w.height - 1, y | 0));
  const idx = yi * w.width + xi;
  // Wet-farmland network: any farmland tile inside the BFS-propagated
  // wet set returns full fertility regardless of distance from natural
  // sea — the "water tunnels" carry water across the field.
  if (state.wetFarmlandTiles && state.wetFarmlandTiles.has(idx)) return 1;
  const cd = w.coastDist[idx];
  // Hard "fully wet" zone within FARMLAND_WATER_FULL_REACH tiles of
  // water — clamps to 1 even though the legacy gradient hadn't reached
  // its peak yet. Beyond that, fall through to the old fade-out.
  if (cd <= FARMLAND_WATER_FULL_REACH) return 1;
  if (cd >= WATER_FERTILE_REACH) return 0;
  return 1 - cd / WATER_FERTILE_REACH;
}

/** Distance-weighted volcano fertility at world (x, y), clamped to
 *  [0, 1]. 1 means the point sits on a volcano centre; 0 means there's
 *  no volcano within VOLCANO_FERTILE_RADIUS. Iterates the cached
 *  `state.volcanoCenters` xy table (built once per game) instead of
 *  scanning the full world.props array — the array can be 50k+ entries
 *  with trees / rocks / craters, vs. typically ~50 actual cones. */
function volcanoFertility(state: GameState, x: number, y: number): number {
  const centers = state.volcanoCenters;
  if (!centers || centers.length === 0) return 0;
  const r2 = VOLCANO_FERTILE_RADIUS * VOLCANO_FERTILE_RADIUS;
  let best = 0;
  for (let i = 0; i < centers.length; i += 2) {
    const dx = x - centers[i];
    const dy = y - centers[i + 1];
    const d2 = dx * dx + dy * dy;
    if (d2 >= r2) continue;
    const t = 1 - Math.sqrt(d2) / VOLCANO_FERTILE_RADIUS;
    if (t > best) best = t;
  }
  return best;
}

/** Wheat per farmed tile per tick. Tuned so a 20×20 fully-fertilized
 *  farm produces about 8 wheat/tick at baseline — enough to feed a
 *  bakery without trivialising bread economy. Water proximity boosts
 *  this; volcano boost is applied separately via the player's nearby
 *  structures rather than per-tile (per-tile volcano lookup is too
 *  expensive at 24M tiles). */
const FARMLAND_WHEAT_PER_TICK = 0.02;
/** How often (in ticks) to scan farmland for production. Every tick is
 *  too expensive at large farms; 5 ticks (~0.5 s) is invisible to the
 *  player but cuts the scan cost by 5×. The per-tick yield is scaled
 *  up to compensate. */
const FARMLAND_SCAN_EVERY = 5;

function stepFarmland(state: GameState): void {
  if (state.tick % FARMLAND_SCAN_EVERY !== 0) return;
  const w = state.world;
  const fs = w.farmlandState;
  const fo = w.farmlandOwner;
  for (let i = 0; i < fs.length; i++) {
    if (fs[i] !== 2) continue;
    const ownerId = fo[i];
    if (ownerId === 0xffff) continue;
    const owner = state.players[ownerId];
    if (!owner || !owner.alive) continue;
    const tx = i % w.width;
    const ty = (i / w.width) | 0;
    const wFert = waterFertility(state, tx, ty);
    const mult = 1 + wFert * (WATER_SOIL_PEAK_MULT - 1);
    // Per-half-second production. The constant name is still
    // "PER_TICK" for back-compat with how the rates are written, but
    // the firing cadence (every FARMLAND_SCAN_EVERY = 5 ticks) means
    // each entry credits FARMLAND_WHEAT_PER_TICK once per 0.5 s —
    // user-requested nerf that puts farms at 1/5 their old throughput.
    // Each farmed tile credits the campfire nearest to it — farms
    // attached to a city build that city's wheat pile, not the global
    // aggregate. Cache resync is handled inside the helper.
    creditNearestCampfire(state, ownerId, tx, ty, "wheat", FARMLAND_WHEAT_PER_TICK * mult);
  }
}

/** All workbench-style production used to fire every tick (100 ms).
 *  The user-asked nerf throttles it to every 5 ticks (0.5 s) without
 *  scaling the rate constants up — per-second yield therefore drops
 *  to 1/5 of the previous "per-tick" value. Apply the same throttle to
 *  every workbench rate constant by gating stepTribalEra. */
const PRODUCTION_TICK_EVERY = 5;

function stepTribalEra(state: GameState): void {
  if (state.tick % PRODUCTION_TICK_EVERY !== 0) return;
  // Workbench income. Each structure adds its def.produces map into the
  // owning player's resource bag. Pure shelters (empty produces) are a
  // no-op — the inner loop has nothing to iterate.
  for (const s of state.structures) {
    const def = getBuildingDef(s.defKey);
    if (!def) continue;
    // Unfinished structures (buildProgress < 1) don't produce yet and
    // don't add to popCap — the build queue (stepBuilds) finishes them
    // once enough workers stand in range.
    if ((s.buildProgress ?? 1) < 1) continue;
    const owner = state.players[s.ownerId];
    if (!owner.alive) continue;
    // Wood-producing workbenches get a 1.5× output multiplier on the
    // `wood` line whenever a woodmill sits within MILL_BUFF_RADIUS of
    // them. Non-wood produces lines (leaves, rock, …) are unaffected.
    const woodBuff = ("wood" in def.produces) && countNearbyStructures(
      state, s.ownerId, "woodmill", s.x, s.y, MILL_BUFF_RADIUS,
    ) > 0 ? 1.5 : 1;
    // Volcano + water fertility, stacked multiplicatively. The peak
    // payoff is a soil-class building sitting on a beach right next to
    // a volcano — VOLCANO_SOIL_PEAK_MULT × WATER_SOIL_PEAK_MULT = 10×.
    // Everything else gets the gentler "ambient" track on both.
    const vFert = volcanoFertility(state, s.x, s.y);
    const wFert = waterFertility(state, s.x, s.y);
    const isSoil = SOIL_BOOSTED_KEYS.has(s.defKey);
    const vPeak = isSoil ? VOLCANO_SOIL_PEAK_MULT : VOLCANO_OTHER_PEAK_MULT;
    const wPeak = isSoil ? WATER_SOIL_PEAK_MULT : WATER_OTHER_PEAK_MULT;
    const volcanoMult = (1 + vFert * (vPeak - 1)) * (1 + wFert * (wPeak - 1));
    for (const k in def.produces) {
      const base = def.produces[k as ResourceKind] ?? 0;
      const woodScaled = k === "wood" ? base * woodBuff : base;
      // Workbench output goes to the campfire NEAREST this workbench —
      // a wood_chop in City A credits City A's campfire, not the
      // aggregate. The cache resync inside creditNearestCampfire keeps
      // player.resources mirrors the new total.
      creditNearestCampfire(state, s.ownerId, s.x, s.y, k as ResourceKind, woodScaled * volcanoMult);
    }
    // Meat workflow (special-cased — not in def.produces). Raw-meat
    // sources increment unpreped_meat; meat prep stations debit it and
    // emit `meat`. Player only sees `meat` count up if they've built
    // both a source AND a prep station.
    if (s.defKey === "raft") {
      creditNearestCampfire(state, s.ownerId, s.x, s.y, "unpreped_meat", RAFT_UNPREPED_MEAT_PER_TICK * volcanoMult);
    } else if (s.defKey === "shallow_water_hut") {
      creditNearestCampfire(state, s.ownerId, s.x, s.y, "unpreped_meat", SHALLOW_HUT_UNPREPED_MEAT_PER_TICK * volcanoMult);
    } else if (s.defKey === "meat_prep") {
      const want = MEAT_PREP_CONVERT_PER_TICK * volcanoMult;
      const have = owner.resources.unpreped_meat;
      const take = Math.min(want, have);
      if (take > 0 && tryDebitAggregate(state, s.ownerId, "unpreped_meat", take)) {
        creditNearestCampfire(state, s.ownerId, s.x, s.y, "meat", take);
      }
    } else if (s.defKey === "stonemill") {
      // Consume rock; small chance per tick to bonus into iron / gold /
      // diamond. Sits idle if the player has no rock.
      const take = Math.min(STONEMILL_ROCK_CONSUMED_PER_TICK, owner.resources.rock);
      if (take > 0 && tryDebitAggregate(state, s.ownerId, "rock", take)) {
        if (Math.random() < STONEMILL_DIAMOND_CHANCE) creditNearestCampfire(state, s.ownerId, s.x, s.y, "diamond", take * volcanoMult);
        else if (Math.random() < STONEMILL_GOLD_CHANCE) creditNearestCampfire(state, s.ownerId, s.x, s.y, "gold", take * volcanoMult);
        else if (Math.random() < STONEMILL_IRON_CHANCE) creditNearestCampfire(state, s.ownerId, s.x, s.y, "iron", take * volcanoMult);
      }
    } else if (s.defKey === "wheatmill") {
      // Berry → processedfruit. Pull from whichever berry has the most
      // stock so the player can dump a single colour into the mill.
      let pick: ResourceKind = "redberry";
      if (owner.resources.yellowberry > owner.resources[pick]) pick = "yellowberry";
      if (owner.resources.blueberry  > owner.resources[pick]) pick = "blueberry";
      const take = Math.min(WHEATMILL_BERRIES_PER_TICK, owner.resources[pick]);
      if (take > 0 && tryDebitAggregate(state, s.ownerId, pick, take)) {
        creditNearestCampfire(state, s.ownerId, s.x, s.y, "processedfruit", take * volcanoMult);
      }
    } else if (s.defKey === "bakery") {
      // Wheat → bread. One-to-one until the wheat runs out.
      const take = Math.min(BAKERY_WHEAT_PER_TICK, owner.resources.wheat);
      if (take > 0 && tryDebitAggregate(state, s.ownerId, "wheat", take)) {
        creditNearestCampfire(state, s.ownerId, s.x, s.y, "bread", take * volcanoMult);
      }
    }
  }
}

/** Advance every villager's job state machine by one tick. State machine:
 *
 *    idle                                    (no movement, no animation)
 *      ↑                                     ←─────────── (no more trees in patch)
 *      └── walkToTree ── chopping ── walkHome ── deposit
 *                ↑                                │
 *                └────────── (next tree found) ───┘
 *
 * Movement is a straight-line lerp at VILLAGER_SPEED tiles/tick. Chopping
 * holds position and alternates the sprite rotation ±25° per tick so the
 * villager visibly swings. Deposit credits 1 wood and either chains into
 * the next tree in the patch or returns to idle. */
/** Max tiles a villager may roam from any structure owned by their
 *  tribe. Anything past this gets recalled home — keeps villagers from
 *  wandering across the world to chop a lone tree that happens to be
 *  the global-closest. Same range concept the shovel uses. */
const VILLAGER_LEASH_RANGE = 300;
const VILLAGER_LEASH_R2 = VILLAGER_LEASH_RANGE * VILLAGER_LEASH_RANGE;
function villagerOutsideKingdom(state: GameState, v: Villager): boolean {
  for (const s of state.structures) {
    if (s.ownerId !== v.ownerId) continue;
    const dx = s.x - v.x;
    const dy = s.y - v.y;
    if (dx * dx + dy * dy <= VILLAGER_LEASH_R2) return false;
  }
  return true;
}

function stepVillagers(state: GameState): void {
  const w = state.world;
  for (const v of state.villagers) {
    // ANIMATION WATCHDOG: only the active-swing jobs animate via v.rot.
    // Any other state — especially ones the villager was interrupted
    // into mid-swing — gets rot forced to 0 so they don't walk around
    // permanently tilted.
    if (v.job !== "chopping" && v.job !== "mining"
        && v.job !== "farming" && v.job !== "building"
        && v.job !== "huntingAnimal"
        && v.rot !== 0) {
      v.rot = 0;
    }
    // Kingdom leash — staggered every 8 ticks per villager via (tick + id)
    // so the O(N_structures) check is amortised cheaply. Skip villagers
    // currently boarded (insideStructureId set) since they have no
    // position to evaluate, and skip walkHome since they're already
    // recalling. Building / boarding paths likewise don't get redirected.
    if (v.insideStructureId === undefined
        && v.job !== "walkHome" && v.job !== "walkToBoard"
        && (state.tick + v.id) % 8 === 0
        && villagerOutsideKingdom(state, v)) {
      const home = findHomeTent(state, v.ownerId);
      if (home) {
        v.job = "walkHome";
        v.targetX = home.x;
        v.targetY = home.y;
        v.targetPropIdx = -1;
        v.assignedBy = undefined;
        clearPath(v);
      }
    }
    switch (v.job) {
      case "idle":
        break;

      case "moveTo": {
        // Free walk to (targetX, targetY) — no harvest, no deposit. Used
        // by the click-villager → click-world player order.
        if (Math.hypot(v.targetX - v.x, v.targetY - v.y) <= DEPOSIT_REACH) {
          v.job = "idle";
          v.targetPropIdx = -1;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      // Walking up to a port / airship-port to board. The boardVillagerIn*
      // helpers set this instead of teleporting the villager inside,
      // so the player sees them approach the entrance before they
      // "vanish" into the dock. On arrival (within the port's size +
      // a couple of tile slack so the villager doesn't try to walk to
      // the literal centre of the structure) we flip insideStructureId
      // and clear the walk target.
      case "walkToBoard": {
        const portId = v.boardTargetStructureId;
        const port = portId !== undefined ? state.structuresById?.get(portId) : undefined;
        if (!port || port.ownerId !== v.ownerId) {
          // Port was destroyed mid-walk — drop the order, go idle.
          v.job = "idle";
          v.boardTargetStructureId = undefined;
          v.targetPropIdx = -1;
          clearPath(v);
          break;
        }
        // Retarget each tick in case the port moved (it doesn't, but
        // keep the path code happy if a future feature drifts it).
        v.targetX = port.x;
        v.targetY = port.y;
        const reach = Math.max(CHOP_REACH, port.size + 4);
        if (Math.hypot(port.x - v.x, port.y - v.y) <= reach) {
          // Arrived — commit boarding. The renderer skips villagers with
          // insideStructureId so the sprite disappears as they "enter".
          v.insideStructureId = port.id;
          v.boardTargetStructureId = undefined;
          v.job = "idle";
          v.rot = 0;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      // Walk to an unfinished friendly structure to help build it. The
      // target structure id lives on v.buildTargetId so we can detect
      // mid-walk that the build was completed (or destroyed) and bail.
      case "walkToBuild": {
        const target = v.buildTargetId !== undefined
          ? (state.structuresById?.get(v.buildTargetId) ?? null)
          : null;
        if (!target || (target.buildProgress ?? 1) >= 1) {
          // Build finished (or got destroyed) before we arrived. Pop
          // the next queued build target if there is one; otherwise
          // resume the production task we were originally pulled off.
          if (!advanceBuildQueue(state, v)) resumeAfterBuild(v);
          clearPath(v);
          break;
        }
        const reach = Math.max(CHOP_REACH, target.size + 4);
        if (Math.hypot(target.x - v.x, target.y - v.y) <= reach) {
          v.job = "building";
          v.rot = 0;
          clearPath(v);
        } else {
          // Re-target each tick so a structure that slightly shifts due
          // to a partial-state save still resolves; cheap because the
          // path cache is keyed off the tile.
          v.targetX = target.x;
          v.targetY = target.y;
          stepAlongPath(state, v);
        }
        break;
      }

      // Standing on / next to a friendly half-built structure. The actual
      // progress increment happens in stepBuilds (so multi-builder counts
      // resolve before we advance), but the villager animates a small
      // swing here so the player can see them working.
      case "building": {
        const target = v.buildTargetId !== undefined
          ? (state.structuresById?.get(v.buildTargetId) ?? null)
          : null;
        if (!target || (target.buildProgress ?? 1) >= 1) {
          // Build done — move on to the next queued target if any,
          // else resume the harvest task we got pulled from.
          if (!advanceBuildQueue(state, v)) resumeAfterBuild(v);
          v.rot = 0;
          break;
        }
        // Drift back toward the target if we got bumped slightly — keeps
        // a loose ring of builders without forcing a rigid stack.
        const dx = target.x - v.x;
        const dy = target.y - v.y;
        const d = Math.hypot(dx, dy);
        const reach = Math.max(CHOP_REACH, target.size + 4);
        if (d > reach) {
          // Drifted out of range — fall back to walk.
          v.job = "walkToBuild";
          v.targetX = target.x;
          v.targetY = target.y;
          break;
        }
        // Small ±15° swing every 4 ticks reads as "hammering".
        v.rot = ((state.tick + v.id) % 8 < 4 ? 1 : -1) * (Math.PI / 12);
        break;
      }

      // Fertilizing loop: empty-handed → walk to home campfire to pick
      // up ash → carrying ash → walk to nearest pending farmland tile →
      // arrival flips the tile to farmed and drops the carry. Loops
      // until no pending tiles remain, then idles.
      case "fertilizing": {
        if (v.carryingSprite !== "ash") {
          const fire = findHomeTent(state, v.ownerId);
          if (!fire) { v.job = "idle"; clearPath(v); break; }
          v.targetX = fire.x;
          v.targetY = fire.y;
          if (Math.hypot(fire.x - v.x, fire.y - v.y) <= DEPOSIT_REACH) {
            v.carryingSprite = "ash";
            clearPath(v);
          } else {
            stepAlongPath(state, v);
          }
          break;
        }
        const tileTarget = findClosestPendingFarmland(state, v.ownerId, v.x, v.y);
        if (tileTarget < 0) {
          v.carryingSprite = undefined;
          v.job = "idle";
          clearPath(v);
          break;
        }
        const tx = (tileTarget % w.width) + 0.5;
        const ty = ((tileTarget / w.width) | 0) + 0.5;
        if (v.targetX !== tx || v.targetY !== ty) {
          v.targetX = tx;
          v.targetY = ty;
          clearPath(v);
        }
        if (Math.hypot(tx - v.x, ty - v.y) <= 1.6) {
          if (w.farmlandState[tileTarget] === 1) {
            w.farmlandState[tileTarget] = 2;
            state.pendingFarmlandTiles?.delete(tileTarget);
            state.dirtyTiles.add(tileTarget);
          }
          v.carryingSprite = undefined;
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      // Hunt-an-animal loop. walkToHunt chases the moving target; on
      // reach, switch to huntingAnimal which holds position + animates
      // a swing for CHOPS_PER_ANIMAL ticks, then kills the animal and
      // banks unpreped_meat into the villager's inventory.
      case "walkToHunt": {
        const animals = state.animals;
        const tgtId = v.huntTargetAnimalId;
        const animal = (animals && tgtId !== undefined)
          ? animals.find((a) => a.id === tgtId) : undefined;
        if (!animal) {
          // Target died / escaped — give up.
          v.huntTargetAnimalId = undefined;
          v.job = "idle";
          clearPath(v);
          break;
        }
        // Re-target each tick since the animal is wandering.
        v.targetX = animal.x;
        v.targetY = animal.y;
        if (Math.hypot(animal.x - v.x, animal.y - v.y) <= CHOP_REACH) {
          v.job = "huntingAnimal";
          v.chopsLeft = CHOPS_PER_TREE;        // reuse chop cadence
          v.rot = 0;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      case "huntingAnimal": {
        const animals = state.animals;
        const tgtId = v.huntTargetAnimalId;
        const idx = (animals && tgtId !== undefined)
          ? animals.findIndex((a) => a.id === tgtId) : -1;
        if (idx < 0) {
          v.huntTargetAnimalId = undefined;
          v.job = "idle";
          v.rot = 0;
          break;
        }
        v.rot = (v.chopsLeft % 2 === 0 ? 1 : -1) * CHOP_ANGLE_RAD;
        v.chopsLeft--;
        if (v.chopsLeft <= 0) {
          v.rot = 0;
          // Kill the animal + bank meat. ~6 unpreped_meat per kill so
          // hunts feel meaningful vs the slow raft drip.
          removeAnimalAt(state, idx);
          inventoryAdd(v, "unpreped_meat", 6);
          v.carryingSprite = "meat";
          v.harvestType = undefined;
          v.huntTargetAnimalId = undefined;
          // If still room in the bag, chase another nearby animal;
          // otherwise walk home to deposit.
          if (!inventoryFull(v)) {
            const next = findClosestAnimal(state, v.x, v.y, PATCH_RADIUS);
            if (next >= 0) {
              assignHuntForVillager(state, v, next);
              break;
            }
          }
          const tent = findHomeTent(state, v.ownerId);
          if (tent) {
            v.job = "walkHome";
            v.targetX = tent.x;
            v.targetY = tent.y;
            clearPath(v);
          } else {
            v.job = "idle";
          }
        }
        break;
      }

      case "walkToTree": {
        // Tree fully harvested OR this villager has already taken their
        // share — find the next tree they CAN still help chop. Falls
        // back to walkHome if the inventory has anything to deposit,
        // else idle.
        if (!canHarvestTree(state, v.targetPropIdx, v.id)) {
          const next = findClosestTreeFor(state, v.id, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
          if (next >= 0) {
            const tree = w.props[next];
            v.targetPropIdx = next;
            v.targetX = tree.x;
            v.targetY = tree.y;
            clearPath(v);
          } else if (inventoryTotal(v) > 0) {
            const tent = findHomeTent(state, v.ownerId);
            if (tent) {
              v.job = "walkHome";
              v.targetX = tent.x;
              v.targetY = tent.y;
              clearPath(v);
            } else {
              v.job = "idle";
            }
          } else {
            v.job = "idle";
            v.targetPropIdx = -1;
            clearPath(v);
          }
          break;
        }
        if (Math.hypot(v.targetX - v.x, v.targetY - v.y) <= CHOP_REACH) {
          v.job = "chopping";
          v.chopsLeft = CHOPS_PER_TREE;
          v.rot = 0;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      case "chopping": {
        // Alternate the swing each tick. chopsLeft counts down 8 → 0,
        // so we get four full forward / back swings.
        v.rot = (v.chopsLeft % 2 === 0 ? 1 : -1) * CHOP_ANGLE_RAD;
        v.chopsLeft--;
        if (v.chopsLeft <= 0) {
          v.rot = 0;
          // Stake this villager's claim on the tree. If they were the
          // 4th distinct villager to chop it, recordTreeHarvest also
          // pushes the prop into harvestedProps so the next chunk
          // repaint drops it.
          const fully = recordTreeHarvest(state, v.targetPropIdx, v.id);
          if (fully) markPropDirty(state, v.targetPropIdx);
          // Credit the yield directly to the villager's inventory bag.
          // Fertility (volcano + water) and woodmill bonuses still
          // apply, but they're computed at chop-time now rather than
          // at deposit so each villager's share reflects where they
          // were standing when they actually felled their slice.
          const woodmills = countNearbyStructures(
            state, v.ownerId, "woodmill", v.patchX, v.patchY, MILL_BUFF_RADIUS,
          );
          const vFertP = volcanoFertility(state, v.patchX, v.patchY);
          const wFertP = waterFertility(state, v.patchX, v.patchY);
          const harvestMult =
            (1 + vFertP * (VOLCANO_HARVEST_PEAK_MULT - 1)) *
            (1 + wFertP * (WATER_HARVEST_PEAK_MULT - 1));
          const total = HARVEST_YIELD * Math.max(1, woodmills * 5) * harvestMult;
          inventoryAdd(v, "wood", Math.round(total));
          v.carryingSprite = "treetump";
          v.harvestType = "wood";

          // Chain to the next tree in the patch ONLY if the bag still
          // has room — the cap (20 items) is what enforces "try to get
          // 2 trees before returning". When the bag is full or no
          // chop-eligible trees remain nearby, go home and deposit.
          if (!inventoryFull(v)) {
            const next = findClosestTreeFor(state, v.id, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
            if (next >= 0) {
              const tree = w.props[next];
              v.job = "walkToTree";
              v.targetPropIdx = next;
              v.targetX = tree.x;
              v.targetY = tree.y;
              clearPath(v);
              break;
            }
          }
          const tent = findHomeTent(state, v.ownerId);
          if (tent) {
            v.job = "walkHome";
            v.targetX = tent.x;
            v.targetY = tent.y;
            clearPath(v);
          } else {
            v.job = "idle";
          }
        }
        break;
      }

      // Rock-mining loop. Same shape as walkToTree → chopping, but
      // gated on harvestType="rock" and visually identical to chopping
      // (sprite swing) for now — a future pass can swap the carried
      // sprite to a piece of stone and the animation to a pickaxe arc.
      case "walkToRock": {
        if (state.harvestedProps.has(v.targetPropIdx)) {
          // Same redirect behaviour as walkToTree — pick the next rock
          // in the patch so the villager keeps mining instead of
          // appearing to softlock at the now-empty spot.
          const next = findClosestRock(state, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
          if (next >= 0) {
            const rock = w.props[next];
            v.targetPropIdx = next;
            v.targetX = rock.x;
            v.targetY = rock.y;
            clearPath(v);
          } else {
            v.job = "idle";
            v.targetPropIdx = -1;
            clearPath(v);
          }
          break;
        }
        if (Math.hypot(v.targetX - v.x, v.targetY - v.y) <= CHOP_REACH) {
          v.job = "mining";
          // Rocks take 2× as many ticks to mine as a tree takes to chop —
          // 16 ticks at ±25° means ~8 visible swings of the pickaxe.
          v.chopsLeft = CHOPS_PER_ROCK;
          v.rot = 0;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      // Beach-farm loop. Click on beach sand with a hoe → villager walks
      // to that tile, swings (same animation as chop/mine for now), then
      // walks home with the carried-item sprite. Deposit picks a random
      // berry of the three (red / blue / yellow).
      case "walkToFarm": {
        if (Math.hypot(v.targetX - v.x, v.targetY - v.y) <= CHOP_REACH) {
          v.job = "farming";
          v.chopsLeft = CHOPS_PER_TREE;
          v.rot = 0;
          clearPath(v);
        } else {
          stepAlongPath(state, v);
        }
        break;
      }

      case "farming": {
        v.rot = (v.chopsLeft % 2 === 0 ? 1 : -1) * CHOP_ANGLE_RAD;
        v.chopsLeft--;
        if (v.chopsLeft <= 0) {
          v.rot = 0;
          v.carryingSprite = "mushroom";
          v.harvestType = "berry";
          // Credit berries directly into inventory.
          const windmills = countNearbyStructures(
            state, v.ownerId, "windmill", v.patchX, v.patchY, MILL_BUFF_RADIUS,
          );
          const vFertP = volcanoFertility(state, v.patchX, v.patchY);
          const wFertP = waterFertility(state, v.patchX, v.patchY);
          const harvestMult =
            (1 + vFertP * (VOLCANO_HARVEST_PEAK_MULT - 1)) *
            (1 + wFertP * (WATER_HARVEST_PEAK_MULT - 1));
          const total = Math.round(HARVEST_YIELD * Math.max(1, windmills * 10) * harvestMult);
          const berries: ResourceKind[] = ["redberry", "blueberry", "yellowberry"];
          for (let i = 0; i < total; i++) {
            const pick = berries[(Math.random() * berries.length) | 0];
            if (inventoryAdd(v, pick, 1) === 0) break;
          }
          const tent = findHomeTent(state, v.ownerId);
          if (tent) {
            v.job = "walkHome";
            v.targetX = tent.x;
            v.targetY = tent.y;
            clearPath(v);
          } else {
            v.job = "idle";
          }
        }
        break;
      }

      case "mining": {
        v.rot = (v.chopsLeft % 2 === 0 ? 1 : -1) * CHOP_ANGLE_RAD;
        v.chopsLeft--;
        if (v.chopsLeft <= 0) {
          v.rot = 0;
          // Decrement the rock's remaining mines. The helper only
          // pushes the prop into harvestedProps once the counter
          // reaches zero (30 mines per rock by default), so each
          // swing yields a small share rather than emptying the rock.
          const fullyDepleted = recordRockMine(state, v.targetPropIdx);
          if (fullyDepleted) markPropDirty(state, v.targetPropIdx);
          const propSprite = w.props[v.targetPropIdx]?.sprite ?? "";
          const vFertP = volcanoFertility(state, v.patchX, v.patchY);
          const wFertP = waterFertility(state, v.patchX, v.patchY);
          const harvestMult =
            (1 + vFertP * (VOLCANO_HARVEST_PEAK_MULT - 1)) *
            (1 + wFertP * (WATER_HARVEST_PEAK_MULT - 1));
          applyRockYield(propSprite, harvestMult, (k, n) => inventoryAdd(v, k, n));
          v.carryingSprite = "rockpile";
          v.harvestType = "rock";

          if (!inventoryFull(v)) {
            const next = findClosestRock(state, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
            if (next >= 0) {
              const rock = w.props[next];
              v.job = "walkToRock";
              v.targetPropIdx = next;
              v.targetX = rock.x;
              v.targetY = rock.y;
              clearPath(v);
              break;
            }
          }
          const tent = findHomeTent(state, v.ownerId);
          if (tent) {
            v.job = "walkHome";
            v.targetX = tent.x;
            v.targetY = tent.y;
            clearPath(v);
          } else {
            v.job = "idle";
          }
        }
        break;
      }

      case "walkHome": {
        if (Math.hypot(v.targetX - v.x, v.targetY - v.y) <= DEPOSIT_REACH) {
          // Drain the villager's inventory bag into the player's pool.
          // Yield was already fertility / mill-scaled at the moment of
          // harvest, so deposit is now a straight copy with a first-
          // wood unlock hook on the side.
          const owner = state.players[v.ownerId];
          const deposited = depositInventory(v, owner, state);
          if ((deposited.wood ?? 0) > 0 && !state.unlockedWoodVillagers.has(v.ownerId)) {
            state.unlockedWoodVillagers.add(v.ownerId);
            spawnWoodUnlockVillagers(state, v.ownerId);
          }
          v.carryingSprite = undefined;
          clearPath(v);
          // Patch follow-up: rocks chain to the next rock, trees use
          // the villager-aware finder so we don't re-target a tree
          // this villager already took a share from. Farming is one-
          // shot per click.
          if (v.harvestType === "rock") {
            const next = findClosestRock(state, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
            if (next >= 0) {
              const rock = w.props[next];
              v.job = "walkToRock";
              v.targetPropIdx = next;
              v.targetX = rock.x;
              v.targetY = rock.y;
              break;
            }
          } else if (v.harvestType === "wood") {
            const next = findClosestTreeFor(state, v.id, v.patchX, v.patchY, INFINITE_PATCH_RADIUS);
            if (next >= 0) {
              const tree = w.props[next];
              v.job = "walkToTree";
              v.targetPropIdx = next;
              v.targetX = tree.x;
              v.targetY = tree.y;
              break;
            }
          }
          v.job = "idle";
          v.targetPropIdx = -1;
          v.harvestType = undefined;
        } else {
          stepAlongPath(state, v);
        }
        break;
      }
    }
  }
}

/** Reset the villager's cached A* path so the next movement step
 *  recomputes from scratch. Called on job transitions where the
 *  destination changes. */
function clearPath(v: Villager): void {
  v.pathTiles = undefined;
  v.pathIdx = undefined;
  v.pathTargetTile = undefined;
}

/** Abandon the villager's current task — drop them to idle and clear
 *  the harvest / target / path state. Called from stepAlongPath when
 *  no path exists and no bridge can be built, so the villager doesn't
 *  freeze at the failed step. The player can then re-issue the order. */
function abandonTask(v: Villager): void {
  v.job = "idle";
  v.targetPropIdx = -1;
  v.harvestType = undefined;
  v.chopsLeft = 0;
  v.rot = 0;
  clearPath(v);
}

/** Step the villager one tick along their cached A* path toward (targetX,
 *  targetY). Recomputes the path on demand if the target moved. If no
 *  path exists and the villager carries wood, drops a treetump on the
 *  first blocking sea tile (turning it into Land) and repaths over the
 *  fresh bridge. If carrying nothing, the villager idles in place for
 *  this tick — fetch-wood-and-bridge is the next layer to add. */
function stepAlongPath(state: GameState, v: Villager): void {
  const w = state.world;
  const tx = Math.max(0, Math.min(w.width - 1, Math.floor(v.targetX)));
  const ty = Math.max(0, Math.min(w.height - 1, Math.floor(v.targetY)));
  const targetTile = tileIdx(w, tx, ty);

  // (Re)compute path if missing or stale.
  if (!v.pathTiles || v.pathTargetTile !== targetTile) {
    const sx = Math.max(0, Math.min(w.width - 1, Math.floor(v.x)));
    const sy = Math.max(0, Math.min(w.height - 1, Math.floor(v.y)));
    const startTile = tileIdx(w, sx, sy);
    const p = findPath(w, startTile, targetTile);
    if (p) {
      v.pathTiles = p;
      v.pathIdx = 0;
      v.pathTargetTile = targetTile;
    } else {
      // No path possible (target on water, walled-off island, out of
      // pathfind's bounded search range, etc.). Try the bridge
      // fallback — if it places one we'll re-path next tick. If it
      // didn't help (carrying no wood, or wood but no sea between
      // here and the goal), abandon the task so the villager doesn't
      // freeze forever pinging the same failing path-find.
      const bridged = tryBridgeIfPossible(state, v, sx, sy, tx, ty);
      if (!bridged) abandonTask(v);
      return;
    }
  }

  if (!v.pathTiles || v.pathIdx === undefined) return;

  // Walk toward current waypoint at VILLAGER_SPEED.
  while (v.pathIdx < v.pathTiles.length) {
    const wpIdx = v.pathTiles[v.pathIdx];
    const wx = (wpIdx % w.width) + 0.5;
    const wy = ((wpIdx / w.width) | 0) + 0.5;
    const dx = wx - v.x;
    const dy = wy - v.y;
    const d = Math.hypot(dx, dy);
    if (d <= 0.8) {
      v.pathIdx++;
      continue;
    }
    const step = Math.min(VILLAGER_SPEED, d);
    v.x += (dx / d) * step;
    v.y += (dy / d) * step;
    return;
  }

  // Path consumed; lerp the last bit toward exact target.
  const dx = v.targetX - v.x;
  const dy = v.targetY - v.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.5) {
    const step = Math.min(VILLAGER_SPEED, d);
    v.x += (dx / d) * step;
    v.y += (dy / d) * step;
  }
}

/** When no path was found, scan the line of sight from villager → target
 *  for the first impassable sea tile and place a wood bridge there if
 *  the villager is carrying any. This is the simple form of the bridge
 *  mechanic — a future pass adds the divert-to-tree behaviour when the
 *  villager has no wood. */
function tryBridgeIfPossible(
  state: GameState,
  v: Villager,
  sx: number, sy: number,
  ex: number, ey: number
): boolean {
  if (v.carryingSprite !== "treetump") return false; // No wood → can't bridge yet.
  const w = state.world;
  const blockIdx = firstBlocker(w, sx, sy, ex, ey);
  if (blockIdx < 0) return false; // No water blocker on the direct line.
  // Drop wood: tile becomes Land, push a treetump prop at that tile so
  // the player can see the bridge. Clear the villager's carried flag.
  w.kind[blockIdx] = TileKind.Land;
  w.riverMask[blockIdx] = 0;
  const bx = blockIdx % w.width;
  const by = (blockIdx / w.width) | 0;
  w.props.push({ sprite: "treetump", x: bx + 0.5, y: by + 0.5, size: 1.5 });
  v.carryingSprite = undefined;
  // Mark surrounding tiles dirty so the renderer repaints the bridge in.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = bx + dx, ny = by + dy;
      if (nx >= 0 && nx < w.width && ny >= 0 && ny < w.height) {
        state.dirtyTiles.add(ny * w.width + nx);
      }
    }
  }
  // Force a fresh path on the next tick over the new land tile.
  clearPath(v);
  void isWalkable;
  return true;
}

/** Add every tile inside a harvested prop's bbox to state.dirtyTiles so
 *  the renderer's incrementalRepaint marks the chunks it overlaps. On the
 *  next chunk repaint, paintPropsIntoChunk consults state.harvestedProps
 *  and skips the prop, visually removing it. */
/** Mine-deposit yield table. Variant rocks credit 10 units of their
 *  tagged resource. Standard / snowy / mesa / epic-rare rocks credit
 *  ten unit-rolls each with a 10% chance of being iron instead of rock —
 *  on average ~9 rock + ~1 iron per mined rock. Berry-bearing rocks
 *  credit 10 of their colour-matched berry. */
const STANDARD_ROCK_IRON_PER_UNIT_CHANCE = 0.1;
/** Refactored from a Record-mutating signature to a callback so callers
 *  can route the yield into the player's resource pool (Record) or a
 *  villager's inventory bag (Partial Record) without two copies of the
 *  table. */
function applyRockYield(
  sprite: string,
  mult: number,
  add: (kind: ResourceKind, amount: number) => void,
): void {
  // Per-mine yield now uses ROCK_YIELD_PER_MINE (5) instead of the
  // big HARVEST_YIELD (10): rocks take many small bites (30 per rock)
  // so each swing should be a smaller chunk. Total per-rock output is
  // 30 × 5 = 150 base, well above the old 10.
  const y = ROCK_YIELD_PER_MINE * mult;
  // Cooled-volcano craters drop a much bigger payload of uranium —
  // these are rare set-piece spawns (1 per ~10 in-game minutes per
  // active cone), so each one should be worth a meaningful haul.
  if (sprite.startsWith("uranium_cooled")) { add("uranium", y * 20); return; }
  if (sprite.startsWith("iron_"))         { add("iron",        y); return; }
  if (sprite.startsWith("gold_"))         { add("gold",        y); return; }
  if (sprite.startsWith("diamond_"))      { add("diamond",     y); return; }
  if (sprite.startsWith("uranium_"))      { add("uranium",     y); return; }
  if (sprite.startsWith("redberry_"))     { add("redberry",    y); return; }
  if (sprite.startsWith("yellowberry_"))  { add("yellowberry", y); return; }
  if (sprite.startsWith("blueberry_"))    { add("blueberry",   y); return; }
  // Standard rock family: 5 unit rolls per mine. Each unit is 90%
  // rock, 10% iron. Fertility scales the roll count linearly.
  const rolls = Math.round(ROCK_YIELD_PER_MINE * mult);
  for (let i = 0; i < rolls; i++) {
    if (Math.random() < STANDARD_ROCK_IRON_PER_UNIT_CHANCE) add("iron", 1);
    else add("rock", 1);
  }
}

/** Count of owner's structures within `radius` tiles of (x, y). Used by
 *  the windmill / woodmill range-based buffs — only mills physically
 *  near the harvest or near the wood-producing workbench contribute.
 *  Iterates the pre-bucketed `structuresByOwnerKey` array (typically 0..3
 *  entries) instead of scanning every structure on the map. */
function countNearbyStructures(
  state: GameState, ownerId: number, defKey: string,
  x: number, y: number, radius: number,
): number {
  const bucket = state.structuresByOwnerKey?.get(ownerId + "|" + defKey);
  if (!bucket || bucket.length === 0) return 0;
  const r2 = radius * radius;
  let n = 0;
  for (let i = 0; i < bucket.length; i++) {
    const s = bucket[i];
    const dx = s.x - x;
    const dy = s.y - y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return n;
}

/** Range in tiles within which a mill's buff applies. Sized so a small
 *  cluster of buildings can sit comfortably in a single mill's footprint
 *  without one mill blanketing the whole tribe. */
const MILL_BUFF_RADIUS = 180;

function markPropDirty(state: GameState, propIdx: number): void {
  const prop = state.world.props[propIdx];
  if (!prop) return;
  const w = state.world;
  // prop.size is the half-width in tiles.
  const x0 = Math.max(0, Math.floor(prop.x - prop.size));
  const x1 = Math.min(w.width - 1, Math.ceil(prop.x + prop.size));
  const y0 = Math.max(0, Math.floor(prop.y - prop.size));
  const y1 = Math.min(w.height - 1, Math.ceil(prop.y + prop.size));
  for (let y = y0; y <= y1; y++) {
    const base = y * w.width;
    for (let x = x0; x <= x1; x++) {
      state.dirtyTiles.add(base + x);
    }
  }
}

/** Per-tick bot AI for the tribal era. Each bot acts at most every
 *  BOT_ACTION_TICKS ticks. The decision tree:
 *
 *   1. ATTACK   — at-war target available + army strength over floor
 *                  → launchTribalAttack on the weakest enemy.
 *   2. PROMOTE  — combat side under-staffed AND surplus workers AND
 *                  a spear is available in the tool pool → promote one
 *                  worker to army/guard (consumes the spear).
 *   3. CRAFT    — workbench is finished AND priority tool is missing AND
 *                  affordable → craft it. Order: pickaxe > spear > hoe
 *                  > shovel. This is the user-requested behaviour-tree
 *                  upgrade — "make a behaviour tree thats much more
 *                  complex as its got more than enough wood but chooses
 *                  to still not make a pickaxe".
 *   4. BUILD-HELP — there's an unfinished friendly structure → send any
 *                  remaining idle workers to help finish it before
 *                  starting new harvest tasks.
 *   5. HARVEST  — idle workers go chop trees near home.
 *   6. EXPAND   — pick a weighted-affordable building and place it.
 *
 *  Each lane is gated so the bot CAN'T stall: if the priority tool isn't
 *  affordable (lane 3) we fall through to harvest, etc. */
/** Cooldown between bot decisions. 15 ticks ≈ 1.5 s at tickMs=100, but
 *  bots are now staggered across this window (see stepBotAi) so the
 *  per-tick cost is constant regardless of bot count — at 16 bots that's
 *  about one bot acting per tick. */
// Bot action cadence — was 18 ticks (1.8 s). Halved to 9 (≈0.9 s) so
// bots evolve at full speed independently of the human pacing. The
// per-tick action cap below still throttles the worst-case stampede,
// but each individual bot now decides + acts twice as often.
const BOT_ACTION_TICKS = 9;
/** Per-tick limit on how many bots can run their action lane. Even with
 *  a perfectly even stagger you can occasionally get a few bots that
 *  hit the same wake-up tick — the cap stops a single tick from ever
 *  paying for all 16 bots at once. */
// Per-tick stampede cap. Raised 2 → 4 so even with 15 bots all hitting
// their wake-up window in the same tick we resolve up to four at once —
// twice the throughput while still bounding worst-case CPU per tick.
const BOT_MAX_ACTIONS_PER_TICK = 4;
/** Module-local bucket arrays reused across stepBotAi calls. The two
 *  refilled-every-tick allocations they replace were the largest single
 *  source of GC pressure in the engine: ~(2 × players) fresh arrays per
 *  bot-tick, with player counts of 16. Reuse keeps the allocation cost
 *  out of the hot loop entirely. */
const BOT_VILLAGER_BUCKETS: Villager[][] = [];
const BOT_STRUCTURE_BUCKETS: import("./state").GameState["structures"][] = [];
const BOT_ARMY_AGGRESSION_FLOOR = 30; // ~3 army villagers worth of strength
const BOT_TARGET_ARMY = 5;
const BOT_TARGET_GUARDS = 3;
/** Bots must always keep at least this many workers chopping or the
 *  economy dies. Promoting villagers to army/guard is blocked while
 *  the worker count would drop below this floor. */
const BOT_MIN_WORKERS = 4;
/** Tool order the bot crafts in. Pickaxe first — stone is the second
 *  resource lever and unlocks the rest of the workbench cascade. Spear
 *  second because promotions depend on it. Hoe + shovel are quality-
 *  of-life and stay last. */
const BOT_TOOL_PRIORITY = ["pickaxe", "spear", "hoe", "shovel"];
/** Per-tool stockpile cap so the bot doesn't endlessly craft pickaxes
 *  once it has a working economy. */
const BOT_TOOL_CAP: Record<string, number> = {
  pickaxe: 2, spear: 6, hoe: 1, shovel: 1,
};
/** Max workers a single bot can dispatch onto fresh harvest tasks in
 *  one action tick. Each dispatch calls assignTreeChop / assignRockMine
 *  which both scan world.props — capping prevents a 30-worker tribe
 *  from paying 30 × O(props) on every wake-up. Remaining idle workers
 *  get picked up by the next action tick (1.8s later) or by the
 *  passive stepAutoAssist tick. */
const BOT_HARVEST_DISPATCH_CAP = 5;
/** Per-stepBotAi shared cache. Computed once per tick that any bot is
 *  due to act, then shared across every botAct call in that tick so the
 *  defence-scan + frontier-scan etc. don't repeat work for each bot.
 *
 *  Without this, a 16-bot tick paid `estimateDefence` (O(structures)) for
 *  every (bot, enemy) pair — O(B × P × S) just for defence. Caching to
 *  a single Float32Array cuts the per-bot cost to O(P). */
interface BotTickCache {
  defence: Float32Array;          // estimateDefence(playerId)
  homeX: Float32Array;            // 0 if no campfire (gated by hasHome)
  homeY: Float32Array;
  hasHome: Uint8Array;            // 1 if a campfire exists for this player
}

function buildBotTickCache(state: GameState): BotTickCache {
  const N = state.players.length;
  const defence = new Float32Array(N);
  const homeX = new Float32Array(N);
  const homeY = new Float32Array(N);
  const hasHome = new Uint8Array(N);
  for (const v of state.villagers) {
    const role = v.role ?? "worker";
    if (role === "guard") defence[v.ownerId] += 8;
    else if (role === "army") defence[v.ownerId] += 5;            // 10 * 0.5
  }
  for (const s of state.structures) {
    if (s.defKey === "trebuchet" && (s.buildProgress ?? 1) >= 1) {
      defence[s.ownerId] += 5;
    } else if (s.defKey === "campfire" && hasHome[s.ownerId] === 0) {
      homeX[s.ownerId] = s.x;
      homeY[s.ownerId] = s.y;
      hasHome[s.ownerId] = 1;
    }
  }
  return { defence, homeX, homeY, hasHome };
}

function stepBotAi(state: GameState): void {
  const owners = state.players.length;
  // Early bail — if NO bot is due to act this tick, don't even build
  // the per-tick indices. This is the biggest win in the steady state
  // where every bot is mid-cooldown.
  let anyDue = false;
  for (let i = 0; i < owners; i++) {
    const p = state.players[i];
    if (!p.alive || p.isHuman) continue;
    if (state.tick >= state.botNextActionTick[i]) { anyDue = true; break; }
  }
  if (!anyDue) return;

  // Reuse two module-local bucket arrays across calls instead of
  // allocating 2 × (owners + 1) fresh arrays every tick. Grows on demand
  // when the player count changes (e.g. resume into a lobby with a
  // different bot count); shrinks would be wasted work. Per-bucket
  // arrays are kept and `.length = 0` cleared so the underlying
  // capacity is reused and the GC doesn't see fresh allocations.
  if (BOT_VILLAGER_BUCKETS.length < owners) {
    while (BOT_VILLAGER_BUCKETS.length < owners) BOT_VILLAGER_BUCKETS.push([]);
    while (BOT_STRUCTURE_BUCKETS.length < owners) BOT_STRUCTURE_BUCKETS.push([]);
  }
  for (let i = 0; i < owners; i++) {
    BOT_VILLAGER_BUCKETS[i].length = 0;
    BOT_STRUCTURE_BUCKETS[i].length = 0;
  }
  for (const v of state.villagers) {
    if (v.insideStructureId !== undefined) continue;
    BOT_VILLAGER_BUCKETS[v.ownerId].push(v);
  }
  for (const s of state.structures) BOT_STRUCTURE_BUCKETS[s.ownerId].push(s);
  const villagersByOwner = BOT_VILLAGER_BUCKETS;
  const structuresByOwner = BOT_STRUCTURE_BUCKETS;
  const cache = buildBotTickCache(state);

  let budget = BOT_MAX_ACTIONS_PER_TICK;
  for (const p of state.players) {
    if (budget <= 0) break;
    if (!p.alive || p.isHuman) continue;
    if (state.tick < state.botNextActionTick[p.id]) continue;
    state.botNextActionTick[p.id] = state.tick + BOT_ACTION_TICKS;
    botAct(state, p.id, villagersByOwner[p.id], structuresByOwner[p.id], cache);
    budget--;
  }
}

/** Classify the bot's current economic phase by what they own. Drives
 *  which buildings + tools get weight boosts, which targets they attack,
 *  and when they spend on ports/airships. Cheap to call every action
 *  tick — no caching needed. */
function botPhase(
  state: GameState, botId: number, myStructures: typeof state.structures,
  popUsed: number,
): import("./state").BotPhase {
  const bot = state.players[botId];
  let hasWorkbench = false, hasStonebench = false, hasMill = false, hasPort = false;
  for (const s of myStructures) {
    if ((s.buildProgress ?? 1) < 1) continue;
    if (s.defKey === "workbench") hasWorkbench = true;
    else if (s.defKey === "stonebench") hasStonebench = true;
    else if (s.defKey === "windmill" || s.defKey === "woodmill"
          || s.defKey === "stonemill" || s.defKey === "wheatmill"
          || s.defKey === "bakery" || s.defKey === "waterwheel") hasMill = true;
    else if (s.defKey.startsWith("port_") || s.defKey.startsWith("airship_port")) hasPort = true;
  }
  const hasSpear = (bot.tools.spear ?? 0) > 0;
  // Imperial — ports up, spears on hand, decent tribe. Pop threshold
  // dropped 10 → 5 so the imperial-phase boosts (3× transport weight,
  // higher vessel-purchase rate, late-game shelter pushes) kick in
  // before the tribe stalls on growth gating.
  if (hasPort && hasSpear && popUsed >= 5) return "imperial";
  // Military — has the stone industry + a spear-capable workforce.
  if (hasStonebench && hasSpear) return "military";
  // Industrial — workbench up, on the way to stone / mills.
  if (hasWorkbench && (hasMill || hasStonebench)) return "industrial";
  if (hasWorkbench) return "industrial";
  return "bootstrap";
}

/** Estimate a player's military strength for target-selection. Stronger
 *  than just army — counts guards, plus a small bonus for trebuchets
 *  (they shoot down enemy airships and signal defensive intent). */
function estimateDefence(state: GameState, playerId: number): number {
  let s = getGuardStrength(state, playerId) + getArmyStrength(state, playerId) * 0.5;
  // +5 per finished trebuchet — they're a defensive signal and a real
  // anti-air threat. Bots that overstate trebuchet weight don't suicide
  // into a fortified tribe.
  for (const st of state.structures) {
    if (st.ownerId !== playerId) continue;
    if (st.defKey !== "trebuchet") continue;
    if ((st.buildProgress ?? 1) < 1) continue;
    s += 5;
  }
  return s;
}

/** Cycle: bots wake up every BOT_DIPLOMACY_TICKS and roll a strategic
 *  diplomatic action — declare war on the weakest pre-existing enemy
 *  that they can plausibly beat, OR propose truce with the strongest
 *  non-allied neighbour they fear. Personality biases which side they
 *  lean toward. Cooldown is long (~30 s) so the world doesn't churn. */
const BOT_DIPLOMACY_TICKS = 300;
function botDiplomacyTick(state: GameState, botId: number, cache: BotTickCache): void {
  const mem = state.botMemory?.[botId];
  if (!mem) return;
  if (state.tick < mem.nextScoutTick) return;
  mem.nextScoutTick = state.tick + BOT_DIPLOMACY_TICKS;

  const myDef = cache.defence[botId];
  let weakestNeutralOrWar = -1, weakestScore = Infinity;
  let strongestNonHostile = -1, strongestScore = -Infinity;
  const allyWarVotes = new Map<number, number>();
  for (const other of state.players) {
    if (other.id === botId || !other.alive) continue;
    const rel = getRelation(state, botId, other.id);
    if (rel === RELATION_ALLY) {
      for (const third of state.players) {
        if (third.id === botId || !third.alive) continue;
        if (third.id === other.id) continue;
        if (getRelation(state, other.id, third.id) === RELATION_WAR) {
          allyWarVotes.set(third.id, (allyWarVotes.get(third.id) ?? 0) + 1);
        }
      }
      continue;
    }
    const def = cache.defence[other.id];
    if (rel !== RELATION_WAR && rel !== RELATION_TRUCE) {
      if (def < weakestScore) { weakestScore = def; weakestNeutralOrWar = other.id; }
    }
    if (rel !== RELATION_WAR) {
      if (def > strongestScore) { strongestScore = def; strongestNonHostile = other.id; }
    }
  }

  if (allyWarVotes.size > 0) {
    let pileTarget = -1;
    let pileVotes = 0;
    for (const [tid, votes] of allyWarVotes) {
      if (votes > pileVotes) { pileVotes = votes; pileTarget = tid; }
    }
    if (pileTarget >= 0) {
      const rel = getRelation(state, botId, pileTarget);
      if (rel !== RELATION_WAR && rel !== RELATION_ALLY && rel !== RELATION_TRUCE) {
        const tgtDef = cache.defence[pileTarget];
        if (tgtDef <= myDef * 2.0) {
          setRelation(state, botId, pileTarget, RELATION_WAR);
          mem.focusTargetId = pileTarget;
          return;
        }
      }
    }
  }

  const aggrBias = ({
    aggressor: 0.85, builder: 0.20, trader: 0.10, opportunist: 0.50,
  } as const)[mem.personality];

  const wantWar = Math.random() < aggrBias;
  if (wantWar && weakestNeutralOrWar >= 0 && weakestScore <= myDef * 1.2) {
    setRelation(state, botId, weakestNeutralOrWar, RELATION_WAR);
    mem.focusTargetId = weakestNeutralOrWar;
    return;
  }
  if (!wantWar && strongestNonHostile >= 0 && strongestScore > myDef * 1.3) {
    if (Math.random() < 0.6) {
      setRelation(state, botId, strongestNonHostile, RELATION_TRUCE);
    }
    return;
  }
  if ((mem.personality === "trader" || mem.personality === "builder")
      && Math.random() < 0.15
      && strongestNonHostile >= 0) {
    setRelation(state, botId, strongestNonHostile, RELATION_TRUCE);
  }
}

function botAct(
  state: GameState, botId: number,
  myVillagers: Villager[],
  myStructures: typeof state.structures,
  cache: BotTickCache,
): void {
  const bot = state.players[botId];
  // Defensive: legacy save shape can race the engine before
  // normalizeResumedState runs. Build a temporary memory if missing.
  if (!state.botMemory) state.botMemory = state.players.map(() => ({
    personality: "opportunist" as const,
    lastAttackedTick: -10_000,
    nextScoutTick: 0,
    lastAttackLaunchedTick: -10_000,
    focusTargetId: -1,
  }));
  const mem = state.botMemory[botId];
  const personality = mem.personality;

  // Run the slow diplomatic lane first — it can set the focus target
  // for combat below.
  botDiplomacyTick(state, botId, cache);

  // Tally roles once.
  let armyCount = 0, guardCount = 0, workerCount = 0;
  const idleWorkers: Villager[] = [];
  for (const v of myVillagers) {
    const role = v.role ?? "worker";
    if (role === "army") armyCount++;
    else if (role === "guard") guardCount++;
    else {
      workerCount++;
      if (v.job === "idle") idleWorkers.push(v);
    }
  }

  const popCap = getPopulationCap(state, botId);
  const popUsed = getPopulationUsed(state, botId);
  const phase = botPhase(state, botId, myStructures, popUsed);
  const recentlyAttacked = state.tick - mem.lastAttackedTick < 600;  // ~60s
  const recentlyAttacking = state.tick - mem.lastAttackLaunchedTick < 80;

  // (0) RETREAT lane — if our defensive posture has collapsed, sue for
  // peace with everyone we're outclassed by. Defence values come from
  // the per-tick cache so this lane is O(P) instead of O(P × S).
  const myDef = cache.defence[botId];
  if (popUsed < 6 || myDef < 5) {
    const retreatThreshold = ({
      aggressor: 0.6, builder: 0.85, trader: 0.9, opportunist: 0.75,
    } as const)[personality];
    for (const other of state.players) {
      if (other.id === botId || !other.alive) continue;
      if (getRelation(state, botId, other.id) !== RELATION_WAR) continue;
      const def = cache.defence[other.id];
      if (def > myDef / retreatThreshold) {
        setRelation(state, botId, other.id, RELATION_TRUCE);
        if (mem.focusTargetId === other.id) mem.focusTargetId = -1;
      }
    }
  }

  // Per-personality scaling for combat thresholds + army targets.
  const personalityArmyTarget = ({
    aggressor: 12, builder: 4, trader: 5, opportunist: 8,
  } as const)[personality];
  const personalityGuardTarget = ({
    aggressor: 3, builder: 6, trader: 4, opportunist: 4,
  } as const)[personality];
  const armyTarget = recentlyAttacked
    ? Math.max(personalityArmyTarget, 14)         // ramp army hard if hit
    : personalityArmyTarget;
  const guardTarget = recentlyAttacked
    ? Math.max(personalityGuardTarget, 6)
    : personalityGuardTarget;

  // (1) ATTACK lane — only swing when our army comfortably outscores
  // the target's defence. Prefer the diplomatic focus target if it's
  // a valid war target; otherwise pick the weakest enemy we're at war
  // with. Aggressors get a smaller margin (more willing to gamble).
  const myAtk = getArmyStrength(state, botId);
  const swingMarginByPersonality = ({
    aggressor: 0.95, builder: 1.4, trader: 1.3, opportunist: 1.15,
  } as const)[personality];
  if (!recentlyAttacking && myAtk >= 20) {
    let target = -1;
    let targetDef = Infinity;
    if (mem.focusTargetId >= 0
        && state.players[mem.focusTargetId]?.alive
        && getRelation(state, botId, mem.focusTargetId) === RELATION_WAR) {
      const def = cache.defence[mem.focusTargetId];
      if (myAtk >= def * swingMarginByPersonality) {
        target = mem.focusTargetId;
        targetDef = def;
      }
    }
    if (target < 0) {
      for (const other of state.players) {
        if (other.id === botId || !other.alive) continue;
        if (getRelation(state, botId, other.id) !== RELATION_WAR) continue;
        const def = cache.defence[other.id];
        if (myAtk < def * swingMarginByPersonality) continue;
        if (def < targetDef) { targetDef = def; target = other.id; }
      }
    }
    if (target >= 0) {
      launchTribalAttack(state, botId, target);
      // Don't pursue every tick — give the meat-grinder a moment.
      mem.lastAttackLaunchedTick = state.tick;
    }
  }

  // (2) PROMOTE lane — needs a spear available to actually arm them.
  // Aggressors + recently-attacked bots will burn their last spears
  // promoting; builders / traders keep a reserve.
  const spearStock = bot.tools.spear ?? 0;
  const minSpearReserve = personality === "aggressor" || recentlyAttacked ? 0 : 1;
  const spearsToBurn = Math.max(0, spearStock - minSpearReserve);
  if (idleWorkers.length > 0 && workerCount > BOT_MIN_WORKERS && spearsToBurn > 0) {
    if (armyCount < armyTarget) {
      const promote = idleWorkers.shift()!;
      promote.role = "army";
      promote.weapon = "spear";
      bot.tools.spear = spearStock - 1;
    } else if (guardCount < guardTarget) {
      const promote = idleWorkers.shift()!;
      promote.role = "guard";
      promote.weapon = "spear";
      bot.tools.spear = spearStock - 1;
    }
  }

  // (3) CRAFT lane — phase-aware priority. Bootstrap urgently wants
  // pickaxe; Military wants spears; recently-attacked emergencies
  // jump spears to the front regardless of phase.
  let toolPriority: readonly string[];
  if (recentlyAttacked) toolPriority = ["spear", "spear", "pickaxe", "hoe", "shovel"];
  else if (phase === "bootstrap") toolPriority = ["pickaxe", "spear", "hoe", "shovel"];
  else if (phase === "industrial") toolPriority = ["spear", "pickaxe", "hoe", "shovel"];
  else if (phase === "military") toolPriority = ["spear", "pickaxe", "shovel", "hoe"];
  else toolPriority = ["spear", "pickaxe", "shovel", "hoe"];
  for (const toolKey of toolPriority) {
    const have = bot.tools[toolKey] ?? 0;
    const cap = (recentlyAttacked && toolKey === "spear" ? 12 : (BOT_TOOL_CAP[toolKey] ?? 1));
    if (have >= cap) continue;
    const res = craftTool(state, botId, toolKey);
    if (res === "ok") break;
    if (res === "no_workbench") break;
  }

  // Find home + figure out whether we have unfinished friendly builds.
  let home: typeof state.structures[number] | null = null;
  let firstUnfinished: typeof state.structures[number] | null = null;
  for (const s of myStructures) {
    if (!home && s.defKey === "campfire") home = s;
    if (!firstUnfinished && (s.buildProgress ?? 1) < 1) firstUnfinished = s;
  }
  if (!home) home = findHomeTent(state, botId);

  // (4) BUILD-HELP lane — pile workers onto the half-built site so it
  // finishes fast. The auto-assist tick passively does this too.
  if (firstUnfinished && idleWorkers.length > 0) {
    const dispatchCount = Math.min(idleWorkers.length, (firstUnfinished.buildersNeeded ?? 3) + 1);
    for (let i = 0; i < dispatchCount; i++) {
      const worker = idleWorkers[i];
      assignBuildHelp(state, worker.id, firstUnfinished.id);
    }
    idleWorkers.splice(0, dispatchCount);
  }

  // (5) HARVEST lane — phase-aware split between chopping and mining.
  // CAPPED at BOT_HARVEST_DISPATCH_CAP per action tick so a tribe with
  // 30 idle workers doesn't pay 30 × O(world.props) per botAct call.
  // Workers we don't dispatch this tick stay idle and get dispatched
  // on the next action tick (1.8s later) — the existing stepAutoAssist
  // also catches them passively.
  if (home) {
    const hasPickaxe = (bot.tools.pickaxe ?? 0) > 0;
    const woodStock = bot.resources.wood ?? 0;
    const rockStock = bot.resources.rock ?? 0;
    let rockFraction = 0;
    if (hasPickaxe) {
      if (phase === "military" || phase === "imperial") rockFraction = 0.5;
      else if (phase === "industrial") rockFraction = 0.35;
      else rockFraction = 0.2;
      if (rockStock < woodStock * 0.3) rockFraction = Math.max(rockFraction, 0.6);
    }
    const dispatchN = Math.min(idleWorkers.length, BOT_HARVEST_DISPATCH_CAP);
    for (let i = 0; i < dispatchN; i++) {
      const px = home.x + (Math.random() - 0.5) * 280;
      const py = home.y + (Math.random() - 0.5) * 280;
      const goMine = hasPickaxe && Math.random() < rockFraction;
      if (goMine) {
        const res = assignRockMine(state, botId, px, py);
        if (res !== "ok") assignTreeChop(state, botId, px, py);
      } else {
        assignTreeChop(state, botId, px, py);
      }
    }
  }

  // (6) VESSEL lane — bots with a finished port + spare resources
  // occasionally purchase a vessel. Now fires from Industrial onward so
  // the bot can buy a raft as soon as it has a port — rafts produce
  // unpreped_meat, which is the gating resource for villager spawn.
  // Imperial bots roll more often + open the airship/galleon catalog.
  const hasFinishedPort = myStructures.some(
    (s) => (s.defKey.startsWith("port_") || s.defKey.startsWith("airship_port"))
        && (s.buildProgress ?? 1) >= 1,
  );
  if (hasFinishedPort && personality !== "builder") {
    // Rate-bumped to address "bots have huge stockpiles but no fleet":
    // any bot with a finished port should be cycling vessels every few
    // action ticks. Rich bots roll even more often so the stockpile
    // doesn't pile up forever. Imperial bots keep their old aggressive
    // rate. The slot cap (4 per port) still limits how many actually
    // commit per call.
    const richBonus = ((bot.resources.wood ?? 0) >= 200 && (bot.resources.rock ?? 0) >= 60)
      ? 0.20 : 0;
    const rate = (phase === "imperial" ? 0.35
              : phase === "military"  ? 0.28
              : phase === "industrial" ? 0.22
              : 0.15) + richBonus;
    if (Math.random() < rate) botPurchaseVesselIfAffordable(state, botId, myStructures);
  }

  // (6.5) POPULATE lane — spawn villagers when meat + room allow. Bots
  // never used canSpawnVillager before, so their tribe was stuck at the
  // 4 starter villagers forever — devastating once any of them died.
  // Now: every action tick with meat ≥ cost AND under pop cap, spawn
  // one and accept up to 3 per tick (so growth catches up after combat
  // losses). Personality scales the limit slightly: aggressors grow
  // faster after they've taken hits.
  if (home && canSpawnVillager(state, botId)) {
    // Bumped: bots now spawn aggressively each action tick so they
    // hit the airship crew threshold (8 villagers) on a reasonable
    // timeline. Builders + post-attack ramp keep their previous extra
    // multipliers; the floor is 4 spawns/tick (up from 2) so every
    // bot's pop curves up at human pace without artificial throttling.
    const maxSpawns = recentlyAttacked ? 6 : (personality === "builder" ? 5 : 4);
    botSpawnVillagers(state, botId, home, maxSpawns);
  }

  // (6.7) FARM-PAINT lane — bots with hoe + shovel + ash drop a small
  // batch of farm tiles around home each action tick. Throttled so a
  // tribe doesn't spam paintFarmTile on every wake-up. fertilize lane
  // (separately in stepAutoAssist) doesn't apply to bots — bots
  // dispatch their own fertilizers via assignFertilize when workers
  // are idle.
  const hasHoe = (bot.tools.hoe ?? 0) > 0;
  const hasShovel = (bot.tools.shovel ?? 0) > 0;
  const hasAsh = bot.resources.ash >= 4;
  if (home && hasHoe && hasShovel && hasAsh && Math.random() < 0.4) {
    botPaintFarmPatch(state, botId, home, 4);
    if (idleWorkers.length > 0) {
      assignFertilize(state, botId);
      idleWorkers.shift();
    }
  }

  // (6.8) BERRY-FARM lane — the human's beach-farming click also exists
  // for bots: if there's a beach tile near home AND a hoe is owned,
  // dispatch an idle worker to assignFarm. Pulls one worker off the
  // harvest pool per action tick. The beach tile is found by scanning
  // a ring around home (Land + coastDist ≤ 5).
  if (home && hasHoe && idleWorkers.length > 0 && Math.random() < 0.35) {
    const beach = findBeachNearHome(state, home);
    if (beach) {
      const res = assignFarm(state, botId, beach.x, beach.y, "auto");
      if (res === "ok") idleWorkers.shift();
    }
  }

  // (6.9) VESSEL-LAUNCH lane — bots with a docked vessel board it up
  // and launch it. Drains idle workers as crew. Builders skip this
  // lane (they prefer to bank villagers). Vessel becomes flying / sea-
  // borne and is no longer at the dock, freeing the slot for the next
  // purchase. The vessel's popCap bonus disappears too — same trade-
  // off the human gets.
  if (personality !== "builder") {
    botBoardAndLaunchVessels(state, botId, myStructures, idleWorkers);
  }

  // (6.95) CLEANUP lane — destroy structures that have been stuck at
  // very-low buildProgress for ages (the worker pool can't reach them,
  // or they sit in a contested spot). Refunds half the cost, frees the
  // build queue for the bot to try a different building.
  if (firstUnfinished && firstUnfinished.buildProgress !== undefined
      && firstUnfinished.buildProgress < 0.05) {
    // Only cleanup if we've had this stuck build for at least ~30s
    // (state.tick has run ~300 ticks since the failed start). We track
    // this implicitly via "we keep being asked to dispatch workers
    // here and the progress never grows" — a bot can give up here.
    // Random gate keeps the cleanup from cascading.
    if (Math.random() < 0.02) {
      destroyStructure(state, firstUnfinished.id);
    }
  }

  // (7) EXPAND lane — phase-aware weighted picker. Skipped if a build
  // is in progress (focus on finishing it) or we have no home.
  if (!home || firstUnfinished) return;
  const ownedCounts = new Map<string, number>();
  for (const s of myStructures) {
    ownedCounts.set(s.defKey, (ownedCounts.get(s.defKey) ?? 0) + 1);
  }
  const popPressure = popUsed >= popCap - 1;
  const hasFinishedWorkbench = myStructures.some(
    (s) => s.defKey === "workbench" && (s.buildProgress ?? 1) >= 1
  );
  // Meat workflow gating. Bots that have a raw-meat source (raft owned
  // OR shallow_water_hut built) but no meat_prep are sitting on growing
  // unpreped_meat without converting it — meat_prep needs a giant
  // weight boost. Conversely, if they have neither yet, shallow_water_hut
  // gets the boost. Either path unlocks meat → villager spawn.
  const hasMeatPrep = (ownedCounts.get("meat_prep") ?? 0) > 0;
  const hasShallowHut = (ownedCounts.get("shallow_water_hut") ?? 0) > 0;
  const ownsRaft = state.vessels.some((v) => v.ownerId === botId && v.defKey === "raft");
  const hasRawSource = ownsRaft || hasShallowHut;
  const lowOnMeat = (bot.resources.meat ?? 0) < 10;

  type Cand = { def: typeof BUILDINGS[number]; weight: number };
  const candidates: Cand[] = [];
  for (const b of BUILDINGS) {
    if (b.era > state.era) continue;
    if (b.styles && b.styles.length && !b.styles.some((s) => bot.originStyles.includes(s))) continue;
    let canAfford = true;
    for (const k in b.cost) {
      const need = b.cost[k as ResourceKind] ?? 0;
      if (bot.resources[k as ResourceKind] < need) { canAfford = false; break; }
    }
    if (!canAfford) continue;
    const count = ownedCounts.get(b.key) ?? 0;
    const cap = BOT_BUILD_CAPS[b.key] ?? BOT_BUILD_CAP_DEFAULT;
    if (count >= cap) continue;

    let weight = 1;
    if (b.category === "shelter") weight = popPressure ? 10 : 3;
    else if (b.key === "workbench") weight = hasFinishedWorkbench ? 0.2 : 6;
    else if (b.category === "workbench" && (b.produces?.wood ?? 0) > 0) weight = 3.5;
    else if (b.key === "trebuchet") weight = 2;
    else if (b.key === "stonebench") weight = 3.5;
    else if (b.key === "meat_prep" || b.key === "hide_prep") weight = 2;
    else if (b.key === "windmill" || b.key === "woodmill" || b.key === "stonemill") weight = 2.5;
    else if (b.key === "wheatmill" || b.key === "bakery" || b.key === "waterwheel") weight = 2;
    else if (b.category === "transport") weight = 1.5;
    if (count === 0) weight *= 3;

    // PHASE biasing. Naval ports stay early-penalised (they need beach
    // + meat-prep workflow first), but airship ports get an explicit
    // override so they're built as soon as the bot has the workbench
    // economy — they don't depend on a coast, and the imperial-phase
    // pop boost won't fire if the bot never gets the airship in the
    // first place.
    if (phase === "bootstrap") {
      if (b.key === "campfire" || b.key === "workbench" || b.key === "wood_chop") weight *= 2;
      if (b.key === "stonebench") weight *= 0.5;        // not ready yet
      if (b.category === "transport") weight *= 0.2;    // skip ports early
    } else if (phase === "industrial") {
      if (b.key === "stonebench" || b.key === "wood_chop" || b.key === "wood_stack") weight *= 1.5;
      if (b.category === "transport") weight *= 0.5;
      // Override the transport penalty for airship ports specifically —
      // the bot can build one inland without needing a beach, so we
      // push them as soon as the workbench economy is up.
      if (b.key.startsWith("airship_port")) weight *= 6;
    } else if (phase === "military") {
      if (b.key === "trebuchet") weight *= 2.5;
      if (b.key === "medival_tower") weight *= 2;
      if (b.category === "workbench" && (b.produces?.iron ?? 0) > 0) weight *= 1.6;
      // Military bots that don't yet have an airship hangar should
      // bring one online — the recon airships act as map intel for
      // the upcoming military / imperial transition.
      if (b.key.startsWith("airship_port")) weight *= 4;
    } else if (phase === "imperial") {
      if (b.category === "transport") weight *= 3;
      if (b.key === "trebuchet") weight *= 1.5;
      if (b.category === "shelter") weight *= 1.5;       // grow the empire
      if (b.key.startsWith("airship_port")) weight *= 3; // stack on the transport ×3
    }
    // RICH-BOT bias — when a bot is sitting on a giant stockpile (the
    // "bots have huge numbers but no docks / airships" complaint), heavy
    // weight transport so they actually spend it. This applies on top
    // of the phase biasing and works for both naval ports and airship
    // ports (which start with "airship_port", not "port_"). The threshold
    // is intentionally generous so it kicks in well before the bot would
    // naturally hit the imperial phase.
    const isAnyPort = b.key.startsWith("port_") || b.key.startsWith("airship_port");
    if (isAnyPort) {
      const w = bot.resources.wood ?? 0;
      const r = bot.resources.rock ?? 0;
      if (w >= 300 && r >= 100) weight *= 6;             // very rich → almost guaranteed
      else if (w >= 150 && r >= 50) weight *= 3;         // comfortable → strongly prefer
      else if (w >= 80 && r >= 25) weight *= 1.5;        // saving up → slight nudge
      // Once one variant is built, also push the OTHER kind. A bot with
      // a naval port should still get an airship hangar (and vice versa).
      const ownsNaval = Array.from(ownedCounts.entries())
        .some(([k, c]) => k.startsWith("port_") && c > 0);
      const ownsAerial = Array.from(ownedCounts.entries())
        .some(([k, c]) => k.startsWith("airship_port") && c > 0);
      if (b.key.startsWith("airship_port") && ownsNaval && !ownsAerial) weight *= 4;
      if (b.key.startsWith("port_") && ownsAerial && !ownsNaval) weight *= 4;
    }

    // PERSONALITY biasing.
    if (personality === "aggressor") {
      if (b.key === "trebuchet") weight *= 1.8;
      if (b.key === "stonebench") weight *= 1.4;
    } else if (personality === "builder") {
      if (b.category === "workbench") weight *= 1.5;
      if (b.category === "shelter") weight *= 1.4;
      if (b.key === "trebuchet") weight *= 0.5;
    } else if (personality === "trader") {
      if (b.category === "transport") weight *= 2.5;
      if (b.key === "windmill" || b.key === "wheatmill" || b.key === "bakery") weight *= 1.5;
    }
    // Opportunist gets no extra bias — pure phase logic.

    // REACTIVE biasing: under attack? Trebuchets + towers spike.
    if (recentlyAttacked) {
      if (b.key === "trebuchet") weight *= 3;
      if (b.key === "medival_tower") weight *= 2;
    }

    // FOOD biasing — bots starving for meat aggressively pursue the
    // workflow (raft via port + shallow_water_hut + meat_prep).
    if (lowOnMeat) {
      if (b.key === "shallow_water_hut") weight *= 5;
      if (b.key === "meat_prep" && hasRawSource && !hasMeatPrep) weight *= 8;
      if (b.key === "meat_prep") weight *= 2;
      // Encourage a port early so the raft is available.
      if (b.key.startsWith("port_")) weight *= 1.6;
    }
    if (hasRawSource && !hasMeatPrep && b.key === "meat_prep") weight *= 6;

    candidates.push({ def: b, weight });
  }
  if (candidates.length === 0) return;
  let total = 0;
  for (const c of candidates) total += c.weight;
  let r = Math.random() * total;
  let pick = candidates[0].def;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) { pick = c.def; break; }
  }

  // Smarter placement. The old version put EVERY new build inside a
  // tight ring around the home campfire, so tribes never grew past
  // their footprint and never had defensive frontiers facing enemies.
  // Now: trebuchets + towers + outposts lean toward the FRONTIER
  // (direction of the nearest enemy/war target), shelters lean AWAY
  // from enemies (rear of the empire), ports look for the closest
  // coast tile, and everything else uses an expanding ring as the
  // tribe grows (radius scales with structure count).
  const ownedRadius = Math.min(220, 32 + myStructures.length * 8);
  const frontierAngle = botFrontierAngle(state, botId, home);
  let placeAngle: number;
  let placeRadius: number;
  if (pick.requiresBeach || pick.key.startsWith("port_") || pick.key.startsWith("airship_port")) {
    // Ports prefer a coast tile within reach of home.
    placeAngle = frontierAngle + (Math.random() - 0.5) * Math.PI;
    placeRadius = 40 + Math.random() * 240;
  } else if (pick.key === "trebuchet" || pick.key === "medival_tower"
          || pick.key === "thatch_outpost" || pick.key === "desert_outpost") {
    // Defensive / aggressive structures lean toward the enemy frontier.
    placeAngle = frontierAngle + (Math.random() - 0.5) * 0.8;
    placeRadius = pick.size + 80 + Math.random() * ownedRadius;
  } else if (pick.category === "shelter") {
    // Shelters lean AWAY from the frontier — safer rear of the empire.
    placeAngle = frontierAngle + Math.PI + (Math.random() - 0.5) * 0.8;
    placeRadius = pick.size + 30 + Math.random() * ownedRadius;
  } else {
    // Workbenches + ancillary builds — uniform around home in the
    // expanding ring.
    placeAngle = Math.random() * Math.PI * 2;
    placeRadius = pick.size + 24 + Math.random() * (ownedRadius * 0.6);
  }
  const placeX = home.x + Math.cos(placeAngle) * placeRadius;
  const placeY = home.y + Math.sin(placeAngle) * placeRadius;
  buildStructure(state, botId, pick.key, placeX, placeY);
}

/** Approximate angle from `home` toward the bot's most threatening
 *  enemy. Used by the EXPAND lane to bias defensive builds toward the
 *  frontier and shelters toward the rear. Returns a random angle when
 *  there's no enemy at war / no enemy at all. */
function botFrontierAngle(state: GameState, botId: number, home: { x: number; y: number }): number {
  // Pick the closest non-ally / non-truce player's home as the enemy
  // reference. If none, fall back to a random angle so placement
  // doesn't bunch up on the same vector.
  let bestAng = Math.random() * Math.PI * 2;
  let bestD2 = Infinity;
  for (const other of state.players) {
    if (other.id === botId || !other.alive) continue;
    const rel = getRelation(state, botId, other.id);
    if (rel === RELATION_ALLY || rel === RELATION_TRUCE) continue;
    // Find their home structure.
    let theirHome: { x: number; y: number } | null = null;
    for (const s of state.structures) {
      if (s.ownerId !== other.id) continue;
      if (s.defKey !== "campfire") continue;
      theirHome = s;
      break;
    }
    if (!theirHome) continue;
    const dx = theirHome.x - home.x;
    const dy = theirHome.y - home.y;
    const d2 = dx * dx + dy * dy;
    // At-war enemies get a 0.5× distance penalty so they win ties even
    // if a peaceful neutral is closer.
    const adj = rel === RELATION_WAR ? d2 * 0.5 : d2;
    if (adj < bestD2) { bestD2 = adj; bestAng = Math.atan2(dy, dx); }
  }
  return bestAng;
}

/** Spawn villagers near `home` until we hit the pop cap, run out of
 *  meat, or maxSpawns is reached. Each spawn debits VILLAGER_MEAT_COST
 *  and places a fresh villager in a small ring. */
function botSpawnVillagers(
  state: GameState, botId: number,
  home: { x: number; y: number },
  maxSpawns: number,
): number {
  let spawned = 0;
  while (spawned < maxSpawns && canSpawnVillager(state, botId)) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 16 + Math.random() * 12;
    spawnVillagerAtHome(state, botId, home.x + Math.cos(ang) * rad, home.y + Math.sin(ang) * rad);
    spawned++;
  }
  return spawned;
}

/** Paint up to `count` farmland tiles in a small patch near home. The
 *  bot owns its own farms — the existing fertilize lane will assign
 *  workers to ash them. */
function botPaintFarmPatch(
  state: GameState, botId: number,
  home: { x: number; y: number },
  count: number,
): number {
  let painted = 0;
  // Pick a base point ~40-90 tiles from home so farms don't overlap the
  // build cluster, then drop `count` adjacent tiles forming a small
  // patch.
  const ang = Math.random() * Math.PI * 2;
  const baseR = 50 + Math.random() * 50;
  const baseX = home.x + Math.cos(ang) * baseR;
  const baseY = home.y + Math.sin(ang) * baseR;
  for (let i = 0; i < count; i++) {
    const dx = (i % 2);
    const dy = (i / 2) | 0;
    const res = paintFarmTile(state, botId, baseX + dx, baseY + dy);
    if (res.ok) painted++;
  }
  return painted;
}

/** Find a beach tile near `home` the bot can call assignFarm on. Walks
 *  a small spiral of candidate offsets until we land on a Land tile
 *  with coastDist ≤ 5 (the same criterion assignFarm uses). Returns
 *  null if no beach is in reach — bot will retry next action tick. */
function findBeachNearHome(
  state: GameState,
  home: { x: number; y: number },
): { x: number; y: number } | null {
  const w = state.world;
  // Sample 16 angles × 6 radii so we cover the full ring without
  // expensive raster scanning.
  for (let r = 30; r <= 180; r += 30) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = home.x + Math.cos(ang) * r;
      const y = home.y + Math.sin(ang) * r;
      const xi = x | 0;
      const yi = y | 0;
      if (xi < 0 || xi >= w.width || yi < 0 || yi >= w.height) continue;
      const idx = yi * w.width + xi;
      if (w.kind[idx] !== TileKind.Land) continue;
      if (w.coastDist[idx] > 5) continue;
      return { x, y };
    }
  }
  return null;
}

/** For each docked vessel the bot owns, fill any open crew slots with
 *  idle workers, then launch the vessel. Pulls workers off the idle
 *  pool so the harvest lane below doesn't double-dispatch them. */
function botBoardAndLaunchVessels(
  state: GameState, botId: number,
  myStructures: typeof state.structures,
  idleWorkers: Villager[],
): void {
  void myStructures;
  for (const vessel of state.vessels) {
    if (vessel.ownerId !== botId) continue;
    if (vessel.status !== "docked") continue;
    const def = getVesselDef(vessel.defKey);
    if (!def) continue;
    const crewNeeded = def.crew ?? 0;
    // Top up the crew from the idle worker pool.
    while (
      vessel.boardedVillagerIds.length < crewNeeded
      && idleWorkers.length > 0
    ) {
      const v = idleWorkers.shift()!;
      // boardVillager handles the slot check + marks the villager as
      // boarded. We don't toggle insideStructureId — the engine treats
      // boarded crew as "with the vessel" via boardedVillagerIds.
      if (!boardVillager(state, vessel.id, v.id)) break;
    }
    // Launch when crew is full (or when crewNeeded === 0 e.g. raft).
    if (vessel.boardedVillagerIds.length >= crewNeeded) {
      launchVessel(state, vessel.id);
    }
  }
}

/** Buy a random affordable vessel at one of the bot's finished ports.
 *  Imperial-phase bots use this to dot the map with their fleet. */
function botPurchaseVesselIfAffordable(
  state: GameState, botId: number, myStructures: typeof state.structures,
): void {
  // Pick a finished port.
  const ports = myStructures.filter(
    (s) => (s.defKey.startsWith("port_") || s.defKey.startsWith("airship_port"))
        && (s.buildProgress ?? 1) >= 1
  );
  if (ports.length === 0) return;
  const port = ports[(Math.random() * ports.length) | 0];
  // Try each vessel def in shuffled order, buy the first one we can
  // afford that's a valid match for this port type.
  const isAirshipPort = port.defKey.startsWith("airship_port");
  const candidates: { defKey: string; cost: Partial<Record<ResourceKind, number>> }[] = [];
  // Pull from vessels catalog. We only need cost — purchaseVesselAtPort
  // handles slot allocation, ownership, etc.
  // Hardcoded subset rather than reaching into vessels.ts to avoid the
  // extra import dependency; pick a small, sensible roster.
  const NAVAL = [
    { defKey: "raft",          cost: { wood: 20 } as Partial<Record<ResourceKind, number>> },
    { defKey: "ship_birch",    cost: { wood: 80,  rock: 20 } as Partial<Record<ResourceKind, number>> },
    { defKey: "ship_desert",   cost: { wood: 80,  rock: 20 } as Partial<Record<ResourceKind, number>> },
    { defKey: "ship_forest",   cost: { wood: 80,  rock: 20 } as Partial<Record<ResourceKind, number>> },
    { defKey: "ship_taiga",    cost: { wood: 80,  rock: 20 } as Partial<Record<ResourceKind, number>> },
  ];
  const AERIAL = [
    { defKey: "airship_scout",  cost: { wood: 40, rock: 10, iron: 4 } as Partial<Record<ResourceKind, number>> },
    { defKey: "airship_patrol", cost: { wood: 40, rock: 10, iron: 4 } as Partial<Record<ResourceKind, number>> },
    { defKey: "airship_recon",  cost: { wood: 40, rock: 10, iron: 4 } as Partial<Record<ResourceKind, number>> },
    { defKey: "airship_cargo",  cost: { wood: 60, rock: 20, iron: 6 } as Partial<Record<ResourceKind, number>> },
  ];
  if (isAirshipPort) candidates.push(...AERIAL);
  else candidates.push(...NAVAL);
  // Shuffle in-place for variety.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const bot = state.players[botId];
  for (const c of candidates) {
    let canAfford = true;
    for (const k in c.cost) {
      const need = c.cost[k as ResourceKind] ?? 0;
      if (bot.resources[k as ResourceKind] < need) { canAfford = false; break; }
    }
    if (!canAfford) continue;
    const v = purchaseVesselAtPort(state, botId, port.id, c.defKey);
    if (v) {
      for (const k in c.cost) {
        bot.resources[k as ResourceKind] -= c.cost[k as ResourceKind] ?? 0;
      }
      return;
    }
  }
}

/** Per-tribe building cap. Stops the AI from spamming any single
 *  catalog entry. Unlisted keys fall back to BOT_BUILD_CAP_DEFAULT. */
const BOT_BUILD_CAP_DEFAULT = 3;
const BOT_BUILD_CAPS: Record<string, number> = {
  campfire: 1,
  workbench: 2,
  wood_chop: 4,
  wood_stack: 3,
  stonebench: 3,
  meat_prep: 2,
  hide_prep: 2,
  tent: 6,
  thatch_building: 5,
  birch_hut: 5,
  desert_hut: 5,
  thatch_outpost: 4,
  desert_outpost: 4,
  thatch_cabin: 4,
  cabin: 5,
  large_cabin: 3,
  medival_tower: 3,
  trebuchet: 4,
  shallow_water_hut: 2,
  // Mid-game production buildings — were defaulting to 2; bumped so
  // bots that build their first mill don't immediately cap out on
  // duplicates and stop diversifying.
  windmill: 3, woodmill: 3, wheatmill: 2, stonemill: 2, bakery: 2, waterwheel: 2,
  // Ports — one per kind. Only the matching biome variant is reachable
  // for any given tribe anyway, but cap the rest at 1 each just so the
  // map filter doesn't need to special-case the style gate.
  port_birch: 1, port_desert: 1, port_thatch: 1, port_cabin: 1,
  airship_port_birch: 1, airship_port_desert: 1, airship_port_thatch: 1, airship_port_cabin: 1,
};

/** Per-tick trebuchet pass. Each trebuchet rolls a small chance to hit
 *  one of the enemy flying airships marked `canBeShotDown`. Flying
 *  vessels currently have no world position (they're "somewhere in the
 *  air"), so a hit is resolved as a probability per trebuchet per tick
 *  rather than a spatial intersection. Once the airship model gets a
 *  position, swap the `Math.random() < hitChance` for a real range
 *  check using TREBUCHET_RANGE. */
const TREBUCHET_HIT_CHANCE_PER_TICK = 0.005; // ≈ 1 hit every 200 ticks (20 s)
function stepTrebuchets(state: GameState): void {
  // Tally trebuchet count per player so we know how many shots fire.
  const treb = new Map<number, number>();
  for (const s of state.structures) {
    if (s.defKey !== "trebuchet") continue;
    if ((s.buildProgress ?? 1) < 1) continue;     // half-built trebs don't fire
    treb.set(s.ownerId, (treb.get(s.ownerId) ?? 0) + 1);
  }
  if (treb.size === 0) return;
  for (const v of state.vessels) {
    if (v.status !== "flying") continue;
    const def = getVesselDef(v.defKey);
    if (!def?.canBeShotDown) continue;
    for (const [shooterId, count] of treb) {
      if (shooterId === v.ownerId) continue;
      if (getRelation(state, shooterId, v.ownerId) === RELATION_ALLY) continue;
      // n trebuchets each get an independent hit roll.
      let hit = false;
      for (let i = 0; i < count; i++) {
        if (Math.random() < TREBUCHET_HIT_CHANCE_PER_TICK) { hit = true; break; }
      }
      if (hit) {
        shootDownVessel(state, v.id);
        break;
      }
    }
  }
}

// ----------------------------------------------------------------------
// Active volcanoes — periodically launch flying debris that lands as a
// crater prop. Active volcanoes are stamped at worldgen (~55% of cones)
// by swapping the sprite to vulcano_active(_snowy). The engine just
// scans world.props for those sprites each tick.
// ----------------------------------------------------------------------
/** Eruption pacing — user wants roughly 1 debris piece per 10 in-game
 *  minutes per active cone. 10 min × 60 s × 10 ticks/s = 6000 ticks,
 *  but eruptions only fire at night (~46 % of ticks), so the per-tick
 *  chance comes out to 1 / (6000 × 0.46) ≈ 0.00036. Per-launch piece
 *  count dropped to 1 because each landing is now a major set-piece. */
const VULCANO_LAUNCH_CHANCE_PER_TICK = 0.00036;
const VULCANO_DEBRIS_PER_LAUNCH_MIN = 1;
const VULCANO_DEBRIS_PER_LAUNCH_MAX = 1;
/** Ticks before a fresh crater "cools" and becomes a mineable uranium
 *  prop. ~6 minutes at tickMs=100. Volcanic props (crater + cooled)
 *  are added to state.volcanicProps so the daily respawn skips them — the
 *  user's rule: "vulcano based resources dont regenreate daily only
 *  when vulcano shoots newones". */
const VULCANO_CRATER_COOLDOWN_TICKS = 3600;
const VULCANO_COOLED_SPRITES = ["uranium_cooled1", "uranium_cooled2", "uranium_cooled3", "uranium_cooled_rock", "uranium_cooled_spire"];
/** Distance (in tiles) a single piece of debris travels from the cone.
 *  Picked uniformly per piece so impacts ring the volcano at varied
 *  range. Slightly skewed inward — closer impacts read better visually. */
const VULCANO_DEBRIS_REACH_MIN = 300;
const VULCANO_DEBRIS_REACH_MAX = 1200;
/** Flight duration in ticks. 24 ticks at tickMs=100 = 2.4 s — long enough
 *  for the player to track the arc, short enough that craters drop in a
 *  steady rhythm. */
const VULCANO_DEBRIS_FLIGHT_TICKS = 24;
const VULCANO_DEBRIS_PEAK_HEIGHT = 32;
const VULCANO_CRATER_SPRITES = ["vulcano_crater1", "vulcano_crater2", "vulcano_crater3", "vulcano_crater4", "vulcano_crater5"];
const VULCANO_DEBRIS_SPRITES = ["magma_rock1", "magma_rock2", "magma_rock3"];

/** Volcanoes only erupt at night — moon-up only, per the user's spec. */
function isNight(state: GameState): boolean {
  const t = (((performance.now() - state.startedAtMs) / DAY_LENGTH_MS) % 1 + 1) % 1;
  // Same curve the renderer uses: darkness = (1 - cos(2π·t)) / 2.
  const darkness = (1 - Math.cos(t * Math.PI * 2)) / 2;
  return darkness > 0.55;
}

/** Per-day chance any given INACTIVE volcano wakes up. When triggered,
 *  the cone stays active for ~1 in-game week (7 day rollovers). */
const VULCANO_ACTIVATE_CHANCE_PER_DAY = 0.1;
const VULCANO_ACTIVE_DAYS = 7;

function stepVulcanoActivationRollover(state: GameState): void {
  const w = state.world;
  if (!state.vulcanoDeactivateOnDay) state.vulcanoDeactivateOnDay = {};
  // 1. Deactivate any volcano whose week is up.
  for (const k in state.vulcanoDeactivateOnDay) {
    const propIdx = +k;
    const deactivateDay = state.vulcanoDeactivateOnDay[k];
    if (state.dayIndex >= deactivateDay) {
      const p = w.props[propIdx];
      if (p) {
        p.sprite = p.sprite === "vulcano_active_snowy" ? "vulcano_inactive_snowy" : "vulcano_inactive";
        dirtyMarkProp(state, p);
      }
      delete state.vulcanoDeactivateOnDay[k];
    }
  }
  // 2. Roll activation for each inactive volcano.
  for (let i = 0; i < w.props.length; i++) {
    const p = w.props[i];
    if (p.sprite !== "vulcano_inactive" && p.sprite !== "vulcano_inactive_snowy") continue;
    if (Math.random() >= VULCANO_ACTIVATE_CHANCE_PER_DAY) continue;
    p.sprite = p.sprite === "vulcano_inactive_snowy" ? "vulcano_active_snowy" : "vulcano_active";
    state.vulcanoDeactivateOnDay[i] = state.dayIndex + VULCANO_ACTIVE_DAYS;
    dirtyMarkProp(state, p);
  }
}

function dirtyMarkProp(state: GameState, p: { x: number; y: number; size: number }): void {
  const w = state.world;
  const x0 = Math.max(0, Math.floor(p.x - p.size));
  const x1 = Math.min(w.width - 1, Math.ceil(p.x + p.size));
  const y0 = Math.max(0, Math.floor(p.y - p.size));
  const y1 = Math.min(w.height - 1, Math.ceil(p.y + p.size));
  for (let y = y0; y <= y1; y++) {
    const base = y * w.width;
    for (let x = x0; x <= x1; x++) state.dirtyTiles.add(base + x);
  }
}

/** Force every logically-active volcano's sprite to match the current
 *  day/night phase. Cheap — iterates only the deactivate-day map (a
 *  handful of entries at most). Exported so App.tsx can call it once
 *  during loading so the very first rendered frame already shows the
 *  correct daytime sprite, instead of flashing "active" for the few
 *  ticks before stepVulcanos catches up. */
export function syncVulcanoSprites(state: GameState): void {
  const w = state.world;
  const night = isNight(state);
  const map = state.vulcanoDeactivateOnDay ?? {};
  for (const k in map) {
    const propIdx = +k;
    const p = w.props[propIdx];
    if (!p) continue;
    const snowy = p.sprite.endsWith("_snowy");
    const wantSprite = night
      ? (snowy ? "vulcano_active_snowy" : "vulcano_active")
      : (snowy ? "vulcano_inactive_snowy" : "vulcano_inactive");
    if (p.sprite !== wantSprite) {
      p.sprite = wantSprite;
      dirtyMarkProp(state, p);
    }
  }
}

/**
 * Per-tick water-flow simulation across player-dug holes.
 *
 * Two flow sources for each hole tile:
 *   1. Natural Sea neighbour — infinite source. Water is drawn from the
 *      ocean toward this tile until the tile's water surface matches sea
 *      level (= 0 in the elevation convention where land = 0 and a tile
 *      with `holeDepth=D` has its bottom at `-D`). Capped per tick by
 *      SEA_INFLOW_RATE so a fresh channel doesn't instantly slam the
 *      reservoir full — the player sees the water trickle through.
 *   2. Adjacent Hole neighbour — finite reservoir. Water transfers from
 *      the neighbour with the higher surface elevation toward the one
 *      with the lower, by a fraction (FLOW_RATE) of the surface
 *      difference per tick. Total water is conserved here, so a player-
 *      dug pond that's been cut off from the sea will only ever hold
 *      what flowed in — exactly the "fill the middle first" reservoir
 *      behaviour the user asked for.
 *
 * Surface elevation of a tile is `waterLevel - holeDepth` (always ≤ 0
 * for holes, exactly 0 for natural Sea). Two tiles with the same surface
 * are in equilibrium — no flow happens between them. Water naturally
 * pools in the deepest cell of a connected component because shallow
 * cells reach surface = 0 (their max waterLevel = holeDepth) first and
 * stop accepting flow, while the deep cell can still rise.
 *
 * Optimisations vs. the v1 simulation:
 *   - Runs every-other tick. Flow rates are doubled so the visible fill
 *     speed matches what the v1 per-tick loop produced.
 *   - Iterates `state.activeWaterTiles` (subset of holeTiles) instead of
 *     every dug tile. Dry inland pits with no Sea neighbour pay nothing.
 *   - When a hole tile fills to capacity, the tile is PROMOTED to
 *     TileKind.Sea (terrain modification — the natural ocean visibly
 *     extends into the dug area). The tile drops out of holeTiles, so a
 *     reservoir filling collapses the simulation set as it floods. The
 *     four orthogonal neighbours wake up so the flood front propagates.
 */
const WATER_FLOW_TICK_INTERVAL = 2;
function stepWaterFlow(state: GameState): void {
  if (state.tick % WATER_FLOW_TICK_INTERVAL !== 0) return;
  // Refresh the per-body classification (sea-connected vs isolated)
  // BEFORE the per-tile loop so the cellular flow can skip isolated
  // tiles cleanly. Rebuild only when something changed — paintHole,
  // paintFill, commitShovelStroke, or the flood-to-Sea path below.
  if (state.waterBodiesDirty) recomputeWaterBodies(state);
  const active = state.activeWaterTiles;
  const isolated = state.isolatedHoleTiles;
  const w = state.world;
  const W = w.width;
  const H = w.height;
  // Rates are 2× v1 because we only run every other tick.
  const SEA_INFLOW_RATE = 0.70;
  const REPAINT_THRESHOLD = 0.05;
  const FLOOD_EPS = 0.05;
  void active; void isolated;        // legacy refs kept for waterBodiesDirty trigger semantics
  // === PASS 1 (sea-connected): volume-conservation redistribute ===
  // Each sea-connected body draws SEA_INFLOW_RATE per sea-edge tile
  // per cycle into a per-body volume reservoir, then settles every
  // tile to a common surface elevation via binary-search. The deepest
  // tile fills first because its surface = water - depth is the most
  // negative, so the equilibrium surface drives water into it before
  // shallower tiles see any rise. Tiles that reach capacity in the
  // settle are promoted to natural Sea so the dug area visibly merges
  // with the ocean.
  const seaBodies = state.seaConnectedBodies;
  if (seaBodies && seaBodies.length > 0) {
    for (const body of seaBodies) {
      if (body.tiles.length === 0) continue;
      let V = 0;
      for (const idx of body.tiles) V += w.waterLevel[idx];
      // Add this cycle's inflow, capped at the body's total capacity.
      const inflow = body.seaEdgeCount * SEA_INFLOW_RATE;
      V = Math.min(body.capacity, V + inflow);
      if (V <= 0.001) continue;
      // Binary-search the surface elevation h such that
      //   sum_t clamp(h + depth_t, 0, depth_t) === V
      let maxDepth = 0;
      for (const idx of body.tiles) {
        const d = w.holeDepth[idx];
        if (d > maxDepth) maxDepth = d;
      }
      let lo = -maxDepth, hi = 0;
      for (let iter = 0; iter < 25; iter++) {
        const h = (lo + hi) * 0.5;
        let v = 0;
        for (const idx of body.tiles) {
          const d = w.holeDepth[idx];
          const wt = h + d;
          v += wt < 0 ? 0 : (wt > d ? d : wt);
        }
        if (v < V) lo = h; else hi = h;
      }
      const h = (lo + hi) * 0.5;
      // Apply the settled levels + flood any tile that hit its cap.
      for (const idx of body.tiles) {
        const d = w.holeDepth[idx];
        const wt = h + d;
        let newLevel = wt < 0 ? 0 : (wt > d ? d : wt);
        const prev = w.waterLevel[idx];
        if (newLevel >= d - FLOOD_EPS) {
          // Promote to Sea: the dug pit fully fills and merges with the
          // ocean. The body topology changes so we re-tag for the next
          // cycle to rebuild.
          w.kind[idx] = TileKind.Sea;
          w.holeDepth[idx] = 0;
          w.waterLevel[idx] = 0;
          w.coastDist[idx] = 1;
          w.riverMask[idx] = 0;
          state.holeTiles?.delete(idx);
          active?.delete(idx);
          state.waterBodiesDirty = true;
          state.dirtyTiles.add(idx);
          continue;
        }
        if (Math.abs(newLevel - prev) > REPAINT_THRESHOLD) {
          state.dirtyTiles.add(idx);
        }
        w.waterLevel[idx] = newLevel;
      }
    }
  }
  // === PASS 2: volume-conserving redistribute for isolated bodies ===
  // For each finite reservoir, settle water to a common surface
  // elevation. Binary-search the elevation h such that
  //   sum_t clamp(h + depth_t, 0, depth_t) == totalVolume
  // then write each tile's waterLevel = clamp(h + depth_t, 0, depth_t).
  // This is the user-asked "fill the deep part first" behaviour AND
  // conserves exact volume across the cycle (no cellular drift). The
  // shallow-→-deep cascade (small reservoir feeds big pit, deep tile
  // partially fills without the shallow filling fully) emerges from
  // this naturally.
  const bodies = state.isolatedBodies;
  if (bodies && bodies.length > 0) {
    for (const body of bodies) {
      if (body.tiles.length === 0) continue;
      // Total volume = current sum of waterLevels in body. The previous
      // cycle's value carries through here, so a body that was just
      // disconnected from the sea keeps whatever water it had.
      let V = 0;
      for (const idx of body.tiles) V += w.waterLevel[idx];
      if (V <= 0.001) {
        // Body is fully dry — make sure all tiles read 0 and skip the
        // binary search. Common case for a freshly-dug isolated pit.
        for (const idx of body.tiles) {
          if (w.waterLevel[idx] !== 0) {
            w.waterLevel[idx] = 0;
            state.dirtyTiles.add(idx);
          }
        }
        continue;
      }
      // Binary search for the equilibrium surface elevation h. Surface
      // ranges from -maxDepth (everything dry) to 0 (filled to brim).
      let maxDepth = 0;
      for (const idx of body.tiles) {
        const d = w.holeDepth[idx];
        if (d > maxDepth) maxDepth = d;
      }
      let lo = -maxDepth, hi = 0;
      for (let iter = 0; iter < 25; iter++) {
        const h = (lo + hi) * 0.5;
        let v = 0;
        for (const idx of body.tiles) {
          const d = w.holeDepth[idx];
          const w_t = h + d;
          v += w_t < 0 ? 0 : (w_t > d ? d : w_t);
        }
        if (v < V) lo = h; else hi = h;
      }
      const h = (lo + hi) * 0.5;
      for (const idx of body.tiles) {
        const d = w.holeDepth[idx];
        const w_t = h + d;
        const newLevel = w_t < 0 ? 0 : (w_t > d ? d : w_t);
        const prev = w.waterLevel[idx];
        if (Math.abs(newLevel - prev) > REPAINT_THRESHOLD) {
          state.dirtyTiles.add(idx);
        }
        w.waterLevel[idx] = newLevel;
      }
    }
  }

  // === Prop destruction sweep ===
  // Any non-stone prop (foliage, treestumps, berries, ore) sitting on a
  // tile that's currently underwater gets killed. Runs once per flow
  // cycle so the cost is bounded; killProp is idempotent if the prop
  // was already dying. Rocks / mesa / volcanoes survive — they read as
  // terrain features and the renderer keeps them visible.
  killSubmergedProps(state);
}

function killSubmergedProps(state: GameState): void {
  const w = state.world;
  const W = w.width;
  const H = w.height;
  const props = w.props;
  for (let i = 0; i < props.length; i++) {
    if (state.harvestedProps.has(i)) continue;
    if (state.dyingProps?.has(i)) continue;
    const p = props[i];
    const sp = p.sprite;
    // Rock / mesa / volcano / ore-deposit / berry-rock survive water —
    // they're terrain features. Everything else (trees, bushes,
    // treestumps placed as bridges, etc.) goes when it gets touched.
    if (sp.startsWith("rock_") || sp.startsWith("rocksnowy_")
        || sp.startsWith("mesa_") || sp.startsWith("vulcano")
        || sp.startsWith("iron_") || sp.startsWith("gold_")
        || sp.startsWith("diamond_") || sp.startsWith("uranium_")
        || sp.startsWith("redberry_") || sp.startsWith("blueberry_")
        || sp.startsWith("yellowberry_")) continue;
    const tx = p.x | 0;
    const ty = p.y | 0;
    if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
    const idx = ty * W + tx;
    const k = w.kind[idx];
    if (k === TileKind.Sea) {
      killProp(state, i);
      continue;
    }
    if (k === TileKind.Hole && w.waterLevel[idx] > 0.4) {
      killProp(state, i);
      continue;
    }
    // Treestumps sit on Land (tryBridgeIfPossible converts the Sea tile
    // it bridges into Land). They still count as "touched by water" if
    // any orthogonal neighbour is Sea or a half-flooded Hole — the user
    // explicitly asked for water to wash bridge stumps away.
    if (sp === "treetump") {
      const nbs = [
        tx > 0       ? idx - 1 : -1,
        tx < W - 1   ? idx + 1 : -1,
        ty > 0       ? idx - W : -1,
        ty < H - 1   ? idx + W : -1,
      ];
      for (const n of nbs) {
        if (n < 0) continue;
        const nk = w.kind[n];
        if (nk === TileKind.Sea
            || (nk === TileKind.Hole && w.waterLevel[n] > 0.4)) {
          killProp(state, i);
          break;
        }
      }
    }
  }
}

/**
 * Progress prop-death animations. Any prop in state.dyingProps whose
 * animation has elapsed `PROP_DEATH_TICKS` ticks is committed to
 * harvestedProps and the chunks covering its bbox get dirty-marked so
 * the chunk repaint drops the sprite (or swaps to a stump). Renderer
 * overlays handle the per-frame flip + fade while the entry sits in
 * dyingProps.
 */
function stepPropDeaths(state: GameState): void {
  const dying = state.dyingProps;
  if (!dying || dying.size === 0) return;
  const w = state.world;
  const W = w.width;
  for (const [propIdx, startTick] of dying) {
    if (state.tick - startTick < PROP_DEATH_TICKS) continue;
    dying.delete(propIdx);
    state.harvestedProps.add(propIdx);
    const p = w.props[propIdx];
    if (!p) continue;
    const x0 = Math.max(0, Math.floor(p.x - p.size));
    const x1 = Math.min(w.width - 1, Math.ceil(p.x + p.size));
    const y0 = Math.max(0, Math.floor(p.y - p.size));
    const y1 = Math.min(w.height - 1, Math.ceil(p.y + p.size));
    for (let y = y0; y <= y1; y++) {
      const base = y * W;
      for (let x = x0; x <= x1; x++) state.dirtyTiles.add(base + x);
    }
  }
}

function stepVulcanos(state: GameState): void {
  const w = state.world;
  if (!state.debris) { state.debris = []; state.nextDebrisId = 1; }
  if (!state.craterCoolAt) state.craterCoolAt = {};
  if (!state.volcanicProps) state.volcanicProps = new Set();

  // A) Sprite-sync — volcanoes are "logically active" if their propIdx
  //    is in vulcanoDeactivateOnDay. At night they show the active
  //    sprite, during the day the inactive one. The map is tiny (≤ a
  //    few dozen entries) so we run this EVERY tick — the previous
  //    "every 5 ticks" cadence meant freshly-spawned worlds spent the
  //    first 500 ms with worldgen-active sprites still visible during
  //    the day. Cheap enough to run inline.
  syncVulcanoSprites(state);

  // B) Crater cooldown — fresh craters become mineable uranium props
  //    after VULCANO_CRATER_COOLDOWN_TICKS. Volcanic props (crater +
  //    cooled uranium) are tracked in state.volcanicProps so the
  //    daily respawn step skips them (volcano-spawned resources only
  //    regenerate when a new eruption fires).
  for (const k in state.craterCoolAt) {
    const propIdx = +k;
    const coolAt = state.craterCoolAt[k];
    if (state.tick < coolAt) continue;
    const p = w.props[propIdx];
    if (p) {
      p.sprite = VULCANO_COOLED_SPRITES[(Math.random() * VULCANO_COOLED_SPRITES.length) | 0];
      dirtyMarkProp(state, p);
      state.volcanicProps.add(propIdx);
    }
    delete state.craterCoolAt[k];
  }

  // C) Eruptions only fire at night — daytime cones stay dormant.
  if (!isNight(state)) return;
  for (const p of w.props) {
    if (p.sprite !== "vulcano_active" && p.sprite !== "vulcano_active_snowy") continue;
    if (Math.random() >= VULCANO_LAUNCH_CHANCE_PER_TICK) continue;
    const range = VULCANO_DEBRIS_PER_LAUNCH_MAX - VULCANO_DEBRIS_PER_LAUNCH_MIN + 1;
    const count = VULCANO_DEBRIS_PER_LAUNCH_MIN + ((Math.random() * range) | 0);
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = VULCANO_DEBRIS_REACH_MIN + Math.random() * (VULCANO_DEBRIS_REACH_MAX - VULCANO_DEBRIS_REACH_MIN);
      const tx = p.x + Math.cos(ang) * dist;
      const ty = p.y + Math.sin(ang) * dist;
      if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) continue;
      state.debris.push({
        id: state.nextDebrisId!++,
        startX: p.x, startY: p.y,
        targetX: tx, targetY: ty,
        sprite: VULCANO_DEBRIS_SPRITES[(Math.random() * VULCANO_DEBRIS_SPRITES.length) | 0],
        age: 0,
        flightTicks: VULCANO_DEBRIS_FLIGHT_TICKS,
        peakHeight: VULCANO_DEBRIS_PEAK_HEIGHT,
        landingSprite: VULCANO_CRATER_SPRITES[(Math.random() * VULCANO_CRATER_SPRITES.length) | 0],
        landingSize: 30 + Math.random() * 20, // 5× the old footprint to match the 10× debris scale
      });
    }
  }
  // D) Advance every in-flight debris piece. On landing, stamp a crater
  // prop at the impact tile and remove the debris from the list.
  for (let i = state.debris.length - 1; i >= 0; i--) {
    const d = state.debris[i];
    d.age++;
    if (d.age >= d.flightTicks) {
      const propIdx = w.props.length;
      w.props.push({
        sprite: d.landingSprite,
        x: d.targetX,
        y: d.targetY,
        size: d.landingSize,
      });
      // Mark crater as a volcanic prop + schedule its cooldown so it
      // eventually becomes a mineable uranium variant.
      state.volcanicProps.add(propIdx);
      state.craterCoolAt[propIdx] = state.tick + VULCANO_CRATER_COOLDOWN_TICKS;
      const cx = d.targetX | 0;
      const cy = d.targetY | 0;
      const cs = Math.ceil(d.landingSize);
      const x0 = Math.max(0, cx - cs);
      const x1 = Math.min(w.width - 1, cx + cs);
      const y0 = Math.max(0, cy - cs);
      const y1 = Math.min(w.height - 1, cy + cs);
      for (let y = y0; y <= y1; y++) {
        const base = y * w.width;
        for (let x = x0; x <= x1; x++) state.dirtyTiles.add(base + x);
      }
      // O(1) swap-remove keeps the debris array tight.
      state.debris[i] = state.debris[state.debris.length - 1];
      state.debris.pop();
    }
  }
}

// ----------------------------------------------------------------------
// Build queue — structures need >= buildersNeeded worker villagers in
// range for their buildProgress to advance. Without this every build
// finished the moment buildStructure() returned, making the player's
// resource economy decouple from their villager headcount.
// ----------------------------------------------------------------------
/** Progress added per tick per builder. Tuned so the speed range
 *  reads as "1 builder = really slow but works; 10 builders = fast":
 *    1 worker  → 0.0017 / tick × 10 ticks/sec = 0.017 /sec → ~59 s build
 *    10 workers → 0.017 / tick × 10 ticks/sec = 0.17 /sec → ~6 s build
 *  No hard "needs ≥ N builders" gate — any positive count progresses. */
const BUILD_PROGRESS_PER_WORKER_PER_TICK = 0.0017;
/** Hard ceiling on the number of builders that can contribute to a
 *  single site. Past 10 the rush of villagers stops adding speed —
 *  matches the user-requested "max of 10 people to a build" rule. */
const BUILD_MAX_HELPERS = 10;

function stepBuilds(state: GameState): void {
  // First-pass collect: count workers in range for each unfinished
  // structure. Single O(V × S_unfinished) loop instead of a per-builder
  // distance check — at 1500 villagers × 20 unfinished sites this is
  // 30 k cheap ops per tick (well inside the 100 ms tick budget).
  // Build a small array of unfinished targets first so we don't keep
  // scanning every finished structure inside the villager loop. Cache
  // the per-target effective radius² so big footprints (ports = size 66,
  // airship ports = 66) are reachable: a villager walks to
  // `max(CHOP_REACH, size+4)` from the centre, which for a size-66 port
  // is 70 tiles — well outside the flat BUILD_HELP_RADIUS=30. Scale the
  // radius so it never undercuts the villager's arrival distance.
  // We also stash the explicitly-assigned villagers per target so the
  // completion handler can iterate that tiny list instead of scanning
  // every villager in the world.
  type BuildTarget = {
    s: typeof state.structures[number];
    count: number;
    r2: number;
    assignedBuilders: Villager[];
  };
  const targets: BuildTarget[] = [];
  for (const s of state.structures) {
    if ((s.buildProgress ?? 1) >= 1) continue;
    const reach = Math.max(BUILD_HELP_RADIUS, s.size + CHOP_REACH);
    targets.push({ s, count: 0, r2: reach * reach, assignedBuilders: [] });
  }
  if (targets.length === 0) return;
  // Build a quick id → target map so the per-villager assigned-builder
  // capture is O(1) even with many concurrent sites. Map size matches the
  // unfinished-structure count (typically < 20).
  const byId = new Map<number, BuildTarget>();
  for (const t of targets) byId.set(t.s.id, t);
  for (const v of state.villagers) {
    if ((v.role ?? "worker") !== "worker") continue;
    if (v.insideStructureId !== undefined) continue;
    // Builders count if they're either explicitly assigned (job=building)
    // or just standing in range while idle. The lenient version lets the
    // founding-villager ring help finish the campfire's first add-ons
    // without the player having to click each villager.
    if (v.job !== "building" && v.job !== "walkToBuild" && v.job !== "idle" && v.job !== "moveTo") continue;
    // Fast-path for villagers with an explicit buildTargetId — they're
    // committed to that site (even mid-walk), so no need to test against
    // every other unfinished structure. Captured into the target's
    // assigned-builder list so the completion handler can resume them
    // directly without rescanning the full villager array.
    if (v.buildTargetId !== undefined) {
      const t = byId.get(v.buildTargetId);
      if (t && t.s.ownerId === v.ownerId) {
        const dx = t.s.x - v.x;
        const dy = t.s.y - v.y;
        if (dx * dx + dy * dy <= t.r2) {
          t.count++;
          t.assignedBuilders.push(v);
          continue;
        }
      }
    }
    // No explicit target — fall back to "any unfinished site of mine
    // nearby contributes." First match wins so the loop bails early.
    for (const t of targets) {
      if (t.s.ownerId !== v.ownerId) continue;
      const dx = t.s.x - v.x;
      const dy = t.s.y - v.y;
      if (dx * dx + dy * dy <= t.r2) { t.count++; break; }
    }
  }
  for (const t of targets) {
    // Any positive count progresses the build — even a single villager
    // can finish a structure, just slowly. The cap on `effective` is
    // BUILD_MAX_HELPERS (10) so beyond that workers are wasted; the
    // structure's own `buildersNeeded` field is still useful for
    // dispatch logic (auto-assign target count) but no longer gates
    // progress.
    if (t.count === 0) continue;
    const effective = Math.min(t.count, BUILD_MAX_HELPERS);
    t.s.buildProgress = Math.min(1, (t.s.buildProgress ?? 0)
      + BUILD_PROGRESS_PER_WORKER_PER_TICK * effective);
    if (t.s.buildProgress >= 1) {
      // Building completed this tick. Iterate ONLY the villagers who
      // were on it (captured above) instead of the whole villager
      // array — at 1500 villagers × frequent build completions this
      // turns into a dominant cost. The list is typically 3-6 entries.
      for (const v of t.assignedBuilders) {
        v.buildTargetId = undefined;
        v.rot = 0;
        if (!advanceBuildQueue(state, v)) {
          // resumeAfterBuild puts them back on their prior task if
          // we snapshotted one; otherwise they go idle.
          const r = v.resumeJob;
          if (r) {
            v.job = r;
            v.targetX = v.resumeTargetX ?? v.x;
            v.targetY = v.resumeTargetY ?? v.y;
            v.patchX = v.resumePatchX ?? v.x;
            v.patchY = v.resumePatchY ?? v.y;
            v.harvestType = v.resumeHarvestType;
            v.resumeJob = undefined;
            v.resumeTargetX = undefined;
            v.resumeTargetY = undefined;
            v.resumePatchX = undefined;
            v.resumePatchY = undefined;
            v.resumeHarvestType = undefined;
          } else {
            v.job = "idle";
          }
        }
      }
    }
  }
}

// ----------------------------------------------------------------------
// Auto-assist — idle worker villagers automatically gravitate to the
// nearest friendly unfinished structure within a short range. Saves the
// player from having to manually order every villager to a build site,
// and gives bots a free dispatch lane without extra AI bookkeeping.
// ----------------------------------------------------------------------
/** Max range (tiles) a villager will walk on their own to help a build. */
const AUTO_ASSIST_RANGE = 220;
/** Re-evaluate the auto-assist lane every N ticks per villager. Higher
 *  = less CPU, lower = snappier dispatch. 24 ticks ≈ 2.4 s at tickMs=100. */
const AUTO_ASSIST_EVERY = 24;

// ----------------------------------------------------------------------
// Human auto-spawn — every human player gets a passive +1 villager every
// HUMAN_SPAWN_EVERY ticks as long as they're under their population cap.
// Bots run a similar lane inside botAct(); the human lane was missing,
// which left the human stuck at their founding 4 + 3 wood-unlock
// specialists forever. The cap is unchanged — build more huts / outposts /
// ports to raise it. The "Spawn Villager" button (App.tsx) bypasses the
// cadence so the player can force a burst anytime under cap.
// ----------------------------------------------------------------------
const HUMAN_SPAWN_EVERY = 40;       // ~4s at tickMs=100
function stepHumanSpawn(state: GameState): void {
  if (state.tick % HUMAN_SPAWN_EVERY !== 0) return;
  for (let pid = 0; pid < state.players.length; pid++) {
    const p = state.players[pid];
    if (!p || !p.alive || !p.isHuman) continue;
    if (!canSpawnVillager(state, pid)) continue;
    const home = findHomeTent(state, pid);
    if (!home) continue;
    const ang = Math.random() * Math.PI * 2;
    const rad = 10 + Math.random() * 8;
    spawnVillagerAtHome(state, pid, home.x + Math.cos(ang) * rad, home.y + Math.sin(ang) * rad);
  }
}

// ----------------------------------------------------------------------
// Human auto-expand — once every house has chopped clean a 250-tile
// radius, the next house gets dropped automatically toward the nearest
// fresh resource. Still paid out of the tribe's stockpile and still has
// to be built up by villagers (uses the normal autoDispatchBuilders
// kickoff inside buildStructure) — this just queues the placement so the
// player doesn't have to micro-frontier expansion themselves.
// ----------------------------------------------------------------------
const HUMAN_EXPAND_EVERY = 200;          // ~20s — slow lane, not a tight loop
const HUMAN_EXPAND_SEARCH_RADIUS = 250;  // "still has resources" threshold
const HUMAN_EXPAND_PROBE_RADIUS = 1500;  // farthest we look for a fresh patch
const HUMAN_EXPAND_PROBE_STEP = 60;      // tiles past the frontier to plant the hut
function isHarvestablePropSprite(sp: string): boolean {
  return sp.startsWith("tree_") || sp.startsWith("rock_")
      || sp.startsWith("iron_") || sp.startsWith("gold_")
      || sp.startsWith("diamond_") || sp.startsWith("uranium_")
      || sp.startsWith("redberry_") || sp.startsWith("blueberry_")
      || sp.startsWith("yellowberry_")
      || sp.startsWith("mesa_rock") || sp.startsWith("mesa_spire")
      || sp.startsWith("rocksnowy_");
}
function stepHumanAutoExpand(state: GameState): void {
  if (state.tick % HUMAN_EXPAND_EVERY !== 0) return;
  const w = state.world;
  for (let pid = 0; pid < state.players.length; pid++) {
    const p = state.players[pid];
    if (!p || !p.alive || !p.isHuman) continue;

    // Outer layer = every shelter the player owns (has popCap > 0). If
    // any one shelter still sees a harvestable prop within 250 tiles the
    // tribe isn't starved yet.
    const ownShelters: typeof state.structures = [];
    for (const s of state.structures) {
      if (s.ownerId !== pid) continue;
      const def = getBuildingDef(s.defKey);
      if (!def || (def.popCap ?? 0) <= 0) continue;
      ownShelters.push(s);
    }
    if (ownShelters.length === 0) continue;

    const searchR2 = HUMAN_EXPAND_SEARCH_RADIUS * HUMAN_EXPAND_SEARCH_RADIUS;
    let starved = true;
    for (let i = 0; i < w.props.length && starved; i++) {
      if (state.harvestedProps.has(i)) continue;
      if (!isHarvestablePropSprite(w.props[i].sprite)) continue;
      for (const sh of ownShelters) {
        const dx = w.props[i].x - sh.x;
        const dy = w.props[i].y - sh.y;
        if (dx * dx + dy * dy <= searchR2) { starved = false; break; }
      }
    }
    if (!starved) continue;

    // Find the nearest harvestable prop OUTSIDE the search zone — that
    // direction is where the frontier needs to push.
    let bestIdx = -1;
    let bestD2 = HUMAN_EXPAND_PROBE_RADIUS * HUMAN_EXPAND_PROBE_RADIUS;
    let bestSh: typeof state.structures[number] | null = null;
    for (let i = 0; i < w.props.length; i++) {
      if (state.harvestedProps.has(i)) continue;
      if (!isHarvestablePropSprite(w.props[i].sprite)) continue;
      for (const sh of ownShelters) {
        const dx = w.props[i].x - sh.x;
        const dy = w.props[i].y - sh.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; bestSh = sh; }
      }
    }
    if (bestIdx < 0 || !bestSh) continue;

    const prop = w.props[bestIdx];
    const dx = prop.x - bestSh.x;
    const dy = prop.y - bestSh.y;
    const d = Math.hypot(dx, dy) || 1;
    const px = bestSh.x + (dx / d) * (HUMAN_EXPAND_SEARCH_RADIUS + HUMAN_EXPAND_PROBE_STEP);
    const py = bestSh.y + (dy / d) * (HUMAN_EXPAND_SEARCH_RADIUS + HUMAN_EXPAND_PROBE_STEP);
    const hutKey = pickCheapestAvailableShelter(state, pid);
    if (!hutKey) continue;
    buildStructure(state, pid, hutKey, px, py);
  }
}

function pickCheapestAvailableShelter(state: GameState, playerId: number): string | null {
  const p = state.players[playerId];
  if (!p) return null;
  let best: { key: string; cost: number } | null = null;
  for (const def of BUILDINGS) {
    if (def.category !== "shelter") continue;
    if ((def.popCap ?? 0) <= 0) continue;
    if (def.era > state.era) continue;
    if (def.styles && def.styles.length > 0
        && !def.styles.some((s) => p.originStyles.includes(s))) continue;
    const cost = (def.cost.wood ?? 0) + (def.cost.rock ?? 0) * 2 + (def.cost.iron ?? 0) * 5;
    if (!best || cost < best.cost) best = { key: def.key, cost };
  }
  return best ? best.key : null;
}

function stepAutoAssist(state: GameState): void {
  // Bots-only. The user wants idle HUMAN villagers to wait for orders —
  // the manual Auto-Assign button (autoAssignIdleWorkers) takes the
  // human's batch. Bots still need this background loop to keep their
  // economies running without their own UI.
  for (const v of state.villagers) {
    if (v.job !== "idle") continue;
    if ((v.role ?? "worker") !== "worker") continue;
    if (v.insideStructureId !== undefined) continue;
    if (state.players[v.ownerId]?.isHuman) continue;
    if ((state.tick + v.id) % AUTO_ASSIST_EVERY !== 0) continue;
    const target = findClosestUnfinishedOwnStructure(state, v.ownerId, v.x, v.y);
    if (target) {
      const dx = target.x - v.x;
      const dy = target.y - v.y;
      if (dx * dx + dy * dy <= AUTO_ASSIST_RANGE * AUTO_ASSIST_RANGE) {
        assignBuildHelp(state, v.id, target.id, "auto");
        continue;
      }
    }
    if (assignFertilize(state, v.ownerId, "auto")) continue;
    const home = findHomeTent(state, v.ownerId);
    if (!home) continue;
    assignTreeChop(state, v.ownerId, home.x, home.y, "auto");
  }
}

// ----------------------------------------------------------------------
// Auto-combat — every villager (worker / guard / army alike) scans for
// the closest enemy villager within VILLAGER_ATTACK_RANGE and kills them
// on a per-weapon cooldown. Enemies = villagers belonging to a player
// with whom the current player is at WAR or NEUTRAL. ALLY and TRUCE are
// non-belligerent and skipped.
//
// The user requested "attack everything/player /bots around itself if
// they get within 50 pixels". 50 tiles in world coords ≈ the 50px
// playspace expression — we use tile-distance since that's how the
// engine reasons about space everywhere else.
// ----------------------------------------------------------------------
export const VILLAGER_ATTACK_RANGE = 50;

/** Per-weapon cooldown in ticks between auto-attacks. Spear is the
 *  flagship melee weapon and ticks fastest; the bow / sling are slow
 *  ranged sidearms so workers don't accidentally out-DPS dedicated
 *  combatants. Numbers tuned at tickMs=100 → seconds = ticks / 10. */
const WEAPON_COOLDOWN_TICKS: Record<VillagerWeapon, number> = {
  spear: 18,    // ~1.8 s — fast melee
  club:  22,    // ~2.2 s — solid bash
  torch: 28,    // ~2.8 s — set-fire sweep
  sling: 38,    // ~3.8 s — ranged but slow
  bow:   46,    // ~4.6 s — fallback weapon for workers
};

/** Per-weapon kill chance per attack. Workers carrying bows fire often
 *  enough to be a nuisance but rarely actually kill — the player has
 *  to invest in spears (= promote villagers) to mount real defence. */
const WEAPON_KILL_CHANCE: Record<VillagerWeapon, number> = {
  spear: 1.0,
  club:  0.9,
  torch: 0.85,
  sling: 0.7,
  bow:   0.5,
};

/** Spatial grid cell size for the combat scan. Built once per tick to
 *  cut the inner enemy-search from O(V) per attacker to O(cell-occupants).
 *  Sized just larger than the attack range so each attacker only needs
 *  to check the 9 cells covering its 50-tile reach (instead of the full
 *  state.villagers array). */
const COMBAT_GRID_CELL = 64;
function stepCombat(state: GameState): void {
  if (state.villagers.length === 0) return;
  // Build a spatial hash keyed by (cellX, cellY) → villager indices.
  const grid = new Map<number, number[]>();
  const CELL = COMBAT_GRID_CELL;
  for (let i = 0; i < state.villagers.length; i++) {
    const v = state.villagers[i];
    if (v.insideStructureId !== undefined) continue;
    const cx = (v.x / CELL) | 0;
    const cy = (v.y / CELL) | 0;
    const key = cx * 100000 + cy;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const r = VILLAGER_ATTACK_RANGE;
  const r2 = r * r;
  const tick = state.tick;
  // Track kills here and apply at end so we don't mutate the array
  // mid-iteration (and so a single victim isn't double-killed in one
  // tick by two attackers).
  const killSet = new Set<number>();

  for (let i = 0; i < state.villagers.length; i++) {
    if (killSet.has(i)) continue;
    const a = state.villagers[i];
    if (a.insideStructureId !== undefined) continue;
    const cooldown = a.attackCooldown ?? 0;
    if (cooldown > tick) continue;
    const weapon = (a.weapon ?? "bow") as VillagerWeapon;
    const cx = (a.x / CELL) | 0;
    const cy = (a.y / CELL) | 0;

    // Find the closest enemy in the 3×3 cell neighbourhood.
    let bestJ = -1;
    let bestD2 = r2;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const bucket = grid.get((cx + ox) * 100000 + (cy + oy));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi];
          if (j === i) continue;
          if (killSet.has(j)) continue;
          const b = state.villagers[j];
          if (b.ownerId === a.ownerId) continue;
          const rel = getRelation(state, a.ownerId, b.ownerId);
          if (rel === RELATION_ALLY || rel === RELATION_TRUCE) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
        }
      }
    }

    if (bestJ < 0) continue;
    // Reset cooldown regardless of hit/miss so workers don't perma-spam.
    a.attackCooldown = tick + (WEAPON_COOLDOWN_TICKS[weapon] ?? 40);
    // Face the target (small visual cue — uses the chop swing slot).
    const target = state.villagers[bestJ];
    const dx = target.x - a.x;
    a.rot = dx >= 0 ? 0.15 : -0.15;
    if (Math.random() < (WEAPON_KILL_CHANCE[weapon] ?? 0.5)) {
      killSet.add(bestJ);
      // Sneak combat triggers war between the two tribes if they
      // weren't already at war — mirrors launchTribalAttack's policy.
      if (getRelation(state, a.ownerId, target.ownerId) !== RELATION_WAR) {
        // No setRelation here — leave neutral/scuffle relations alone
        // so a one-off worker brawl doesn't auto-escalate every tribe
        // into total war on the same tick. Real war declarations stay
        // gated to the scout / scripted-attack paths.
      }
    }
  }

  if (killSet.size > 0) {
    state.villagers = state.villagers.filter((_, idx) => !killSet.has(idx));
  }
}
