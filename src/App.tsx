import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { buildWorld } from "./game/world";
import { addVesselWaypoint, assignDockCrewToVessel, assignFarm, assignRockMine, assignTreeChop, autoAssignIdleWorkers, boardVillagerInAirshipPort, boardVillagerInNavalPort, buildStructure, canSpawnVillager, clearVesselPath, commitShovelStroke, countBoardedVillagers, craftTool, createGame, cycleVillagerRole, destroyStructure, findClosestRock, findClosestTree, findFarthestSpawnTile, findHomeTent, getPopulationCap, getPopulationUsed, launchVessel, loadCargoOntoVessel, moveVillagerTo, normalizeResumedState, paintFarmTile, paintHole, paintFill, pointNearOwnedBase, purchaseVesselAtPort, ROCK_PICK_DIST, seedWildlife, setSpriteAlphaSampler, SHOVEL_RANGE_FROM_BASE, spawnTribe, spawnVillagerAtHome, stopVillagerTask, structureAt, tileAt, TREE_PICK_DIST, tryDebitAggregate, unloadAllCargo, vesselAtPoint, villagerAt, type GameState } from "./game/state";
import { stepGame, syncVulcanoSprites } from "./game/engine";
import { isOwnable, type GameConfig } from "./game/types";
import { Renderer } from "./render/renderer";
import { clampCamera, makeCamera, screenToWorld, type Camera } from "./render/camera";
import { loadTextures, spriteAlphaAt } from "./render/textures";
import { Clouds } from "./render/clouds";
import { drawAllProps } from "./render/structures";
import { drawKingdomHulls } from "./render/kingdomHulls";
import { drawNightFog } from "./render/nightFog";
import { drawVulcanoEffects } from "./render/vulcanoEffects";
import { drawDayNightOverlay } from "./render/dayNight";
import { World3DView } from "./render3d/World3D";
import { BuildHUD, DESTROY_KEY, FARM_KEY, SHOVEL_KEY } from "./ui/BuildHUD";
import { PortWindow, type PortKind } from "./ui/PortWindow";
import { WorkbenchWindow } from "./ui/WorkbenchWindow";
import { getVesselDef } from "./game/vessels";
import { type ResourceKind } from "./game/types";
import { MainMenu } from "./ui/MainMenu";
import { MakeLobby } from "./ui/MakeLobby";
import { JoinLobby } from "./ui/JoinLobby";
import { InfoBook } from "./ui/InfoBook";
import { DevPanel } from "./ui/DevPanel";
import { SelectedVillagerCard } from "./ui/SelectedVillagerCard";
import { clearSave, loadSave, saveGame, type SaveData } from "./game/persist";

const SPAWN_TIMEOUT_SECONDS = 60;

const CONFIG: GameConfig = {
  // 7000×3500 = 24.5M tiles. With the renderer's SUB=2 sub-pixel offscreen
  // each tile gets a 2×2 patch of texture (14000×7000 offscreen, ~390 MB).
  // Going past 8192 here would exceed Chrome's canvas size limit at SUB=2.
  worldWidth: 7000,
  worldHeight: 3500,
  numBots: 15,
  tickMs: 100,
};

type Phase = "menu" | "makeLobby" | "joinLobby" | "loading" | "spawn" | "playing" | "ended";

/** Read a ?join=CODE query param from the URL, if any. Set by the QR
 *  code that a host shares — letting a joiner deep-link straight into
 *  the Join Lobby screen with the code pre-filled. */
function readJoinParam(): string {
  try {
    const url = new URL(window.location.href);
    return (url.searchParams.get("join") ?? "").toUpperCase();
  } catch {
    return "";
  }
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const cameraRef = useRef<Camera | null>(null);
  const cloudsRef = useRef<Clouds | null>(null);
  const viewSizeRef = useRef({ w: 0, h: 0 });
  // 3D world view. When `threeD` is on, a WebGL heightmap of the live world
  // is drawn on its own canvas overlaid on the 2D game. `threeDRef` mirrors
  // the state so the rAF loop (which only re-subscribes on phase change) can
  // read the current mode without a stale closure.
  const threeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const world3dRef = useRef<World3DView | null>(null);
  const threeDRef = useRef(false);
  const [threeD, setThreeD] = useState(false);
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number; moved: boolean }>({
    active: false, lastX: 0, lastY: 0, moved: false,
  });

  const initialJoinCode = useRef(readJoinParam()).current;
  const [phase, setPhase] = useState<Phase>(initialJoinCode ? "joinLobby" : "menu");
  const [error, setError] = useState<string | null>(null);
  const [buildKey, setBuildKey] = useState<string | null>(null);
  const [portOpen, setPortOpen] = useState<PortKind | null>(null);
  // Tracks WHICH port structure the player clicked to open the dock
  // window. Needed so onPurchase can actually call purchaseVesselAtPort
  // with a specific port id (otherwise the buy debits resources but
  // no vessel is created).
  const portStructureIdRef = useRef<number | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState<boolean>(false);
  // Click-and-move: first click on a villager sets this; second click
  // (anywhere on the world) dispatches them to that tile with job=moveTo.
  const [selectedVillagerId, setSelectedVillagerId] = useState<number | null>(null);
  // Farm-rectangle first corner. When buildKey === FARM_KEY, the first
  // click on the world stores its world coords here; the second click
  // commits the rectangle and clears this back to null.
  const farmCornerRef = useRef<{ x: number; y: number } | null>(null);
  // Tracks whether shift is currently held while in shovel mode. The
  // listener is mounted lazily when SHOVEL_KEY becomes the active build
  // key — without it the entire window would have keyboard handlers
  // active even in unrelated game states. Used by both onMouseDown and
  // onMouseMove so a drag started with shift held keeps filling even if
  // the player releases shift mid-drag (last value wins per stroke).
  const shovelShiftRef = useRef<boolean>(false);
  // Tracks the last painted world tile so onMouseMove can stamp the
  // brush at every cursor step, even when the mouse moves faster than
  // the React event cadence. Updated by paintShovelAt.
  const shovelLastPaintRef = useRef<{ x: number; y: number } | null>(null);
  // Current screen-space mouse position. Updated by onMouseMove regardless
  // of drag state so the render loop can draw a translucent shovel-brush
  // preview disk wherever the cursor sits while SHOVEL_KEY is active.
  const mouseScreenRef = useRef<{ x: number; y: number } | null>(null);
  // Airship flight-path editor. When non-null the player has clicked
  // a docked airship to enter path-edit mode for it: subsequent left
  // clicks on the world append waypoints to that vessel's flightPath,
  // right-clicks set the deboard marker (where half the crew jumps
  // out and the rest flies home), Enter / a confirm button launches,
  // Esc cancels. The id survives camera pans because it's stored on
  // a ref, not React state — fewer rerenders during fast edit-mode use.
  const [pathEditVesselId, setPathEditVesselId] = useState<number | null>(null);
  const [infoBookOpen, setInfoBookOpen] = useState<boolean>(false);
  const [devPanelOpen, setDevPanelOpen] = useState<boolean>(false);
  // Pull any persisted save up front so the MainMenu can offer "Resume".
  // The IDB load is async — savedStateRef starts as `undefined` (not yet
  // checked) and gets set to the SaveData or null when the load resolves.
  // The menu's Resume button only appears once we know the result.
  const savedStateRef = useRef<SaveData | null | undefined>(undefined);
  const [hasSavedSession, setHasSavedSession] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    loadSave().then((data) => {
      if (cancelled) return;
      savedStateRef.current = data;
      setHasSavedSession(data !== null);
    });
    return () => { cancelled = true; };
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const [spawnSecondsLeft, setSpawnSecondsLeft] = useState(SPAWN_TIMEOUT_SECONDS);
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  const onResize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    c.width = (w * dpr) | 0;
    c.height = (h * dpr) | 0;
    c.style.width = w + "px";
    c.style.height = h + "px";
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viewSizeRef.current = { w, h };
    if (cameraRef.current && stateRef.current) {
      clampCamera(cameraRef.current, stateRef.current.world.width, stateRef.current.world.height, w, h);
    }
    // Keep the WebGL 3D canvas in lockstep with the 2D one.
    world3dRef.current?.setSize(w, h);
  }, []);

  // Toggle the 3D world view. Builds the WebGL view lazily on first use and
  // rebuilds its terrain from the current state each time it's turned on so
  // territory expansion since the last view is reflected.
  const toggle3D = useCallback(() => {
    setThreeD((prev) => {
      const next = !prev;
      threeDRef.current = next;
      if (next) {
        const canvas = threeCanvasRef.current;
        const state = stateRef.current;
        if (canvas && state) {
          if (!world3dRef.current) {
            world3dRef.current = new World3DView(canvas);
            // Click-to-command: clicking the 3D map (without dragging) jumps
            // the 2D game camera to that spot and drops back into 2D so the
            // player can act there — turning the 3D view into a strategic map.
            world3dRef.current.onPick = (wx, wy) => {
              const cam = cameraRef.current;
              const st = stateRef.current;
              if (cam && st) {
                cam.x = wx;
                cam.y = wy;
                cam.zoom = Math.max(cam.zoom, 4);
                clampCamera(cam, st.world.width, st.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
              }
              threeDRef.current = false;
              setThreeD(false);
              setToast("Jumped to map location");
            };
          }
          const { w, h } = viewSizeRef.current;
          world3dRef.current.setSize(w, h);
          world3dRef.current.build(state);
        }
      }
      return next;
    });
  }, []);

  // Hotkey: press "3" to flip between the 2D and 3D views while in-world.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "3" || e.key === "v" || e.key === "V") && (phase === "playing" || phase === "spawn")) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        toggle3D();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, toggle3D]);

  // Permanent window-resize listener. Cheap idempotent attach.
  useEffect(() => {
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onResize]);

  // Re-run sizing whenever a phase change might have mounted the canvas.
  // The initial render shows the menu (no canvas), so `onResize` running
  // at mount time would bail. Phase transitions like menu → loading mount
  // the canvas; this effect catches that and sizes it then.
  useEffect(() => {
    onResize();
  }, [phase, onResize]);

  useEffect(() => {
    if (phase !== "loading") return;
    // Already built (e.g. user backed out then re-entered) — skip rebuild.
    if (stateRef.current && rendererRef.current) {
      setPhase("spawn");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Always load textures first — needed regardless of resume vs
        // fresh, and the saved state references sprite names by string.
        await loadTextures();
        if (cancelled) return;
        // Now that sprites are loaded, let placement restrict volcano
        // exclusion zones to the cone's non-transparent texture pixels.
        setSpriteAlphaSampler(spriteAlphaAt);

        const save = savedStateRef.current;
        let state: GameState;
        if (save) {
          // RESUME PATH: use the saved state directly. Skips buildWorld +
          // createGame + seedBotTribes entirely — the world arrays
          // (terrain, ports, villagers, vessels, diplomacy, …) are all
          // in the structured-cloned save and ready to render. Call
          // normalizeResumedState to fix the few fields that depend on
          // the per-session performance.now() clock (otherwise bots
          // sit motionless on resume and the day-rollover check goes
          // haywire).
          state = save.state;
          normalizeResumedState(state);
        } else {
          // FRESH PATH: rebuild world from a random seed, then seed bots.
          const world = await buildWorld(CONFIG.worldWidth, CONFIG.worldHeight);
          if (cancelled) return;
          state = createGame(CONFIG, world);
          seedBotTribes(state);
          seedWildlife(state);
        }
        // Force initial volcano sprite sync so the spawn screen + the
        // first playing frame render the correct day/night cone state
        // instead of the raw worldgen sprite (which is "active" until
        // the first stepGame tick catches up).
        syncVulcanoSprites(state);

        stateRef.current = state;
        const renderer = new Renderer(state.world.width, state.world.height);
        renderer.fullRepaint(state);
        rendererRef.current = renderer;
        cameraRef.current = makeCamera(state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
        if (save?.camera && cameraRef.current) {
          cameraRef.current.x = save.camera.x;
          cameraRef.current.y = save.camera.y;
          cameraRef.current.zoom = save.camera.zoom;
          clampCamera(cameraRef.current, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
        }
        cloudsRef.current = new Clouds();
        // Resume sessions skip the spawn screen — the human already
        // spawned in the saved run.
        setPhase(save?.state.humanSpawned ? "playing" : "spawn");
      } catch (e) {
        setError((e as Error).message ?? "Failed to initialize");
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  // Dev panel hotkey: Ctrl+Ä toggles a debug overlay with one-click
  // shortcuts for every gameplay system. Listener lives globally so it
  // fires regardless of focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "ä" || e.key === "Ä")) {
        e.preventDefault();
        setDevPanelOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Autosave loop. While the player is actively playing, persist a fresh
  // snapshot every 10 s so a crash / refresh costs at most that much
  // progress. The save layer guards against quota / JSON failures so
  // a bad call here never disrupts the render loop.
  useEffect(() => {
    if (phase !== "playing") return;
    const id = setInterval(() => {
      const s = stateRef.current;
      if (s) {
        saveGame(s, cameraRef.current);
        setHasSavedSession(true);
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [phase]);

  // Toast auto-dismiss. Any time `toast` becomes non-null, schedule a
  // clear ~2 s later. Re-running the effect (because the user triggered
  // another toast in the meantime) cancels the prior timer so the new
  // message gets its full window.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(id);
  }, [toast]);

  // Escape clears villager selection (no other modal handles Esc when
  // they're closed, so this only fires in the world view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedVillagerId !== null) {
        setSelectedVillagerId(null);
      }
      // Esc also cancels an in-progress airship path edit — drops the
      // waypoints and exits edit mode. The vessel stays docked.
      if (e.key === "Escape" && pathEditVesselId !== null) {
        const s = stateRef.current;
        if (s) clearVesselPath(s, s.humanId, pathEditVesselId);
        setPathEditVesselId(null);
        forceUpdate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedVillagerId, pathEditVesselId]);

  // 60-second spawn timer. While the player is on the spawn screen we
  // count down; if they don't click before it hits 0 we drop them on the
  // most-isolated land tile via findFarthestSpawnTile and advance the
  // phase ourselves. Bot tribes are already on the map (seeded at world
  // load) so "isolated" means "as far as possible from any other tribe".
  useEffect(() => {
    if (phase !== "spawn") return;
    const startMs = performance.now();
    setSpawnSecondsLeft(SPAWN_TIMEOUT_SECONDS);
    const tick = () => {
      const elapsed = (performance.now() - startMs) / 1000;
      const remaining = Math.max(0, SPAWN_TIMEOUT_SECONDS - elapsed);
      setSpawnSecondsLeft(remaining);
      if (remaining > 0) return;
      clearInterval(intervalId);
      const state = stateRef.current;
      const cam = cameraRef.current;
      if (!state || !cam || state.humanSpawned) return;
      const idx = findFarthestSpawnTile(state);
      if (idx < 0) return;
      // Auto-spawn enforces the tree-proximity gate so the timer fallback
      // never plops the player onto a treeless rock.
      if (spawnTribe(state, state.humanId, idx, true)) {
        state.humanSpawned = true;
        setPhase("playing");
        cam.x = idx % state.world.width;
        cam.y = (idx / state.world.width) | 0;
        cam.zoom = Math.max(cam.zoom * 2, 3);
        clampCamera(cam, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
        forceUpdate();
      }
    };
    const intervalId = setInterval(tick, 250);
    return () => clearInterval(intervalId);
  }, [phase]);

  useEffect(() => {
    if (phase === "loading") return;
    let rafId = 0;
    let lastTick = performance.now();
    let lastFrame = performance.now();

    // Cache the 2D context once instead of calling getContext every
    // frame — small win but it adds up at 240 fps. Re-resolves only
    // if the canvas element changes.
    let cachedCtx: CanvasRenderingContext2D | null = null;
    // FPS measurement — rolling window of the last 60 frame timestamps
    // so we can show the user the actual rate they're getting. The
    // overlay is a tiny corner readout; render cost is one fillText.
    const fpsTimes: number[] = [];
    let fpsLabel = "";
    let fpsLastUpdate = 0;
    const loop = (now: number) => {
      const state = stateRef.current;
      const renderer = rendererRef.current;
      const cam = cameraRef.current;
      const canvas = canvasRef.current;
      const clouds = cloudsRef.current;
      const dtMs = now - lastFrame;
      lastFrame = now;
      if (state && renderer && cam && canvas) {
        if (phase === "playing" && now - lastTick >= CONFIG.tickMs) {
          // Wrap stepGame in a try/catch so an unhandled exception
          // doesn't tank the entire rAF loop (which is what made the
          // "softlock after spawn" appear to freeze the page — an
          // engine throw silently stopped both the tick AND the
          // render). On error we log and skip the tick; rendering
          // continues so the player at least sees the world.
          try {
            stepGame(state);
          } catch (err) {
            console.error("[engine] stepGame threw:", err);
          }
          lastTick = now;
          if (state.winner !== null) setPhase("ended");
        }
        // 3D mode: drive the WebGL world view and skip the 2D draw stack
        // entirely (the simulation above still ticks so the world stays
        // live under the 3D render).
        if (threeDRef.current) {
          world3dRef.current?.render(state, now);
        } else {
        renderer.incrementalRepaint(state);
        if (!cachedCtx || (cachedCtx.canvas as HTMLCanvasElement) !== canvas) {
          cachedCtx = canvas.getContext("2d")!;
        }
        const ctx = cachedCtx;
        renderer.draw(ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam, state);
        drawAllProps(ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam, state);
        drawKingdomHulls(ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam, state);
        drawVulcanoEffects(ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam, state, now);
        if (clouds) {
          clouds.update(dtMs, state.world.width, state.world.height, []);
          clouds.draw(ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam);
        }
        // Day/night overlay sits on top of world + clouds so both dim
        // together at night and warm together at dusk/dawn. The phase
        // is keyed off `state.startedAtMs` so the tint stays in sync
        // with the engine's isNight() check (and the DevPanel
        // time-jump buttons) — without subtracting startedAtMs the
        // overlay drifted out of phase and night never actually
        // looked dark.
        drawDayNightOverlay(
          ctx, viewSizeRef.current.w, viewSizeRef.current.h, now,
          state.startedAtMs,
        );
        // Night fog of war — layered after the day/night tint so the
        // black collapses around lights only at deep night. Dawn / dusk
        // are still handled by the blue + warm tints above.
        drawNightFog(
          ctx, viewSizeRef.current.w, viewSizeRef.current.h, cam, state,
          now, state.startedAtMs,
        );
        // Shovel brush preview. While SHOVEL_KEY is active and the
        // cursor is over the canvas, render a translucent disk at the
        // cursor's world position so the player can see exactly which
        // tiles will be dug (or filled with shift). Drawn on top of the
        // day/night tint so it stays readable even at night.
        if (buildKey === SHOVEL_KEY) {
          const ms = mouseScreenRef.current;
          if (ms) {
            const { x: wx, y: wy } = screenToWorld(
              cam, viewSizeRef.current.w, viewSizeRef.current.h, ms.x, ms.y,
            );
            const SHOVEL_RADIUS = 4; // matches SHOVEL_BRUSH_RADIUS
            const rPx = SHOVEL_RADIUS * cam.zoom;
            const cxPx = viewSizeRef.current.w / 2 + (wx - cam.x) * cam.zoom;
            const cyPx = viewSizeRef.current.h / 2 + (wy - cam.y) * cam.zoom;
            // Out-of-range → red "forbidden" brush so the player can see
            // they can't edit there before clicking. Otherwise: shift held
            // → green fill, default → cyan dig.
            const isFill = shovelShiftRef.current;
            const inRange = pointNearOwnedBase(state, state.humanId, wx, wy, SHOVEL_RANGE_FROM_BASE);
            let fill: string;
            let stroke: string;
            if (!inRange) {
              fill = "rgba(240, 80, 80, 0.22)";
              stroke = "rgba(255, 110, 110, 0.95)";
            } else if (isFill) {
              fill = "rgba(120, 210, 130, 0.25)";
              stroke = "rgba(140, 240, 150, 0.95)";
            } else {
              fill = "rgba(120, 200, 240, 0.22)";
              stroke = "rgba(150, 220, 255, 0.9)";
            }
            ctx.beginPath();
            ctx.arc(cxPx, cyPx, rPx, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.lineWidth = Math.max(1, cam.zoom * 0.6);
            ctx.strokeStyle = stroke;
            ctx.stroke();
            // Crosshair at the centre for a precise cursor reference.
            ctx.beginPath();
            ctx.moveTo(cxPx - 3, cyPx); ctx.lineTo(cxPx + 3, cyPx);
            ctx.moveTo(cxPx, cyPx - 3); ctx.lineTo(cxPx, cyPx + 3);
            ctx.lineWidth = 1;
            ctx.strokeStyle = stroke;
            ctx.stroke();
          }
        }
        // Airship flight-path overlay. Draw the planned route for any
        // vessel currently in path-edit mode, plus the in-progress flight
        // line for vessels already launched on a path. Polyline from
        // home port → waypoints; small dots at each waypoint; a red
        // marker at the deboard waypoint; a thin dashed line back to
        // the home port after the deboard. Drawn above the day/night
        // overlay so the line stays readable at night.
        {
          const vessels = state.vessels;
          for (const v of vessels) {
            if (!v.flightPath || v.flightPath.length === 0) continue;
            const def = getVesselDef(v.defKey);
            if (!def || def.category !== "airship") continue;
            const isEditing = pathEditVesselId === v.id;
            const isFlying = v.status === "flying";
            if (!isEditing && !isFlying) continue;
            // Anchor point — for docked vessels, the vessel's parked
            // position; for flying, the current world position.
            const anchorX = v.x ?? 0;
            const anchorY = v.y ?? 0;
            const ax = viewSizeRef.current.w / 2 + (anchorX - cam.x) * cam.zoom;
            const ay = viewSizeRef.current.h / 2 + (anchorY - cam.y) * cam.zoom;
            ctx.lineWidth = Math.max(2, cam.zoom * 0.8);
            ctx.strokeStyle = isEditing ? "rgba(255, 230, 120, 0.9)" : "rgba(150, 220, 255, 0.85)";
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            // Bezier-curve rendering. While editing, the waypoints are
            // the original user clicks — draw a Catmull-Rom curve
            // through them converted to per-segment cubic Beziers, so
            // the route reads as a smooth arc instead of a zig-zag.
            // After launch, flightPath has already been resampled
            // (samplePathAsCurve in state.ts) so the points are dense
            // enough to render as a straight polyline without losing
            // the curve. We use the same code path either way — at
            // dense sample counts the per-segment tangent math just
            // produces nearly-straight Beziers between adjacent
            // samples, which is fine.
            const wpts = v.flightPath;
            // Build a control-point list anchored at the vessel's
            // current position. This is the same construction used in
            // samplePathAsCurve so the visual matches the engine path.
            const ctrl: { x: number; y: number }[] = [{ x: anchorX, y: anchorY }];
            for (const wp of wpts) ctrl.push({ x: wp.x, y: wp.y });
            // Catmull-Rom → cubic Bezier conversion. For each segment
            // (P1, P2) the Bezier control handles are:
            //   B1 = P1 + (P2 - P0) / 6
            //   B2 = P2 - (P3 - P1) / 6
            // P0 / P3 are the neighbours (clamp at ends).
            for (let i = 0; i < ctrl.length - 1; i++) {
              const p1 = ctrl[i];
              const p2 = ctrl[i + 1];
              const p0 = i > 0 ? ctrl[i - 1] : p1;
              const p3 = i < ctrl.length - 2 ? ctrl[i + 2] : p2;
              const b1x = p1.x + (p2.x - p0.x) / 6;
              const b1y = p1.y + (p2.y - p0.y) / 6;
              const b2x = p2.x - (p3.x - p1.x) / 6;
              const b2y = p2.y - (p3.y - p1.y) / 6;
              // Project all four to screen-space.
              const b1px = viewSizeRef.current.w / 2 + (b1x - cam.x) * cam.zoom;
              const b1py = viewSizeRef.current.h / 2 + (b1y - cam.y) * cam.zoom;
              const b2px = viewSizeRef.current.w / 2 + (b2x - cam.x) * cam.zoom;
              const b2py = viewSizeRef.current.h / 2 + (b2y - cam.y) * cam.zoom;
              const p2px = viewSizeRef.current.w / 2 + (p2.x - cam.x) * cam.zoom;
              const p2py = viewSizeRef.current.h / 2 + (p2.y - cam.y) * cam.zoom;
              ctx.bezierCurveTo(b1px, b1py, b2px, b2py, p2px, p2py);
            }
            ctx.stroke();
            // Waypoint dots.
            for (let i = 0; i < v.flightPath.length; i++) {
              const wp = v.flightPath[i];
              const px = viewSizeRef.current.w / 2 + (wp.x - cam.x) * cam.zoom;
              const py = viewSizeRef.current.h / 2 + (wp.y - cam.y) * cam.zoom;
              const dotR = Math.max(2, cam.zoom * 0.7);
              ctx.beginPath();
              if (wp.deboard) {
                // Deboard waypoint — red marker so it stands out.
                ctx.fillStyle = "rgba(255, 90, 90, 0.95)";
                ctx.strokeStyle = "rgba(120, 0, 0, 0.95)";
                ctx.arc(px, py, dotR * 1.6, 0, Math.PI * 2);
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.stroke();
                // Small "DROP" tag above so the role is obvious.
                ctx.fillStyle = "rgba(255, 220, 220, 0.95)";
                ctx.font = "bold 10px ui-sans-serif, system-ui";
                ctx.fillText("DROP", px - 14, py - dotR * 1.8 - 2);
              } else {
                ctx.fillStyle = isEditing ? "rgba(255, 230, 120, 0.95)" : "rgba(150, 220, 255, 0.95)";
                ctx.arc(px, py, dotR, 0, Math.PI * 2);
                ctx.fill();
              }
            }
            // Dashed return line from the deboard waypoint back to the
            // home port — only shown while editing so the player can
            // confirm the return route at a glance.
            if (isEditing && v.homePortId === undefined && v.portStructureId >= 0) {
              const port = state.structuresById?.get(v.portStructureId);
              const deboardWp = v.flightPath.find((w) => w.deboard);
              if (port && deboardWp) {
                ctx.setLineDash([6, 4]);
                ctx.strokeStyle = "rgba(200, 200, 200, 0.6)";
                ctx.lineWidth = Math.max(1, cam.zoom * 0.4);
                const px = viewSizeRef.current.w / 2 + (deboardWp.x - cam.x) * cam.zoom;
                const py = viewSizeRef.current.h / 2 + (deboardWp.y - cam.y) * cam.zoom;
                const hx = viewSizeRef.current.w / 2 + (port.x - cam.x) * cam.zoom;
                const hy = viewSizeRef.current.h / 2 + (port.y - cam.y) * cam.zoom;
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(hx, hy);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            }
          }
        }
        // FPS readout. Sample over the last 60 frames, recompute the
        // displayed value at most twice a second so the number doesn't
        // strobe. Tiny font in the top-left corner.
        fpsTimes.push(now);
        while (fpsTimes.length > 60) fpsTimes.shift();
        if (now - fpsLastUpdate > 500 && fpsTimes.length >= 2) {
          const spanSec = (fpsTimes[fpsTimes.length - 1] - fpsTimes[0]) / 1000;
          const fps = spanSec > 0 ? Math.round((fpsTimes.length - 1) / spanSec) : 0;
          fpsLabel = `${fps} fps`;
          fpsLastUpdate = now;
        }
        if (fpsLabel) {
          ctx.font = "12px ui-sans-serif, system-ui";
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(8, 8, 70, 18);
          ctx.fillStyle = "#9af0a0";
          ctx.fillText(fpsLabel, 14, 21);
        }
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, moved: false };
    // Latch the shift state for the upcoming shovel stroke. The drag-
    // paint loop in onMouseMove reads this so the user gets consistent
    // "dig" vs "fill" behaviour across the whole stroke even if shift
    // is released mid-drag.
    shovelShiftRef.current = e.shiftKey;
    // First-click brush stamp for the shovel — without this a single
    // click (no drag) does nothing because onMouseMove only fires after
    // motion. Drag-extending the brush is still handled in onMouseMove.
    const state = stateRef.current;
    const cam = cameraRef.current;
    if (buildKey === SHOVEL_KEY && state && cam) {
      const { x, y } = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, e.clientX, e.clientY);
      const fn = e.shiftKey ? paintFill : paintHole;
      const result = fn(state, state.humanId, x | 0, y | 0);
      if (result.ok && result.tilesAffected > 0) {
        shovelLastPaintRef.current = { x, y };
        if (rendererRef.current) rendererRef.current.incrementalRepaint(state);
        forceUpdate();
      } else if (result.ok === false && result.reason === "no_shovel") {
        setToast("Requires Shovel");
      }
    }
  }, [buildKey]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    // Always track the cursor — the shovel-brush preview reads this
    // every frame even when the mouse button isn't held.
    mouseScreenRef.current = { x: e.clientX, y: e.clientY };
    const d = dragRef.current;
    if (!d.active) return;
    const cam = cameraRef.current;
    if (!cam) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    const state = stateRef.current;
    // Farm tool is two-click rectangle now (drag does NOT paint). Fall
    // through to the camera-pan path so the player can still scroll the
    // map between picking the two corners.
    // Shovel-paint brush — same idea, but with hole / fill toggled by
    // the shift state latched on mousedown. Each cursor step stamps the
    // brush; the brush radius lives in state.ts. Interpolate between
    // the last paint position and the current cursor so a fast drag
    // doesn't leave gaps between stamps.
    if (buildKey === SHOVEL_KEY && state) {
      const { x, y } = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, e.clientX, e.clientY);
      const fn = shovelShiftRef.current ? paintFill : paintHole;
      const last = shovelLastPaintRef.current;
      // Step along the line from last → current at half-brush spacing
      // so the disks overlap. Brush radius is 4 → step = 2 tiles.
      const STEP = 2;
      if (last) {
        const dx2 = x - last.x;
        const dy2 = y - last.y;
        const dist = Math.hypot(dx2, dy2);
        const steps = Math.max(1, Math.ceil(dist / STEP));
        let painted = false;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const px = last.x + dx2 * t;
          const py = last.y + dy2 * t;
          const result = fn(state, state.humanId, px | 0, py | 0);
          if (result.ok && result.tilesAffected > 0) painted = true;
        }
        if (painted) {
          if (rendererRef.current) rendererRef.current.incrementalRepaint(state);
          forceUpdate();
        }
      } else {
        fn(state, state.humanId, x | 0, y | 0);
      }
      shovelLastPaintRef.current = { x, y };
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      return;
    }
    cam.x -= dx / cam.zoom;
    cam.y -= (dy * 2) / cam.zoom;
    if (state) clampCamera(cam, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  }, [buildKey]);

  const handleClick = useCallback((sx: number, sy: number) => {
    const state = stateRef.current;
    const cam = cameraRef.current;
    if (!state || !cam) return;
    const { x, y } = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, sx, sy);
    const idx = tileAt(state.world, x, y);
    if (idx < 0) return;

    if (phase === "spawn") {
      if (!isOwnable(state.world.kind[idx])) return;
      // Bot tribes were already seeded at world load. The buildStructure
      // min-dist check inside spawnTribe still guards against the human
      // dropping their founding campfire on top of a bot tribe.
      if (spawnTribe(state, state.humanId, idx)) {
        state.humanSpawned = true;
        setPhase("playing");
        cam.x = idx % state.world.width;
        cam.y = (idx / state.world.width) | 0;
        cam.zoom = Math.max(cam.zoom * 2, 3);
        clampCamera(cam, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
        forceUpdate();
      }
      return;
    }

    if (phase === "playing") {
      const { x: wx, y: wy } = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, sx, sy);

      // Airship path-edit mode. While `pathEditVesselId` is set, world
      // clicks append waypoints to that vessel's planned route. Clicking
      // the SAME airship a second time launches the flight; clicking a
      // DIFFERENT docked airship switches the edit target. Right-click
      // (onContextMenu below) marks the deboard waypoint. Esc cancels.
      if (pathEditVesselId !== null && !buildKey) {
        const hit = vesselAtPoint(state, wx, wy);
        if (hit && hit.id === pathEditVesselId) {
          if (launchVessel(state, hit.id)) setToast("Airship launched");
          else setToast("Need full crew to launch — Crew Up first");
          setPathEditVesselId(null);
          forceUpdate();
          return;
        }
        if (hit && hit.status === "docked"
            && hit.ownerId === state.humanId
            && getVesselDef(hit.defKey)?.category === "airship") {
          setPathEditVesselId(hit.id);
          forceUpdate();
          return;
        }
        if (addVesselWaypoint(state, state.humanId, pathEditVesselId, wx, wy, false)) {
          forceUpdate();
        }
        return;
      }

      // Click an own docked airship while not in any other mode → enter
      // path-edit mode for it. Subsequent clicks add waypoints; right-
      // click marks the deboard waypoint; clicking the same airship
      // again launches the flight.
      // PORT PRIORITY: the airship's hit-disk for the big variants is
      // ~40 tiles wide and the dirigible hovers only 38 tiles above the
      // port, so a click on the port itself was being captured by the
      // path-edit branch and the PortWindow never opened. Check for an
      // own port structure FIRST and bail so the existing port-click
      // path (further below) handles it.
      if (!buildKey && pathEditVesselId === null) {
        const structHere = structureAt(state, wx, wy);
        const onOwnPort = structHere
          && structHere.ownerId === state.humanId
          && (structHere.defKey.startsWith("port_")
              || structHere.defKey.startsWith("airship_port"));
        if (!onOwnPort) {
          const hitAirship = vesselAtPoint(state, wx, wy);
          if (hitAirship && hitAirship.status === "docked"
              && hitAirship.ownerId === state.humanId
              && getVesselDef(hitAirship.defKey)?.category === "airship") {
            // Clear any stale path so a fresh edit starts blank — the
            // user expects each new selection to drop the prior route.
            clearVesselPath(state, state.humanId, hitAirship.id);
            setPathEditVesselId(hitAirship.id);
            setToast("Click to add waypoints • Right-click for deboard • Click airship again to launch");
            forceUpdate();
            return;
          }
        }
      }

      // Click-to-move villager — takes priority over build / harvest
      // dispatch so picking a villager + a destination feels snappy.
      // Build mode and destroy mode still win, since those are explicit
      // affordances; the player picked them and shouldn't have their
      // click rerouted unexpectedly.
      if (!buildKey) {
        // Tight-radius villager hit (8 tiles). If that misses, fall back
        // to a wider scan that's the size of a typical tree canopy, but
        // ONLY when the click actually landed inside a tree's footprint
        // AND the wide-hit villager belongs to the player. This is the
        // "click the tree → select the friendly villager hiding under
        // it" rule — without it the canopy overlay would always
        // intercept clicks even when there was a clear villager to grab.
        let hitVillager = villagerAt(state, wx, wy, 8);
        if (!hitVillager) {
          const clickedTree = treeAtPoint(state, wx, wy);
          if (clickedTree) {
            const candidate = villagerAt(state, wx, wy, Math.max(clickedTree.size, 12));
            if (candidate && candidate.ownerId === state.humanId) {
              hitVillager = candidate;
            }
          }
        }
        // Click on the already-selected villager toggles selection OFF.
        if (hitVillager && selectedVillagerId === hitVillager.id) {
          setSelectedVillagerId(null);
          return;
        }
        // Click on a different villager you own selects them.
        if (hitVillager && hitVillager.ownerId === state.humanId) {
          setSelectedVillagerId(hitVillager.id);
          return;
        }
        // Click on a non-villager spot dispatches the selected villager.
        if (selectedVillagerId !== null && !hitVillager) {
          if (moveVillagerTo(state, selectedVillagerId, wx, wy)) {
            setSelectedVillagerId(null);
            forceUpdate();
          }
          return;
        }
      }
      if (buildKey === FARM_KEY) {
        // Two-click rectangle: first click stores the corner; second
        // click flood-fills the bbox between the two corners. Each tile
        // inside the rectangle is paintFarmTile'd — paintFarmTile itself
        // does the per-tile validity gate (ownership, no prop, no water,
        // not already farmland) and the ash cost, so we just iterate and
        // ignore individual failures. Aggregated failure reasons are
        // surfaced as a toast.
        if (!farmCornerRef.current) {
          farmCornerRef.current = { x: wx, y: wy };
          setToast("Click the opposite corner of the farm");
          return;
        }
        const a = farmCornerRef.current;
        farmCornerRef.current = null;
        const x0 = Math.min(a.x, wx) | 0;
        const x1 = Math.max(a.x, wx) | 0;
        const y0 = Math.min(a.y, wy) | 0;
        const y1 = Math.max(a.y, wy) | 0;
        let painted = 0;
        let lastReason: "no_hoe" | "no_shovel" | "no_ash" | "not_paintable" | null = null;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const r = paintFarmTile(state, state.humanId, x, y);
            if (r.ok) painted++;
            else lastReason = r.reason;
          }
        }
        if (painted > 0) {
          setToast(`Claimed ${painted} farmland tiles`);
          forceUpdate();
        } else if (lastReason === "no_hoe") {
          setToast("Requires Hoe");
        } else if (lastReason === "no_shovel") {
          setToast("Requires Shovel");
        } else if (lastReason === "no_ash") {
          setToast("Not enough ash (1 per 25 tiles)");
        } else {
          // Whole rectangle was unpaintable — already farmland, props,
          // water, or outside player territory.
          setToast("Nothing to claim there");
        }
        return;
      }
      if (buildKey === SHOVEL_KEY) {
        // Shovel paint is handled in onMouseDown / onMouseMove (it's a
        // drag-paint, not a two-click flow). The click-up arrives here
        // when the player tapped without dragging — the brush stamp
        // already fired on mousedown, so nothing to do.
        return;
      }
      if (buildKey === DESTROY_KEY) {
        // Destroy mode — click on any of the player's own placed
        // structures wipes it. Stays in destroy mode after a hit so the
        // player can wipe several in a row; click somewhere empty or
        // press Cancel to exit.
        const target = structureAt(state, wx, wy);
        if (target && target.ownerId === state.humanId) {
          const w = state.world;
          const x0 = Math.max(0, Math.floor(target.x - target.size));
          const x1 = Math.min(w.width - 1, Math.ceil(target.x + target.size));
          const y0 = Math.max(0, Math.floor(target.y - target.size));
          const y1 = Math.min(w.height - 1, Math.ceil(target.y + target.size));
          if (destroyStructure(state, target.id)) {
            for (let yy = y0; yy <= y1; yy++) {
              const base = yy * w.width;
              for (let xx = x0; xx <= x1; xx++) state.dirtyTiles.add(base + xx);
            }
            setToast(`Destroyed ${target.defKey}`);
            forceUpdate();
          }
        }
        return;
      }
      if (buildKey) {
        if (buildStructure(state, state.humanId, buildKey, wx, wy)) {
          forceUpdate();
        } else {
          // Silent failure made stacking feel broken. Generic hint so
          // the player knows the click registered but something
          // (terrain / resources / overlap / style) rejected it.
          setToast("Can't place here");
        }
        return;
      }
      // No build mode: first check if the click landed on the player's
      // own port or airship port — those open the dock window for
      // launching ships / airships. Tents are still destroy-on-click.
      // Falls through to tree-chop dispatch if nothing was hit.
      const struct = structureAt(state, wx, wy);
      if (struct && struct.ownerId === state.humanId) {
        // Port comes in four biome-locked variants — any of them opens
        // the yellow ship book.
        if (struct.defKey.startsWith("port_")) {
          portStructureIdRef.current = struct.id;
          setPortOpen("port");
          return;
        }
        if (struct.defKey.startsWith("airship_port")) {
          portStructureIdRef.current = struct.id;
          setPortOpen("airship_port");
          return;
        }
        if (struct.defKey === "workbench") {
          setWorkbenchOpen(true);
          return;
        }
      }
      if (struct && struct.ownerId === state.humanId && struct.defKey === "tent") {
        if (destroyStructure(state, struct.id)) {
          // Dirty the tiles the tent's bbox covered so the chunk repaints
          // without the sprite.
          const w = state.world;
          const x0 = Math.max(0, Math.floor(struct.x - struct.size));
          const x1 = Math.min(w.width - 1, Math.ceil(struct.x + struct.size));
          const y0 = Math.max(0, Math.floor(struct.y - struct.size));
          const y1 = Math.min(w.height - 1, Math.ceil(struct.y + struct.size));
          for (let yy = y0; yy <= y1; yy++) {
            const base = yy * w.width;
            for (let xx = x0; xx <= x1; xx++) state.dirtyTiles.add(base + xx);
          }
          forceUpdate();
          return;
        }
      }
      // Villager role cycle: clicking one of YOUR OWN villagers rotates
      // their role (worker → guard → army → worker). Worker → guard
      // consumes one spear from the tribe's tool pool; without a spear
      // the promotion fails and we surface a toast so the player knows
      // they need to craft one at the Workbench first. Runs before the
      // harvest click priorities so role-switching takes precedence
      // over accidentally dispatching the clicked villager to a tree.
      const v = villagerAt(state, wx, wy);
      if (v && v.ownerId === state.humanId) {
        const res = cycleVillagerRole(state, v);
        if (res === "no_spear") {
          setToast("Requires Spear");
        } else {
          forceUpdate();
        }
        return;
      }

      // Click priority by proximity. Trees and rocks often coexist within
      // the wide pick radius (120 tiles each), so we have to disambiguate
      // by which prop is physically closer to the click — otherwise a
      // rock-click without a pickaxe would silently fall through to
      // chopping a nearby tree, crediting wood for what the user thought
      // was a mine.
      const closestRockIdx = findClosestRock(state, wx, wy, ROCK_PICK_DIST);
      const closestTreeIdx = findClosestTree(state, wx, wy, TREE_PICK_DIST);
      const propDistSq = (idx: number): number => {
        const p = state.world.props[idx];
        return (p.x - wx) ** 2 + (p.y - wy) ** 2;
      };
      const rockD2 = closestRockIdx >= 0 ? propDistSq(closestRockIdx) : Infinity;
      const treeD2 = closestTreeIdx >= 0 ? propDistSq(closestTreeIdx) : Infinity;

      // Rock closer than any tree → user intent is mining. If pickaxe is
      // required and missing, toast and STOP — do not fall through to
      // chopping. That fallthrough was the bug where clicking a
      // can't-mine-yet rock yielded wood from a redirected tree-chop.
      let mine: ReturnType<typeof assignRockMine> | null = null;
      if (rockD2 < treeD2) {
        mine = assignRockMine(state, state.humanId, wx, wy);
        if (mine === "ok") { forceUpdate(); return; }
        if (mine === "no_pickaxe") { setToast("Requires Pickaxe"); return; }
      }

      const farm = assignFarm(state, state.humanId, wx, wy);
      if (farm === "ok") { forceUpdate(); return; }

      // Tree was closer (or tied) → chop it.
      if (treeD2 < Infinity && assignTreeChop(state, state.humanId, wx, wy)) {
        forceUpdate();
        return;
      }

      // Last resort: a rock existed but the tree was closer and chop
      // failed (e.g. no idle villager). Try mining now so a click near a
      // rock-and-tree pair still does something.
      if (mine === null && rockD2 < Infinity) {
        mine = assignRockMine(state, state.humanId, wx, wy);
        if (mine === "ok") { forceUpdate(); return; }
        if (mine === "no_pickaxe") { setToast("Requires Pickaxe"); return; }
      }

      if (farm === "no_hoe") setToast("Requires Hoe");
    }
  }, [phase, buildKey]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.active && !d.moved) handleClick(e.clientX, e.clientY);
    d.active = false;
    // End-of-stroke for the shovel — clear the "last paint position" so
    // the next mousedown starts a fresh stamp instead of interpolating
    // from wherever the previous stroke ended.
    shovelLastPaintRef.current = null;
    shovelShiftRef.current = false;
    // Commit the stroke: terrain was destroyed live during the drag, but
    // water flow has been GATED. Now that the player released the mouse,
    // scan their holes and activate any next to natural sea so the water
    // rushes in.
    if (buildKey === SHOVEL_KEY) {
      const s = stateRef.current;
      if (s) commitShovelStroke(s);
    }
  }, [handleClick, buildKey]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const cam = cameraRef.current;
    const state = stateRef.current;
    if (!cam || !state) return;
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    const { x: wx, y: wy } = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, e.clientX, e.clientY);
    cam.zoom *= factor;
    clampCamera(cam, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
    const after = screenToWorld(cam, viewSizeRef.current.w, viewSizeRef.current.h, e.clientX, e.clientY);
    cam.x += wx - after.x;
    cam.y += wy - after.y;
    clampCamera(cam, state.world.width, state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
  }, []);

  const cursorClass = phase === "spawn" ? "spawning" : phase === "playing" && buildKey ? "attack" : "";

  if (phase === "menu") {
    const save = savedStateRef.current;
    const minsAgo = save
      ? Math.max(1, Math.round((Date.now() - save.savedAt) / 60000))
      : null;
    return (
      <MainMenu
        onSingleplayer={() => {
          // New Game: wipe any existing save so the next autosave doesn't
          // collide with a previous run.
          clearSave();
          savedStateRef.current = null;
          setHasSavedSession(false);
          setPhase("loading");
        }}
        onMakeLobby={() => setPhase("makeLobby")}
        onJoinLobby={() => setPhase("joinLobby")}
        onResume={hasSavedSession ? () => setPhase("loading") : undefined}
        resumeLabel={minsAgo !== null ? `saved ${minsAgo} min ago` : null}
      />
    );
  }
  if (phase === "makeLobby") {
    return (
      <MakeLobby
        onBack={() => setPhase("menu")}
        onStart={() => setPhase("loading")}
      />
    );
  }
  if (phase === "joinLobby") {
    return (
      <JoinLobby
        initialCode={initialJoinCode}
        onBack={() => setPhase("menu")}
        onConnected={() => setPhase("loading")}
      />
    );
  }

  return (
    <div className="app">
      <canvas
        ref={canvasRef}
        className={`game-canvas ${cursorClass}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          dragRef.current.active = false;
          // Hide the shovel-brush preview when the cursor leaves the
          // canvas so the disk doesn't linger at an old position.
          mouseScreenRef.current = null;
        }}
        onWheel={onWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          // Right-click → set the deboard waypoint at the cursor while
          // an airship is in path-edit mode. Half the crew will jump
          // out at this point and the rest will return to the home
          // port. Only one deboard waypoint per path — re-right-clicking
          // moves it to the new location.
          const state = stateRef.current;
          const cam = cameraRef.current;
          if (!state || !cam) return;
          if (pathEditVesselId === null) return;
          const { x: wx, y: wy } = screenToWorld(
            cam, viewSizeRef.current.w, viewSizeRef.current.h, e.clientX, e.clientY,
          );
          if (addVesselWaypoint(state, state.humanId, pathEditVesselId, wx, wy, true)) {
            setToast("Deboard point set — click the airship to launch");
            forceUpdate();
          }
        }}
      />
      {/* WebGL 3D world view. Sits on top of the 2D canvas and is shown only
          in 3D mode; pointer-events off when hidden so 2D input passes
          through. The World3DView owns its own orbit-camera listeners. */}
      <canvas
        ref={threeCanvasRef}
        className="game-canvas-3d"
        style={{ display: threeD ? "block" : "none" }}
      />
      {(phase === "playing" || phase === "spawn") && (
        <button
          className={`view3d-toggle${threeD ? " active" : ""}`}
          onClick={toggle3D}
          title="Toggle 3D world view (press 3)"
        >
          {threeD ? "2D" : "3D"}
        </button>
      )}
      {threeD && (
        <div className="view3d-hint">
          Click the map to jump there · drag to orbit · scroll to zoom
        </div>
      )}
      {error && <div className="loading">Error: {error}</div>}
      {phase === "loading" && !error && <div className="loading">Generating world…</div>}
      {phase === "spawn" && !error && !threeD && (
        <div className="hint">
          Click on land to plant your founding tent —
          {" "}auto-spawn in {formatCountdown(spawnSecondsLeft)}
        </div>
      )}
      {/* The 2D game HUD is hidden while the 3D world view is active so the
          terrain reads cleanly; the floating 2D/3D toggle stays on top. */}
      {phase === "playing" && !threeD && stateRef.current && (
        <>
        <BuildHUD
          state={stateRef.current}
          tick={stateRef.current.tick}
          selectedKey={buildKey}
          onSelect={(k) => {
            // Leaving farm-mode for any other tool clears the half-done
            // rectangle so the next farm pick starts fresh.
            if (buildKey === FARM_KEY && k !== FARM_KEY) farmCornerRef.current = null;
            // Leaving the shovel tool drops the in-progress stroke
            // bookkeeping so the next time the player picks the shovel
            // they start from a clean slate.
            if (buildKey === SHOVEL_KEY && k !== SHOVEL_KEY) {
              shovelLastPaintRef.current = null;
              shovelShiftRef.current = false;
            }
            setBuildKey(k);
          }}
          canSpawn={canSpawnVillager(stateRef.current, stateRef.current.humanId)
            && findHomeTent(stateRef.current, stateRef.current.humanId) !== null}
          popLabel={`${getPopulationUsed(stateRef.current, stateRef.current.humanId)} / ${getPopulationCap(stateRef.current, stateRef.current.humanId)}`}
          onSpawnVillager={() => {
            const s = stateRef.current;
            if (!s) return;
            const home = findHomeTent(s, s.humanId);
            if (!home) { setToast("No campfire / tent to spawn at"); return; }
            if (!canSpawnVillager(s, s.humanId)) { setToast("Pop cap reached"); return; }
            const ang = Math.random() * Math.PI * 2;
            const rad = 10 + Math.random() * 8;
            spawnVillagerAtHome(s, s.humanId, home.x + Math.cos(ang) * rad, home.y + Math.sin(ang) * rad);
            forceUpdate();
          }}
        />
        <button className="info-book-toggle" onClick={() => setInfoBookOpen(true)} title="Open info book (resources, villagers, diplomacy)">
          <img src="/IMG/HUD/bookblue.png" alt="Info" draggable={false} />
        </button>
        {/* Quick save / load — autosave still runs every 10 s but these
            let the player pin a checkpoint or roll back deliberately. */}
        <button
          className="save-btn save"
          title="Save the current session"
          onClick={() => {
            const s = stateRef.current;
            if (!s) return;
            saveGame(s, cameraRef.current);
            setHasSavedSession(true);
            setToast("Saved");
          }}
        >
          Save
        </button>
        <button
          className="save-btn load"
          title="Reload the most recent save in place"
          onClick={() => {
            // Loading mid-game replaces state.current with the saved
            // GameState (world arrays included). Async — wait for the
            // IDB read before swapping in. While reading, the live game
            // keeps running normally.
            (async () => {
              const save = await loadSave();
              if (!save) { setToast("No save found"); return; }
              normalizeResumedState(save.state);
              stateRef.current = save.state;
              if (save.camera && cameraRef.current) {
                cameraRef.current.x = save.camera.x;
                cameraRef.current.y = save.camera.y;
                cameraRef.current.zoom = save.camera.zoom;
                clampCamera(cameraRef.current, save.state.world.width, save.state.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
              }
              if (rendererRef.current) {
                // World may have changed — force a fresh full repaint to
                // rebuild any cached chunks against the new tiles.
                rendererRef.current = new Renderer(save.state.world.width, save.state.world.height);
                rendererRef.current.fullRepaint(save.state);
              }
              forceUpdate();
              setToast("Loaded");
            })();
          }}
        >
          Load
        </button>
        <button
          className="save-btn menu"
          title="Save & return to main menu"
          onClick={() => {
            // Snapshot before leaving so Resume from the menu picks up
            // exactly where the player left off. Save is async; we
            // don't need to await it before swapping phases because
            // the saved-state ref pointed at the same in-memory state
            // and the next Resume click will await loadSave anyway.
            const s = stateRef.current;
            if (s) {
              saveGame(s, cameraRef.current);
              setHasSavedSession(true);
              // savedStateRef is updated lazily — the menu's load-on-
              // mount effect will re-read IDB. Until then we point it
              // at the in-memory state so a fast Resume tap still works.
              savedStateRef.current = {
                version: 2,
                savedAt: Date.now(),
                state: s,
                camera: cameraRef.current
                  ? { x: cameraRef.current.x, y: cameraRef.current.y, zoom: cameraRef.current.zoom }
                  : null,
              };
            }
            // Reset live refs so a "New Game" click from the menu won't
            // shortcut past world-rebuild in the loading effect.
            stateRef.current = null;
            rendererRef.current = null;
            cameraRef.current = null;
            cloudsRef.current = null;
            setBuildKey(null);
            setSelectedVillagerId(null);
            setPortOpen(null);
            setWorkbenchOpen(false);
            setInfoBookOpen(false);
            setDevPanelOpen(false);
            setPhase("menu");
          }}
        >
          Menu
        </button>
        <button
          className="save-btn auto-assign"
          title="Send every idle worker to chop wood, fertilize farmland, or help finish a nearby build"
          onClick={() => {
            const s = stateRef.current;
            if (!s) return;
            const n = autoAssignIdleWorkers(s, s.humanId);
            setToast(n > 0 ? `Auto-assigned ${n} idle workers` : "No idle workers");
            forceUpdate();
          }}
        >
          Auto-Assign
        </button>
        <button
          className="save-btn capital"
          title="Centre the camera on your nation's capital (founding campfire)"
          onClick={() => {
            const s = stateRef.current;
            const cam = cameraRef.current;
            if (!s || !cam) return;
            const home = findHomeTent(s, s.humanId);
            if (!home) { setToast("No capital yet"); return; }
            cam.x = home.x;
            cam.y = home.y;
            // Pop to a comfortable close-up if the player was zoomed out.
            if (cam.zoom < 1.5) cam.zoom = 2;
            clampCamera(cam, s.world.width, s.world.height, viewSizeRef.current.w, viewSizeRef.current.h);
            forceUpdate();
          }}
        >
          Capital
        </button>
        </>
      )}
      {infoBookOpen && stateRef.current && (
        <InfoBook
          state={stateRef.current}
          tick={stateRef.current.tick}
          onClose={() => { setInfoBookOpen(false); forceUpdate(); }}
          onWarn={(m) => setToast(m)}
        />
      )}
      {devPanelOpen && stateRef.current && (
        <DevPanel
          state={stateRef.current}
          onMutate={forceUpdate}
          onToast={(m) => setToast(m)}
          onClose={() => setDevPanelOpen(false)}
        />
      )}
      {workbenchOpen && stateRef.current && (
        <WorkbenchWindow
          state={stateRef.current}
          onClose={() => setWorkbenchOpen(false)}
          onCraft={(key) => {
            const s = stateRef.current;
            if (!s) return;
            const res = craftTool(s, s.humanId, key);
            if (res === "ok") {
              forceUpdate();
            } else if (res === "no_workbench") {
              setToast("Workbench still under construction");
            } else if (res === "unaffordable") {
              setToast("Not enough resources");
            }
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {selectedVillagerId !== null && stateRef.current && (() => {
        const v = stateRef.current.villagers.find((vv) => vv.id === selectedVillagerId);
        // Clear stale selection if the villager was removed (combat,
        // boarded a vessel, etc.). Render nothing this frame; the next
        // tick the state update will hide the card cleanly.
        if (!v) return null;
        return (
          <SelectedVillagerCard
            villager={v}
            onClose={() => setSelectedVillagerId(null)}
            onStop={() => {
              const s = stateRef.current;
              if (!s) return;
              if (stopVillagerTask(s, v.id)) {
                setToast(`${v.name} is now idle`);
                forceUpdate();
              }
            }}
          />
        );
      })()}
      {portOpen && stateRef.current && (
        <PortWindow
          kind={portOpen}
          state={stateRef.current}
          onClose={() => setPortOpen(null)}
          onPurchase={(key) => {
            const s = stateRef.current;
            const def = getVesselDef(key);
            if (!s || !def) return;
            const player = s.players[s.humanId];
            // Affordability re-check + deduction. The PortWindow already
            // hides un-affordable cards, but the second check guards
            // against a state change between hover and click.
            for (const k in def.cost) {
              const need = def.cost[k as ResourceKind] ?? 0;
              if (player.resources[k as ResourceKind] < need) return;
            }
            // Resolve which port to dock at. portStructureIdRef was set
            // when the player clicked a specific port; if it's somehow
            // missing fall back to the first owned port matching the
            // current dock kind so the click still does something.
            let portId = portStructureIdRef.current;
            if (portId == null) {
              const wantPrefix = portOpen === "airship_port" ? "airship_port" : "port_";
              const port = s.structures.find(
                (st) => st.ownerId === s.humanId && st.defKey.startsWith(wantPrefix),
              );
              if (!port) { setToast("No port available"); return; }
              portId = port.id;
            }
            const vessel = purchaseVesselAtPort(s, s.humanId, portId, key);
            if (!vessel) {
              setToast("Port is full (4 slots max)");
              return;
            }
            // Purchase succeeded — NOW debit the cost.
            for (const k in def.cost) {
              tryDebitAggregate(s, s.humanId, k as ResourceKind, def.cost[k as ResourceKind] ?? 0);
            }
            setToast(`Built ${def.label}`);
            // Don't close the window — let the player buy multiple
            // vessels in a row without re-opening.
            forceUpdate();
          }}
          onBoard={() => {
            const s = stateRef.current;
            if (!s) return;
            // Same "+ Board villager" affordance on both dock kinds —
            // routes to the matching state helper based on which port
            // window is open. The button itself is rendered by the
            // PortWindow whenever onBoard is wired.
            const result = portOpen === "airship_port"
              ? boardVillagerInAirshipPort(s, s.humanId)
              : boardVillagerInNavalPort(s, s.humanId);
            if (result === "no_idle_villager") setToast("No idle villager to board");
            else if (result === "no_structure") {
              setToast(portOpen === "airship_port"
                ? "Build an Airship Port first"
                : "Build a Naval Port first");
            } else forceUpdate();
          }}
          boardedCount={(() => {
            const s = stateRef.current;
            if (!s) return 0;
            // Sum boarded villagers across every port of the matching
            // kind the player owns. The crew counter at the top of the
            // Boarding page shows this aggregate so the player can see
            // their pool before committing to a specific vessel.
            const prefix = portOpen === "airship_port" ? "airship_port" : "port_";
            let n = 0;
            for (const st of s.structures) {
              if (st.ownerId === s.humanId && st.defKey.startsWith(prefix)) {
                n += countBoardedVillagers(s, st.id);
              }
            }
            return n;
          })()}
          onLoadCargo={(vesselId, kind, amount) => {
            const s = stateRef.current;
            if (!s) return;
            const moved = loadCargoOntoVessel(s, vesselId, kind, amount);
            if (moved > 0) forceUpdate();
            else setToast("Can't load — out of resource or out of space");
          }}
          onUnloadAll={(vesselId) => {
            const s = stateRef.current;
            if (!s) return;
            unloadAllCargo(s, vesselId);
            forceUpdate();
          }}
          onLaunch={(vesselId) => {
            const s = stateRef.current;
            if (!s) return;
            if (launchVessel(s, vesselId)) {
              setToast("Vessel launched");
              forceUpdate();
            } else {
              setToast("Crew not full — board more villagers");
            }
          }}
          onAssignCrew={portOpen === "airship_port" ? (vesselId) => {
            const s = stateRef.current;
            if (!s) return;
            const moved = assignDockCrewToVessel(s, s.humanId, vesselId);
            if (moved > 0) {
              setToast(`Assigned ${moved} villager(s) to the airship`);
              forceUpdate();
            } else {
              setToast("No dock villagers available, or crew already full");
            }
          } : undefined}
          onSetRoute={(vesselId) => {
            // Close the dock window and enter flight-path edit mode for
            // this vessel. Wipes any stale route so the player starts
            // from a clean slate; subsequent world clicks append
            // waypoints, right-click marks the deboard, clicking the
            // vessel again launches.
            const s = stateRef.current;
            if (!s) return;
            clearVesselPath(s, s.humanId, vesselId);
            setPathEditVesselId(vesselId);
            setPortOpen(null);
            setToast("Click to add waypoints • Right-click for deboard • Click vessel to launch");
            forceUpdate();
          }}
        />
      )}
    </div>
  );
}

/** Drop one founding tent + 5 villagers for every non-human player at a
 *  random valid land tile. Retries until a tile passes both the tile-kind
 *  test and the min-distance check inside spawnTribe (which guarantees
 *  tribes don't overlap each other). */
/** Hit-test the click world-coord against every LIVE tree prop. Returns
 *  the closest tree whose footprint actually contains (wx, wy), or null
 *  if the click missed all trees. Used by the villager-under-tree click
 *  rule — when a tree's canopy is occluding a friendly villager, we
 *  widen the villager radius to the tree's size so the click selects
 *  the villager instead of just rolling off into "no hit". */
function treeAtPoint(state: GameState, wx: number, wy: number) {
  const props = state.world.props;
  let best: { x: number; y: number; size: number } | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    if (!p.sprite.startsWith("tree_")) continue;
    if (state.harvestedProps.has(i)) continue;
    const dx = wx - p.x;
    const dy = wy - p.y;
    const d2 = dx * dx + dy * dy;
    // Click must land inside the visual footprint, then pick the tree
    // whose centre is closest to the click point.
    if (d2 <= p.size * p.size && d2 < bestD2) {
      bestD2 = d2;
      best = { x: p.x, y: p.y, size: p.size };
    }
  }
  return best;
}

/** Format the spawn-timer countdown as M:SS. Truncates rather than rounds
 *  so the displayed value never reads "0:60" at the start of the minute. */
function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = (total / 60) | 0;
  const s = total - m * 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function seedBotTribes(state: GameState): void {
  const w = state.world;
  // Require a healthy margin from any shoreline so the bot's campfire +
  // villager ring doesn't visually clip into water. spawnTribe enforces
  // SPAWN_MIN_COAST_DIST (25) internally, so we just retry random tiles
  // until one passes; matching the threshold here avoids burning ATTEMPT
  // budget on tiles spawnTribe would reject anyway.
  const ATTEMPTS = 1500;
  for (const p of state.players) {
    if (p.isHuman) continue;
    for (let a = 0; a < ATTEMPTS; a++) {
      const tx = (Math.random() * w.width) | 0;
      const ty = (Math.random() * w.height) | 0;
      const idx = ty * w.width + tx;
      if (!isOwnable(w.kind[idx])) continue;
      if (w.coastDist[idx] < 25) continue;
      // Tree-proximity gate: bot tribes also need wood within easy
      // reach so their economies actually start ticking.
      if (spawnTribe(state, p.id, idx, true)) break;
    }
  }
}
