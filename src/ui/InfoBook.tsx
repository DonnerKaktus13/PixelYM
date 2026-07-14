import { useEffect, useState } from "react";
import {
  countRoles, getArmyStrength, getGuardStrength, getPlayerScore,
  getPopulationCap, getPopulationUsed, VILLAGER_MEAT_COST,
  getRelation, scoutDeclareWar, scoutProposeAlliance, scoutProposeTruce,
  type GameState,
} from "../game/state";
import {
  RELATION_ALLY, RELATION_TRUCE, RELATION_WAR,
  RESOURCE_KEYS, type ResourceKind,
} from "../game/types";
import { BUILDINGS } from "../game/catalog";

interface Props {
  state: GameState;
  tick: number;
  onClose: () => void;
  /** Surface a transient warning toast (e.g. "Requires Spear"). Mostly
   *  used by the villager role gates — without the spear unlocked, the
   *  player can't promote villagers to army / guard. */
  onWarn: (message: string) => void;
}

/** Total pages in the blue book. Page indices: 0 = resources, 1 =
 *  villagers + diplomacy, 2 = structures. Add another entry here when
 *  you add a new page and the prev/next buttons will wrap correctly. */
const PAGES = ["Resources", "Villagers & Diplomacy", "Structures"];

/** Page-flip animation. Sequence: bookblue1 → bookblue2 → bookblue3 →
 *  bookblueopend, each frame held for FLIP_FRAME_MS. Total ~3 × frame
 *  duration before content shows again on the new page. */
const FLIP_FRAMES = [
  "/IMG/HUD/bookblue1.png",
  "/IMG/HUD/bookblue2.png",
  "/IMG/HUD/bookblue3.png",
];
const REST_FRAME = "/IMG/HUD/bookblueopend.png";
const FLIP_FRAME_MS = 90;

/** Blue Info Book — meta panel showing resources, villager management
 *  (with spear-gate), structures, and diplomacy. Multi-page with a
 *  page-turn animation built from the bookblue1/2/3 frames. */
export function InfoBook({ state, onClose, onWarn }: Props) {
  const [page, setPage] = useState(0);
  const [flipFrame, setFlipFrame] = useState<number>(-1);  // -1 = rest, 0..2 = animating

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Trigger a page-turn: cycle through the three flip frames, then
   *  swap to `newPage` on the way back to the rest frame. Bail if we're
   *  already mid-flip so spam clicks don't desync the timer chain. */
  const flipTo = (newPage: number) => {
    if (flipFrame !== -1) return;
    setFlipFrame(0);
    setTimeout(() => {
      setFlipFrame(1);
      setTimeout(() => {
        setFlipFrame(2);
        setTimeout(() => {
          setPage(newPage);
          setFlipFrame(-1);
        }, FLIP_FRAME_MS);
      }, FLIP_FRAME_MS);
    }, FLIP_FRAME_MS);
  };

  const prevPage = () => flipTo((page - 1 + PAGES.length) % PAGES.length);
  const nextPage = () => flipTo((page + 1) % PAGES.length);

  const bgSrc = flipFrame === -1 ? REST_FRAME : FLIP_FRAMES[flipFrame];
  const human = state.players[state.humanId];
  const hasSpear = (human.tools.spear ?? 0) > 0;

  return (
    <div className="info-book-overlay" onClick={onClose}>
      <div className="info-book-panel" onClick={(e) => e.stopPropagation()}>
        <img className="info-book-bg" src={bgSrc} alt="" draggable={false} />
        {/* Content only renders on the rest frame — while the book is
            flipping, the pages would otherwise jump around. */}
        {flipFrame === -1 && (
          <div className="info-book-pages">
            {page === 0 && <ResourcesPage state={state} />}
            {page === 1 && (
              <VillagersPage
                state={state}
                hasSpear={hasSpear}
                onLockedAction={() => onWarn("Requires Spear")}
              />
            )}
            {page === 2 && <StructuresPage state={state} />}
          </div>
        )}

        {/* Page navigation — arrows tucked into the bottom corners of
            the spread, page indicator in the centre. */}
        <button className="info-book-nav prev" onClick={prevPage} title="Previous page">‹</button>
        <button className="info-book-nav next" onClick={nextPage} title="Next page">›</button>
        <div className="info-book-page-label">{PAGES[page]} ({page + 1} / {PAGES.length})</div>
        <button className="info-book-close" onClick={onClose} title="Close (Esc)">×</button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Pages
// ----------------------------------------------------------------------

function ResourcesPage({ state }: { state: GameState }) {
  const human = state.players[state.humanId];
  // Per-tick production summed across all the player's structures.
  // Matches the catalog's `produces` table; the special-cased meat /
  // mill conversions aren't reflected here yet — TODO when the eng.
  // export tracks them.
  const production: Record<string, number> = {};
  for (const s of state.structures) {
    if (s.ownerId !== state.humanId) continue;
    const def = BUILDINGS.find((b) => b.key === s.defKey);
    if (!def) continue;
    for (const k in def.produces) {
      production[k] = (production[k] ?? 0) + (def.produces[k as keyof typeof def.produces] ?? 0);
    }
  }
  return (
    <div className="info-book-spread">
      <div className="info-book-page">
        <h3>Resources</h3>
        <table className="info-table">
          <tbody>
            {RESOURCE_KEYS.slice(0, 10).map((k) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td className="v">{Math.floor(human.resources[k as ResourceKind])}</td>
                <td className="pv">{(production[k] ?? 0) > 0 ? `+${(production[k] ?? 0).toFixed(2)}/t` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="info-book-page">
        <h3>Resources (cont.)</h3>
        <table className="info-table">
          <tbody>
            {RESOURCE_KEYS.slice(10).map((k) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td className="v">{Math.floor(human.resources[k as ResourceKind])}</td>
                <td className="pv">{(production[k] ?? 0) > 0 ? `+${(production[k] ?? 0).toFixed(2)}/t` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VillagersPage({
  state, hasSpear, onLockedAction,
}: { state: GameState; hasSpear: boolean; onLockedAction: () => void; }) {
  const roles = countRoles(state, state.humanId);
  return (
    <div className="info-book-spread">
      <div className="info-book-page">
        <h3>Villagers</h3>
        <table className="info-table">
          <tbody>
            <tr><td className="k">Workers</td><td className="v">{roles.worker}</td></tr>
            <tr><td className="k">Guards</td><td className="v">{roles.guard}</td></tr>
            <tr><td className="k">Army</td><td className="v">{roles.army}</td></tr>
            <tr className="info-total">
              <td className="k">Total</td>
              <td className="v">{roles.worker + roles.guard + roles.army}</td>
            </tr>
          </tbody>
        </table>
        <p className="info-tip">
          {hasSpear
            ? "Click a villager in the world to cycle role: worker → guard → army → worker."
            : "Army & Guard roles unlock when you craft a Spear at the Workbench."}
        </p>
        <table className="info-table">
          <tbody>
            <tr>
              <td className="k">Population</td>
              <td className="v">
                {getPopulationUsed(state, state.humanId)} / {getPopulationCap(state, state.humanId)}
              </td>
            </tr>
            <tr><td className="k">New villager cost</td><td className="v">{VILLAGER_MEAT_COST} meat</td></tr>
            <tr><td className="k">Army strength</td><td className="v">{getArmyStrength(state, state.humanId)}</td></tr>
            <tr><td className="k">Guard strength</td><td className="v">{getGuardStrength(state, state.humanId)}</td></tr>
            <tr><td className="k">Score</td><td className="v">{Math.floor(getPlayerScore(state, state.humanId))}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="info-book-page">
        <h3>Diplomacy</h3>
        <p className="info-tip">Send a scout to change relations. Declared war = +25% attack damage.</p>
        <table className="info-table">
          <thead>
            <tr><th>Tribe</th><th>Status</th><th>Score</th><th colSpan={3}>Scout</th></tr>
          </thead>
          <tbody>
            {state.players.filter((p) => p.id !== state.humanId && p.alive).map((p) => {
              const rel = getRelation(state, state.humanId, p.id);
              const label =
                rel === RELATION_WAR ? "WAR" :
                rel === RELATION_TRUCE ? "truce" :
                rel === RELATION_ALLY ? "ally" : "neutral";
              const cls =
                rel === RELATION_WAR ? "war" :
                rel === RELATION_TRUCE ? "truce" :
                rel === RELATION_ALLY ? "ally" : "neutral";
              const gateOr = (fn: () => void) => () => {
                if (!hasSpear) { onLockedAction(); return; }
                fn();
              };
              return (
                <tr key={p.id}>
                  <td className="k" style={{ color: p.color }}>{p.name}</td>
                  <td className={`rel-${cls}`}>{label}</td>
                  <td className="v">{Math.floor(getPlayerScore(state, p.id))}</td>
                  <td><button className="info-btn war"   onClick={gateOr(() => scoutDeclareWar(state, state.humanId, p.id))}>War</button></td>
                  <td><button className="info-btn truce" onClick={() => scoutProposeTruce(state, state.humanId, p.id)}>Truce</button></td>
                  <td><button className="info-btn ally"  onClick={() => scoutProposeAlliance(state, state.humanId, p.id)}>Ally</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StructuresPage({ state }: { state: GameState }) {
  const counts: Record<string, number> = {};
  for (const s of state.structures) {
    if (s.ownerId !== state.humanId) continue;
    counts[s.defKey] = (counts[s.defKey] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="info-book-spread">
      <div className="info-book-page">
        <h3>Structures</h3>
        <table className="info-table">
          <tbody>
            {entries.length === 0 ? (
              <tr><td className="k">—</td><td className="v">None</td></tr>
            ) : entries.slice(0, Math.ceil(entries.length / 2)).map(([k, c]) => (
              <tr key={k}><td className="k">{k}</td><td className="v">{c}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="info-book-page">
        <h3>Structures (cont.)</h3>
        <table className="info-table">
          <tbody>
            {entries.slice(Math.ceil(entries.length / 2)).map(([k, c]) => (
              <tr key={k}><td className="k">{k}</td><td className="v">{c}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
