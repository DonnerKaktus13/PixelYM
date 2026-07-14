import { UNOWNED, isOwnable } from "./types";
import type { GameState } from "./state";
import { neighbors } from "./world";
import { launchAttack, launchExpansion } from "./combat";

/**
 * Per-tick AI. Each bot decides whether to expand into unowned land
 * or attack a weaker neighbor.
 */
export function runAI(state: GameState): void {
  const w = state.world;
  for (const p of state.players) {
    if (!p.alive || p.isHuman) continue;
    if (w.ownedCount[p.id] === 0) continue;
    if (p.attacks.length > 1) continue; // already committed
    if (state.tick % 8 !== p.id % 8) continue; // stagger decisions

    const totalReserve = p.troopReserve;
    if (totalReserve < 30) continue;

    // Survey neighbors via border tiles.
    const neighborStrength = new Map<number, number>(); // playerId or UNOWNED -> their tile count on our border
    const nbuf: number[] = [];
    let unownedAdj = 0;
    for (const idx of w.borders[p.id]) {
      const nlen = neighbors(w, idx, nbuf);
      for (let i = 0; i < nlen; i++) {
        const n = nbuf[i];
        if (!isOwnable(w.kind[n])) continue;
        const o = w.owner[n];
        if (o === p.id) continue;
        if (o === UNOWNED) {
          unownedAdj++;
        } else {
          neighborStrength.set(o, (neighborStrength.get(o) ?? 0) + 1);
        }
      }
    }

    const mySize = w.ownedCount[p.id];
    // Prefer expansion early game when unowned land is plentiful.
    const expansionWeight = unownedAdj * 2;

    // Score each neighbor — attack if they look weaker than us.
    let bestTarget = -1;
    let bestScore = expansionWeight;
    for (const [otherId, contactTiles] of neighborStrength) {
      const other = state.players[otherId];
      if (!other.alive) continue;
      const otherSize = w.ownedCount[otherId];
      const sizeRatio = mySize / Math.max(otherSize, 1);
      // Higher score = better target. Prefer weaker, more-exposed neighbors.
      const score = contactTiles * sizeRatio * (other.troopReserve < p.troopReserve ? 1.3 : 0.7);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = otherId;
      }
    }

    const commit = Math.floor(totalReserve * (0.4 + Math.random() * 0.3));
    if (bestTarget === -1) {
      launchExpansion(state, p.id, commit);
    } else {
      launchAttack(state, p.id, bestTarget, commit);
    }
  }
}
