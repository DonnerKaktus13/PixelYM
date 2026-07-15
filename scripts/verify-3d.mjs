// Deterministic verify gate for the 3D world view.
//
// Grades the 3D feature end-to-end and prints a single `SCORE: <0-100>`
// line on stdout (progress goes to stderr). Scoring is graded so the goal
// loop can see partial progress:
//   0   — the World3D module is missing
//   30  — App.tsx doesn't wire the 3D view in
//   60  — TypeScript type-check (tsc --noEmit) fails
//   100 — types pass AND the production build (vite build) succeeds
//
// Run from the repo root: `node scripts/verify-3d.mjs`.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => process.stderr.write(m + "\n");

function score(n, why) {
  log(`verify: ${why}`);
  process.stdout.write(`SCORE: ${n}\n`);
  process.exit(0);
}

// 1. The 3D module must exist.
const modPath = join(root, "src", "render3d", "World3D.ts");
if (!existsSync(modPath)) score(0, "src/render3d/World3D.ts missing");

// 2. App.tsx must actually import + use the 3D view.
const app = readFileSync(join(root, "src", "App.tsx"), "utf8");
const wired = app.includes("World3DView") && app.includes("threeCanvasRef") && app.includes("render3d/World3D");
if (!wired) score(30, "App.tsx does not wire in the World3DView");

// 3. TypeScript type-check.
try {
  execSync("npx tsc --noEmit", { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  log("verify: tsc --noEmit passed");
} catch {
  score(60, "tsc --noEmit failed (type errors)");
}

// 4. Production build.
try {
  execSync("npx vite build", { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  log("verify: vite build succeeded");
} catch {
  score(80, "vite build failed");
}

score(100, "3D module present, wired, type-checked, and builds");
