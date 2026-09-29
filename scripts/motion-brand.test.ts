import { describe, expect, test } from "bun:test";
import { brandFromSite, BrandError } from "../src/motion/server/brand";
import type { Theme } from "../src/motion/engine/types";

// M&U: the keyless brand reader that replaces Firecrawl on /motion. Synthetic pages only;
// nothing here touches the network.
const FALLBACK: Theme = { bg: "#0c0c0e", ink: "#f2efe9", accent: "#d97757", accent2: "#7f93a8", font: "Inter" };
const PAGE = `<!doctype html><html><head><title>Harbour Dental | Parramatta</title>
<meta property="og:site_name" content="Harbour &amp; Co">
<link rel="stylesheet" href="/site.css">
<style>:root{--brand-primary:#0f6e8c}</style></head>
<body><img class="logo" src="/logo.svg"></body></html>`;
const CSS = `h1{font-family:"Fraunces",serif;color:#0f6e8c} .cta{background:#e0833a}`;

type Routes = Record<string, { status?: number; body?: string; location?: string }>;
function fake(routes: Routes) {
  const seen: string[] = [];
  const request = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) return new Response("", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      headers: route.location ? { location: route.location } : {},
    });
  }) as typeof fetch;
  return { request, seen };
}
const publicDns = (async () => [{ address: "203.0.113.10", family: 4 }]) as any;
const privateDns = (async () => [{ address: "192.168.1.20", family: 4 }]) as any;

describe("Motion brand from a site (free reader)", () => {
  test("reads colours, font, name and logo from the page and one stylesheet", async () => {
    const { request } = fake({
      "https://harbour.example.com/": { body: PAGE },
      "https://harbour.example.com/site.css": { body: CSS },
    });
    const result = await brandFromSite("harbour.example.com", FALLBACK, request, publicDns);
    expect(result.source).toBe("site");
    expect(result.site).toBe("harbour.example.com");
    expect(result.colors[0]).toBe("#0f6e8c");
    expect(result.theme.font).toBe("Fraunces");
    expect(result.theme.name).toBe("Harbour & Co"); // entities decoded
    expect(result.logoUrl).toBe("https://harbour.example.com/logo.svg");
  });

  test("respects a robots.txt that disallows everything", async () => {
    const { request, seen } = fake({
      "https://shy.example.com/robots.txt": { body: "User-agent: *\nDisallow: /" },
      "https://shy.example.com/": { body: PAGE },
    });
    await expect(brandFromSite("https://shy.example.com/", FALLBACK, request, publicDns)).rejects.toThrow(
      "asks not to be read",
    );
    expect(seen).not.toContain("https://shy.example.com/");
  });

  test("refuses names that resolve inside the network, and redirects that lead there", async () => {
    const { request } = fake({ "https://lan.example.com/": { body: PAGE } });
    await expect(brandFromSite("lan.example.com", FALLBACK, request, privateDns)).rejects.toBeInstanceOf(BrandError);
    const hop = fake({
      "https://hop.example.com/": { status: 302, location: "http://127.0.0.1:8081/" },
    });
    await expect(brandFromSite("hop.example.com", FALLBACK, hop.request, publicDns)).rejects.toThrow(/public website/);
    expect(hop.seen).not.toContain("http://127.0.0.1:8081/");
  });

  test("rejects local addresses before any request", async () => {
    for (const bad of ["localhost:8081", "http://10.0.0.2/", "http://100.101.102.103/", "mybox.tail1234.ts.net"]) {
      const { request, seen } = fake({});
      await expect(brandFromSite(bad, FALLBACK, request, publicDns)).rejects.toBeInstanceOf(BrandError);
      expect(seen).toHaveLength(0);
    }
  });
});
