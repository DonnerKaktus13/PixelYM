/**
 * Seedable RNG used by worldgen so the same `worldSeed` regenerates an
 * identical map. Without this, every reload re-rolls all of `Math.random`
 * and the user's persisted save lands on a different world.
 *
 * Implementation is mulberry32 — a tiny, fast 32-bit RNG with good
 * distribution for procedural-generation use. Not cryptographically
 * secure (we don't need that here).
 *
 * Usage:
 *   seedRng(state.worldSeed);
 *   const x = rand();   // [0, 1) — drop-in replacement for Math.random
 *
 * The state is module-global, so anyone importing `rand` from this file
 * sees the same sequence. Worldgen calls `seedRng` once at the top of
 * `buildWorld`; nothing else needs to track the cursor.
 */

let _state = 0x12345678;

/** Seed the RNG. Idempotent — call this at the start of any
 *  deterministic block (currently just worldgen). */
export function seedRng(seed: number): void {
  // Force to non-zero so the first call doesn't degenerate.
  _state = ((seed | 0) || 0x12345678) >>> 0;
}

/** Mulberry32. Returns a float in [0, 1). */
export function rand(): number {
  let t = _state = (_state + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Pick a fresh non-zero 32-bit seed. Used at game-start when no save
 *  is present, so a new session gets its own world. */
export function freshWorldSeed(): number {
  // Math.random is fine HERE — we just need entropy for the seed itself.
  return ((Math.random() * 0xffffffff) | 0) >>> 0 || 1;
}
