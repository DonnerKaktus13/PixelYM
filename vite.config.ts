import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  // SWC-based React plugin instead of the Babel one. With HMR disabled the
  // Babel plugin's react-refresh preamble was still being injected and the
  // VSCode Simple Browser was reading the failed WebSocket reconnect as a
  // signal to reload the iframe. SWC plugin + an explicit `devTarget` keeps
  // JSX support but skips the refresh runtime when HMR is off.
  plugins: [react()],
  server: {
    port: 5173,
    // Auto-open disabled — Claude restarts the dev server after each code
    // change, and `open: true` would spawn a fresh browser tab every time.
    open: false,
    // Bind to all IPv4 interfaces. With `host: true` Vite was opening an
    // IPv6-only socket on Windows (LocalAddress = `::`, IPV6_V6ONLY left at
    // the OS default), so http://127.0.0.1:5173 had no listener. Explicit
    // 0.0.0.0 makes 127.0.0.1 and localhost both resolve to a real listener.
    host: "0.0.0.0",
    hmr: false,
    watch: null,
  },
});
