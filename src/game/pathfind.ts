import { TileKind, type World } from "./types";

/**
 * Villager-grade tile pathfinding.
 *
 * Passability: Land tiles are walkable. Sea tiles are walkable ONLY if
 * `world.riverMask[idx] === 1` — i.e. a carved river. Mountains, ice, and
 * un-masked sea are blocked.
 *
 * Algorithm: 4-connected A* with Manhattan heuristic over a bounded
 * search rectangle that hugs the start→goal line. Bounded so a villager
 * who needs to cross half the world doesn't churn millions of nodes; if
 * the bound is too tight to find a path the caller falls back to bridge
 * placement logic.
 */

/** True if a villager can step onto this tile. */
export function isWalkable(world: World, idx: number): boolean {
  // Volcano cones (and any future impassable props) are stamped into
  // world.blockedByProp at worldgen time so pathfind doesn't have to
  // intersect each prop's bbox on every node expansion. blockedByProp
  // may be missing on older saves — guard with the optional chain.
  if (world.blockedByProp && world.blockedByProp[idx] === 1) return false;
  const k = world.kind[idx];
  if (k === TileKind.Sea) return world.riverMask[idx] === 1;
  // Mountain / Ice / Hole (player-dug pit) are blocked; everything else
  // Land+ is fine. Holes are never traversable even when full of water —
  // the user wants the pit itself to be an obstacle.
  return k !== TileKind.Mountain && k !== TileKind.Ice && k !== TileKind.Hole;
}

/** Convenience: tile index in the world array. */
export function tileIdx(world: World, x: number, y: number): number {
  return y * world.width + x;
}

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/** Open-set min-heap entry. Keyed by `f = g + h`. */
interface Node {
  idx: number;
  g: number;
  f: number;
}

/** A* from `startIdx` to `endIdx`. Returns null if no path exists within
 *  the bounded search window. Path is a sequence of tile indices starting
 *  with `startIdx` and ending with `endIdx`. */
export function findPath(
  world: World,
  startIdx: number,
  endIdx: number,
  maxNodes: number = 40000
): number[] | null {
  if (startIdx === endIdx) return [startIdx];
  if (!isWalkable(world, endIdx)) return null;
  const W = world.width;
  const H = world.height;
  const sx = startIdx % W;
  const sy = (startIdx / W) | 0;
  const ex = endIdx % W;
  const ey = (endIdx / W) | 0;

  // Bound the search to a generous rectangle around start↔goal so A*
  // doesn't run away across an unrelated continent. Widened from 80 →
  // 200 along with the maxNodes bump because long player-issued
  // moveTo orders kept tripping the old bound and freezing the
  // villager when their cached path failed mid-walk.
  const minX = Math.max(0, Math.min(sx, ex) - 200);
  const maxX = Math.min(W - 1, Math.max(sx, ex) + 200);
  const minY = Math.max(0, Math.min(sy, ey) - 200);
  const maxY = Math.min(H - 1, Math.max(sy, ey) + 200);

  // gScore / cameFrom over a Map (sparse; world has millions of tiles).
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  // Tiny binary heap on f.
  const open: Node[] = [];
  const pushOpen = (n: Node) => {
    open.push(n);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p].f <= open[i].f) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const popOpen = (): Node | undefined => {
    if (open.length === 0) return undefined;
    const top = open[0];
    const last = open.pop()!;
    if (open.length > 0) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let smallest = i;
        if (l < open.length && open[l].f < open[smallest].f) smallest = l;
        if (r < open.length && open[r].f < open[smallest].f) smallest = r;
        if (smallest === i) break;
        [open[i], open[smallest]] = [open[smallest], open[i]];
        i = smallest;
      }
    }
    return top;
  };

  gScore.set(startIdx, 0);
  pushOpen({ idx: startIdx, g: 0, f: Math.abs(ex - sx) + Math.abs(ey - sy) });

  let visited = 0;
  while (open.length > 0) {
    const cur = popOpen()!;
    if (cur.idx === endIdx) {
      // Reconstruct.
      const out: number[] = [endIdx];
      let p = endIdx;
      while (cameFrom.has(p)) {
        p = cameFrom.get(p)!;
        out.push(p);
      }
      out.reverse();
      return out;
    }
    if (cur.g > (gScore.get(cur.idx) ?? Infinity)) continue;
    visited++;
    if (visited > maxNodes) return null;

    const cx = cur.idx % W;
    const cy = (cur.idx / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const nIdx = ny * W + nx;
      if (!isWalkable(world, nIdx)) continue;
      const ng = cur.g + 1;
      const prev = gScore.get(nIdx);
      if (prev !== undefined && ng >= prev) continue;
      gScore.set(nIdx, ng);
      cameFrom.set(nIdx, cur.idx);
      const h = Math.abs(ex - nx) + Math.abs(ey - ny);
      pushOpen({ idx: nIdx, g: ng, f: ng + h });
    }
  }
  return null;
}

/** Walk a Bresenham line from `(sx, sy)` to `(ex, ey)` and return the
 *  first tile-index on that line that is impassable AND not a river. Used
 *  by the bridge mechanic when A* fails: that tile is the natural place
 *  to drop wood. Returns -1 if the line is clear. */
export function firstBlocker(
  world: World,
  sx: number, sy: number,
  ex: number, ey: number
): number {
  const W = world.width;
  let x = sx, y = sy;
  const adx = Math.abs(ex - sx);
  const ady = Math.abs(ey - sy);
  const stx = sx < ex ? 1 : -1;
  const sty = sy < ey ? 1 : -1;
  let err = adx - ady;
  while (true) {
    const i = y * W + x;
    if (!isWalkable(world, i) && world.kind[i] === TileKind.Sea) return i;
    if (x === ex && y === ey) return -1;
    const e2 = err * 2;
    if (e2 > -ady) { err -= ady; x += stx; }
    if (e2 < adx) { err += adx; y += sty; }
  }
}
