export interface Camera {
  x: number;
  y: number;
  /** Pixels-per-tile zoom. */
  zoom: number;
}

/** The smallest zoom (pixels-per-tile) at which the world still completely
 *  covers the viewport on both axes — i.e. no black bars on either side.
 *  Below this, the viewport would show the page-background outside the
 *  map; above it, the world is cropped on at least one axis. Zooming out
 *  past this value is disallowed and the player starts here. */
function coverZoom(worldW: number, worldH: number, viewW: number, viewH: number): number {
  if (viewW <= 0 || viewH <= 0) return 0.1;
  return Math.max(viewW / worldW, viewH / worldH);
}

export function makeCamera(worldW: number, worldH: number, viewW: number, viewH: number): Camera {
  // Start at the "world fully covers viewport" zoom so no off-map area
  // is visible on first frame.
  return { x: worldW / 2, y: worldH / 2, zoom: coverZoom(worldW, worldH, viewW, viewH) };
}

export function screenToWorld(cam: Camera, viewW: number, viewH: number, sx: number, sy: number): { x: number; y: number } {
  const x = cam.x + (sx - viewW / 2) / cam.zoom;
  const y = cam.y + (sy - viewH / 2) / cam.zoom;
  return { x, y };
}

export function clampCamera(cam: Camera, worldW: number, worldH: number, viewW: number, viewH: number): void {
  // Min zoom = coverZoom (no black borders allowed); max zoom is 12 — 3×
  // closer than the previous cap of 4 so the player can inspect individual
  // villagers + workbenches at a sensible scale.
  const minZ = coverZoom(worldW, worldH, viewW, viewH);
  cam.zoom = Math.max(minZ, Math.min(12, cam.zoom));
  const halfH = viewH / 2 / cam.zoom;
  const halfW = viewW / 2 / cam.zoom;
  // With the cover-zoom floor the world is always at least as big as the
  // viewport, so these branches both clamp; centering on undersize-world
  // is no longer reachable but the guard stays for safety.
  if (halfW >= worldW / 2) cam.x = worldW / 2;
  else cam.x = Math.max(halfW, Math.min(worldW - halfW, cam.x));
  if (halfH >= worldH / 2) cam.y = worldH / 2;
  else cam.y = Math.max(halfH, Math.min(worldH - halfH, cam.y));
}
