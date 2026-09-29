// Tiny static preview server for one generated draft folder. Loopback only — this is an internal
// review copy, never meant to be reachable from anywhere but this PC.
//   bun scripts/site-draft/serve.ts <draft-dir> [port]
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

export function startDraftServer(dir: string, port = 0) {
  const root = normalize(dir);
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/" || rel === "") rel = "/index.html";
      const target = normalize(join(root, rel));
      if (!target.startsWith(root) || !existsSync(target) || !statSync(target).isFile())
        return new Response("Not found", { status: 404 });
      const ext = target.slice(target.lastIndexOf("."));
      // Assets are immutable per draft build; the page itself is always revalidated.
      const cache = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return new Response(readFileSync(target), { headers: { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": cache } });
    },
  });
}

if (import.meta.main) {
  const [dir, portArg] = process.argv.slice(2);
  if (!dir) {
    console.error("Usage: bun scripts/site-draft/serve.ts <draft-dir> [port]");
    process.exit(1);
  }
  const server = startDraftServer(dir, portArg ? Number(portArg) : 0);
  console.log(`Serving ${dir} at http://127.0.0.1:${server.port}`);
}
