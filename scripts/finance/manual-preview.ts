// Isolated SYNTHETIC preview of the Finance destination (default port 4303). Bypasses app config,
// provider plugins, .env loading and the real .operator-data: the store is in memory unless
// --file=<path> is given, and --seed imports the synthetic September fixture. Real loopback HTTP
// goes through the same handleManualFinance() the Vite plugin uses.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleManualFinance, resolveManualFinanceOwner } from "./manual-plugin";
import { SHARED_LEDGER, openManualFinanceStore } from "./manual-store";
import { syntheticSeptemberCsv } from "./manual-fixtures";
import { NAB_CSV_MAX_BYTES } from "./manual-nab-csv";

const root = fileURLToPath(new URL("../../", import.meta.url));
const result = await build({ configFile: false, envFile: false, logLevel: "warn", root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react(), tailwind()], resolve: { alias: { "@": `${root}/src` } },
  build: { write: false, rollupOptions: { input: fileURLToPath(new URL("./manual-preview.html", import.meta.url)) } },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => ("output" in item ? item.output : []));
const assets = new Map(outputs.map((item) => [`/${item.fileName}`, item.type === "chunk" ? item.code : item.source]));
if (process.argv.includes("--build-only")) { console.log(`Finance preview compiled: ${assets.size} in-memory assets; no server started.`); process.exit(0); }

const arg = (name: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const port = Number(arg("port") ?? 4303);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8081) throw new Error("INVALID_PREVIEW_PORT");
const today = arg("today") ?? "2026-09-27";
const store = openManualFinanceStore(arg("file") ?? ":memory:");
if (process.argv.includes("--seed")) store.importCsv(SHARED_LEDGER, syntheticSeptemberCsv(), "test", { actor: "usman" });
const token = randomBytes(24).toString("hex");

Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: NAB_CSV_MAX_BYTES + 1024, async fetch(request, server) {
  const url = new URL(request.url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (url.pathname === "/__token") return json(200, { token });
  if (url.pathname.startsWith("/__finance_manual/")) {
    const owner = resolveManualFinanceOwner({ socket: { remoteAddress: server.requestIP(request)?.address }, headers: Object.fromEntries(request.headers) }, { root });
    const reply = handleManualFinance({ method: request.method, path: url.pathname.slice("/__finance_manual".length), query: url.searchParams, owner,
      tokenOk: request.headers.get("x-claude-os-token") === token, contentType: request.headers.get("content-type") ?? "",
      body: request.method === "POST" ? await request.text() : undefined }, { store: () => store, today: () => today });
    return json(reply.status, reply.body);
  }
  const path = url.pathname === "/" ? "/manual-preview.html" : url.pathname;
  const asset = assets.get(path);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(typeof asset === "string" ? asset : new Uint8Array(asset), { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html", "Cache-Control": "no-store" } });
} });
console.log(`Finance synthetic preview: http://127.0.0.1:${port}/ (store: ${arg("file") ? "file" : "memory"}, today ${today})`);
