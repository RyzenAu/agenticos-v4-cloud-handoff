// Motion-preserving templates for the two Next.js flagships (dental: Lantern Dental, real estate:
// Aldergate). Instead of a script-less HTML snapshot, each is a real `next build` static export
// WITH its client JS, so scroll scenes, reveals, menus and the header behave exactly as on the
// flagship. Built once per vertical:
//   1. copy the flagship into a build folder OUTSIDE its repo (dental: the working tree, which is
//      what's deployed; real estate: committed HEAD, which is what's deployed) — the flagship
//      repos are only ever read;
//   2. lay the overlay files over it (scripts/lead-sites/overlays/<vertical>/): the identity
//      becomes {{TOKENS}} in the SOURCE, so the server HTML, the RSC payload and the client
//      chunks all carry the same placeholder and hydration can't revert anything; invented
//      staff, listings, fees, reviews and claims are removed; lists come from #mu-preview-data;
//   3. apply the small asserted edits below, drop every route but the home page (no booking, no
//      API, no DB), and `next build` with output: "export";
//   4. copy out/ to <draftsRoot>/_templates/<vertical>/, prune unused images, and refuse the
//      template if any flagship identity survives in the HTML, the RSC payload OR the JS chunks,
//      or if a token sits inside a length-prefixed RSC text row (replacing it would corrupt it).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { templatesRoot, type Vertical } from "./templates";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = "C:\\Users\\Nebula PC\\source\\repos";
export const DEFAULT_BUILD_ROOT = process.env.MU_LEAD_SITE_BUILDS || "D:\\mu-lead-site-builds";

export type Edit = { file: string; from: string | RegExp; to: string };
export type NextTemplateSpec = {
  vertical: Extract<Vertical, "dental" | "real-estate">;
  flagship: string;
  repo: string;
  from: "worktree" | "HEAD";
  liveUrl: string;
  /** Entries of src/app to keep; every other route (booking, API, listings…) is deleted. */
  keepApp: string[];
  deletePaths: string[];
  edits: Edit[];
  /** Case-sensitive: must not appear in any HTML, RSC or JS file of the export. */
  residue: RegExp[];
  /** Offsets for the fixed preview banner (and any first-screen fixes). */
  css: string;
  /** Extra <head> HTML, e.g. preloading the first screen's image (mobile Lighthouse LCP). */
  head: string;
};

/** The preview banner goes INSIDE the React tree (PreviewBanner.tsx), so hydration keeps it. */
const BANNER_EDITS: Edit[] = [
  { file: "src/app/layout.tsx", from: 'import "./globals.css";', to: 'import "./globals.css";\nimport { PreviewBanner } from "@/components/PreviewBanner";' },
  { file: "src/app/layout.tsx", from: "<body>", to: "<body>\n        <PreviewBanner />" },
];

const DENTAL: NextTemplateSpec = {
  vertical: "dental",
  flagship: "Lantern Dental",
  repo: join(REPOS, "muv-demo-dental"),
  from: "worktree",
  liveUrl: "https://muv-demo-dental.vercel.app/",
  keepApp: ["page.tsx", "page.module.css", "layout.tsx", "globals.css"],
  deletePaths: ["src/proxy.ts", "src/middleware.ts"],
  residue: [/Lantern Dental/, /Rozelle/, /Darling Street/, /5550 0142/, /61255500142/, /Amara/, /Halloran/, /Natarajan/, /CDBS/, /bitewing/, /\$195/, /lanterndental/, /Saturday mornings/],
  css: `header[class*="Header-module"]{top:var(--mu-banner-h,0px)!important}
section[id]{scroll-margin-top:calc(var(--mu-banner-h,0px) + 96px)}
[data-mu-marquee]{color:var(--navy,#143a62)}`,
  head: '<link rel="preload" as="image" imagesrcset="/_img/640/img/generated/r15/lantern-room-wide.webp 640w, /_img/1080/img/generated/r15/lantern-room-wide.webp 1080w, /_img/1600/img/generated/r15/lantern-room-wide.webp 1600w, /_img/2400/img/generated/r15/lantern-room-wide.webp 2400w" imagesizes="100vw" fetchpriority="high">',
  edits: [
    // Header: the treatments menu lists the verified services; every action stays on the page.
    { file: "src/components/Header.tsx", from: 'import { nav, site, treatments } from "@/lib/site";', to: 'import { nav, site } from "@/lib/site";\nimport { PreviewServiceLinks } from "./PreviewServices";' },
    { file: "src/components/Header.tsx", from: "  const groups = Array.from(new Set(treatments.map((t) => t.group)));\n", to: "" },
    {
      file: "src/components/Header.tsx",
      from: /<div className=\{s\.menuGrid\}>[\s\S]*?All treatments <Arrow size=\{16\} \/><\/Link>/,
      to: '<div className={s.menuGrid}><div><ul><PreviewServiceLinks onPick={() => setMenu(false)} /></ul></div></div>\n                    <a href="#services" className={s.menuAll} onClick={() => setMenu(false)}>All treatments <Arrow size={16} /></a>',
    },
    { file: "src/components/Header.tsx", from: '<Link href="/book" className="btn btn--sm">Book</Link>', to: '<a href="#find-us" className="btn btn--sm">Contact</a>' },
    {
      file: "src/components/Header.tsx",
      from: /<li><Link href="\/treatments" className=\{s\.drawerLink\}>Treatments<\/Link>[\s\S]*?<\/ul>\s*<\/li>/,
      to: '<li><a href="#services" className={s.drawerLink} onClick={() => setOpen(false)}>Treatments</a>\n              <ul className={s.drawerSub}><PreviewServiceLinks onPick={() => setOpen(false)} /></ul>\n            </li>',
    },
    { file: "src/components/Header.tsx", from: "className={s.drawerLink}>{n.label}</Link>", to: "className={s.drawerLink} onClick={() => setOpen(false)}>{n.label}</Link>" },
    { file: "src/components/Header.tsx", from: '<Link href="/book" className="btn">Book an appointment</Link>', to: '<a href="#find-us" className="btn">Find the practice</a>' },
    // Opening scene: same motion, neutral words built only from the practice's own facts.
    { file: "src/components/flagship/FlagshipOpening.tsx", from: 'import { ChooseExampleLink } from "@/components/ChooseExampleLink";\n', to: "" },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: /const NOTES = \[[\s\S]*?\];/, to: "const NOTES = [`Dental care in ${site.suburb}.`, `${site.address.line1}, ${site.address.suburb}.`, `Call ${site.phone}.`];" },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "Dentistry.<br />At your pace.", to: "Dentistry.<br />In {site.suburb}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "You’ll know the plan, the fee and the time before we start.", to: "{site.name}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "General dentistry in {site.suburb}.", to: "Dental care in {site.suburb}." },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: /<Link href="\/book" className=\{`btn btn--lg \$\{s\.book\}`\}>Book an appointment (<span className="arrow"><Arrow \/><\/span>)<\/Link>/, to: '<a href="#find-us" className={`btn btn--lg ${s.book}`}>Find the practice $1</a>' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "<ChooseExampleLink className={s.times}>See example times <Arrow size={16} /></ChooseExampleLink>", to: '<a href="#services" className={s.times}>See treatments <Arrow size={16} /></a>' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: 'aria-label="What a visit is like"', to: 'aria-label="About the practice"' },
    { file: "src/components/flagship/FlagshipOpening.tsx", from: "Illustrative image, AI-generated for this concept. Not Lantern Dental’s premises, staff or patients.", to: "Illustrative image, AI-generated for this preview. Not {site.namePossessive} premises, staff or patients." },
    // "How a visit goes": the scroll story stays; its practice-specific claims don't.
    { file: "src/components/flagship/FlagshipVisit.tsx", from: 'import { ScrollScene } from "./ScrollScene";', to: 'import { ScrollScene } from "./ScrollScene";\nimport { site } from "@/lib/site";' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: 'const CAPTION = "Illustrative image, AI-generated for this concept. Not Lantern Dental’s premises, staff or patients.";', to: "const CAPTION = `Illustrative image, AI-generated for this preview. Not ${site.namePossessive} premises, staff or patients.`;" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"What is bothering you, and what you would like to change. Nothing happens in your mouth yet."', to: '"What is bothering you, and what you would like to change."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"Longer appointments, and an agreed signal to pause at any point."', to: '"The practice can explain how a first visit works."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"A full examination, with x-rays only when they are clinically due."', to: '"An examination, explained as it happens."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"At a first visit: a comprehensive examination, two bitewing x-rays, a scale and clean."', to: '"What a first visit includes is confirmed by the practice."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"A written plan with the fees on it, before any treatment starts."', to: '"The next step is agreed with you before any treatment starts."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: '"Health funds are claimed on the spot."', to: '"Fees are confirmed by the practice before treatment."' },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "Lantern Dental <span>Example only</span>", to: "{site.name} <span>Example only</span>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "<dd>What we found and what comes next</dd>", to: "<dd>What was found and what comes next</dd>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "<div><dt>The fee</dt><dd>Written down before treatment</dd></div>", to: "<div><dt>The options</dt><dd>Explained before you choose</dd></div>" },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "A little more time.<br />A clearer plan.", to: "A clear conversation.<br />A clear plan." },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: "Nothing happens in your mouth until you have said what you want and we have agreed it.", to: "An illustration of how a first visit could be explained. {site.name} would confirm the details." },
    { file: "src/components/flagship/FlagshipVisit.tsx", from: /<Link href="\/new-patients" className=\{s\.more\}>What to bring, and what happens after (<span aria-hidden="true">→<\/span>)<\/Link>/, to: '<a href="#find-us" className={s.more}>Find the practice $1</a>' },
    // Logo text.
    { file: "src/components/Logo.tsx", from: "<span>Lantern Dental</span>", to: "<span>{site.name}</span>" },
    { file: "src/components/Logo.tsx", from: '>Rozelle</span>', to: ">{site.suburb}</span>" },
    { file: "src/components/Logo.tsx", from: /^/, to: 'import { site } from "@/lib/site";\n' },
    // Layout: no demo bar (the preview banner replaces it), one neutral title, noindex.
    { file: "src/app/layout.tsx", from: 'import { DemoBar } from "@/components/DemoBar";\n', to: "" },
    { file: "src/app/layout.tsx", from: /\s*<DemoBar \/>/, to: "" },
    { file: "src/app/layout.tsx", from: /export const metadata: Metadata = \{[\s\S]*?\n\};/, to: 'export const metadata: Metadata = {\n  title: "{{TITLE}}",\n  robots: { index: false, follow: false },\n};' },
    ...BANNER_EDITS,
  ],
};

const REAL_ESTATE: NextTemplateSpec = {
  vertical: "real-estate",
  flagship: "Aldergate",
  repo: join(REPOS, "aldergate"),
  from: "HEAD",
  liveUrl: "https://aldergate-demo.vercel.app/",
  keepApp: ["page.tsx", "home.module.css", "layout.tsx", "globals.css", "template.tsx"],
  deletePaths: ["src/middleware.ts", "src/proxy.ts"],
  residue: [/Aldergate/, /Balmain/, /Birchgrove/, /Lilyfield/, /Annandale/, /Leichhardt/, /Rozelle/, /Darling Street/, /9000 0000/, /Imogen/, /Marchetti/, /Priya Raman/, /aldergate\.demo/, /Glover Street/, /Price guide \$/],
  // The hero copy is the mobile LCP element: show it at once instead of waiting for the reveal JS.
  css: `header[class*="Header-module"]{top:var(--mu-banner-h,0px)!important}
section[class*="home-module"][class*="__hero"] .reveal{opacity:1!important;transform:none!important;transition:none!important}
.pageEnter{animation:none!important}
section[id]{scroll-margin-top:calc(var(--mu-banner-h,0px) + 88px)}
a[data-mu-optional="email"]:not([href^="mailto:"]){display:none}
[data-mu-marquee]{color:var(--ink,#1c1a17);background:var(--paper,transparent)}`,
  head: '<link rel="preload" as="image" imagesrcset="/_img/640/photos/stock/hero-01.webp 640w, /_img/1080/photos/stock/hero-01.webp 1080w, /_img/1600/photos/stock/hero-01.webp 1600w, /_img/2400/photos/stock/hero-01.webp 2400w" imagesizes="100vw" fetchpriority="high">',
  edits: [
    { file: "src/components/shell/Header.tsx", from: /\s*<Link href="\/saved" className=\{styles\.iconBtn\} aria-label="Saved properties">\s*<Heart \/>\s*<\/Link>/, to: "" },
    { file: "src/components/shell/Header.tsx", from: /<Link href="\/sell#appraisal" className=\{`btn btn--ink btn--sm \$\{styles\.cta\}`\}>\s*Get an appraisal\s*<\/Link>/, to: '<a href="#contact" className={`btn btn--ink btn--sm ${styles.cta}`}>Contact</a>' },
    { file: "src/components/shell/Header.tsx", from: /<Link href="\/sell#appraisal" className="btn btn--oxblood btn--lg" onClick=\{\(\) => setOpen\(false\)\} tabIndex=\{open \? 0 : -1\}>\s*Get an appraisal\s*<\/Link>/, to: '<a href="#services" className="btn btn--oxblood btn--lg" onClick={() => setOpen(false)} tabIndex={open ? 0 : -1}>Services</a>' },
    { file: "src/components/shell/Header.tsx", from: /<Link href="\/contact" className="btn btn--outline btn--lg" onClick=\{\(\) => setOpen\(false\)\} tabIndex=\{open \? 0 : -1\}>\s*Contact\s*<\/Link>/, to: '<a href="#contact" className="btn btn--outline btn--lg" onClick={() => setOpen(false)} tabIndex={open ? 0 : -1}>Contact</a>' },
    { file: "src/app/layout.tsx", from: 'import { DemoBanner } from "@/components/shell/DemoBanner";\n', to: "" },
    { file: "src/app/layout.tsx", from: /\s*<DemoBanner \/>/, to: "" },
    // No structured data claiming to BE the business, no social cards, noindex.
    { file: "src/app/layout.tsx", from: /\s*<script type="application\/ld\+json"[^\n]*\/>/, to: "" },
    { file: "src/app/layout.tsx", from: /export const metadata: Metadata = \{[\s\S]*?\n\};/, to: 'export const metadata: Metadata = {\n  title: "{{TITLE}}",\n  robots: { index: false, follow: false },\n};' },
    { file: "src/app/layout.tsx", from: /const orgJsonLd = \{[\s\S]*?\n\};\n/, to: "" },
    ...BANNER_EDITS,
  ],
};

export const NEXT_TEMPLATE_SPECS: Record<"dental" | "real-estate", NextTemplateSpec> = { dental: DENTAL, "real-estate": REAL_ESTATE };

export function applyEdit(text: string, edit: Edit): string {
  if (typeof edit.from === "string") {
    if (!text.includes(edit.from)) throw new Error(`${edit.file}: expected text not found: ${edit.from.slice(0, 80)}`);
    return text.split(edit.from).join(edit.to);
  }
  if (!edit.from.test(text)) throw new Error(`${edit.file}: pattern not found: ${edit.from}`);
  return text.replace(edit.from, edit.to);
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: String(e) }); });
  });
}

/** Plain file-by-file copy (no .env files). Bun's cpSync on Windows can leave handles open,
 *  which later keeps next's hard-linked export files from being deleted. */
function copyTree(src: string, dst: string) {
  if (statSync(src).isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return;
  }
  for (const rel of readdirSync(src, { recursive: true }) as string[]) {
    if (/(^|[\\/])\.env[^\\/]*$/.test(rel)) continue;
    const from = join(src, rel);
    if (!statSync(from).isFile()) continue;
    mkdirSync(dirname(join(dst, rel)), { recursive: true });
    copyFileSync(from, join(dst, rel));
  }
}

const SKIP_COPY = new Set(["node_modules", ".next", ".git", ".vercel", "out", "review", "memory", "docs", ".impeccable"]);

/** Fresh flagship source in <buildRoot>/<vertical>/ (keeps node_modules), overlays + edits applied. */
export function prepareSource(spec: NextTemplateSpec, work: string) {
  mkdirSync(work, { recursive: true });
  for (const entry of readdirSync(work)) if (entry !== "node_modules") rmSync(join(work, entry), { recursive: true, force: true });
  if (spec.from === "worktree") {
    for (const entry of readdirSync(spec.repo)) {
      if (SKIP_COPY.has(entry) || entry.startsWith(".env")) continue;
      copyTree(join(spec.repo, entry), join(work, entry));
    }
  } else {
    const tar = join(work, "..", `${spec.vertical}-head.tar`);
    const archived = spawnSync("git", ["-C", spec.repo, "archive", "--format=tar", "-o", tar, "HEAD"], { windowsHide: true });
    if (archived.status !== 0) throw new Error(`git archive failed: ${archived.stderr}`);
    // Relative path: GNU tar reads "D:\…" as a remote host.
    const untar = spawnSync("tar", ["-xf", `../${spec.vertical}-head.tar`], { cwd: work, windowsHide: true });
    rmSync(tar, { force: true });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    for (const entry of readdirSync(work)) if (entry.startsWith(".env")) rmSync(join(work, entry), { force: true });
  }
  copyTree(join(HERE, "overlays", spec.vertical), work);
  const app = join(work, "src", "app");
  for (const entry of readdirSync(app)) if (!spec.keepApp.includes(entry)) rmSync(join(app, entry), { recursive: true, force: true });
  for (const p of spec.deletePaths) rmSync(join(work, p), { recursive: true, force: true });
  for (const edit of spec.edits) {
    const file = join(work, edit.file);
    // Edits are written for LF; a git-archived checkout may be CRLF.
    writeFileSync(file, applyEdit(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), edit), "utf8");
  }
}

function walk(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p)).filter((p) => statSync(p).isFile());
}
export const TEXT_EXT = /\.(html|js|txt|json|css|rsc)$/i;

/** Tokens inside a length-prefixed RSC text row ("…:T<hex>,") can't be replaced safely. */
export function tokensInRscTextRows(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    let payload = "";
    try { payload = JSON.parse(m[1]); } catch { continue; }
    for (const row of payload.matchAll(/(?:^|\n)[0-9a-f]+:T([0-9a-f]+),/g)) {
      const start = row.index! + row[0].length;
      const text = payload.slice(start, start + parseInt(row[1], 16));
      const tok = /\{\{[A-Z0-9_]+\}\}/.exec(text);
      if (tok) bad.push(tok[0]);
    }
  }
  return bad;
}

export function exportResidue(dir: string, spec: Pick<NextTemplateSpec, "residue">): string[] {
  const hits: string[] = [];
  for (const file of walk(dir).filter((f) => TEXT_EXT.test(f))) {
    const text = readFileSync(file, "utf8");
    for (const re of spec.residue) if (re.test(text)) hits.push(`${relative(dir, file)}: ${re}`);
  }
  return hits;
}

/** Deletes images/photos/credits the export doesn't reference (portraits, listing photos). */
export function pruneExport(dir: string, dryRun = false): number {
  let removed = 0;
  const files = walk(dir);
  const text = files.filter((f) => TEXT_EXT.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  for (const f of files) {
    const rel = relative(dir, f).replace(/\\/g, "/");
    if (/(^|\/)CREDITS[^/]*$/i.test(rel)) { if (!dryRun) unlinkSync(f); removed++; continue; }
    if (rel.startsWith("_next/")) continue;
    if (!/\.(jpe?g|png|webp|avif|svg|gif|ico|mp4|webm)$/i.test(rel)) continue;
    if (!text.includes(rel) && !text.includes(rel.split("/").pop()!)) { if (!dryRun) unlinkSync(f); removed++; }
  }
  return removed;
}

/** Waits until a folder has stopped changing for ~6 s (max ~90 s). next build's export workers
 *  keep copying public/ into out/ after the CLI itself has returned. */
async function settle(dir: string, mustExist: string[] = []) {
  let last = "";
  let stable = 0;
  for (let i = 0; i < 45 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!mustExist.every((p) => existsSync(join(dir, p)))) continue;
    const files = walk(dir);
    const sig = `${files.length}:${files.reduce((a, f) => a + statSync(f).size, 0)}`;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
  }
}

/** Deletes public/ images and credits that no kept source file references (staff portraits,
 *  listing photos…) BEFORE the build — next's export hard-links public/ into out/ and on
 *  Windows those links can't be removed while its workers linger. */
export function pruneSourcePublic(work: string): number {
  const pub = join(work, "public");
  if (!existsSync(pub)) return 0;
  const src = walk(join(work, "src")).filter((f) => /\.(tsx?|css|json)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  let removed = 0;
  for (const f of walk(pub)) {
    const rel = relative(pub, f).replace(/\\/g, "/");
    const name = rel.split("/").pop()!;
    if (/^CREDITS/i.test(name) || (/\.(jpe?g|png|webp|avif|gif|mp4|webm|svg)$/i.test(name) && !src.includes(name) && !src.includes(`"${name.replace(/\.[^.]+$/, "")}"`))) { unlinkSync(f); removed++; } // data files may name images without the extension
  }
  return removed;
}

export type NextTemplateManifest = {
  kind: "next-export";
  vertical: string;
  flagship: string;
  source: { repo: string; from: string; liveUrl: string };
  builtAt: string;
  tokens: string[];
  css: string;
  head: string;
};

export async function buildNextTemplate(vertical: "dental" | "real-estate", draftsRoot: string, buildRoot = DEFAULT_BUILD_ROOT, log: (s: string) => void = () => {}) {
  const spec = NEXT_TEMPLATE_SPECS[vertical];
  const work = join(buildRoot, vertical);
  log(`preparing ${work}`);
  prepareSource(spec, work);
  if (!existsSync(join(work, "node_modules", "next"))) {
    log("npm ci");
    const npm = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], work);
    if (npm.code !== 0) throw new Error(`npm ci failed: ${npm.out.slice(-800)}`);
  }
  log(`removed ${pruneSourcePublic(work)} unused public files`);
  const out = join(work, "out");
  const publicDirs = existsSync(join(work, "public")) ? readdirSync(join(work, "public")).filter((e) => statSync(join(work, "public", e)).isDirectory()) : [];
  const nextBuild = async () => {
    log("next build");
    rmSync(out, { recursive: true, force: true });
    const built = await run(process.execPath.includes("bun") ? "node" : process.execPath, [join(work, "node_modules", "next", "dist", "bin", "next"), "build"], work);
    // The CLI can return before the export workers finish writing out/: wait for it.
    for (let i = 0; i < 60 && built.code === 0 && !existsSync(join(out, "index.html")); i++) await new Promise((r) => setTimeout(r, 1000));
    if (built.code !== 0 || !existsSync(join(out, "index.html"))) throw new Error(`next build failed: ${built.out.slice(-1500)}`);
    await settle(out, ["index.html", ...publicDirs]);
    return built;
  };
  let built = await nextBuild();
  // Second pass: drop public files the built page never references (listing photos, portraits
  // that data files mention but the preview doesn't render), then build again.
  const unused = pruneExport(out, true);
  if (unused > 0) {
    const text = walk(out).filter((f) => TEXT_EXT.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    let removed = 0;
    for (const f of walk(join(work, "public"))) {
      const name = relative(join(work, "public"), f).replace(/\\/g, "/").split("/").pop()!;
      const stem = name.replace(/\.[^.]+$/, "");
      if (/\.(jpe?g|png|webp|avif|gif|mp4|webm|svg)$/i.test(name) && !text.includes(name) && !text.includes(`/${stem}.webp`)) { unlinkSync(f); removed++; }
    }
    log(`removed ${removed} more unused public files; rebuilding`);
    built = await nextBuild();
  }
  // Responsive WebP widths for next/image (the export has no optimiser): see image-loader.js.
  const variants = spawnSync("node", ["make-image-variants.mjs"], { cwd: work, windowsHide: true, encoding: "utf8" });
  if (variants.status !== 0) throw new Error(`image variants failed: ${variants.stderr || variants.stdout}`);
  log(`rendered ${String(variants.stdout).trim()} image variants`);

  const dir = join(templatesRoot(draftsRoot), vertical);
  rmSync(dir, { recursive: true, force: true }); // our own generated folder
  for (const file of walk(join(work, "out"))) {
    const target = join(dir, relative(join(work, "out"), file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target); // a real copy, never a link to next's output
  }
  const residue = exportResidue(dir, spec);
  if (residue.length) throw new Error(`The ${vertical} export still carries flagship content: ${residue.slice(0, 8).join("; ")}`);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const unsafe = tokensInRscTextRows(html);
  if (unsafe.length) throw new Error(`Tokens inside RSC text rows (would corrupt on fill): ${unsafe.join(", ")}`);
  const tokens = new Set<string>();
  for (const f of walk(dir).filter((p) => TEXT_EXT.test(p))) for (const m of readFileSync(f, "utf8").matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) tokens.add(m[1]);
  const manifest: NextTemplateManifest = {
    kind: "next-export",
    vertical,
    flagship: spec.flagship,
    source: { repo: spec.repo, from: spec.from, liveUrl: spec.liveUrl },
    builtAt: new Date().toISOString(),
    tokens: [...tokens].sort(),
    css: spec.css,
    head: spec.head,
  };
  writeFileSync(join(dir, "template.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest, buildLog: built.out.slice(-1200) };
}
