import type { GameState } from "./state";
import type { Camera } from "../render/camera";

/**
 * Crash-recovery save layer (IndexedDB).
 *
 * The whole `GameState` — including the world's typed arrays (kind, heat,
 * coastDist, …, owner, troops, riverMask, props, …) — is persisted via
 * structured-clone into IndexedDB. On resume we read it back, hand the
 * state straight to the Renderer, and skip `buildWorld` entirely. No more
 * "generating world…" on a reload.
 *
 * localStorage was the previous backend; it caps around 5–10 MB which is
 * nowhere near the ~250 MB the world arrays consume. IDB has no such
 * limit (roughly half of available disk on modern browsers) and supports
 * typed arrays + Sets + Maps directly via the structured-clone algorithm.
 *
 * Schema is versioned via SAVE_VERSION — bump it to invalidate older
 * saves cleanly when the GameState shape changes.
 */
const DB_NAME = "pixelwargame";
const DB_VERSION = 1;
const STORE = "saves";
const KEY = "current";
const SAVE_VERSION = 2;

export interface SaveData {
  version: number;
  savedAt: number;
  /** Full game state, including the world. Structured-clone reconstructs
   *  Sets, Maps, and typed arrays losslessly, so this object can be
   *  handed straight to the engine on resume. */
  state: GameState;
  camera: { x: number; y: number; zoom: number } | null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Snapshot the current state to IDB. Async; failures (quota, IDB
 *  unavailable in private mode, etc.) are logged and the previous save
 *  is left in place. Safe to fire-and-forget. */
export async function saveGame(state: GameState, camera: Camera | null): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const data: SaveData = {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        state,
        camera: camera ? { x: camera.x, y: camera.y, zoom: camera.zoom } : null,
      };
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[persist] saveGame failed:", e);
  }
}

/** Read the most recent save. Returns null on miss or on a schema-
 *  version mismatch — older saves are silently discarded so the UI
 *  doesn't offer Resume buttons that would crash on apply. */
export async function loadSave(): Promise<SaveData | null> {
  try {
    const db = await openDB();
    const data = await new Promise<SaveData | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!data || data.version !== SAVE_VERSION) return null;
    return data;
  } catch (e) {
    console.warn("[persist] loadSave failed:", e);
    return null;
  }
}

/** Delete the persisted save. Called on "New Game". */
export async function clearSave(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[persist] clearSave failed:", e);
  }
}

/** Backwards-compat stub. The old layer overlaid tribe fields onto a
 *  freshly-rebuilt world; the new layer saves the world inside the
 *  save itself, so the loader in App.tsx uses save.state directly. */
export function applySave(_state: GameState, _save: SaveData): void {
  // intentionally empty
}

/** Backwards-compat stub. Use `loadSave()` (async) and check for null. */
export function hasSave(): boolean { return false; }
