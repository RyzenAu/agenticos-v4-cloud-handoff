import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { harnessMiddleware } from "./hub";

/**
 * A synthetic SERVER-role hub (MU_HUB_ROLE=server) on loopback, for reproducing pairing from the desktop app's WebView without
 * Tailscale or Ryzen. It mounts the REAL /__devices service and the REAL Profile panel; Tailscale Serve is simulated the way the
 * test harness does (scripts/devices/test-harness.ts). Isolation: it refuses port 8081 and any data folder that is not under the
 * folder given in PAIRING_HARNESS_DATA.
 *
 *   $env:PAIRING_HARNESS_DATA='D:\AgenticOS-r7-data\g'
 *   bun --bun node_modules/vite/bin/vite.js --config scripts/devices/pairing-harness/vite.config.ts --port 8127 --strictPort --host 127.0.0.1
 */
const repo = resolve(__dirname, "../../..");
const harness = (): Plugin => ({
  name: "pairing-harness",
  configureServer(server) {
    const data = process.env.PAIRING_HARNESS_DATA;
    if (!data) throw new Error("Set PAIRING_HARNESS_DATA to a scratch folder (for example D:\AgenticOS-r7-data\g).");
    server.middlewares.use(harnessMiddleware(data, Number(server.config.server.port ?? 8127)));
  },
});

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss(), harness()],
  resolve: { alias: { "@": resolve(repo, "src") } },
  server: { host: "127.0.0.1", allowedHosts: true, fs: { allow: [repo] } },
  logLevel: "info",
});
