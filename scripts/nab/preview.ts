// Isolated source-only preview: bypasses app config, provider plugins, seeding and .env loading.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const result = await build({ configFile: false, envFile: false, root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react(), tailwind()], resolve: { alias: { "@": `${root}/src` } },
  build: { write: false, rollupOptions: { input: fileURLToPath(new URL("./preview.html", import.meta.url)) } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
const assets = new Map(outputs.map(item => [`/${item.fileName}`, item.type === "chunk" ? item.code : item.source]));
if (process.argv.includes("--build-only")) {
  console.log(`Synthetic NAB preview compiled: ${assets.size} in-memory assets; no server started.`);
  process.exit(0);
}
const portArgument = process.argv.find(value => /^--port=\d+$/.test(value));
const port = portArgument ? Number(portArgument.slice(7)) : 4188;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_PREVIEW_PORT");
Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
  const path = new URL(request.url).pathname;
  const asset = assets.get(path);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset, { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "Cache-Control": "no-store" } });
} });
console.log(`Synthetic NAB preview: http://127.0.0.1:${port}/preview.html`);
