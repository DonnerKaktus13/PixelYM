import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Belt-and-braces: stub out ALL programmatic page-reload paths. Vite's
// client (still injected even with HMR off) and any stray library code
// can refresh through reload(), assign(), replace(), or `location.href =`.
// F5 / Ctrl-R from the user still work — only JS-initiated navigations are
// silenced. The reload-suppression noise is logged once so we know it
// actually fired in case something is trying to reload behind the scenes.
const suppressed = (kind: string) => () => {
  console.warn(`[reload] suppressed JS-initiated page ${kind}`);
};
try { Object.defineProperty(window.location, "reload",  { configurable: true, value: suppressed("reload") }); } catch {}
try { Object.defineProperty(window.location, "assign",  { configurable: true, value: suppressed("assign") }); } catch {}
try { Object.defineProperty(window.location, "replace", { configurable: true, value: suppressed("replace") }); } catch {}
try {
  // `location.href = X` setter — block writes that aren't pure hash changes.
  const origHref = Object.getOwnPropertyDescriptor(Location.prototype, "href");
  if (origHref?.set) {
    Object.defineProperty(window.location, "href", {
      configurable: true,
      get: () => origHref.get!.call(window.location),
      set: (v: string) => {
        if (typeof v === "string" && v.startsWith("#")) origHref.set!.call(window.location, v);
        else console.warn("[reload] suppressed location.href =", v);
      },
    });
  }
} catch {}

// No StrictMode in dev — it intentionally double-mounts effects, which makes
// the world-builder run twice back-to-back (the page flashes "Generating
// world…" → world → "Generating world…" → world). For a real interactive
// app it's fine to leave off; if you want StrictMode back later we'll need
// to memoise/abort the world build instead.
createRoot(document.getElementById("root")!).render(<App />);
