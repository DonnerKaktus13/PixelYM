import { useEffect, useState } from "react";
import { SHIPS, AIRSHIPS, type VesselDef, getVesselDef } from "../game/vessels";
import { getSpritePath } from "../render/textures";
import { RESOURCE_KEYS, type ResourceKind } from "../game/types";
import type { GameState, Vessel } from "../game/state";
import { vesselCargoCap, vesselCargoUsed } from "../game/state";

export type PortKind = "port" | "airship_port";

interface Props {
  kind: PortKind;
  state: GameState;
  onClose: () => void;
  /** Called when the player clicks an affordable vessel card. */
  onPurchase: (vesselKey: string) => void;
  /** Called when the player clicks the "Board villager" button on the
   *  Board page — App boards the nearest idle villager. */
  onBoard?: () => void;
  /** Current count of villagers boarded across the player's ports. */
  boardedCount?: number;
  /** Load `amount` of `kind` onto vessel `vesselId`. App calls into
   *  the state helper and triggers a re-render. */
  onLoadCargo?: (vesselId: number, resourceKind: ResourceKind, amount: number) => void;
  /** Drain every resource off a docked vessel back into the player. */
  onUnloadAll?: (vesselId: number) => void;
  /** Launch a docked vessel — moves it to "flying"/"sailing". App-side
   *  checks that the crew gate is satisfied; the button is disabled
   *  for vessels that aren't ready. */
  onLaunch?: (vesselId: number) => void;
  /** Airship-only: pull boarded dock villagers (insideStructureId set to
   *  an owned airship port) onto the given vessel until the crew
   *  requirement is met. Lets the player fill a dock with workers and
   *  then commit them to a specific airship in one click. */
  onAssignCrew?: (vesselId: number) => void;
  /** Enter flight-path edit mode for this docked vessel. App-side
   *  closes the PortWindow and lets the player drop waypoints on the
   *  world; the route renders as a Bezier curve through the points,
   *  and the airship follows that curve when launched. */
  onSetRoute?: (vesselId: number) => void;
}

/** Short labels for the per-resource cost line. */
const RES_SHORT: Record<ResourceKind, string> = {
  wood: "Wood", rock: "Rock", iron: "Iron", gold: "Gold",
  diamond: "Diam", redcrystal: "Red", bluecrystal: "Blue", uranium: "Uran",
  redberry: "Rber", yellowberry: "Yber", blueberry: "Bber",
  mushroom: "Mush", leaves: "Leaf", ash: "Ash",
  meat: "Meat", unpreped_meat: "Raw",
  wheat: "Wht", processedfruit: "Frut", bread: "Brd",
};

export function PortWindow({
  kind, state, onClose, onPurchase, onBoard, boardedCount,
  onLoadCargo, onUnloadAll, onLaunch, onAssignCrew, onSetRoute,
}: Props) {
  const [page, setPage] = useState<0 | 1 | 2 | 3>(0);
  const [selectedVesselId, setSelectedVesselId] = useState<number | null>(null);

  // Esc closes — standard modal affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const human = state.players[state.humanId];
  const title = kind === "port" ? "Port — Naval Dock" : "Airship Port — Sky Dock";
  const catalog = kind === "port" ? SHIPS : AIRSHIPS;
  // Style gate: ships are biome-locked; airships are universal.
  const available = catalog.filter((v) => {
    if (!v.styles || v.styles.length === 0) return true;
    return v.styles.some((s) => human.originStyles.includes(s));
  });

  // Player-owned docked vessels matching the current port kind. The
  // Board + Load Cargo pages operate on these.
  const dockedVessels = state.vessels.filter((v) => {
    if (v.ownerId !== state.humanId) return false;
    if (v.status !== "docked") return false;
    const def = getVesselDef(v.defKey);
    if (!def) return false;
    if (kind === "port" && def.category !== "ship") return false;
    if (kind === "airship_port" && def.category !== "airship") return false;
    return true;
  });
  const selectedVessel = selectedVesselId
    ? dockedVessels.find((v) => v.id === selectedVesselId) ?? null
    : null;

  return (
    <div className="craft-book-overlay" onClick={onClose}>
      <div className="craft-book-panel" onClick={(e) => e.stopPropagation()}>
        {/* Yellow ship-book background. */}
        <img className="craft-book-bg" src="/IMG/Tools/yellowbook.png" alt={title} draggable={false} />
        <div className="craft-book-pages">
          {page === 0 && (
            available.length === 0 ? (
              <div className="craft-book-empty">No vessels match your tribe's style.</div>
            ) : (
              available.map((v) => {
                const affordable = canAfford(human.resources, v.cost);
                const imgSrc = getSpritePath(v.sprite);
                return (
                  <button
                    key={v.key}
                    className={`craft-book-card${affordable ? "" : " poor"}`}
                    disabled={!affordable}
                    onClick={() => affordable && onPurchase(v.key)}
                  >
                    {imgSrc && <img src={imgSrc} alt="" draggable={false} />}
                    <div className="craft-book-card-tip">
                      <div className="craft-book-card-tip-name">{v.label}</div>
                      <div className="craft-book-card-tip-desc">{v.description}</div>
                      <div className="craft-book-card-tip-cost">{costLine(v.cost)}</div>
                    </div>
                  </button>
                );
              })
            )
          )}
          {page === 1 && (
            <BoardPage
              boardedCount={boardedCount ?? 0}
              onBoard={onBoard}
              kind={kind}
              dockedVessels={dockedVessels}
              onLaunch={onLaunch}
              onAssignCrew={onAssignCrew}
              onSetRoute={onSetRoute}
            />
          )}
          {page === 2 && (
            <LoadCargoPage
              state={state}
              dockedVessels={dockedVessels}
              selectedVessel={selectedVessel}
              setSelectedVesselId={setSelectedVesselId}
              onLoadCargo={onLoadCargo}
              onUnloadAll={onUnloadAll}
            />
          )}
          {page === 3 && (
            <CargoManifestPage
              dockedVessels={dockedVessels}
              selectedVessel={selectedVessel}
              setSelectedVesselId={setSelectedVesselId}
            />
          )}
        </div>
        <button
          className="craft-book-nav prev"
          onClick={() => setPage(Math.max(0, page - 1) as 0 | 1 | 2 | 3)}
          disabled={page === 0}
          title="Previous page"
        >‹</button>
        <button
          className="craft-book-nav next"
          onClick={() => setPage(Math.min(3, page + 1) as 0 | 1 | 2 | 3)}
          disabled={page === 3}
          title="Next page"
        >›</button>
        <div className="craft-book-page-label">
          {pageTitle(page, kind)} (Pair {Math.floor(page / 2) + 1} / 2)
        </div>
        <button className="craft-book-close" onClick={onClose} title="Close (Esc)">×</button>
      </div>
    </div>
  );
}

function pageTitle(page: 0 | 1 | 2 | 3, kind: PortKind): string {
  const word = kind === "port" ? "Ships" : "Airships";
  if (page === 0) return word;
  if (page === 1) return "Board";
  if (page === 2) return "Load Cargo";
  return "Cargo Manifest";
}

/** Page 4 — read-only summary of what's currently sitting in a docked
 *  vessel's cargo hold. Useful sanity-check before takeoff so the
 *  player knows what's actually loaded; the Load Cargo page already
 *  shows per-row aboard counts but they're easy to miss in the editor. */
function CargoManifestPage({
  dockedVessels, selectedVessel, setSelectedVesselId,
}: {
  dockedVessels: Vessel[];
  selectedVessel: Vessel | null;
  setSelectedVesselId: (id: number | null) => void;
}) {
  return (
    <div className="craft-book-cargo-page">
      <h3 className="craft-book-page-h3">Cargo Manifest</h3>
      <div className="craft-book-vessel-picker">
        {dockedVessels.length === 0 ? (
          <div className="craft-book-empty">No docked vessels here.</div>
        ) : dockedVessels.map((v) => {
          const def = getVesselDef(v.defKey);
          const used = vesselCargoUsed(v);
          const selected = selectedVessel?.id === v.id;
          return (
            <button
              key={v.id}
              className={`craft-book-vessel-pick${selected ? " selected" : ""}`}
              onClick={() => setSelectedVesselId(selected ? null : v.id)}
            >
              <span>{def?.label ?? v.defKey}</span>
              <span className="craft-book-cargo-fill">{Math.round(used)} aboard</span>
            </button>
          );
        })}
      </div>
      {selectedVessel && selectedVessel.inventory ? (
        <div className="craft-book-manifest-rows">
          {RESOURCE_KEYS
            .filter((k) => (selectedVessel.inventory?.[k] ?? 0) > 0)
            .map((k) => (
              <div key={k} className="craft-book-manifest-row">
                <span className="craft-book-cargo-name">{RES_SHORT[k]}</span>
                <span>{Math.floor(selectedVessel.inventory?.[k] ?? 0)}</span>
              </div>
            ))}
          {RESOURCE_KEYS.every((k) => (selectedVessel.inventory?.[k] ?? 0) === 0) && (
            <div className="craft-book-empty">Empty hold.</div>
          )}
        </div>
      ) : selectedVessel ? (
        <div className="craft-book-empty">Empty hold.</div>
      ) : null}
    </div>
  );
}

function BoardPage({
  boardedCount, onBoard, kind, dockedVessels, onLaunch, onAssignCrew, onSetRoute,
}: {
  boardedCount: number;
  onBoard?: () => void;
  kind: PortKind;
  dockedVessels: Vessel[];
  onLaunch?: (vesselId: number) => void;
  onAssignCrew?: (vesselId: number) => void;
  onSetRoute?: (vesselId: number) => void;
}) {
  return (
    <div className="craft-book-board-page">
      <h3 className="craft-book-page-h3">Crew & Boarding</h3>
      <div className="craft-book-board-row">
        <span>Crew aboard (all docks): {boardedCount}</span>
        {onBoard && (
          <button
            className="craft-book-board-btn"
            onClick={onBoard}
            title="Send the nearest idle villager aboard"
          >+ Board villager</button>
        )}
      </div>
      <div className="craft-book-vessel-list">
        {dockedVessels.length === 0 ? (
          <div className="craft-book-empty">No {kind === "port" ? "ships" : "airships"} docked.</div>
        ) : dockedVessels.map((v) => {
          const def = getVesselDef(v.defKey);
          const need = def?.crew ?? 0;
          const have = v.boardedVillagerIds.length;
          const ready = need === 0 || have >= need;
          const stillNeeds = Math.max(0, need - have);
          const canAssign = kind === "airship_port" && need > 0 && have < need && boardedCount > 0;
          return (
            <div key={v.id} className="craft-book-vessel-row">
              <span className="craft-book-vessel-name">{def?.label ?? v.defKey}</span>
              <span className={`craft-book-vessel-crew${need > 0 && have < need ? " short" : ""}`}>
                {have} / {need} crew
              </span>
              {/* Airship-only: pull boarded dock villagers onto THIS
                  airship. Disabled when the vessel already has full crew
                  or the dock has no villagers waiting. */}
              {onAssignCrew && kind === "airship_port" && need > 0 && (
                <button
                  className="craft-book-assign-btn"
                  disabled={!canAssign}
                  onClick={() => onAssignCrew(v.id)}
                  title={canAssign
                    ? `Send ${Math.min(stillNeeds, boardedCount)} dock villager(s) aboard this airship`
                    : have >= need
                      ? "Crew already full"
                      : "No villagers waiting at the dock — use + Board villager first"}
                >
                  Crew up
                </button>
              )}
              {/* "Set Route" tool — closes the dock window and lets
                  the player drop waypoints on the world. Available on
                  both naval and airship docks; the route renders as
                  a Bezier curve through the waypoints, and the vessel
                  follows it when launched. */}
              {onSetRoute && (
                <button
                  className="craft-book-route-btn"
                  onClick={() => onSetRoute(v.id)}
                  title="Draw a flight path on the world for this vessel — click to add waypoints, right-click to mark a deboard point."
                >
                  Set Route
                </button>
              )}
              {onLaunch && (
                <button
                  className="craft-book-launch-btn"
                  disabled={!ready}
                  onClick={() => onLaunch(v.id)}
                  title={ready
                    ? (kind === "port" ? "Sail this ship out" : "Take off")
                    : `Needs ${need} crew — board ${need - have} more`}
                >
                  {kind === "port" ? "Sail" : "Launch"} →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LoadCargoPage({
  state, dockedVessels, selectedVessel, setSelectedVesselId,
  onLoadCargo, onUnloadAll,
}: {
  state: GameState;
  dockedVessels: Vessel[];
  selectedVessel: Vessel | null;
  setSelectedVesselId: (id: number | null) => void;
  onLoadCargo?: (vesselId: number, kind: ResourceKind, amount: number) => void;
  onUnloadAll?: (vesselId: number) => void;
}) {
  const player = state.players[state.humanId];
  return (
    <div className="craft-book-cargo-page">
      <h3 className="craft-book-page-h3">Load Cargo</h3>
      <div className="craft-book-vessel-picker">
        {dockedVessels.length === 0 ? (
          <div className="craft-book-empty">No docked vessels here. Craft one first.</div>
        ) : dockedVessels.map((v) => {
          const def = getVesselDef(v.defKey);
          const cap = vesselCargoCap(v.defKey);
          const used = vesselCargoUsed(v);
          const selected = selectedVessel?.id === v.id;
          return (
            <button
              key={v.id}
              className={`craft-book-vessel-pick${selected ? " selected" : ""}`}
              onClick={() => setSelectedVesselId(selected ? null : v.id)}
            >
              <span>{def?.label ?? v.defKey}</span>
              <span className="craft-book-cargo-fill">{Math.round(used)} / {cap}</span>
            </button>
          );
        })}
      </div>
      {selectedVessel && (
        <CargoEditor
          vessel={selectedVessel}
          playerResources={player.resources}
          onLoadCargo={onLoadCargo}
          onUnloadAll={onUnloadAll}
        />
      )}
    </div>
  );
}

function CargoEditor({
  vessel, playerResources, onLoadCargo, onUnloadAll,
}: {
  vessel: Vessel;
  playerResources: Record<ResourceKind, number>;
  onLoadCargo?: (vesselId: number, kind: ResourceKind, amount: number) => void;
  onUnloadAll?: (vesselId: number) => void;
}) {
  const cap = vesselCargoCap(vessel.defKey);
  const used = vesselCargoUsed(vessel);
  const space = Math.max(0, cap - used);
  // Only show resource rows the player actually has something of, or
  // that are already on the vessel — otherwise the editor balloons to
  // 19 always-empty rows.
  const rows = RESOURCE_KEYS.filter((k) => playerResources[k] > 0 || (vessel.inventory?.[k] ?? 0) > 0);
  return (
    <div className="craft-book-cargo-editor">
      <div className="craft-book-cargo-hdr">
        <span>Aboard: {Math.round(used)} / {cap}</span>
        <button
          className="craft-book-unload-btn"
          disabled={used === 0}
          onClick={() => onUnloadAll?.(vessel.id)}
          title="Move every resource on the vessel back into the tribe stockpile"
        >Unload All</button>
      </div>
      <div className="craft-book-cargo-rows">
        {rows.length === 0 ? (
          <div className="craft-book-empty">Nothing to load.</div>
        ) : rows.map((k) => {
          const have = Math.floor(playerResources[k]);
          const onBoard = Math.floor(vessel.inventory?.[k] ?? 0);
          const can1   = have >= 1   && space >= 1;
          const can10  = have >= 10  && space >= 10;
          const can100 = have >= 100 && space >= 100;
          return (
            <div key={k} className="craft-book-cargo-row">
              <span className="craft-book-cargo-name">{RES_SHORT[k]}</span>
              <span className="craft-book-cargo-have">stock {have}</span>
              <span className="craft-book-cargo-aboard">aboard {onBoard}</span>
              <button disabled={!can1}   onClick={() => onLoadCargo?.(vessel.id, k, 1)}>+1</button>
              <button disabled={!can10}  onClick={() => onLoadCargo?.(vessel.id, k, 10)}>+10</button>
              <button disabled={!can100} onClick={() => onLoadCargo?.(vessel.id, k, 100)}>+100</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function canAfford(resources: Record<ResourceKind, number>, cost: VesselDef["cost"]): boolean {
  for (const k in cost) {
    const need = cost[k as ResourceKind] ?? 0;
    if (resources[k as ResourceKind] < need) return false;
  }
  return true;
}

function costLine(cost: VesselDef["cost"]): string {
  const parts: string[] = [];
  for (const k in cost) {
    parts.push(`${cost[k as ResourceKind]} ${RES_SHORT[k as ResourceKind]}`);
  }
  return parts.length === 0 ? "free" : parts.join(" + ");
}
