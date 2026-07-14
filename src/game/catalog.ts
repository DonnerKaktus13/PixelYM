import { Era, type ArchStyle, type ResourceMap } from "./types";

/**
 * Catalog of placeable buildings.
 *
 * Each entry maps a stable key (used in `Structure.defKey` on save state)
 * to a sprite name (registered in textures.ts) plus gameplay params.
 *
 * Early-game / tribal entries only for now — medieval + biome-specific
 * variants come in a later phase. The mid-game system will inject
 * additional entries here (e.g. `cabin_forest`, `cabin_taiga`) without
 * having to change anything else.
 */
export interface BuildingDef {
  key: string;
  /** Display label in the build menu. */
  label: string;
  /** Sprite name (registered in textures.ts). */
  sprite: string;
  /** Half-width in tiles — render extent and tribe placement radius. */
  size: number;
  /** Per-resource cost to place. Missing keys treated as 0. */
  cost: ResourceMap;
  /** Per-resource production every tick this building exists. Missing
   *  keys treated as 0 (a pure shelter has no produces entries). */
  produces: ResourceMap;
  /** Earliest era this building is unlocked in. */
  era: Era;
  /** Category — controls grouping in the build menu.
   *   shelter:    Buildings page (basic huts / outposts / cabins)
   *   workbench:  small 8-card crafting page
   *   transport:  ports / trebuchet on the Transport panel
   *   production: mills + shops on the new page-2 production atlas */
  category: "shelter" | "workbench" | "transport" | "production";
  /** Architecture styles that can build this. Empty / omitted = universal
   *  (any tribe). A non-empty list means at least one style here must
   *  appear in the player's `originStyles` for the building to be
   *  available. */
  styles?: ArchStyle[];
  /** If true, this building can only be placed on a beach tile (Land
   *  within 5 tiles of the coast). Used by naval Ports — Airship Ports
   *  do NOT set this and can sit anywhere on land. */
  requiresBeach?: boolean;
  /** If true, this building lives in shallow water (Sea kind within 5
   *  tiles of the coast). Used by the Shallow Water Hut — overrides
   *  the default land-only check in buildStructure so the hut can sit
   *  on sea tiles. */
  requiresShallowWater?: boolean;
  /** How many villagers this building adds to the owner's population
   *  cap. Tents = 2, large outposts = 5, ports = 6, airship ports = 6.
   *  Default 0 (pure workbenches don't house anyone). Sum across every
   *  owned structure (plus per-vessel docked bonuses) = the cap the
   *  player can grow their tribe to. */
  popCap?: number;
  /** Half-width (in tiles) of the building's PLACEMENT footprint. If
   *  unset, defaults to `size`. Used by buildStructure for the two
   *  overlap checks (prop-blocking and structure-spacing) — large
   *  decorative sprites like the port (size 66) ship with ships and
   *  water in their PNG, but the actual building body is much smaller,
   *  so `size: 66, placementSize: 24` lets a port sit on a rocky beach
   *  without the surrounding sprites pushing its footprint past every
   *  rock and tent. The rendered sprite still uses `size`. */
  placementSize?: number;
}

export const BUILDINGS: BuildingDef[] = [
  // --- Tribal-era shelters (thatch / hide / wood). ---
  {
    key: "tent",
    label: "Tent",
    sprite: "b_tent",
    size: 16,
    cost: { rock: 3, wood: 10 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 2,
  },
  {
    key: "thatch_building",
    label: "Thatch Hut",
    sprite: "b_thatch_building",
    size: 20,
    cost: { wood: 12, rock: 3 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 3,
    styles: ["thatch"],
  },
  {
    key: "thatch_outpost",
    label: "Thatch Outpost",
    sprite: "b_thatch_outpost",
    size: 24,
    cost: { wood: 18, rock: 8 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 5,
    styles: ["thatch"],
  },
  {
    key: "birch_hut",
    label: "Birch Hut",
    sprite: "b_birch_hut",
    size: 20,
    cost: { wood: 12, rock: 3 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 3,
    // Wooden hut works for both plains-tribes and forest-tribes in the
    // tribal era. Forest tribes graduate to the proper cabin in medieval.
    styles: ["birch", "cabin"],
  },
  {
    key: "desert_hut",
    label: "Desert Hut",
    sprite: "b_desert_hut",
    size: 20,
    cost: { wood: 12, rock: 3 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 3,
    styles: ["desert"],
  },
  {
    key: "desert_outpost",
    label: "Desert Outpost",
    sprite: "b_desert_outpost",
    size: 24,
    cost: { wood: 18, rock: 8 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    popCap: 5,
    styles: ["desert"],
  },

  // --- Tribal-era workbenches (resource producers). Universal — every
  //     tribe needs an economy regardless of biome aesthetic. ---
  {
    key: "campfire",
    label: "Campfire",
    sprite: "wb_campfire",
    size: 10,
    cost: { wood: 5 },
    produces: { ash: 0.5, leaves: 0.2 },
    era: Era.Tribal,
    category: "workbench",
  },
  {
    key: "workbench",
    label: "Workbench",
    sprite: "wb_workbench",
    size: 10,
    // Cheap entry point. Workbench is also the crafting station for
    // tools (pickaxe / hoe / shovel / spear) — click on a placed one
    // to open the WorkbenchWindow.
    cost: { wood: 5 },
    produces: {},
    era: Era.Tribal,
    category: "workbench",
  },
  // Wood Chop sits BEFORE Stone Bench so it lands one slot left in the
  // workbenches 4×2 grid (column 3 instead of column 4 of row 1) and
  // sits directly above the Wood Stack in row 2.
  {
    key: "wood_chop",
    label: "Wood Chop",
    sprite: "wb_wood_chop",
    size: 10,
    cost: { wood: 14, rock: 5 },
    produces: { wood: 2.2, leaves: 0.4 },
    era: Era.Tribal,
    category: "workbench",
  },
  {
    key: "stonebench",
    label: "Stone Bench",
    sprite: "wb_stonebench",
    size: 10,
    cost: { rock: 14, wood: 10 },
    produces: { rock: 1.8, iron: 0.2 },
    era: Era.Tribal,
    category: "workbench",
  },
  {
    key: "wood_stack",
    label: "Wood Stack",
    sprite: "wb_wood_stack",
    size: 10,
    cost: { wood: 10 },
    produces: { wood: 0.6 },
    era: Era.Tribal,
    category: "workbench",
  },
  {
    key: "meat_prep",
    label: "Meat Prep",
    sprite: "wb_meat_prep",
    size: 10,
    cost: { wood: 14, rock: 5 },
    // The prep station doesn't add to its `produces` map — its income
    // is special-cased in engine.ts: each tick it consumes a chunk of
    // the owning player's `unpreped_meat` and emits the same amount of
    // `meat`. Raw meat sources (rafts + shallow water huts) feed it.
    produces: {},
    era: Era.Tribal,
    category: "workbench",
  },
  {
    key: "hide_prep",
    label: "Hide Prep",
    sprite: "wb_hide_prep",
    size: 10,
    cost: { wood: 14, rock: 5 },
    produces: { leaves: 1.0, mushroom: 0.4 },
    era: Era.Tribal,
    category: "workbench",
  },
  // --- Trebuchet (anti-airship). Tribal-era universal building. Each
  //     trebuchet within TREBUCHET_RANGE tiles of an enemy flying
  //     airship has a per-tick chance to shoot it down; resolution lives
  //     in engine.ts. Counts as transport-class so it sits next to the
  //     ports in the build menu. ---
  {
    key: "trebuchet",
    label: "Trebuchet",
    sprite: "b_trebuchet",
    size: 14,
    cost: { wood: 30, rock: 20, iron: 5 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
  },

  // --- Tribal-era extra shelter variant (thatch tribes only). ---
  {
    key: "thatch_cabin",
    label: "Taiga Cabin",
    sprite: "b_thatch_cabin",
    size: 22,
    cost: { wood: 16, rock: 5 },
    produces: {},
    era: Era.Tribal,
    category: "shelter",
    // No styles → universal, so every tribe (including birch) sees
    // the taiga cabin in their Buildings list per the user's request.
  },

  // --- Medieval-era shelters. Locked behind Era.Medieval until the
  //     game advances; visible in the build book once the era changes.
  //     Cabin variants are biome-locked like their tribal counterparts;
  //     the tower is universal (any tribe can build a fortified lookout). ---
  {
    key: "cabin",
    label: "Cabin",
    sprite: "b_cabin",
    size: 22,
    cost: { wood: 30, rock: 6 },
    produces: {},
    era: Era.Medieval,
    category: "shelter",
    // Birch tribes get cabin / large_cabin too — without this every
    // forest-side feature is locked behind the cabin origin biome and
    // a birch (open-plains) spawn feels strictly worse.
    styles: ["cabin", "birch"],
  },
  {
    key: "large_cabin",
    label: "Large Cabin",
    sprite: "b_large_cabin",
    size: 28,
    cost: { wood: 55, rock: 12 },
    produces: {},
    era: Era.Medieval,
    category: "shelter",
    styles: ["cabin", "birch"],
  },
  {
    key: "medival_tower",
    label: "Tower",
    sprite: "b_medival_tower",
    size: 24,
    cost: { wood: 30, rock: 30, iron: 5 },
    produces: {},
    era: Era.Medieval,
    category: "shelter",
  },

  // --- Mid-game production buildings. All workbench-category so they
  //     stack with each other (multiple windmills → additive farm
  //     boost). Specific per-tick mechanics live in engine.ts; the
  //     `produces` map carries the simple flat tick rates, and the
  //     special-cased buildings (stonemill / wheatmill / bakery /
  //     trebuchet) emit nothing through `produces` because their
  //     output depends on input availability. ---
  {
    key: "windmill",
    label: "Windmill",
    sprite: "b_windmill",
    size: 18,
    cost: { wood: 30, rock: 12, iron: 4 },
    // Trickles a small amount of each berry every tick on top of the
    // 10× boost it gives to nearby farm yields. Pays for itself even
    // without a farm next to it.
    produces: { redberry: 0.05, yellowberry: 0.05, blueberry: 0.05 },
    era: Era.Tribal,
    category: "production",
    // Mills are coastal industry — they need exposure to the shore
    // wind (windmill), water flow (wheat/stonemill), or driftwood
    // supply (woodmill). Forcing beach placement also reads as the
    // working harbour silhouette the player expects.
    requiresBeach: true,
  },
  {
    key: "woodmill",
    label: "Wood Mill",
    sprite: "b_woodmill",
    size: 18,
    cost: { wood: 40, rock: 10, iron: 4 },
    // Slow passive wood output. Stacks with its own nearby-chop boost
    // so a Wood Mill standalone still produces, but planting one next
    // to a Wood Chop is much better.
    produces: { wood: 0.25, leaves: 0.05 },
    era: Era.Tribal,
    category: "production",
    requiresBeach: true,
  },
  {
    key: "wheatmill",
    label: "Wheat Mill",
    sprite: "b_wheatmill",
    size: 16,
    cost: { wood: 25, rock: 10 },
    // Wheatmill mills a flat wheat supply per tick and also lays down a
    // small processedfruit trickle from its own grain. The berry-to-
    // processedfruit conversion is the special case in engine.ts.
    produces: { wheat: 0.4, processedfruit: 0.05 },
    era: Era.Tribal,
    category: "production",
    requiresBeach: true,
  },
  {
    key: "stonemill",
    label: "Stone Mill",
    sprite: "b_stonemill",
    size: 16,
    cost: { wood: 20, rock: 25, iron: 5 },
    // Slow passive rock + iron output. The special case in engine.ts
    // additionally consumes 1 rock per tick from the stockpile and
    // rolls for an iron / gold / diamond upgrade, so a stonemill with
    // input feeding it is far more valuable than one that's just
    // running on its baseline produces.
    produces: { rock: 0.15, iron: 0.03 },
    era: Era.Tribal,
    category: "production",
    requiresBeach: true,
  },
  {
    key: "bakery",
    label: "Bakery",
    sprite: "b_bakery",
    size: 16,
    cost: { wood: 25, rock: 12 },
    // Slow passive bread output on top of the wheat→bread conversion
    // in engine.ts. Even a bakery starved of wheat still drips out a
    // few loaves over time.
    produces: { bread: 0.05 },
    era: Era.Tribal,
    category: "production",
  },
  {
    key: "waterwheel",
    label: "Water Wheel",
    sprite: "b_waterwheel",
    size: 18,
    cost: { wood: 30, rock: 8 },
    // Generic mid-game production helper — emits a flat wood + leaves
    // tick. Adjacency-boost rules live in engine.ts (TBD).
    produces: { wood: 0.4, leaves: 0.2 },
    era: Era.Tribal,
    category: "production",
  },
  {
    key: "trebuchet",
    label: "Trebuchet",
    sprite: "b_trebuchet",
    size: 20,
    cost: { wood: 60, rock: 20, iron: 6 },
    // Combat siege weapon — requires 3 assigned villagers to fire and
    // 3 rocks per shot. State machine + animation are follow-ups; for
    // now the building can be placed but stands idle.
    produces: {},
    era: Era.Tribal,
    category: "production",
  },
  // --- Crafting + training shops. Each one is a small workbench that
  //     either produces a specialty consumable resource or stands as a
  //     prerequisite for a future combat-recruitment unlock. ---
  {
    key: "archery_shop",
    label: "Archery Shop",
    sprite: "b_archery_shop",
    size: 16,
    cost: { wood: 25, rock: 6, iron: 2, leaves: 4 },
    // Slow leaves trickle (fletching scraps) + a small iron drip from
    // arrowhead practice. Pays for itself on the leaves line alone.
    produces: { leaves: 0.06, iron: 0.02 },
    era: Era.Tribal,
    category: "production",
  },
  {
    key: "tool_shop",
    label: "Tool Shop",
    sprite: "b_tool_shop",
    size: 16,
    cost: { wood: 30, rock: 12, iron: 3 },
    // Tool Shop hammers out a passive wood + iron trickle. The user
    // can stack one of these next to a Workbench to keep the tool
    // queue full without manual crafting.
    produces: { wood: 0.08, iron: 0.04 },
    era: Era.Tribal,
    category: "production",
  },
  {
    key: "weaponry",
    label: "Weaponry",
    sprite: "b_weaponry",
    size: 18,
    cost: { wood: 35, rock: 15, iron: 6 },
    // Heaviest of the crafting shops — outputs more iron (forge work)
    // and a steady ash trickle from the smelting hearth.
    produces: { iron: 0.08, ash: 0.05 },
    era: Era.Tribal,
    category: "production",
  },
  {
    key: "stone_advanced",
    label: "Stone Refinery",
    sprite: "b_stone_advanced",
    size: 20,
    cost: { wood: 30, rock: 40, iron: 8 },
    // Big-ticket follow-up to the Stonemill: passively trickles every
    // ore line plus base rock. Designed as a single-of building per
    // tribe — costly enough that planting two doesn't pay back.
    produces: { rock: 0.3, iron: 0.08, gold: 0.02, diamond: 0.005 },
    era: Era.Tribal,
    category: "production",
  },

  // --- Tribal-era transport. Rafts USED to live here as a free-placement
  //     building; they've been moved into the Port window (see vessels.ts)
  //     so all watercraft purchases go through the same dock UI. ---
  // Naval port — four biome-locked variants (parallel to the galleon
  // catalog in vessels.ts). Each tribe sees only the one that matches
  // its `originStyles`, so the human's build menu only ever shows one
  // Port option.
  {
    key: "port_birch",
    label: "Birch Port",
    sprite: "b_port_birch",
    size: 66,
    placementSize: 24,
    cost: { wood: 90, rock: 30 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    requiresBeach: true,
    popCap: 6,
    styles: ["birch"],
  },
  {
    key: "port_desert",
    label: "Desert Port",
    sprite: "b_port_desert",
    size: 66,
    placementSize: 24,
    cost: { wood: 90, rock: 30 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    requiresBeach: true,
    popCap: 6,
    styles: ["desert"],
  },
  {
    key: "port_thatch",
    label: "Thatch Port",
    sprite: "b_port_thatch",
    size: 66,
    placementSize: 24,
    cost: { wood: 90, rock: 30 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    requiresBeach: true,
    popCap: 6,
    styles: ["thatch"],
  },
  {
    key: "port_cabin",
    label: "Forest Port",
    sprite: "b_port_cabin",
    size: 66,
    placementSize: 24,
    cost: { wood: 90, rock: 30 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    requiresBeach: true,
    popCap: 6,
    // Strict biome lock: only forest (cabin) tribes can build the
    // Forest Port. Birch tribes get their own port_birch variant.
    styles: ["cabin"],
  },
  {
    key: "shallow_water_hut",
    label: "Shallow Water Hut",
    sprite: "b_shallow_water_hut",
    size: 18,
    cost: { wood: 14, rock: 2 },
    // Stationary fishing platform — sits IN shallow water (Sea kind
    // within 5 tiles of the coast). Produces twice the raw meat rate
    // of a raft. Engine.ts handles the unpreped_meat tick.
    produces: {},
    era: Era.Tribal,
    category: "transport",
    requiresShallowWater: true,
  },
  // Airship port — four biome-locked variants matching the naval port
  // + galleon pattern. Tribe sees only its own biome's airship dock.
  {
    key: "airship_port_birch",
    label: "Birch Airship Port",
    sprite: "b_airship_port_birch",
    size: 66,
    placementSize: 24,
    cost: { wood: 75, rock: 45 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    styles: ["birch"],
    popCap: 6,
  },
  {
    key: "airship_port_desert",
    label: "Desert Airship Port",
    sprite: "b_airship_port_desert",
    size: 66,
    placementSize: 24,
    cost: { wood: 75, rock: 45 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    styles: ["desert"],
    popCap: 6,
  },
  {
    key: "airship_port_thatch",
    label: "Thatch Airship Port",
    sprite: "b_airship_port_thatch",
    size: 66,
    placementSize: 24,
    cost: { wood: 75, rock: 45 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    styles: ["thatch"],
    popCap: 6,
  },
  {
    key: "airship_port_cabin",
    label: "Forest Airship Port",
    sprite: "b_airship_port_cabin",
    size: 66,
    placementSize: 24,
    cost: { wood: 75, rock: 45 },
    produces: {},
    era: Era.Tribal,
    category: "transport",
    // Strict biome lock — birch tribes get airship_port_birch instead.
    styles: ["cabin"],
    popCap: 6,
  },
];

const byKey = new Map(BUILDINGS.map((b) => [b.key, b]));
export function getBuildingDef(key: string): BuildingDef | undefined {
  return byKey.get(key);
}

/** Human sprite names for villagers — registered in textures.ts. One per
 *  entry in the IMG/Humans folder. */
export const HUMAN_SPRITES = [
  "human1", "human2", "human3", "human4",
  "human5", "human6", "human7", "human8",
];
