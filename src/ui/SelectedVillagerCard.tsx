import { getSpritePath } from "../render/textures";
import type { Villager, VillagerJobKind } from "../game/types";

interface Props {
  villager: Villager;
  onClose: () => void;
  onStop: () => void;
}

/** Human-readable label + one-line task summary for the villager's
 *  current job. The label shows on the card pill; the explanation
 *  reads as "currently …" prose so the player knows exactly what the
 *  Stop button will interrupt. */
const JOB_INFO: Record<VillagerJobKind, { label: string; explain: string }> = {
  idle:        { label: "Idle",              explain: "Waiting for orders." },
  moveTo:      { label: "Walking",           explain: "Walking to a spot you ordered." },
  walkToTree:  { label: "Walking to Tree",   explain: "On their way to chop a tree." },
  chopping:    { label: "Chopping",          explain: "Felling a tree for wood." },
  walkToRock:  { label: "Walking to Rock",   explain: "On their way to mine a rock." },
  mining:      { label: "Mining",            explain: "Breaking rock with a pickaxe." },
  walkToFarm:  { label: "Walking to Farm",   explain: "On their way to a farm tile." },
  farming:     { label: "Farming",           explain: "Picking berries from the shore." },
  walkHome:    { label: "Returning Home",    explain: "Carrying their harvest back to the tent." },
  walkToBuild: { label: "Walking to Build",  explain: "Heading to a half-built structure to help." },
  building:    { label: "Building",          explain: "Hammering away on an unfinished structure." },
  fertilizing: { label: "Fertilizing",       explain: "Spreading ash over claimed farmland." },
  walkToHunt:  { label: "Walking to Hunt",   explain: "Chasing down a wild animal for meat." },
  huntingAnimal: { label: "Hunting",         explain: "Bringing down a wild animal." },
  walkToBoard:   { label: "Boarding",         explain: "Walking up to a port to board." },
};

/** Floating card pinned to the left edge of the viewport whenever the
 *  player has a villager selected. Shows the villager's sprite, name,
 *  role, current animation label, a one-sentence task explanation, and
 *  two buttons: Stop Task (cancels back to idle) and a big red X to
 *  clear the selection. */
export function SelectedVillagerCard({ villager, onClose, onStop }: Props) {
  const sprite = getSpritePath(villager.sprite);
  const info = JOB_INFO[villager.job] ?? JOB_INFO.idle;
  const role = villager.role ?? "worker";
  const weapon = villager.weapon ?? "bow";
  const canStop = villager.job !== "idle";
  return (
    <div className="selected-villager-card">
      <button
        type="button"
        className="selected-villager-x"
        onClick={onClose}
        title="Deselect villager (Esc)"
        aria-label="Deselect villager"
      >
        ×
      </button>
      <div className="selected-villager-portrait">
        {sprite && <img src={sprite} alt={villager.name} draggable={false} />}
      </div>
      <div className="selected-villager-name">{villager.name}</div>
      <div className="selected-villager-role">{role} · {weapon}</div>
      <div className="selected-villager-job">{info.label}</div>
      <div className="selected-villager-explain">{info.explain}</div>
      {villager.carryingSprite && (
        <div className="selected-villager-carry">Carrying: {villager.carryingSprite}</div>
      )}
      <button
        type="button"
        className="selected-villager-stop"
        onClick={onStop}
        disabled={!canStop}
        title={canStop ? "Cancel the current task" : "Villager is already idle"}
      >
        Stop Task
      </button>
    </div>
  );
}
