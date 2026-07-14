import { TileKind, UNOWNED } from "../game/types";
import type { GameState } from "../game/state";
import type { Camera } from "./camera";
import { getSprite, getTexHandle, type TexHandle } from "./textures";

// Accept HMR silently — no full reload on save, so an editor auto-save
// can't restart the world build loop.
if (import.meta.hot) import.meta.hot.accept();

// Ordered cold → hot. Desert sits BEFORE Badlands on the dry side so the
// outer-most dry zone is desert; Badlands (mesa) only shows up deeper in
// the dryest core.
const BIOME_TEX_NAMES = ["taiga", "birch", "forest", "desert", "badlands"];

interface Chunk {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  buffer: ImageData;
  width: number;       // offscreen-pixel dims (last-row/col chunks are smaller)
  height: number;
  offX: number;        // offscreen-pixel origin
  offY: number;
  row: number;
  col: number;
  /** Progressive paint: tile-row count painted so far. 0 = unpainted,
   *  layer.tpc = fully painted. Chunks paint in slices across frames
   *  bounded by a per-frame time budget so a freshly-visible chunk
   *  doesn't cause a 4M-pixel hitch on the frame it first appears. */
  nextTileRow: number;
  /** True once props have been blitted onto the fully-painted chunk —
   *  they only draw once paint is complete so they don't get repainted
   *  over by later slices. */
  propsPainted: boolean;
}

/** One chunk grid. Both layers run at SUB max so sub-pixel density is the
 *  same; the difference is which texture set the painter samples — the low
 *  layer reads from the 1/4-resolution lo-res texture copies, so its PNG
 *  decode and pixel sampling cost less while keeping full sub-pixel detail
 *  in the chunk canvas. Dispatch happens at draw time based on cam.zoom. */
interface ChunkLayer {
  sub: number;
  tpc: number;                       // tiles per chunk = CHUNK_SIZE / sub
  cols: number;
  rows: number;
  lowRes: boolean;                   // true → paint via sampleTexLo
  chunks: Map<number, Chunk>;
  dirty: Set<number>;
  propsByChunk: number[][] | null;
}

/**
 * Lazy-chunked offscreen renderer.
 *
 * The full offscreen would be `worldW × SUB` by `worldH × SUB` pixels, which
 * at SUB=8 + 7000×3500 = 56000×28000 = ~6 GB if eagerly allocated. Instead
 * chunks are allocated on demand — when a tile's chunk first comes into
 * view, the chunk's canvas is created and painted, then cached. Off-screen
 * chunks just don't exist in memory.
 *
 * Each chunk is at most `CHUNK_SIZE × CHUNK_SIZE` (a multiple of SUB so
 * tile blocks never straddle chunks). Chunk world position is implicit in
 * its (row, col) — adjacent chunks read continuous texture columns because
 * sub-pixel sampling uses GLOBAL offscreen coords.
 */
export class Renderer {
  private worldW: number;
  private worldH: number;

  private static readonly CHUNK_SIZE = 2048; // chunk side in offscreen px
  /** Sub-pixel density per tile for the close-up (hi) layer. At SUB=16 a
   *  single slice paint cost ~20 ms (4× the previous SUB=8), blowing past
   *  the 8 ms frame budget so only one slice ever painted per frame and
   *  chunks visibly stalled around the first quarter. Back to 8: slices
   *  fit in budget, multiple slices land per frame, chunks complete in
   *  a handful of frames. */
  private static readonly SUB_HI = 8;
  /** Sub-pixel density for the lo layer. At cam.zoom ≤ ZOOM_LO_THRESHOLD
   *  every viewport pixel already covers ≥ 2 source tiles, so a 2×2 patch
   *  per tile is plenty — 16× fewer sub-pixels paint than the hi layer,
   *  which is the dominant chunk-paint cost when first scrolling around. */
  private static readonly SUB_LO = 2;
  /** Below this camera zoom, every viewport pixel covers ≥ 2 tiles, so the
   *  loss of texture detail in the lo-res copy isn't visible. Switch to the
   *  lo-res layer below the threshold to cut texture sampling cost. */
  private static readonly ZOOM_LO_THRESHOLD = 0.5;

  private hi!: ChunkLayer;
  private lo!: ChunkLayer;

  /** SSAA factor. At 4 the super-canvas was 16× viewport pixels which
   *  meant every chunk drawImage and the per-frame downsample paid 16×
   *  the GPU cost — fine on a beefy desktop but the dominant frame-time
   *  hit elsewhere (4 fps reported at any zoom). At SSAA=1 the super is
   *  the viewport's own size, so it stays useful as a back-buffer cache
   *  (chunks → super skipped on idle frames, only the cheap super → ctx
   *  blit + overlays still run) without the 16× rendering cost. AA can
   *  be re-introduced later via a smaller selective pass. */
  private static readonly SSAA = 1;
  private superCanvas: HTMLCanvasElement | null = null;
  private superCtx: CanvasRenderingContext2D | null = null;
  /** Cached camera + viewport state from the last super-canvas redraw.
   *  When the next frame's camera + chunk state is identical we keep the
   *  existing super-canvas pixels and skip the chunk drawImage stack
   *  entirely — only the final downsample (super → ctx) and the overlay
   *  passes (clouds, day/night) still run. Big win at idle. */
  private lastSuperCamX = Number.NaN;
  private lastSuperCamY = Number.NaN;
  private lastSuperCamZoom = Number.NaN;
  private lastSuperViewW = -1;
  private lastSuperViewH = -1;

  private static readonly TERRAIN: Record<number, [number, number, number]> = {
    [TileKind.Sea]:      [12, 32, 54],
    [TileKind.Ice]:      [206, 222, 234],
    [TileKind.Mountain]: [92, 84, 76],
    [TileKind.Land]:     [86, 124, 76],
    [TileKind.Forest]:   [44, 84, 50],
    [TileKind.Bush]:     [136, 144, 86],
    [TileKind.Snow]:     [232, 236, 240],
    // Dry, freshly-dug dirt. Water-filled holes lerp between this and
    // the deep-ocean palette in paintTileIntoChunk based on waterLevel.
    [TileKind.Hole]:     [62, 44, 28],
  };
  private static readonly SHALLOW = [92, 165, 192] as const;
  private static readonly MEDIUM  = [40, 96, 142] as const;
  private static readonly DEEP    = [12, 32, 60] as const;
  private static readonly SAND    = [224, 204, 144] as const;
  // Parallel to BIOME_TEX_NAMES (cold → hot, with Desert outer / Badlands core).
  private static readonly BIOMES: [number, number, number][] = [
    [62,  110, 92],   // Taiga
    [148, 178, 108],  // Birch
    [54,  104, 60],   // Forest
    [216, 196, 130],  // Desert      (outer dry layer)
    [168, 110, 78],   // Badlands    (inner / hottest)
  ];

  /** Cumulative heat stops carving up 0..255 into 5 non-uniform biome bands.
   *  Forest (and to a lesser extent Birch) are intentionally widened so the
   *  world reads as mostly humid. */
  private static readonly BIOME_STOPS = [0, 28, 88, 180, 220, 256];

  /** Coarse 2D value noise on tile coordinates, returns 0..1. Used by the
   *  mesa-variant picker to choose Meza1 vs Meza2 in large patches (~67-tile
   *  features at FREQ=0.015), with a smoothstep transition near the 0.5
   *  threshold so the two textures don't meet on a hard grid edge. */
  private static mesaNoise(tx: number, ty: number): number {
    const FREQ = 0.015;
    const x = tx * FREQ;
    const y = ty * FREQ;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const hash = (a: number, b: number): number => {
      let h = (a * 374761393 + b * 668265263) | 0;
      h = ((h ^ (h >>> 13)) * 1274126177) | 0;
      h = h ^ (h >>> 16);
      return ((h >>> 0) & 0xffff) / 0xffff;
    };
    const v00 = hash(x0, y0);
    const v10 = hash(x0 + 1, y0);
    const v01 = hash(x0, y0 + 1);
    const v11 = hash(x0 + 1, y0 + 1);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = v00 * (1 - sx) + v10 * sx;
    const bot = v01 * (1 - sx) + v11 * sx;
    return top * (1 - sy) + bot * sy;
  }

  /** Map heat 0..255 to (low band, high band, blend t in [0,1)). */
  private static heatToBand(heat: number): { i0: number; i1: number; t: number } {
    const stops = Renderer.BIOME_STOPS;
    // Find the band heat falls into.
    let i0 = 0;
    for (let i = 0; i < 5; i++) {
      if (heat < stops[i + 1]) { i0 = i; break; }
      i0 = i;
    }
    const lo = stops[i0];
    const hi = stops[i0 + 1];
    // t = 0 at the band's lower edge, ~1 at its upper edge.
    const t = hi > lo ? (heat - lo) / (hi - lo) : 0;
    const i1 = i0 < 4 ? i0 + 1 : 4;
    return { i0, i1, t };
  }

  constructor(worldW: number, worldH: number) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.hi = this.makeLayer(false);
    this.lo = this.makeLayer(true);
  }

  private makeLayer(lowRes: boolean): ChunkLayer {
    const CS = Renderer.CHUNK_SIZE;
    const sub = lowRes ? Renderer.SUB_LO : Renderer.SUB_HI;
    return {
      sub,
      tpc: CS / sub,
      cols: Math.ceil((this.worldW * sub) / CS),
      rows: Math.ceil((this.worldH * sub) / CS),
      lowRes,
      chunks: new Map(),
      dirty: new Set(),
      propsByChunk: null,
    };
  }

  /** Clear all caches and eagerly pre-paint the entire LO layer. The LO
   *  layer is the zoomed-out strategic map — paying its full ~28-chunk
   *  paint cost once at world load means panning + zooming at low zoom is
   *  thereafter instant for the rest of the game session. The HI layer
   *  remains lazy: only allocated when the camera zooms past
   *  ZOOM_LO_THRESHOLD into a region, at which point each new chunk
   *  paints at SUB_HI=16 (2× linear over-resolution) so further zoom-in
   *  within that chunk needs no further paint. */
  fullRepaint(state: GameState): void {
    for (const layer of [this.hi, this.lo]) {
      layer.chunks.clear();
      layer.dirty.clear();
      layer.propsByChunk = null;
    }
    this.prePaintLayer(state, this.lo);
  }

  /** Paint every chunk in `layer` synchronously. Used to pre-render the
   *  LO strategic-map layer at world load so all subsequent low-zoom pans
   *  and zooms are zero-paint. The cost is the layer's full chunk-count
   *  paid up-front: at SUB_LO=2 the LO layer is ~7×4 = 28 chunks for the
   *  default world size, each painting ~1M tiles × 4 sub-pixels = 4M
   *  pixels — under 5 seconds on commodity hardware. */
  private prePaintLayer(state: GameState, layer: ChunkLayer): void {
    for (let r = 0; r < layer.rows; r++) {
      for (let c = 0; c < layer.cols; c++) {
        const chunkIdx = r * layer.cols + c;
        const chunk = this.allocateChunk(layer, r, c);
        layer.chunks.set(chunkIdx, chunk);
        this.paintChunk(state, layer, chunk);
      }
    }
  }

  /** Mark chunks containing changed tiles as dirty on the HI layer only.
   *  The LO layer is a strategic-overview base — at TPC=1024 / SUB=2
   *  each world tile is ≈0.5 LO pixels, so owner-color changes don't
   *  register visually, and progressive repaint of its multi-million-
   *  pixel chunks can't keep up with per-tick dirty bursts. Leaving LO
   *  unaffected keeps the fallback base intact under HI as it re-fills. */
  incrementalRepaint(state: GameState): boolean {
    const w = state.world;
    if (state.dirtyTiles.size === 0) return false;
    const layer = this.hi;
    const TPC = layer.tpc;
    // Edge darkening means a tile's render depends on its 4 neighbors' owners,
    // so a neighbor chunk needs repainting only when the dirty tile sits on
    // this chunk's edge.
    for (const idx of state.dirtyTiles) {
      const tx = idx % w.width;
      const ty = (idx / w.width) | 0;
      this.markChunk(layer, tx, ty);
      const lx = tx - ((tx / TPC) | 0) * TPC;
      const ly = ty - ((ty / TPC) | 0) * TPC;
      if (lx === 0 && tx > 0) this.markChunk(layer, tx - 1, ty);
      else if (lx === TPC - 1 && tx < w.width - 1) this.markChunk(layer, tx + 1, ty);
      if (ly === 0 && ty > 0) this.markChunk(layer, tx, ty - 1);
      else if (ly === TPC - 1 && ty < w.height - 1) this.markChunk(layer, tx, ty + 1);
    }
    state.dirtyTiles.clear();
    return true;
  }

  private markChunk(layer: ChunkLayer, tx: number, ty: number): void {
    const col = (tx / layer.tpc) | 0;
    const row = (ty / layer.tpc) | 0;
    if (col < 0 || col >= layer.cols || row < 0 || row >= layer.rows) return;
    layer.dirty.add(row * layer.cols + col);
  }

  draw(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, cam: Camera, state: GameState): void {
    // 16× SSAA path: render the same scene into an offscreen canvas at
    // SSAA× linear resolution (= SSAA² samples per output pixel), then
    // downsample once to the user-facing viewport. The chunk drawImage
    // calls below are unchanged — they emit viewport-space coords —
    // because we apply a setTransform(SSAA, …) so all writes land on the
    // bigger canvas without rewriting the geometry math.
    const S = Renderer.SSAA;
    const superW = (viewW * S) | 0;
    const superH = (viewH * S) | 0;
    if (!this.superCanvas || this.superCanvas.width !== superW || this.superCanvas.height !== superH) {
      this.superCanvas = document.createElement("canvas");
      this.superCanvas.width = superW;
      this.superCanvas.height = superH;
      this.superCtx = this.superCanvas.getContext("2d")!;
    }
    const sctx = this.superCtx!;

    // Visible tile range plus a pre-fetch margin. Chunks one full HI-chunk
    // outside the strict viewport get allocated and queued for paint too,
    // so as the player pans toward un-rendered territory those chunks have
    // already started painting before the camera reaches them. Without
    // this, paint only kicked in once a chunk was strictly inside the
    // viewport and the player had to "drive into" each new chunk before
    // any work happened.
    const halfTilesW = viewW / 2 / cam.zoom;
    const halfTilesH = viewH / 2 / cam.zoom;
    const MARGIN_TILES = this.hi.tpc; // 1 hi-chunk worth of pre-fetch.
    const minTileX = Math.max(0, Math.floor(cam.x - halfTilesW) - MARGIN_TILES);
    const maxTileX = Math.min(this.worldW - 1, Math.ceil(cam.x + halfTilesW) + MARGIN_TILES);
    const minTileY = Math.max(0, Math.floor(cam.y - halfTilesH) - MARGIN_TILES);
    const maxTileY = Math.min(this.worldH - 1, Math.ceil(cam.y + halfTilesH) + MARGIN_TILES);

    // Cache check: if the camera + viewport hasn't moved AND every visible
    // HI chunk is fully painted and clean, the super-canvas content from
    // the last frame is still bit-perfect. Skip the entire chunk → super
    // drawImage stack — only the downsample at the end and the App's
    // clouds + day/night overlays will re-execute.
    const camSame = cam.x === this.lastSuperCamX
      && cam.y === this.lastSuperCamY
      && cam.zoom === this.lastSuperCamZoom
      && viewW === this.lastSuperViewW
      && viewH === this.lastSuperViewH;
    const needsHiWork = cam.zoom > Renderer.ZOOM_LO_THRESHOLD
      && this.anyVisibleChunkNeedsWork(this.hi, minTileX, maxTileX, minTileY, maxTileY);
    const superDirty = !camSame || needsHiWork;

    if (superDirty) {
      sctx.setTransform(S, 0, 0, S, 0, 0);
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "low";
      sctx.fillStyle = "#040810";
      sctx.fillRect(0, 0, viewW, viewH);

      // Per-frame paint budget. New / in-progress HI chunks consume from
      // this; once exhausted, remaining chunks blit whatever they have
      // so far. Bumped back up after a stint at 2.5 ms made post-spawn
      // chunks visibly "freeze" while painting (the player saw a black
      // viewport for many frames). 6 ms is the largest budget that
      // still allows ~150 Hz; for displays past that, painting will
      // dominate a couple of frames during fresh-territory reveal but
      // steady-state has plenty of headroom thanks to the chunk cache.
      const FRAME_PAINT_BUDGET_MS = 6;
      const paintStart = performance.now();
      const overBudget = () => performance.now() - paintStart >= FRAME_PAINT_BUDGET_MS;

      this.drawLayer(
        sctx, this.lo, state, cam,
        viewW, viewH, minTileX, maxTileX, minTileY, maxTileY, overBudget
      );
      if (cam.zoom > Renderer.ZOOM_LO_THRESHOLD) {
        this.drawLayer(
          sctx, this.hi, state, cam,
          viewW, viewH, minTileX, maxTileX, minTileY, maxTileY, overBudget
        );
      }
      sctx.setTransform(1, 0, 0, 1, 0, 0);

      this.lastSuperCamX = cam.x;
      this.lastSuperCamY = cam.y;
      this.lastSuperCamZoom = cam.zoom;
      this.lastSuperViewW = viewW;
      this.lastSuperViewH = viewH;
    }

    // Final downsample to the actual viewport. Always runs so the App
    // can overdraw clouds + day-night cleanly on a known background.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(this.superCanvas!, 0, 0, viewW, viewH);
  }

  /** True if any chunk inside the visible tile range either isn't fully
   *  painted yet or is flagged dirty. Used by the super-canvas cache to
   *  decide whether the chunks → super pass can be skipped. */
  private anyVisibleChunkNeedsWork(
    layer: ChunkLayer,
    minTileX: number, maxTileX: number,
    minTileY: number, maxTileY: number
  ): boolean {
    const TPC = layer.tpc;
    const minC = (minTileX / TPC) | 0;
    const maxC = Math.min(layer.cols - 1, (maxTileX / TPC) | 0);
    const minR = (minTileY / TPC) | 0;
    const maxR = Math.min(layer.rows - 1, (maxTileY / TPC) | 0);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const idx = r * layer.cols + c;
        const chunk = layer.chunks.get(idx);
        if (!chunk) return true;                // not allocated yet
        if (chunk.nextTileRow < layer.tpc) return true;
        if (layer.dirty.has(idx)) return true;
      }
    }
    return false;
  }

  private allocateChunk(layer: ChunkLayer, row: number, col: number): Chunk {
    const CS = Renderer.CHUNK_SIZE;
    const offX = col * CS;
    const offY = row * CS;
    const w = Math.min(CS, this.worldW * layer.sub - offX);
    const h = Math.min(CS, this.worldH * layer.sub - offY);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const buffer = ctx.createImageData(w, h);
    return {
      canvas, ctx, buffer, width: w, height: h, offX, offY, row, col,
      nextTileRow: 0, propsPainted: false,
    };
  }

  /** Target pixels per slice — sets the granularity of the progressive
   *  paint. Lower = smoother per-frame distribution, higher = fewer slices
   *  to fully paint a chunk. 256k ≈ 3 ms on a modern CPU; with a per-frame
   *  budget of ~8 ms we can paint 2–3 slices per frame without dropping
   *  below 60 fps even on freshly-revealed chunks. */
  private static readonly TARGET_SLICE_PIXELS = 256_000;

  /** Draw a single chunk layer into the super-canvas: progressive paint
   *  (HI) or zero-paint blit (LO, pre-painted). Dirty chunks clear their
   *  canvas first so the LO base shows through the cleared area while
   *  slices re-fill — instead of stale tiles freezing on screen until
   *  paint finishes. */
  private drawLayer(
    sctx: CanvasRenderingContext2D,
    layer: ChunkLayer,
    state: GameState,
    cam: Camera,
    viewW: number,
    viewH: number,
    minTileX: number,
    maxTileX: number,
    minTileY: number,
    maxTileY: number,
    overBudget: () => boolean
  ): void {
    const SUB = layer.sub;
    const TPC = layer.tpc;
    const minC = (minTileX / TPC) | 0;
    const maxC = Math.min(layer.cols - 1, (maxTileX / TPC) | 0);
    const minR = (minTileY / TPC) | 0;
    const maxR = Math.min(layer.rows - 1, (maxTileY / TPC) | 0);

    // Two-pass: first round we collect every visible chunk, reset any
    // dirty ones, and queue up the ones that still need slices. Then we
    // round-robin one slice per chunk per frame until either every chunk
    // is fully painted or the budget runs out. This replaces the old
    // "paint chunk 1 to budget exhaustion, leave chunks 2..N at zero
    // progress" behaviour, which made the HI render look like it gave
    // up halfway across the viewport.
    const unfinished: Chunk[] = [];
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const chunkIdx = r * layer.cols + c;
        let chunk = layer.chunks.get(chunkIdx);
        if (!chunk) {
          chunk = this.allocateChunk(layer, r, c);
          layer.chunks.set(chunkIdx, chunk);
        }
        if (layer.dirty.has(chunkIdx)) {
          // NOTE: we do NOT clearRect here. The old chunk content stays
          // on the canvas until each slice's putImageData overwrites its
          // strip — that way a dirty repaint (e.g. tree harvest) looks
          // like the OLD picture slowly being replaced row-by-row by the
          // new one, instead of the chunk visibly going transparent and
          // showing the LO base through it.
          chunk.nextTileRow = 0;
          chunk.propsPainted = false;
          layer.dirty.delete(chunkIdx);
        }
        if (chunk.nextTileRow < layer.tpc) unfinished.push(chunk);
      }
    }
    // Round-robin paint pass. Each iteration walks the unfinished list
    // once and paints one slice per chunk before re-checking the budget,
    // so every visible chunk makes visible progress per frame.
    let progressed = true;
    while (progressed && !overBudget()) {
      progressed = false;
      for (const chunk of unfinished) {
        if (chunk.nextTileRow >= layer.tpc) continue;
        this.paintChunkSlice(state, layer, chunk);
        progressed = true;
        if (overBudget()) break;
      }
    }
    // Blit every visible chunk (finished or not — partially-painted ones
    // still show the old content under the new strips).
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const chunkIdx = r * layer.cols + c;
        const chunk = layer.chunks.get(chunkIdx);
        if (!chunk) continue;
        const tileX = chunk.offX / SUB;
        const tileY = chunk.offY / SUB;
        const tileW = chunk.width / SUB;
        const tileH = chunk.height / SUB;
        const destXf = viewW / 2 + (tileX - cam.x) * cam.zoom;
        const destYf = viewH / 2 + (tileY - cam.y) * cam.zoom;
        const destEndXf = viewW / 2 + (tileX + tileW - cam.x) * cam.zoom;
        const destEndYf = viewH / 2 + (tileY + tileH - cam.y) * cam.zoom;
        const dx = Math.floor(destXf);
        const dy = Math.floor(destYf);
        const dw = Math.ceil(destEndXf) - dx;
        const dh = Math.ceil(destEndYf) - dy;
        sctx.drawImage(chunk.canvas, dx, dy, dw, dh);
      }
    }
  }

  /** Paint the next slice of tile rows on `chunk`, return true if the
   *  chunk became fully painted on this call. Only writes the affected
   *  strip back to the chunk canvas so unfinished chunks don't re-pay
   *  putImageData for already-painted rows. Props are deferred until the
   *  chunk is complete so the final blit doesn't get overwritten. */
  private paintChunkSlice(state: GameState, layer: ChunkLayer, chunk: Chunk): boolean {
    const TPC = layer.tpc;
    if (chunk.nextTileRow >= TPC) return false;
    const w = state.world;
    const SUB = layer.sub;
    // Slice size in tile rows ≈ TARGET_SLICE_PIXELS / (tilesPerRow × SUB²).
    const sliceRows = Math.max(
      1,
      Math.floor(Renderer.TARGET_SLICE_PIXELS / (TPC * SUB * SUB))
    );
    const startRow = chunk.nextTileRow;
    const endRow = Math.min(startRow + sliceRows, TPC);
    const startTileX = chunk.col * TPC;
    const startTileY = chunk.row * TPC + startRow;
    const endTileX = Math.min(startTileX + TPC, w.width);
    const endTileY = Math.min(chunk.row * TPC + endRow, w.height);

    for (let ty = startTileY; ty < endTileY; ty++) {
      for (let tx = startTileX; tx < endTileX; tx++) {
        const idx = ty * w.width + tx;
        this.paintTileIntoChunk(state, layer, idx, chunk, tx, ty);
      }
    }

    // Push just the painted strip onto the chunk canvas.
    const stripY = startRow * SUB;
    const stripH = Math.min((endRow - startRow) * SUB, chunk.height - stripY);
    if (stripH > 0) {
      chunk.ctx.putImageData(chunk.buffer, 0, 0, 0, stripY, chunk.width, stripH);
    }
    chunk.nextTileRow = endRow;

    if (chunk.nextTileRow >= TPC && !chunk.propsPainted) {
      this.paintPropsIntoChunk(state, layer, chunk);
      chunk.propsPainted = true;
      return true;
    }
    return false;
  }

  /** Eager full-chunk paint, kept for the dirty-tile path where the
   *  caller already accepted "do the work now". */
  private paintChunk(state: GameState, layer: ChunkLayer, chunk: Chunk): void {
    const w = state.world;
    const TPC = layer.tpc;
    const startTileX = chunk.col * TPC;
    const startTileY = chunk.row * TPC;
    const endTileX = Math.min(startTileX + TPC, w.width);
    const endTileY = Math.min(startTileY + TPC, w.height);

    for (let ty = startTileY; ty < endTileY; ty++) {
      for (let tx = startTileX; tx < endTileX; tx++) {
        const idx = ty * w.width + tx;
        this.paintTileIntoChunk(state, layer, idx, chunk, tx, ty);
      }
    }
    chunk.ctx.putImageData(chunk.buffer, 0, 0);
    chunk.nextTileRow = TPC;
    chunk.propsPainted = false;
    this.paintPropsIntoChunk(state, layer, chunk);
    chunk.propsPainted = true;
  }

  /**
   * Draw any world prop whose bounding box overlaps this chunk on top of the
   * terrain buffer. Each drawImage uses the 9-arg form with the SOURCE rect
   * clipped to just the portion of the sprite that falls inside this chunk's
   * pixel bounds, and the DEST rect clipped to the visible region. Without
   * this, a 600-tile-wide plateau would ask drawImage to scale the full
   * 1254² source up to 4800² before clipping — Chrome allocates ~90MB of
   * intermediate GPU buffer per call, which OOMs the renderer process when
   * many chunks each see several large props.
   */
  private paintPropsIntoChunk(state: GameState, layer: ChunkLayer, chunk: Chunk): void {
    const w = state.world;
    if (!w.props || w.props.length === 0) return;
    if (!layer.propsByChunk) this.buildPropIndex(state, layer);
    const propIdxs = layer.propsByChunk![chunk.row * layer.cols + chunk.col];
    if (!propIdxs || propIdxs.length === 0) return;
    const SUB = layer.sub;
    const cMinPx = chunk.offX;
    const cMinPy = chunk.offY;
    const cMaxPx = chunk.offX + chunk.width;
    const cMaxPy = chunk.offY + chunk.height;
    const ctx = chunk.ctx;
    ctx.imageSmoothingEnabled = false;

    for (const i of propIdxs) {
      const prop = w.props[i];
      // LIVE TREES are painted in a SEPARATE pass (drawTrees in
      // structures.ts) that runs AFTER drawStructures, so the canopy
      // sits visually on top of any villager standing under it. We
      // still draw the stump variant inside the chunk once the tree
      // is fully harvested — a stump is ground-level and shouldn't
      // obscure villagers, so the chunk path is correct for it.
      const isLiveTree = prop.sprite.startsWith("tree_")
        && !(state.harvestedProps && state.harvestedProps.has(i));
      if (isLiveTree) continue;
      // Dying props are rendered by the per-frame overlay (drawDyingProps
      // in structures.ts) so they can flip + fade smoothly. Skipping
      // them here AND keeping them out of harvestedProps for the
      // duration of the animation is what keeps them visibly on screen
      // even when nearby terrain is flooding under them.
      if (state.dyingProps && state.dyingProps.has(i)) continue;
      // Harvested? Swap to the matching stub sprite (tree stump or the
      // hollow-rock variant) so the player sees they cleared the spot —
      // the bare-ground exclusion used to read as "the prop just
      // vanished". The stubs respawn on the same day-rollover schedule
      // as the full prop.
      let spriteKey = prop.sprite;
      let sizeScale = 1;
      if (state.harvestedProps && state.harvestedProps.has(i)) {
        const stub = harvestedStubSprite(prop.sprite);
        if (!stub) continue;
        spriteKey = stub;
        // Tree stumps are a small remnant — the source art covers the
        // full tree silhouette, so we shrink its footprint to 1/4 so it
        // reads as a low stump on the ground. Rock stubs already match
        // the harvested-rock shape and stay at full size.
        if (stub === "treestump" || stub === "treestump_snowy") sizeScale = 0.25;
      }
      const sprite = getSprite(spriteKey);
      if (!sprite) continue;

      // Prop bbox in offscreen-pixel coords (global, across all chunks).
      const drawSize = prop.size * sizeScale;
      const pMinPx = (prop.x - drawSize) * SUB;
      const pMinPy = (prop.y - drawSize) * SUB;
      const pSize = drawSize * 2 * SUB;
      // Intersect with this chunk's pixel bounds.
      const ix0 = pMinPx > cMinPx ? pMinPx : cMinPx;
      const iy0 = pMinPy > cMinPy ? pMinPy : cMinPy;
      const ix1 = pMinPx + pSize < cMaxPx ? pMinPx + pSize : cMaxPx;
      const iy1 = pMinPy + pSize < cMaxPy ? pMinPy + pSize : cMaxPy;
      if (ix1 <= ix0 || iy1 <= iy0) continue;

      // Source-rect mapping: the full sprite covers the full prop bbox.
      const srcScaleX = sprite.width / pSize;
      const srcScaleY = sprite.height / pSize;
      const sx = (ix0 - pMinPx) * srcScaleX;
      const sy = (iy0 - pMinPy) * srcScaleY;
      const sw = (ix1 - ix0) * srcScaleX;
      const sh = (iy1 - iy0) * srcScaleY;

      ctx.drawImage(
        sprite,
        sx, sy, sw, sh,
        ix0 - cMinPx, iy0 - cMinPy, ix1 - ix0, iy1 - iy0
      );
    }
  }

  /** Bucket every prop into the chunks its bbox touches. Called once per
   *  layer the first time a prop-paint pass needs the index. Each bucket
   *  is sorted by prop.y ascending so during paint the props farther from
   *  the camera (lower y, "behind") are drawn first and props closer to
   *  the bottom of the world overlap on top — the standard "lower-on-
   *  screen wins" overlap order. */
  private buildPropIndex(state: GameState, layer: ChunkLayer): void {
    const props = state.world.props;
    const TPC = layer.tpc;
    const buckets: number[][] = new Array(layer.rows * layer.cols);
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      const minC = Math.max(0, Math.floor((p.x - p.size) / TPC));
      const maxC = Math.min(layer.cols - 1, Math.floor((p.x + p.size) / TPC));
      const minR = Math.max(0, Math.floor((p.y - p.size) / TPC));
      const maxR = Math.min(layer.rows - 1, Math.floor((p.y + p.size) / TPC));
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const k = r * layer.cols + c;
          (buckets[k] ??= []).push(i);
        }
      }
    }
    for (const bucket of buckets) {
      if (bucket) bucket.sort((a, b) => props[a].y - props[b].y);
    }
    layer.propsByChunk = buckets;
  }

  private paintTileIntoChunk(
    state: GameState,
    layer: ChunkLayer,
    idx: number,
    chunk: Chunk,
    tx: number,
    ty: number
  ): void {
    const w = state.world;
    const SUB = layer.sub;
    const TPC = layer.tpc;
    const kind = w.kind[idx];
    const o = w.owner[idx];
    const dist = w.coastDist[idx];
    const chunkData = chunk.buffer.data;
    const chunkW = chunk.width;
    const localTileX = tx - chunk.col * TPC;
    const localTileY = ty - chunk.row * TPC;
    const baseX = localTileX * SUB;
    const baseY = localTileY * SUB;

    // Texture choice + crossfade.
    let texName = "";
    let texName2: string | null = null;
    let blend = 0;
    let fallback: readonly [number, number, number];

    if (kind === TileKind.Sea) {
      const isChannel = w.seaChannel[idx] === 1;
      // Add the per-tile noise offset to the underlying Manhattan distance
      // before bucketing into depth bands. This breaks up the diamond
      // iso-curves that pure chamfer distance produces, so band edges
      // wander organically instead of forming 45°-rotated squares.
      let eff = dist + w.oceanDistJitter[idx];
      if (eff < 0) eff = 0;
      if (isChannel || eff <= 5) {
        texName = "ocean_shallow";
        fallback = Renderer.SHALLOW;
      } else if (eff <= 50) {
        texName = "ocean_shallow";
        texName2 = "ocean_medium";
        blend = (eff - 5) / 45;
        fallback = Renderer.SHALLOW;
      } else if (eff <= 100) {
        texName = "ocean_medium";
        fallback = Renderer.MEDIUM;
      } else if (eff <= 180) {
        texName = "ocean_medium";
        texName2 = "ocean_deep";
        blend = (eff - 100) / 80;
        fallback = Renderer.MEDIUM;
      } else {
        texName = "ocean_deep";
        fallback = Renderer.DEEP;
      }
    } else if (kind === TileKind.Snow) {
      texName = "snow";
      fallback = Renderer.TERRAIN[TileKind.Snow];
    } else if (kind === TileKind.Mountain) {
      texName = "mountain";
      fallback = Renderer.TERRAIN[TileKind.Mountain];
    } else if (kind === TileKind.Hole) {
      // Player-dug pit. Compute the per-tile colour by lerping between
      // dry-dirt and water-blue based on the waterLevel ratio. Depth
      // pushes both colours darker so deep pits read as more dramatic
      // pits / deep water than shallow rim tiles.
      texName = "";
      const d = w.holeDepth[idx];
      // Polish: smooth wetMix across orthogonal neighbours so the
      // boundary between filled and empty tiles isn't a hard quantised
      // edge. Self-weighted 3× to keep the centre's level dominant; a
      // soft 1× from each Hole neighbour gives a gentle dither. Sea
      // neighbours read as "fully wet" so a tile adjacent to natural
      // ocean blends correctly. Land / mountain neighbours read as
      // "fully dry" so the rim of a partially-filled pond fades to
      // dirt instead of clipping into the surrounding terrain.
      const W = w.width;
      const H = w.height;
      const tx2 = idx % W;
      const ty2 = (idx / W) | 0;
      let mixSum = 0;
      let mixCnt = 0;
      const selfWet = d > 0 ? Math.min(1, w.waterLevel[idx] / d) : 0;
      mixSum += selfWet * 3; mixCnt += 3;
      const nbsIdx = [
        tx2 > 0       ? idx - 1 : -1,
        tx2 < W - 1   ? idx + 1 : -1,
        ty2 > 0       ? idx - W : -1,
        ty2 < H - 1   ? idx + W : -1,
      ];
      for (const n of nbsIdx) {
        if (n < 0) continue;
        const nk = w.kind[n];
        if (nk === TileKind.Hole) {
          const nd = w.holeDepth[n];
          mixSum += nd > 0 ? Math.min(1, w.waterLevel[n] / nd) : 0;
          mixCnt += 1;
        } else if (nk === TileKind.Sea) {
          mixSum += 1; mixCnt += 1;
        } else {
          mixSum += 0; mixCnt += 1;
        }
      }
      const wetMix = mixSum / mixCnt;
      // Depth darkening 0..0.7 (cap so very deep holes don't go pitch
      // black). holeDepth ranges 1..MAX_HOLE_DEPTH (≈ 8).
      const depthRatio = d > 0 ? Math.min(1, d / 8) : 0;
      const darken = 1 - 0.55 * depthRatio;
      const dry: readonly [number, number, number] = [
        62 * darken, 44 * darken, 28 * darken,
      ];
      // Wet colour interpolates from shallow → deep ocean as depth grows.
      const wetR = 92 + (12 - 92) * depthRatio;
      const wetG = 165 + (32 - 165) * depthRatio;
      const wetB = 192 + (60 - 192) * depthRatio;
      fallback = [
        dry[0] * (1 - wetMix) + wetR * wetMix,
        dry[1] * (1 - wetMix) + wetG * wetMix,
        dry[2] * (1 - wetMix) + wetB * wetMix,
      ] as readonly [number, number, number];
    } else if (kind === TileKind.Land) {
      if (dist <= 5) {
        texName = "sand";
        fallback = Renderer.SAND;
      } else {
        // Non-uniform heat bands so the world reads as mostly humid:
        //   Taiga    [0,   28]    ~11%
        //   Birch    [28,  88]    ~24%
        //   Forest   [88,  180]   ~36%
        //   Desert   [180, 220]   ~16%
        //   Badlands [220, 255]   ~14%
        // Forest + Birch ≈ 60% of land, desert/badlands ≈ 30%.
        const heat = w.heat[idx];
        const band = Renderer.heatToBand(heat);
        texName = BIOME_TEX_NAMES[band.i0];
        if (band.i1 !== band.i0) {
          texName2 = BIOME_TEX_NAMES[band.i1];
          blend = band.t * band.t * (3 - 2 * band.t);
        }
        fallback = Renderer.BIOMES[band.i0];
      }
    } else {
      fallback = Renderer.TERRAIN[kind] ?? Renderer.TERRAIN[TileKind.Land];
    }

    // Mesa-variant pick: half the badlands tiles use Meza1, half use Meza2,
    // chosen by a coarse value noise so the two textures appear in patches
    // rather than per-tile checkerboard. If badlands is the sole texture for
    // this tile (no cross-band blend), tiles near the noise threshold get a
    // smooth cross-fade between the two variants. If badlands is already on
    // one side of a cross-band blend (e.g. Desert→Badlands), the variant is
    // resolved by dominant noise side and no extra blend is added.
    if (kind === TileKind.Land && (texName === "badlands" || texName2 === "badlands")) {
      const n = Renderer.mesaNoise(tx, ty);
      const dom = n >= 0.5 ? "badlands2" : "badlands";
      if (texName === "badlands" && texName2 === null) {
        if (n >= 0.45 && n <= 0.55) {
          texName = "badlands";
          texName2 = "badlands2";
          const t = (n - 0.45) / 0.1;
          blend = t * t * (3 - 2 * t);
        } else {
          texName = dom;
        }
      } else {
        if (texName === "badlands") texName = dom;
        if (texName2 === "badlands") texName2 = dom;
      }
    }

    // Mountain density blend on Land tiles: tiles with 0 < density ≤ 128
    // stay Land but the renderer fades in the mountain texture. Above 128
    // the tile is already Mountain (kind switched), so no blend here.
    let mountainBlend = 0;
    if (kind === TileKind.Land) {
      const md = w.mountainDensity[idx];
      if (md > 0) mountainBlend = Math.min(1, md / 128);
    }

    let or = 0, og = 0, ob = 0;
    let hasOwner = false;
    // Skip the owner tint on hole tiles — the colour we just computed
    // (dirt ↔ water blend by depth + fill) is the whole point of the
    // hole rendering and the standard 65% owner mix would drown it out.
    // The surrounding land tiles still carry the territory colour so the
    // pit reads as "inside my kingdom" via its rim, not via the floor.
    if (o !== UNOWNED && kind >= TileKind.Land && kind !== TileKind.Hole) {
      const rgb = state.players[o].colorRgb;
      or = (rgb >> 16) & 0xff;
      og = (rgb >> 8) & 0xff;
      ob = rgb & 0xff;
      hasOwner = true;
    }

    // Farmland override. State 1 = pending, state 2 = farmed; the
    // wet/dry axis (coastDist <= 15) picks one of four PNG textures
    // the user dropped in /IMG/GT. Each tile renders exactly ONE
    // copy of the texture (no wrap), so the farmland grid lines up
    // with the tile grid — per the user's "1 grid = 1 row" request.
    // The actual per-tile sampling override happens in the pixel
    // loop below; this block just records whether the tile is
    // farmland and which variant.
    const fState = w.farmlandState ? w.farmlandState[idx] : 0;
    // Farmland is "wet" if it's within 10 tiles of natural water OR if
    // it's part of a wet connected farmland network (the user's "water
    // tunnels" — fine channels too small to block villager paths but
    // large enough to ferry water from a coastal seed across the field).
    // Computed in state.wetFarmlandTiles by paintFarmTile + the resume
    // rebuild; falls back to the raw distance check for tiles that
    // pre-date the index.
    const isWet = (state.wetFarmlandTiles && state.wetFarmlandTiles.has(idx))
      || w.coastDist[idx] <= 10;
    let farmTexName: string | null = null;
    if (fState === 1) farmTexName = isWet ? "farm_wet_pending" : "farm_dry_pending";
    else if (fState === 2) farmTexName = isWet ? "farm_wet_harvested" : "farm_dry_harvested";

    // Rounded-corner mask for farmland edges. A corner is "rounded" when
    // BOTH adjacent edges are exposed — i.e. neither orthogonal neighbour
    // is farmland. Tiles in the middle of a patch read all four corners
    // as un-rounded; the patch's outline emerges as soft quarter-circles
    // at the four convex corners, with straight edges between them. When
    // the player paints a new tile adjacent to existing farmland the
    // dirty-mark in paintFarmTile makes both tiles repaint, so the
    // formerly-exposed corner becomes interior and the shape grows
    // smoothly.
    let farmRoundNW = false, farmRoundNE = false, farmRoundSW = false, farmRoundSE = false;
    if (fState > 0 && w.farmlandState) {
      const W = w.width;
      const H = w.height;
      const nF = ty > 0       && w.farmlandState[idx - W] > 0;
      const sF = ty < H - 1   && w.farmlandState[idx + W] > 0;
      const eF = tx < W - 1   && w.farmlandState[idx + 1] > 0;
      const wF = tx > 0       && w.farmlandState[idx - 1] > 0;
      farmRoundNW = !nF && !wF;
      farmRoundNE = !nF && !eF;
      farmRoundSW = !sF && !wF;
      farmRoundSE = !sF && !eF;
    }
    /** Fraction of a tile (0..1) that the corner quarter-circle occupies.
     *  0.4 → the corner box is a 40 %-side square, and inside it pixels
     *  outside the quarter-circle get masked back to the underlying
     *  biome texture. Reads as a moderate "tile with rounded corners". */
    const FARM_CORNER_R = 0.4;
    const farmAnyRounded = farmRoundNW || farmRoundNE || farmRoundSW || farmRoundSE;

    let edge = false;
    if (kind >= TileKind.Land) {
      const W = w.width;
      if (tx > 0)            edge = w.kind[idx - 1] < TileKind.Land || w.owner[idx - 1] !== o;
      if (!edge && tx < W-1) edge = w.kind[idx + 1] < TileKind.Land || w.owner[idx + 1] !== o;
      if (!edge && ty > 0)   edge = w.kind[idx - W] < TileKind.Land || w.owner[idx - W] !== o;
      if (!edge && ty < w.height-1) edge = w.kind[idx + W] < TileKind.Land || w.owner[idx + W] !== o;
    }

    // Hoist texture handles per-tile so the inner loop reads the raw byte
    // buffer directly with no function calls / hash lookups / wrap-modulo
    // on negative inputs. globalPx/globalPy are non-negative here (chunk
    // origin + non-negative offsets), so the simpler `coord % size` wrap
    // is safe and we skip the `((x % N) + N) % N` dance.
    const lowRes = layer.lowRes;
    const tex1: TexHandle | null = texName ? getTexHandle(texName, lowRes) : null;
    const useBlend = texName2 !== null && blend > 0.01;
    const tex2: TexHandle | null = useBlend ? getTexHandle(texName2!, lowRes) : null;
    const useMountain = mountainBlend > 0.01;
    const texM: TexHandle | null = useMountain ? getTexHandle("mountain", lowRes) : null;
    // Farmland override texture — sampled in TILE-LOCAL coords so each
    // tile renders one complete copy of the PNG. That's the
    // "1 grid = 1 row" alignment the user asked for.
    const texF: TexHandle | null = farmTexName ? getTexHandle(farmTexName, lowRes) : null;
    const dataF = texF?.data ?? null;
    const TSF = texF?.size ?? 0;
    // All loaded textures share the same size per layer, so the wrap modulus
    // and coord shift can be hoisted out of every per-pixel branch.
    const TS = tex1?.size ?? tex2?.size ?? texM?.size ?? 0;
    const TSHIFT = tex1?.shift ?? tex2?.shift ?? texM?.shift ?? 0;
    const data1 = tex1?.data ?? null;
    const data2 = tex2?.data ?? null;
    const dataM = texM?.data ?? null;
    const fr = fallback[0], fg = fallback[1], fb = fallback[2];
    const blendInv = 1 - blend;
    const mtnInv = 1 - mountainBlend;

    // Farmland sampling parameters. The texture spans
    // FARM_TEX_TILE_SPAN × FARM_TEX_TILE_SPAN tiles per PNG copy, and
    // the sampling axes are swapped to rotate the texture 90° — visually
    // a transpose, which the user wanted to spice up the field pattern.
    // Bumped from 10 → 100 per the latest "10× bigger" request: each PNG
    // copy now stretches across a 100×100-tile patch of farmland.
    const FARM_TEX_TILE_SPAN = 100;
    const FARM_BLOCK_PX = FARM_TEX_TILE_SPAN * SUB;
    const farmLocalTileX = ((tx % FARM_TEX_TILE_SPAN) + FARM_TEX_TILE_SPAN) % FARM_TEX_TILE_SPAN;
    const farmLocalTileY = ((ty % FARM_TEX_TILE_SPAN) + FARM_TEX_TILE_SPAN) % FARM_TEX_TILE_SPAN;
    const farmBaseX = farmLocalTileX * SUB;
    const farmBaseY = farmLocalTileY * SUB;
    for (let sy = 0; sy < SUB; sy++) {
      const py = baseY + sy;
      const globalPy = chunk.offY + py;
      // Hoist the Y wrap once per row — SUB-x less work than the inner loop.
      const texY = TS > 0 ? (globalPy >> TSHIFT) % TS : 0;
      const rowOff = texY * TS * 3;
      // Farm sampling source-X (drives the rotated texture's Y axis,
      // since we transpose below). 10-tile span × SUB-per-tile → divide
      // the block-local pixel position by the block size to get a 0..TSF
      // texture coordinate.
      const farmSrcX = dataF ? farmBaseX + sy /* note: swapped with sx for 90° */ : 0;
      // farmSrcX is the FINAL texture-Y once we transpose; compute it
      // once per row from sy (the row we're rendering). The X axis is
      // resolved inside the inner loop because that depends on sx.
      const farmTexY = dataF ? ((farmSrcX * TSF) / FARM_BLOCK_PX) | 0 : 0;
      const farmRowOff = farmTexY * TSF * 3;
      for (let sx = 0; sx < SUB; sx++) {
        const px = baseX + sx;
        const globalPx = chunk.offX + px;
        const texX = TS > 0 ? (globalPx >> TSHIFT) % TS : 0;
        const texOff = rowOff + texX * 3;

        let r: number, g: number, b: number;
        // Rounded-corner mask check. Compute once per pixel only when
        // the tile is farmland with at least one exposed corner — most
        // tiles in a patch have all four corners interior and skip the
        // entire check at near-zero cost.
        let maskedByFarmCorner = false;
        if (dataF && farmAnyRounded) {
          // Tile-local subpixel position in [0, 1).
          const uu = sx / SUB;
          const vv = sy / SUB;
          if (farmRoundNW && uu < FARM_CORNER_R && vv < FARM_CORNER_R) {
            const du = uu - FARM_CORNER_R;
            const dv = vv - FARM_CORNER_R;
            if (du * du + dv * dv > FARM_CORNER_R * FARM_CORNER_R) maskedByFarmCorner = true;
          } else if (farmRoundNE && uu > 1 - FARM_CORNER_R && vv < FARM_CORNER_R) {
            const du = uu - (1 - FARM_CORNER_R);
            const dv = vv - FARM_CORNER_R;
            if (du * du + dv * dv > FARM_CORNER_R * FARM_CORNER_R) maskedByFarmCorner = true;
          } else if (farmRoundSW && uu < FARM_CORNER_R && vv > 1 - FARM_CORNER_R) {
            const du = uu - FARM_CORNER_R;
            const dv = vv - (1 - FARM_CORNER_R);
            if (du * du + dv * dv > FARM_CORNER_R * FARM_CORNER_R) maskedByFarmCorner = true;
          } else if (farmRoundSE && uu > 1 - FARM_CORNER_R && vv > 1 - FARM_CORNER_R) {
            const du = uu - (1 - FARM_CORNER_R);
            const dv = vv - (1 - FARM_CORNER_R);
            if (du * du + dv * dv > FARM_CORNER_R * FARM_CORNER_R) maskedByFarmCorner = true;
          }
        }
        if (dataF && !maskedByFarmCorner) {
          // Rotated 10× farmland sampling — sx drives the final
          // texture-X (formerly drove Y). Block-local pixel = farmBaseY
          // + sx; mapped to TSF range across FARM_BLOCK_PX pixels.
          const farmSrcY = farmBaseY + sx;
          const farmTexX = ((farmSrcY * TSF) / FARM_BLOCK_PX) | 0;
          const farmOff = farmRowOff + farmTexX * 3;
          r = dataF[farmOff]; g = dataF[farmOff + 1]; b = dataF[farmOff + 2];
        } else if (data1) {
          r = data1[texOff]; g = data1[texOff + 1]; b = data1[texOff + 2];
          if (data2) {
            r = r * blendInv + data2[texOff]     * blend;
            g = g * blendInv + data2[texOff + 1] * blend;
            b = b * blendInv + data2[texOff + 2] * blend;
          }
        } else {
          r = fr; g = fg; b = fb;
        }
        if (dataM) {
          r = r * mtnInv + dataM[texOff]     * mountainBlend;
          g = g * mtnInv + dataM[texOff + 1] * mountainBlend;
          b = b * mtnInv + dataM[texOff + 2] * mountainBlend;
        }
        if (hasOwner) {
          r = or * 0.65 + r * 0.35;
          g = og * 0.65 + g * 0.35;
          b = ob * 0.65 + b * 0.35;
        }
        if (edge) {
          r *= 0.55;
          g *= 0.55;
          b *= 0.55;
        }
        const off = (py * chunkW + px) * 4;
        chunkData[off]     = r | 0;
        chunkData[off + 1] = g | 0;
        chunkData[off + 2] = b | 0;
        chunkData[off + 3] = 255;
      }
    }
  }
}

/** Pick the right "harvested stub" sprite for a prop the player has just
 *  chopped or mined. Trees get a wooden stump (snowy variant if it was
 *  a taiga tree); rocks get the matching hollow-shape harvested PNG.
 *  Returns null if the prop doesn't have a defined stub (bushes /
 *  mesa plateaus / volcanoes — bushes simply disappear, the rest
 *  aren't harvestable). */
function harvestedStubSprite(sprite: string): string | null {
  if (sprite.startsWith("tree_taiga")) return "treestump_snowy";
  if (sprite.startsWith("tree_")) return "treestump";
  if (sprite.endsWith("_spikebatch")) return "harvested_spikebatch";
  if (sprite.endsWith("_arch"))       return "harvested_arch";
  if (sprite.endsWith("_mound"))      return "harvested_mound";
  if (sprite.endsWith("_spire"))      return "harvested_spire";
  if (sprite.endsWith("_spike"))      return "harvested_spire";
  if (sprite.endsWith("_rock"))       return "harvested_rock";
  return null;
}
