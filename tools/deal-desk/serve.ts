/**
 * Local preview for the M&U deal desk: bundles app.ts for the browser, then serves it on 127.0.0.1 only.
 *   bun tools/deal-desk/serve.ts            (port 4317, or DEAL_DESK_PORT)
 *   bun tools/deal-desk/serve.ts --build    (write tools/deal-desk/dist/ and exit; add `--out public/deal-desk` to publish into the OS)
 * No network calls, no secrets, no production data.
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const here = import.meta.dir;
async function bundle(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(here, "app.ts")], target: "browser", minify: false, sourcemap: "none" });
  if (!out.success) throw new AggregateError(out.logs, "Deal desk build failed");
  return await out.outputs[0].text();
}

if (process.argv.includes("--build")) {
  // Optional target directory: `--build --out public/deal-desk` publishes the desk as a static OS page.
  const outArg = process.argv.indexOf("--out");
  const dist = outArg > 0 ? join(process.cwd(), process.argv[outArg + 1]) : join(here, "dist"); mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "app.js"), await bundle());
  writeFileSync(join(dist, "index.html"), readFileSync(join(here, "index.html")));
  console.log(`Built ${dist}`);
} else {
  const port = Number(process.env.DEAL_DESK_PORT ?? 4317);
  Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const headers = { "cache-control": "no-store" };
      if (path === "/" || path === "/index.html") return new Response(Bun.file(join(here, "index.html")), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      if (path === "/app.js") {
        try { return new Response(await bundle(), { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } }); }
        catch (e) { return new Response(`console.error(${JSON.stringify(String(e))})`, { status: 500, headers: { "content-type": "text/javascript" } }); }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`M&U deal desk: http://127.0.0.1:${port}/`);
}
