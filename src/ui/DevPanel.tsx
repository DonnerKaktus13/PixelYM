import { useEffect } from "react";
import { BUILDINGS } from "../game/catalog";
import { SHIPS, AIRSHIPS } from "../game/vessels";
import { RESOURCE_KEYS, RELATION_WAR, RELATION_TRUCE, RELATION_ALLY, RELATION_NEUTRAL,
         type ResourceKind } from "../game/types";
import {
  buildStructure, findHomeTent, launchTribalAttack,
  purchaseVesselAtPort, launchVessel, shootDownVessel,
  setRelation, getRelation, type GameState,
} from "../game/state";

interface Props {
  state: GameState;
  /** Force a re-render after a mutation. */
  onMutate: () => void;
  /** Surface a toast to the player. */
  onToast: (msg: string) => void;
  onClose: () => void;
}

/** Developer test panel — keyboard-toggled with Ctrl+Ä. Every entry
 *  mutates `state` directly and then calls `onMutate()` so the rest of
 *  the React tree sees the change. NOT visible in production builds;
 *  the keyboard binding is just a quick affordance for testing. */
export function DevPanel({ state, onMutate, onToast, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const human = state.players[state.humanId];

  const fireMut = (label: string, fn: () => void) => () => {
    fn();
    onMutate();
    onToast(label);
  };

  // ----- Resources --------------------------------------------------
  const giveAllResources = () => {
    for (const k of RESOURCE_KEYS) human.resources[k as ResourceKind] += 1000;
  };
  const giveResource = (k: ResourceKind) => () => {
    human.resources[k] += 100;
    onMutate();
    onToast(`+100 ${k}`);
  };

  // ----- Tools ------------------------------------------------------
  const TOOLS = ["pickaxe", "hoe", "shovel", "spear"];
  const giveAllTools = () => {
    for (const t of TOOLS) human.tools[t] = (human.tools[t] ?? 0) + 5;
  };

  // ----- Villagers --------------------------------------------------
  // Direct mass-promote bypasses the spear gate (the prod path goes
  // through cycleVillagerRole in App.tsx). Combat villagers still need
  // a weapon, so we synthesise a spear for the combat roles and reset
  // demotions back to bow.
  const cycleAllRoles = (role: "worker" | "guard" | "army") => () => {
    for (const v of state.villagers) {
      if (v.ownerId !== state.humanId) continue;
      v.role = role;
      v.weapon = role === "worker" ? "bow" : "spear";
    }
    onMutate();
    onToast(`All villagers → ${role}`);
  };

  // ----- Buildings --------------------------------------------------
  const spawnBuilding = (key: string) => () => {
    const home = findHomeTent(state, state.humanId);
    if (!home) { onToast("No home"); return; }
    const ang = Math.random() * Math.PI * 2;
    const r = 50 + Math.random() * 80;
    if (buildStructure(state, state.humanId, key, home.x + Math.cos(ang) * r, home.y + Math.sin(ang) * r, true)) {
      onMutate();
      onToast(`Built ${key}`);
    } else {
      onToast(`Build ${key} failed`);
    }
  };

  // ----- Vessels ----------------------------------------------------
  const buyVessel = (defKey: string) => () => {
    const port = state.structures.find(
      (s) => s.ownerId === state.humanId &&
      (s.defKey.startsWith("port_") || s.defKey.startsWith("airship_port"))
    );
    if (!port) { onToast("No port"); return; }
    const v = purchaseVesselAtPort(state, state.humanId, port.id, defKey);
    if (v) { onMutate(); onToast(`Bought ${defKey}`); }
    else { onToast(`Port full / not found`); }
  };
  const launchAllVessels = () => {
    let n = 0;
    for (const v of state.vessels) {
      if (v.ownerId !== state.humanId) continue;
      if (launchVessel(state, v.id)) n++;
    }
    onMutate();
    onToast(`Launched ${n} vessel(s)`);
  };
  const shootDownAllFlying = () => {
    let n = 0;
    for (const v of state.vessels) {
      if (v.status === "flying" && shootDownVessel(state, v.id)) n++;
    }
    onMutate();
    onToast(`Shot down ${n} vessel(s)`);
  };

  // ----- Day / Night ------------------------------------------------
  // The visible cycle reads (now - state.startedAtMs) % DAY_LENGTH_MS.
  // Shifting startedAtMs warps the phase by setting where "noon" sits
  // relative to wall-clock now.
  const DAY_LENGTH_MS = 60 * 60 * 1000;
  const jumpTo = (frac: number) => () => {
    state.startedAtMs = performance.now() - frac * DAY_LENGTH_MS;
    onMutate();
    onToast(frac < 0.25 ? "Noon" : frac < 0.75 ? "Midnight" : "Dawn");
  };

  // ----- Diplomacy --------------------------------------------------
  const setAllRelations = (rel: number, label: string) => () => {
    for (const p of state.players) {
      if (p.id === state.humanId || !p.alive) continue;
      setRelation(state, state.humanId, p.id, rel);
    }
    onMutate();
    onToast(`All → ${label}`);
  };

  // ----- Combat -----------------------------------------------------
  const attackBot = (botId: number) => () => {
    const won = launchTribalAttack(state, state.humanId, botId);
    onMutate();
    onToast(won ? `Defeated ${state.players[botId].name}` : `Attack on ${state.players[botId].name} bounced`);
  };

  return (
    <div className="dev-panel-overlay" onClick={onClose}>
      <div className="dev-panel" onClick={(e) => e.stopPropagation()}>
        <div className="dev-panel-head">
          <h2>Dev Panel</h2>
          <span className="dev-panel-hint">Ctrl + Ä to toggle · Esc to close</span>
          <button className="dev-panel-close" onClick={onClose}>×</button>
        </div>

        <section className="dev-section">
          <h3>Resources</h3>
          <div className="dev-row">
            <button onClick={fireMut("+1000 all resources", giveAllResources)}>+1000 ALL</button>
            {RESOURCE_KEYS.map((k) => (
              <button key={k} onClick={giveResource(k)}>+100 {k}</button>
            ))}
          </div>
        </section>

        <section className="dev-section">
          <h3>Tools</h3>
          <div className="dev-row">
            <button onClick={fireMut("Gave all tools", giveAllTools)}>+5 all tools</button>
            {TOOLS.map((t) => (
              <button
                key={t}
                onClick={fireMut(`+1 ${t}`, () => { human.tools[t] = (human.tools[t] ?? 0) + 1; })}
              >+1 {t}</button>
            ))}
          </div>
        </section>

        <section className="dev-section">
          <h3>Villager roles</h3>
          <div className="dev-row">
            <button onClick={cycleAllRoles("worker")}>All → Worker</button>
            <button onClick={cycleAllRoles("guard")}>All → Guard</button>
            <button onClick={cycleAllRoles("army")}>All → Army</button>
          </div>
        </section>

        <section className="dev-section">
          <h3>Spawn building near home</h3>
          <div className="dev-row dev-row-wrap">
            {BUILDINGS.map((b) => (
              <button key={b.key} onClick={spawnBuilding(b.key)} title={b.label}>
                {b.label}
              </button>
            ))}
          </div>
        </section>

        <section className="dev-section">
          <h3>Vessels</h3>
          <div className="dev-row dev-row-wrap">
            {SHIPS.map((v) => (
              <button key={v.key} onClick={buyVessel(v.key)} title={v.label}>
                Buy {v.label}
              </button>
            ))}
            {AIRSHIPS.map((v) => (
              <button key={v.key} onClick={buyVessel(v.key)} title={v.label}>
                Buy {v.label}
              </button>
            ))}
          </div>
          <div className="dev-row">
            <button onClick={launchAllVessels}>Launch all docked</button>
            <button onClick={shootDownAllFlying}>Shoot down all flying</button>
          </div>
        </section>

        <section className="dev-section">
          <h3>Day / Night</h3>
          <div className="dev-row">
            <button onClick={jumpTo(0)}>Noon</button>
            <button onClick={jumpTo(0.25)}>Dusk</button>
            <button onClick={jumpTo(0.5)}>Midnight</button>
            <button onClick={jumpTo(0.75)}>Dawn</button>
          </div>
        </section>

        <section className="dev-section">
          <h3>Diplomacy (all bots)</h3>
          <div className="dev-row">
            <button onClick={setAllRelations(RELATION_NEUTRAL, "Neutral")}>Neutral</button>
            <button onClick={setAllRelations(RELATION_TRUCE, "Truce")}>Truce</button>
            <button onClick={setAllRelations(RELATION_ALLY, "Ally")}>Ally</button>
            <button onClick={setAllRelations(RELATION_WAR, "War")}>War</button>
          </div>
        </section>

        <section className="dev-section">
          <h3>Attack bot</h3>
          <div className="dev-row dev-row-wrap">
            {state.players.filter((p) => !p.isHuman && p.alive).map((p) => (
              <button key={p.id} onClick={attackBot(p.id)} title={p.name}>
                <span style={{ color: p.color }}>●</span> {p.name}{" "}
                <span className="dev-rel">{relationLabel(getRelation(state, state.humanId, p.id))}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function relationLabel(rel: number): string {
  return rel === RELATION_WAR ? "[war]"
    : rel === RELATION_TRUCE ? "[truce]"
    : rel === RELATION_ALLY ? "[ally]"
    : "";
}
