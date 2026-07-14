import type { ArchStyle, ResourceMap } from "./types";

/**
 * Vessel catalog — ships sold at the naval Port and airships sold at the
 * Airship Port. Mirrors the BuildingDef shape but doesn't get placed via
 * the build menu; instead the PortWindow shows these as cards and a
 * click on a card debits the cost from the player.
 *
 * Ship sprites are biome-locked (one galleon per tribe style) so a
 * tribe always builds the navy that matches its architecture. Airships
 * are universal — every tribe can build every airship.
 */
export interface VesselDef {
  key: string;
  label: string;
  /** Sprite name registered in textures.ts. */
  sprite: string;
  cost: ResourceMap;
  category: "ship" | "airship";
  description: string;
  /** Architecture-style gate. Empty/omitted = universal (any tribe). */
  styles?: ArchStyle[];
  /** Population cap bonus while docked. Big ships / airships add 8 to
   *  the owner's `getPopulationCap` value as long as they're parked at
   *  one of their ports. Rafts and scout balloons are 0. */
  popCap?: number;
  /** Crew capacity. Airships need to be filled to this number of
   *  villagers before they can take off — see launchVessel(). Ships
   *  inherit the same field but currently aren't gated on it. */
  crew?: number;
  /** Sprite to swap to when the vessel is shot down. Reserved on the
   *  big airships; the actual PNGs land later under
   *  IMG/Vessels/*_destroyed.png and are registered in textures.ts. */
  shotDownSprite?: string;
  /** True if the vessel can be destroyed and switch to its
   *  `shotDownSprite`. Airships are reachable by trebuchets; ships go
   *  down to naval combat (still being designed). Either way the
   *  catalog flag flips them into the destroyed sprite state when
   *  `shootDownVessel` fires. */
  canBeShotDown?: boolean;
}

export const SHIPS: VesselDef[] = [
  {
    // Cheapest entry point — formerly a free-placement transport building,
    // now sold at the port like everything else that floats. Universal
    // (no `styles` gate) so every tribe gets the basic raft regardless of
    // which biome they spawned in.
    key: "raft",
    label: "Raft",
    sprite: "b_raft",
    cost: { wood: 20 },
    category: "ship",
    description: "Lashed-log raft — short-range coastal hop.",
  },
  {
    key: "ship_birch",
    label: "Birch Galleon",
    sprite: "ship_birch",
    cost: { wood: 50, rock: 10, iron: 5 },
    category: "ship",
    popCap: 8,
    crew: 8,
    shotDownSprite: "ship_birch_destroyed",
    canBeShotDown: true,
    description: "Light birch-planked galleon — quick over open plains coasts.",
    styles: ["birch"],
  },
  {
    key: "ship_desert",
    label: "Sun Galleon",
    sprite: "ship_desert",
    cost: { wood: 50, rock: 10, iron: 5 },
    category: "ship",
    popCap: 8,
    crew: 8,
    shotDownSprite: "ship_desert_destroyed",
    canBeShotDown: true,
    description: "Pale lateen-rigged galleon for coastal desert trade.",
    styles: ["desert"],
  },
  {
    key: "ship_forest",
    label: "Forest Galleon",
    sprite: "ship_forest",
    cost: { wood: 50, rock: 10, iron: 5 },
    category: "ship",
    popCap: 8,
    crew: 8,
    shotDownSprite: "ship_forest_destroyed",
    canBeShotDown: true,
    description: "Heavy oak galleon — built for long voyages.",
    styles: ["cabin"],
  },
  {
    key: "ship_taiga",
    label: "Taiga Galleon",
    sprite: "ship_taiga",
    cost: { wood: 50, rock: 10, iron: 5 },
    category: "ship",
    popCap: 8,
    crew: 8,
    shotDownSprite: "ship_taiga_destroyed",
    canBeShotDown: true,
    description: "Reinforced taiga galleon with an ice-resistant hull.",
    styles: ["thatch"],
  },
];

export const AIRSHIPS: VesselDef[] = [
  {
    key: "airship_heavy",
    label: "Heavy Airship",
    sprite: "airship_heavy",
    cost: { wood: 80, rock: 20, iron: 15, gold: 5 },
    category: "airship",
    description: "Cargo dirigible — hauls bulk supplies across continents.",
    popCap: 8,
    crew: 8,
    shotDownSprite: "airship_heavy_destroyed",
    canBeShotDown: true,
  },
  {
    key: "airship_scout",
    label: "Scout Airship",
    sprite: "airship_scout",
    cost: { wood: 35, rock: 8, iron: 5 },
    category: "airship",
    shotDownSprite: "airship_scout_destroyed",
    canBeShotDown: true,
    description: "Fast scout balloon; reveals terrain ahead of armies.",
  },
  {
    key: "airship_recon",
    label: "Recon Airship",
    sprite: "airship_recon",
    cost: { wood: 35, rock: 8, iron: 5 },
    category: "airship",
    shotDownSprite: "airship_recon_destroyed",
    canBeShotDown: true,
    description: "Sustained-flight reconnaissance — marks enemy positions.",
  },
  {
    key: "airship_patrol",
    label: "Patrol Airship",
    sprite: "airship_patrol",
    cost: { wood: 40, rock: 10, iron: 10 },
    category: "airship",
    description: "Armed patrol skimmer — deters border incursions.",
    popCap: 8,
    crew: 8,
    shotDownSprite: "airship_patrol_destroyed",
    canBeShotDown: true,
  },
  {
    key: "airship_cargo",
    label: "Cargo Airship",
    sprite: "airship_cargo",
    cost: { wood: 45, rock: 12, iron: 8 },
    category: "airship",
    description: "Small cargo lifter — shuttles resources between tribes.",
    popCap: 8,
    crew: 8,
    shotDownSprite: "airship_cargo_destroyed",
    canBeShotDown: true,
  },
];

const vesselByKey = new Map<string, VesselDef>([
  ...SHIPS.map((v): [string, VesselDef] => [v.key, v]),
  ...AIRSHIPS.map((v): [string, VesselDef] => [v.key, v]),
]);

export function getVesselDef(key: string): VesselDef | undefined {
  return vesselByKey.get(key);
}
