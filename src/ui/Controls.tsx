interface Props {
  attackRatio: number;
  onAttackRatioChange: (v: number) => void;
  onExpand: () => void;
  canExpand: boolean;
  canAttack: boolean;
  hasTarget: boolean;
  onAttack: () => void;
  troopReserve: number;
}

export function Controls({
  attackRatio,
  onAttackRatioChange,
  onExpand,
  canExpand,
  canAttack,
  hasTarget,
  onAttack,
  troopReserve,
}: Props) {
  const pct = Math.round(attackRatio * 100);
  const commit = Math.floor(troopReserve * attackRatio);
  return (
    <div className="hud-bottom">
      <div className="panel slider-panel">
        <span style={{ opacity: 0.7, fontSize: 12 }}>Commit</span>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.01}
          value={attackRatio}
          onChange={(e) => onAttackRatioChange(parseFloat(e.target.value))}
        />
        <span className="pct">{pct}%</span>
        <span style={{ opacity: 0.7, fontSize: 12, marginLeft: 8 }}>= {commit} troops</span>
      </div>
      <div className="controls">
        <button onClick={onExpand} disabled={!canExpand}>Expand into wilds</button>
        <button onClick={onAttack} disabled={!canAttack || !hasTarget}>
          {hasTarget ? "Attack target" : "Click an enemy to target"}
        </button>
      </div>
    </div>
  );
}
