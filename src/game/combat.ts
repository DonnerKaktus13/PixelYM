import { UNOWNED, isOwnable, type Attack } from "./types";
import { claimTile } from "./state";
import type { GameState } from "./state";
import { neighbors } from "./world";

/**
 * Launch an attack from `attackerId` against `defenderId` (or UNOWNED for expansion).
 * `troopsCommitted` is drawn from the attacker's reserve.
 * Returns the created Attack, or null if no valid front exists.
 */
export function launchAttack(
  state: GameState,
  attackerId: number,
  defenderId: number,
  troopsCommitted: number
): Attack | null {
  const w = state.world;
  const attacker = state.players[attackerId];
  if (!attacker.alive) return null;
  troopsCommitted = Math.min(troopsCommitted, attacker.troopReserve);
  if (troopsCommitted < 1) return null;

  // Find border tiles of attacker adjacent to defender tiles.
  const front = new Set<number>();
  const nbuf: number[] = [];
  for (const idx of w.borders[attackerId]) {
    const nlen = neighbors(w, idx, nbuf);
    for (let i = 0; i < nlen; i++) {
      const n = nbuf[i];
      if (!isOwnable(w.kind[n])) continue;
      if (w.owner[n] === defenderId) {
        front.add(n);
        break;
      }
    }
  }
  if (front.size === 0) return null;

  attacker.troopReserve -= troopsCommitted;
  const atk: Attack = {
    attackerId,
    defenderId,
    remaining: troopsCommitted,
    front,
  };
  attacker.attacks.push(atk);
  return atk;
}

/**
 * Launch a neutral expansion — push outward into unowned land.
 * Cheaper per tile than an attack since defenders are zero or weak.
 */
export function launchExpansion(state: GameState, playerId: number, troopsCommitted: number): Attack | null {
  const w = state.world;
  const player = state.players[playerId];
  if (!player.alive) return null;
  troopsCommitted = Math.min(troopsCommitted, player.troopReserve);
  if (troopsCommitted < 1) return null;

  const front = new Set<number>();
  const nbuf: number[] = [];
  for (const idx of w.borders[playerId]) {
    const nlen = neighbors(w, idx, nbuf);
    for (let i = 0; i < nlen; i++) {
      const n = nbuf[i];
      if (!isOwnable(w.kind[n])) continue;
      if (w.owner[n] === UNOWNED) {
        front.add(n);
      }
    }
  }
  if (front.size === 0) return null;

  player.troopReserve -= troopsCommitted;
  const atk: Attack = {
    attackerId: playerId,
    defenderId: UNOWNED,
    remaining: troopsCommitted,
    front,
  };
  player.attacks.push(atk);
  return atk;
}

/**
 * Advance one attack by one tick: consume some troops to convert front tiles.
 * Returns true if the attack should continue, false if exhausted.
 */
export function stepAttack(state: GameState, atk: Attack): boolean {
  const w = state.world;
  if (atk.front.size === 0 || atk.remaining <= 0) return false;

  // Pick how many tiles to convert this tick — scale with front size and remaining troops.
  const isExpansion = atk.defenderId === UNOWNED;
  // Cost per tile = local defender troops + base resistance.
  // To prevent runaway expansions consuming entire continents, we cap tiles/tick.
  const maxConvert = Math.min(atk.front.size, Math.ceil(Math.sqrt(atk.remaining) * (isExpansion ? 3 : 2)));

  const frontArr = Array.from(atk.front);
  // Shuffle for natural-looking spread.
  for (let i = frontArr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [frontArr[i], frontArr[j]] = [frontArr[j], frontArr[i]];
  }

  let converted = 0;
  const nbuf: number[] = [];
  const newFront = new Set<number>();

  for (const idx of frontArr) {
    if (converted >= maxConvert || atk.remaining <= 0) {
      newFront.add(idx);
      continue;
    }
    if (w.owner[idx] !== atk.defenderId) {
      // Tile state changed since front was sampled — drop it.
      continue;
    }
    const defenderTroops = w.troops[idx];
    const cost = isExpansion ? 0.5 : defenderTroops + 1.5;
    if (atk.remaining < cost) {
      newFront.add(idx);
      continue;
    }
    atk.remaining -= cost;
    // Garrison the new tile with a small fraction.
    const garrison = isExpansion ? 1 : 2;
    claimTile(state, idx, atk.attackerId, garrison);
    converted++;

    // New front: this tile's neighbors that are still defender's.
    const nlen = neighbors(w, idx, nbuf);
    for (let i = 0; i < nlen; i++) {
      const n = nbuf[i];
      if (!isOwnable(w.kind[n])) continue;
      if (w.owner[n] === atk.defenderId) newFront.add(n);
    }
  }

  atk.front = newFront;
  return atk.remaining > 0 && atk.front.size > 0;
}
