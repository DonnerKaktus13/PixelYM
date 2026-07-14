import type { GameState } from "../game/state";

interface Props {
  state: GameState;
  /** Bumps when state changes — used to force re-render. */
  tick: number;
  selectedEnemyId: number | null;
}

export function HUD({ state, selectedEnemyId }: Props) {
  const w = state.world;
  const human = state.players[state.humanId];
  const ranked = [...state.players].sort((a, b) => w.ownedCount[b.id] - w.ownedCount[a.id]);
  const totalLand = ranked.reduce((s, p) => s + w.ownedCount[p.id], 0);

  return (
    <div className="hud-top">
      <div className="panel stats">
        <div className="stat-row"><span className="k">Troops</span><span>{Math.floor(human.troopReserve)}</span></div>
        <div className="stat-row"><span className="k">Gold</span><span>{Math.floor(human.resources.gold)}</span></div>
        <div className="stat-row"><span className="k">Territory</span><span>{w.ownedCount[human.id]}</span></div>
        {selectedEnemyId !== null && selectedEnemyId !== state.humanId && (
          <div className="stat-row" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <span className="k">Target</span>
            <span style={{ color: state.players[selectedEnemyId].color }}>
              {state.players[selectedEnemyId].name}
            </span>
          </div>
        )}
      </div>

      <div className="panel leaderboard">
        <h3>Leaderboard</h3>
        {ranked.map((p) => {
          const size = w.ownedCount[p.id];
          const pct = totalLand > 0 ? ((size / totalLand) * 100).toFixed(1) : "0.0";
          return (
            <div
              key={p.id}
              className={`leaderboard-row ${p.id === state.humanId ? "you" : ""} ${!p.alive ? "dead" : ""}`}
            >
              <div className="swatch" style={{ background: p.color }} />
              <div>{p.name}</div>
              <div>{pct}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
