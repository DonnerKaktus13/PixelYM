import { useEffect, useState } from "react";
import { BUILDINGS, type BuildingDef } from "../game/catalog";
import { Era, RESOURCE_KEYS, type ResourceKind } from "../game/types";
import type { GameState } from "../game/state";
import { getSpritePath } from "../render/textures";

/** Sentinel value flowed through `selectedKey` to indicate the player is
 *  in "destroy" mode rather than placing a specific building. The App's
 *  click handler watches for this key and routes the click to
 *  destroyStructure. Exported so App.tsx can import the same constant
 *  instead of duplicating the string literal. */
export const DESTROY_KEY = "__destroy__";
/** Sentinel buildKey for the farm-rectangle tool. The App click handler
 *  routes the next two world clicks to claimFarmRectangle instead of
 *  buildStructure. The book closes on pick like any other entry. */
export const FARM_KEY = "__farm__";
/** Sentinel buildKey for the river-carve (shovel) tool. The App click
 *  handler routes the next two world clicks into a 10-tile-wide line
 *  that becomes a river ONLY if it touches existing sea. */
export const SHOVEL_KEY = "__shovel__";

interface Props {
  state: GameState;
  /** Bumps when state changes — used to force a re-render. */
  tick: number;
  /** Currently-selected building def key, or null. */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Click-to-spawn-villager handler. Wired by App.tsx into
   *  canSpawnVillager + spawnVillagerAtHome so the player can force a
   *  burst when they want to grow faster than the auto-spawn cadence. */
  onSpawnVillager?: () => void;
  /** Whether a spawn is currently allowed (under pop cap and the player
   *  has a home tent). Disables the button visually when false. */
  canSpawn?: boolean;
  /** Pretty "used / cap" label for the spawn button. */
  popLabel?: string;
}

/** Resource pills visible in each era. Tribal-era tribes only see the
 *  three basics — the other 11 resources are tracked internally but
 *  hidden until later progression unlocks them. */
const VISIBLE_RESOURCES_BY_ERA: Record<Era, ResourceKind[]> = {
  // Tribal era: wood / rock / iron + the meat workflow (raw + preped) +
  // the three farm berries. Player sees them all from the start so it's
  // obvious which workflows are wired (e.g. raw climbing but meat at 0
  // means they're missing a Meat Prep).
  [Era.Tribal]: [
    "wood", "rock", "iron",
    "gold", "diamond", "uranium",
    "unpreped_meat", "meat",
    "redberry", "yellowberry", "blueberry",
    "wheat", "processedfruit", "bread",
  ],
  [Era.Medieval]: [...RESOURCE_KEYS],
  [Era.Modern]: [...RESOURCE_KEYS],
};

/** Short labels for the resource pills — full names are too wide. */
const RES_SHORT: Record<ResourceKind, string> = {
  wood: "Wood", rock: "Rock", iron: "Iron", gold: "Gold",
  diamond: "Diam", redcrystal: "Red", bluecrystal: "Blue", uranium: "Uran",
  redberry: "Rber", yellowberry: "Yber", blueberry: "Bber",
  mushroom: "Mush", leaves: "Leaf", ash: "Ash",
  meat: "Meat", unpreped_meat: "Raw",
  wheat: "Wht", processedfruit: "Frut", bread: "Brd",
};

export function BuildHUD({ state, selectedKey, onSelect, onSpawnVillager, canSpawn, popLabel }: Props) {
  const human = state.players[state.humanId];
  const [bookOpen, setBookOpen] = useState(false);
  // Multi-page book. Page 0 = the original spread (Buildings + Transport
  // sharing the page). Page 1 = the dedicated Workbench atlas, sitting
  // on barrenpagestructures.png. Reset to 0 whenever the book is closed
  // so re-opening lands on the headline page.
  const [bookPage, setBookPage] = useState<0 | 1 | 2>(0);
  // Page-flip animation. The user shipped a 10-frame sequence — the
  // active frame is 1..10 (matching the filenames structures1.png …
  // structures10.png) and -1 means "no flip in progress, show normal
  // page content". While flipping we hide the page content so the
  // cards don't jump around mid-turn.
  const [flipFrame, setFlipFrame] = useState<number>(-1);

  // Esc closes the open book — standard modal affordance.
  useEffect(() => {
    if (!bookOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBookOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bookOpen]);

  useEffect(() => {
    if (!bookOpen) { setBookPage(0); setFlipFrame(-1); }
  }, [bookOpen]);

  // Frame cadence — total flip ≈ 8 × 65 ms ≈ 520 ms. Matches the
  // structures1.png … structures8.png sequence the user shipped.
  const FLIP_FRAME_MS = 65;
  const FLIP_FRAMES = 8;
  /** When advancing (page 0 → 1) we play 1..8 forward. When going back
   *  (page 1 → 0) we play 8..1 in reverse so the book visually closes
   *  rather than opens — matches the intuition of turning a real page
   *  back the way it came. */
  const flipTo = (newPage: 0 | 1 | 2) => {
    if (newPage === bookPage) return;
    if (flipFrame !== -1) return;
    const forward = newPage > bookPage;
    let frame = forward ? 1 : FLIP_FRAMES;
    const step = forward ? +1 : -1;
    const endFrame = forward ? FLIP_FRAMES : 1;
    const tick = () => {
      setFlipFrame(frame);
      if (frame === endFrame) {
        setTimeout(() => {
          setBookPage(newPage);
          setFlipFrame(-1);
        }, FLIP_FRAME_MS);
        return;
      }
      frame += step;
      setTimeout(tick, FLIP_FRAME_MS);
    };
    tick();
  };

  // Filter by era AND architecture style. A building with non-empty
  // `styles` is shown only if at least one of its styles matches the
  // human's origin biome lock. Universal buildings (tent, workbenches,
  // transport) have no styles tag and pass through automatically.
  const available = BUILDINGS.filter((b) => {
    if (b.era > state.era) return false;
    if (b.styles && b.styles.length > 0) {
      // Strict style gating — biome variants only show to tribes whose
      // originStyles overlap. The taiga cabin is now untagged (universal)
      // so it shows for everyone without needing a special exception.
      return b.styles.some((s) => human.originStyles.includes(s));
    }
    return true;
  });

  const shelters = available
    .filter((b) => b.category === "shelter")
    .slice()
    .sort(shelterRank);
  // Transport icons plus the shovel terraform tool synthesized as a
  // virtual transport card so it sits in the same grid alongside ports
  // and the airship hangar. SHOVEL_KEY routes through App.tsx — picking
  // it switches the cursor into drag-paint mode (click + drag = dig
  // holes; hold shift while dragging = raise terrain). Holes stay inside
  // the player's own kingdom and fill with water only when connected to
  // natural ocean.
  const transport: BuildingDef[] = [
    ...available.filter((b) => b.category === "transport"),
    {
      key: SHOVEL_KEY,
      label: "Shovel (drag = dig, shift+drag = fill)",
      sprite: "tool_shovel",
      size: 0,
      cost: {},
      produces: {},
      era: Era.Tribal,
      category: "transport",
    },
  ];
  const workbenches = available.filter((b) => b.category === "workbench");
  const productions = available.filter((b) => b.category === "production");

  const pickAndClose = (key: string | null) => {
    onSelect(key);
    if (key !== null) setBookOpen(false);
  };

  return (
    <>
      {/* Persistent top strip: resource pills + era / style / current
          build-mode indicator. Stays visible whether the book is open
          or closed so the player can monitor income at a glance. */}
      <div className="status-bar">
        <div className="resource-bar">
          {VISIBLE_RESOURCES_BY_ERA[state.era].map((k) => (
            <div className={`res-pill res-${k}`} key={k} title={k}>
              <span className="k">{RES_SHORT[k]}</span>
              <span>{Math.floor(human.resources[k])}</span>
            </div>
          ))}
        </div>
        <div className="status-meta">
          {onSpawnVillager && (
            <button
              className="cancel-btn"
              disabled={!canSpawn}
              onClick={onSpawnVillager}
              title="Spawn a villager (gated by population cap)"
            >
              + Villager{popLabel ? ` (${popLabel})` : ""}
            </button>
          )}
          <div className="stat-pill"><span className="k">Era</span><span>{eraLabel(state.era)}</span></div>
          <div className="stat-pill">
            <span className="k">Style</span>
            <span>{human.originStyles.length === 0 ? "—" : human.originStyles.join(" + ")}</span>
          </div>
          {selectedKey && (
            <button className="cancel-btn" onClick={() => pickAndClose(null)}>
              Cancel ({getLabel(selectedKey)})
            </button>
          )}
        </div>
      </div>

      {/* Closed-book toggle — bottom-right corner. Click opens the
          build menu overlay; click again (on the open book backdrop or
          the X) to close. */}
      <button
        className={`book-toggle${bookOpen ? " hidden" : ""}`}
        title="Open build menu"
        onClick={() => setBookOpen(true)}
      >
        <img src="/IMG/HUD/book.png" alt="Build menu" draggable={false} />
      </button>

      {/* Open-book overlay. Multi-page:
            page 0 — Bookopend.png with Buildings (left) + Transport
                     (right). Workbenches moved to page 2.
            page 1 — Bookopend2.png (drop the new art at IMG/HUD/),
                     full-spread workbench atlas. Falls back to the
                     same Bookopend.png until the new art ships.
          The two prev/next chevrons flip between them with a 3-frame
          page-turn animation. */}
      {bookOpen && (
        <div className="book-open-overlay" onClick={() => setBookOpen(false)}>
          <div className="book-open-panel" onClick={(e) => e.stopPropagation()}>
            <img
              className="book-open-bg"
              src={
                // Mid-flip: render the structures1..8 animation frame.
                // Out of flip: page 0 is the original Bookopend spread,
                // pages 1 + 2 (Workbenches + Production) both render
                // on barrenpagestructures.png so the right-page
                // parchment area stays consistent across the second
                // and third spreads.
                flipFrame > 0
                  ? `/IMG/HUD/structures${flipFrame}.png`
                  : (bookPage === 1 || bookPage === 2)
                    ? "/IMG/HUD/barrenpagestructures.png"
                    : "/IMG/HUD/Bookopend.png"
              }
              onError={(e) => {
                // Fallback while the new art is still being authored —
                // render the original Bookopend background so the layout
                // doesn't go blank.
                (e.currentTarget as HTMLImageElement).src = "/IMG/HUD/Bookopend.png";
              }}
              alt=""
              draggable={false}
            />
            <button
              className={`book-destroy-btn${selectedKey === DESTROY_KEY ? " active" : ""}`}
              title="Destroy a placed building"
              onClick={() => pickAndClose(DESTROY_KEY)}
            >
              ✕ Destroy
            </button>
            <button
              className={`book-farm-btn${selectedKey === FARM_KEY ? " active" : ""}`}
              title="Claim a rectangle of farmland. Click two corners on the world; villagers will carry ash from the campfire to fertilize each tile."
              onClick={() => pickAndClose(FARM_KEY)}
            >
              ▦ Farm
            </button>
            {flipFrame === -1 && bookPage === 0 && (
              <div className="book-pages">
                {/* Buildings — 3 across × 2 down grid, nudged right by
                    one card-width so the cluster sits over the parchment
                    inset rather than the binding seam. */}
                <div className="book-buildings-col">
                  <BookSection
                    title="Buildings"
                    items={shelters}
                    human={human}
                    selectedKey={selectedKey}
                    onPick={pickAndClose}
                    columns={3}
                  />
                </div>
                {/* Transport — pushed up half a card and right three
                    card-widths so it sits in the upper-right vignette
                    of the book art. */}
                <div className="book-right-col">
                  <BookSection
                    title="Transport"
                    items={transport}
                    human={human}
                    selectedKey={selectedKey}
                    onPick={pickAndClose}
                    columns={transport.length > 6 ? 4 : 3}
                  />
                </div>
              </div>
            )}
            {flipFrame === -1 && bookPage === 1 && (
              <div className="book-pages book-pages-workbench">
                <h3 className="workbench-header">Workbenches</h3>
                <BookSection
                  title="Workbenches"
                  items={workbenches}
                  human={human}
                  selectedKey={selectedKey}
                  onPick={pickAndClose}
                  columns={3}
                />
              </div>
            )}
            {flipFrame === -1 && bookPage === 2 && (
              <div className="book-pages book-pages-production">
                <h3 className="workbench-header">Production Buildings</h3>
                <BookSection
                  title="Production"
                  items={productions}
                  human={human}
                  selectedKey={selectedKey}
                  onPick={pickAndClose}
                  columns={
                    productions.length > 9 ? 4
                    : productions.length > 4 ? 3
                    : 2
                  }
                />
              </div>
            )}
            {/* Page-flip controls. Three-page spread now: Buildings +
                Transport → Workbenches → Production. */}
            <button
              className="book-nav prev"
              onClick={() => flipTo((bookPage - 1) as 0 | 1 | 2)}
              disabled={bookPage === 0}
              title="Previous page"
            >‹</button>
            <button
              className="book-nav next"
              onClick={() => flipTo((bookPage + 1) as 0 | 1 | 2)}
              disabled={bookPage === 2}
              title="Next page"
            >›</button>
            <div className="book-page-label">
              {bookPage === 0 ? "Buildings & Transport" : bookPage === 1 ? "Workbenches" : "Production"} ({bookPage + 1} / 3)
            </div>
            <button
              className="book-close"
              onClick={() => setBookOpen(false)}
              title="Close (Esc)"
            >×</button>
          </div>
        </div>
      )}
    </>
  );
}

interface BookSectionProps {
  title: string;
  items: BuildingDef[];
  human: GameState["players"][number];
  selectedKey: string | null;
  onPick: (key: string | null) => void;
  /** If set, lay the cards out in this many columns instead of the
   *  default vertical stack. Used by the workbench section so its
   *  eight cards read as a 4×2 block. */
  columns?: number;
}

function BookSection({ title: _title, items, human, selectedKey, onPick, columns }: BookSectionProps) {
  // Category headers are baked into the Bookopend.png art, so we don't
  // render a text title here. Cards are sprite-only — on hover the
  // tooltip floats above the sprite with name, cost, and what it
  // produces (the "description" for tribal-era buildings).
  const gridCls = columns ? `book-grid cols-${columns}` : "book-grid";
  return (
    <div className="book-section">
      {items.length === 0 ? (
        <div className="book-empty">—</div>
      ) : (
        <div className={gridCls}>
          {items.map((b) => {
            const affordable = canAfford(human.resources, b.cost);
            const sel = selectedKey === b.key;
            const imgSrc = getSpritePath(b.sprite);
            const hasProduces = b.produces && Object.keys(b.produces).length > 0;
            return (
              <button
                key={b.key}
                className={`book-card${sel ? " selected" : ""}${affordable ? "" : " poor"}`}
                disabled={!affordable}
                onClick={() => onPick(sel ? null : b.key)}
              >
                {imgSrc && <img src={imgSrc} alt="" draggable={false} />}
                <div className="book-card-tip">
                  <div className="book-card-tip-name">{b.label}</div>
                  <div className="book-card-tip-cost">{costLine(b)}</div>
                  {hasProduces && (
                    <div className="book-card-tip-prod">{producesTitle(b)}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function canAfford(resources: Record<ResourceKind, number>, cost: BuildingDef["cost"]): boolean {
  for (const k in cost) {
    const need = cost[k as ResourceKind] ?? 0;
    if (resources[k as ResourceKind] < need) return false;
  }
  return true;
}

function costLine(b: BuildingDef): string {
  const parts: string[] = [];
  for (const k in b.cost) {
    parts.push(`${b.cost[k as ResourceKind]} ${RES_SHORT[k as ResourceKind]}`);
  }
  return parts.length === 0 ? "free" : parts.join(" + ");
}

function producesTitle(b: BuildingDef): string {
  const parts: string[] = [];
  for (const k in b.produces) {
    parts.push(`${b.produces[k as ResourceKind]?.toFixed(2)} ${RES_SHORT[k as ResourceKind]} / tick`);
  }
  return parts.length === 0 ? "Shelter — no income" : parts.join(", ");
}

function getLabel(key: string): string {
  if (key === DESTROY_KEY) return "Destroy mode";
  if (key === FARM_KEY) return "Farm rectangle";
  if (key === SHOVEL_KEY) return "Carve river";
  return BUILDINGS.find((b) => b.key === key)?.label ?? key;
}

/** Sort key for the shelter column. Order:
 *    0. tent     (the founding building always on top)
 *    1. huts     (anything that isn't "tent" or "outpost")
 *    2. outposts (the larger fortified variants on the bottom)
 *  Within each band, catalog order is preserved (Array.sort is stable
 *  in modern JS engines). Mirrors the layout the user sketched:
 *  tent / hut / hut / hut / outpost. */
function shelterRank(a: BuildingDef, b: BuildingDef): number {
  return rank(a) - rank(b);
}
function rank(b: BuildingDef): number {
  if (b.key === "tent") return 0;
  if (/outpost/i.test(b.key) || /outpost/i.test(b.label)) return 2;
  return 1;
}

function eraLabel(era: Era): string {
  switch (era) {
    case Era.Tribal: return "Tribal";
    case Era.Medieval: return "Medieval";
    case Era.Modern: return "Modern";
  }
}
