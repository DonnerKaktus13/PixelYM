import { useEffect } from "react";
import { TOOLS, type ToolDef } from "../game/tools";
import { getSpritePath } from "../render/textures";
import type { ResourceKind } from "../game/types";
import type { GameState } from "../game/state";

interface Props {
  state: GameState;
  onClose: () => void;
  /** Called when the player clicks an affordable tool card. The host
   *  (App.tsx) deducts the cost and bumps the player's tool count. */
  onCraft: (toolKey: string) => void;
}

const RES_SHORT: Record<ResourceKind, string> = {
  wood: "Wood", rock: "Rock", iron: "Iron", gold: "Gold",
  diamond: "Diam", redcrystal: "Red", bluecrystal: "Blue", uranium: "Uran",
  redberry: "Rber", yellowberry: "Yber", blueberry: "Bber",
  mushroom: "Mush", leaves: "Leaf", ash: "Ash",
  meat: "Meat", unpreped_meat: "Raw",
  wheat: "Wht", processedfruit: "Frut", bread: "Brd",
};

/**
 * Modal opened by clicking on the player's own Workbench in the world.
 * Shows the tool catalog (pickaxe / hoe / shovel / spear) as a card
 * grid with hover tooltips. A click on an affordable card crafts the
 * tool: deducts the resource cost and increments the player's tool
 * stockpile (`player.tools[key]`). Visual hand-off to villagers is a
 * later pass.
 */
export function WorkbenchWindow({ state, onClose, onCraft }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const human = state.players[state.humanId];

  return (
    <div className="craft-book-overlay" onClick={onClose}>
      <div className="craft-book-panel" onClick={(e) => e.stopPropagation()}>
        {/* Red tool-book background. Asset lives in IMG/Tools/. */}
        <img className="craft-book-bg" src="/IMG/Tools/redbook.png" alt="Workbench — Tools" draggable={false} />
        <div className="craft-book-pages">
          {TOOLS.map((t) => {
            const affordable = canAfford(human.resources, t.cost);
            const imgSrc = getSpritePath(t.sprite);
            const owned = human.tools[t.key] ?? 0;
            return (
              <button
                key={t.key}
                className={`craft-book-card${affordable ? "" : " poor"}`}
                disabled={!affordable}
                onClick={() => affordable && onCraft(t.key)}
              >
                {imgSrc && <img src={imgSrc} alt="" draggable={false} />}
                {owned > 0 && <div className="craft-book-card-badge">{owned}</div>}
                <div className="craft-book-card-tip">
                  <div className="craft-book-card-tip-name">{t.label}</div>
                  <div className="craft-book-card-tip-desc">{t.description}</div>
                  <div className="craft-book-card-tip-cost">{costLine(t.cost)}</div>
                </div>
              </button>
            );
          })}
        </div>
        <button className="craft-book-close" onClick={onClose} title="Close (Esc)">×</button>
      </div>
    </div>
  );
}

function canAfford(resources: Record<ResourceKind, number>, cost: ToolDef["cost"]): boolean {
  for (const k in cost) {
    const need = cost[k as ResourceKind] ?? 0;
    if (resources[k as ResourceKind] < need) return false;
  }
  return true;
}

function costLine(cost: ToolDef["cost"]): string {
  const parts: string[] = [];
  for (const k in cost) {
    parts.push(`${cost[k as ResourceKind]} ${RES_SHORT[k as ResourceKind]}`);
  }
  return parts.length === 0 ? "free" : parts.join(" + ");
}
