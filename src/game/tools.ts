import type { ResourceMap } from "./types";
import { registerCraftableTool } from "./state";

/**
 * Tool catalog — items crafted at a Workbench. Each crafted tool goes
 * into the player's `tools` stockpile (Record<key, count>); the gameplay
 * effect (villager pickup, equip-on-villager, bonus to harvest rate,
 * etc.) is left as a follow-up — for this slice we just stub the
 * catalog + crafting cost so the UI loop is in place.
 *
 * Sprites are TBD — drop the PNGs into IMG/Buildings/ (or a new
 * IMG/Tools/) and add `["tool_<key>", "<path>.png"]` to textures.ts.
 * Cards will render the sprite once registered; until then the cards
 * are blank but functional.
 */
export interface ToolDef {
  key: string;
  label: string;
  /** Sprite name registered in textures.ts. May not exist yet. */
  sprite: string;
  cost: ResourceMap;
  description: string;
}

export const TOOLS: ToolDef[] = [
  {
    key: "pickaxe",
    label: "Pickaxe",
    sprite: "tool_pickaxe",
    // Wood-only on purpose — the pickaxe is what the player USES to
    // get rock, so requiring rock to craft it would lock the loop.
    // Cost bumped to 6 wood to make up for dropping the rock line.
    cost: { wood: 6 },
    description: "Hewn pick — speeds up rock and iron extraction.",
  },
  {
    key: "hoe",
    label: "Hoe",
    sprite: "tool_hoe",
    cost: { wood: 4, iron: 1 },
    description: "Bent farming blade — tills soil for crop tiles.",
  },
  {
    key: "shovel",
    label: "Shovel",
    sprite: "tool_shovel",
    cost: { wood: 3, iron: 1 },
    description: "Wooden-handled spade — clears earth and shapes terrain.",
  },
  {
    key: "spear",
    label: "Spear",
    sprite: "tool_spear",
    cost: { wood: 5, rock: 1, iron: 2 },
    description: "Hafted spear — light hunting and tribal-era combat.",
  },
];

const byKey = new Map<string, ToolDef>(TOOLS.map((t) => [t.key, t]));
export function getToolDef(key: string): ToolDef | undefined {
  return byKey.get(key);
}

// Publish each tool's cost into state.ts's craftTool() lookup so the bot
// AI (engine.ts, via state.craftTool) can validate / debit costs without
// a circular import. UI callers still go through WorkbenchWindow's
// onCraft handler, which mirrors the same deduction logic in App.tsx.
for (const t of TOOLS) registerCraftableTool(t.key, t.cost);
