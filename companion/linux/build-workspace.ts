import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ExecutorResult } from "../../scripts/jarvis-command/contracts";

/**
 * The Builder computer's workspace: a small website kept in a git repository inside THIS computer's own working folder, where every job gets its own
 * git worktree on its own branch, so a job never touches the base site, another job's work or any file outside the folder.
 *
 *   <workdir>/repo        the base site (branch main): index.html and two small components, committed
 *   <workdir>/wt-<id>     a worktree for one job (branch job/<id>): where components are made or changed, checked and diffed
 *
 * `build.component` is a typed executor, not a shell: a fixed set of actions (init, worktree, apply, check, diff, preview), each running only `git` and
 * `node --check` with fixed arguments (no shell, no user text on a command line except a validated id and commit message). Files it will write are
 * limited to `components/<name>.(html|css|js)` and `pages/<name>.html`, flat names, small sizes. It reads nothing outside the folder, has no network
 * and never pushes.
 */

const ID = /^[a-z0-9][a-z0-9-]{3,23}$/;
const PATH = /^(?:components|pages)\/[a-z0-9][a-z0-9-]{0,40}\.(?:html|css|js)$/;
const MAX_FILES = 6;
const MAX_FILE_BYTES = 40 * 1024;
const DIFF_CAP = 60 * 1024;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const refused = (said: string): ExecutorResult => ({ ok: false, said, verified: false, data: { refused: true } });

export const BASE_FILES: Record<string, string> = {
  "README.md": "# Clinic site (synthetic fixture)\n\nA tiny static site used to practise building components. Components live in `components/`; `index.html` lists them.\n",
  "index.html": `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbour Street Clinic (synthetic fixture)</title>
</head>
<body>
<header class="site-header"><h1>Harbour Street Clinic</h1><p>Friendly local care. This is a synthetic practice site.</p></header>
<main>
<!--components-->
</main>
</body>
</html>
`,
  "components/pricing-card.html": `<section class="pricing-card" aria-labelledby="pc-title">
  <h2 id="pc-title">Standard visit</h2>
  <p class="pricing-card__price">$80</p>
  <p>A standard 30 minute consultation.</p>
  <a class="pricing-card__cta" href="#book">Book a visit</a>
</section>
`,
  "components/pricing-card.css": `.pricing-card { border: 1px solid #cfd8d4; border-radius: 12px; padding: 20px; max-width: 320px; font-family: system-ui, sans-serif; }
.pricing-card__price { font-size: 2rem; font-weight: 700; margin: 4px 0; }
.pricing-card__cta { display: inline-block; padding: 10px 16px; background: #2f6f5e; color: #fff; border-radius: 8px; text-decoration: none; }
`,
};

function git(cwd: string, args: string[], timeoutMs = 20_000, input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const child = execFile("git", ["-c", "user.name=M&U Builder bot", "-c", "user.email=builder@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" } }, (error, stdout, stderr) => {
      res({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0, out: String(stdout), err: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function nodeCheck(file: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    // On a computer the companion IS node; under another runtime (a test under bun) the node on the PATH does the syntax check.
    const exe = /(?:^|[\\/])node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
    execFile(exe, ["--check", file],{ timeout: 10_000, env: { PATH: process.env.PATH ?? "" } }, (error, _o, stderr) => res({ ok: !error, detail: error ? String(stderr).split("\n").find((l) => /Error/.test(l))?.slice(0, 160) ?? "syntax error" : "syntax ok" }));
  });
}

/** Script that reaches the network, navigates away, builds loading elements or runs code from a string. A component is code a model wrote: none of this is allowed. */
export const JS_FORBIDDEN = /\b(?:eval|Function)\s*\(|document\.write(?:ln)?\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bnew\s+Image\b|\bImage\s*\(|\blocation\b\s*(?:=|\.\s*(?:href|assign|replace|reload)\b)|\bopen\s*\(|\bimport\s*\(|createElement\s*\(\s*["'](?:script|img|iframe|link|object|embed|form|video|audio|source)|\.(?:src|href|action|srcset|data)\s*=|setAttribute\s*\(\s*["'](?:src|href|action|srcset|data)|innerHTML\s*=|insertAdjacentHTML|\bWorker\s*\(|serviceWorker/i;

const URLISH = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const LOADING_ATTRS = new Set(["src", "data", "poster", "action", "formaction", "srcset", "xlink:href", "background", "ping", "manifest", "codebase", "icon"]);
const LOADING_TAGS = new Set(["script", "img", "iframe", "frame", "link", "source", "video", "audio", "track", "object", "embed", "input", "form", "use", "image", "svg", "body", "button", "applet", "base"]);
const CSS_REMOTE = /@import\b|url\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
/**
 * What an HTML fragment loads or submits to another address, found by parsing every tag's attributes properly (quoted, single-quoted or UNQUOTED), plus
 * meta refresh, srcset lists, remote @import / url() in styles and style attributes, and base. Ordinary links (a, area) to other sites are fine. Pure.
 */
export function externalRefs(html: string): string[] {
  const found: string[] = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    if (tag === "meta" && /refresh/i.test(attrs["http-equiv"] ?? "")) found.push("<meta http-equiv=refresh>");
    for (const [k, v] of Object.entries(attrs)) {
      if ((LOADING_ATTRS.has(k) && LOADING_TAGS.has(tag)) || (k === "href" && tag !== "a" && tag !== "area" && LOADING_TAGS.has(tag))) {
        const urls = k === "srcset" ? v.split(",").map((x) => x.trim().split(/\s+/)[0]) : [v];
        for (const u of urls) if (URLISH.test(u) || /^\s*(?:https?|ftp|wss?):/i.test(u)) found.push(`<${tag} ${k}=${u.slice(0, 50)}>`);
      }
      if (k === "style" && CSS_REMOTE.test(v)) found.push(`<${tag} style=remote>`);
    }
  }
  for (const m of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) if (CSS_REMOTE.test(m[1])) found.push("<style> loads a remote address");
  return found;
}

const VOID = new Set(["meta", "link", "br", "hr", "img", "input", "source", "area", "base", "col", "embed", "track", "wbr"]);
/** A small, honest HTML structure check: tags balanced, images have alt, no external references, no script from elsewhere. Not a full validator. */
export function checkHtml(name: string, html: string): { name: string; ok: boolean; detail: string }[] {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  const stack: string[] = [];
  let bad = "";
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[\s\S]*/, `<${/^<script/i.test(m) ? "script" : "style"}></${/^<script/i.test(m) ? "script" : "style"}>`));
  for (const m of body.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      if (stack.at(-1) === tag) stack.pop();
      else if (!bad) bad = `</${tag}> does not match the open <${stack.at(-1) ?? "nothing"}>`;
    } else if (!VOID.has(tag) && !m[2]) stack.push(tag);
  }
  if (!bad && stack.length) bad = `<${stack.at(-1)}> is never closed`;
  out.push({ name: `${name}: tags balanced`, ok: !bad, detail: bad || "every tag closes" });
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt\s*=/.test(t)).length;
  out.push({ name: `${name}: images have alt text`, ok: noAlt === 0, detail: imgs.length ? `${imgs.length - noAlt} of ${imgs.length} have alt` : "no images" });
  // Ordinary links to other sites are fine; anything the page LOADS or SUBMITS to another address is not (attributes parsed, not pattern-matched).
  const external = externalRefs(html);
  out.push({ name: `${name}: nothing loaded from elsewhere`, ok: external.length === 0, detail: external.length ? `loads ${external[0]}` : "no external scripts, images, styles, refreshes or form targets" });
  const handlers = /\son[a-z]+\s*=|javascript:/i.test(body);
  out.push({ name: `${name}: no inline handlers or javascript: links`, ok: !handlers, detail: handlers ? "found an inline handler or javascript: link" : "none" });
  return out;
}

export function checkCss(name: string, css: string): { name: string; ok: boolean; detail: string }[] {
  const open = (css.match(/{/g) ?? []).length;
  const close = (css.match(/}/g) ?? []).length;
  const ext = CSS_REMOTE.test(css);
  return [
    { name: `${name}: braces balanced`, ok: open === close, detail: open === close ? `${open} rule block${open === 1 ? "" : "s"}` : `${open} "{" but ${close} "}"` },
    { name: `${name}: nothing loaded from elsewhere`, ok: !ext, detail: ext ? "uses @import or a remote url()" : "no remote loads" },
  ];
}

export function createBuildExecutor(workdir: string): (args: Record<string, unknown>, ctx: { signal: AbortSignal; progress?: (p: any) => void }) => Promise<ExecutorResult> {
  const repo = join(workdir, "repo");
  const wtOf = (id: string) => join(workdir, `wt-${id}`);
  const inside = (root: string, p: string) => {
    const r = resolve(root, p);
    return r === resolve(root) || r.startsWith(resolve(root) + sep) ? r : null;
  };
  const noEscape = (root: string, target: string) => {
    // A symlink inside the worktree must never carry a write out of it.
    try {
      const real = realpathSync(dirname(target));
      return real === realpathSync(root) || real.startsWith(realpathSync(root) + sep);
    } catch {
      return false; // fail CLOSED: a path that cannot be resolved is not a path that may be written
    }
  };

  async function init(): Promise<ExecutorResult> {
    if (!existsSync(join(repo, ".git"))) {
      mkdirSync(repo, { recursive: true });
      for (const [p, c] of Object.entries(BASE_FILES)) {
        const f = join(repo, p);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, c);
      }
      for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "Base site (synthetic fixture)"]]) {
        const r = await git(repo, args);
        if (r.code !== 0) return { ok: false, said: `git ${args[0]} failed: ${r.err.slice(0, 120)}`, verified: false };
      }
    }
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const status = await git(repo, ["status", "--porcelain"]);
    const files = (await git(repo, ["ls-files"])).out.split("\n").filter(Boolean);
    const clean = status.out.trim() === "";
    return { ok: head.code === 0 && clean, said: `Base site ready at ${head.out.trim().slice(0, 8)}: ${files.length} files, ${clean ? "clean" : "not clean"}.`, verified: head.code === 0 && clean, evidence: `main ${head.out.trim().slice(0, 12)}; ${files.join(", ").slice(0, 120)}`, data: { base: head.out.trim(), files } };
  }

  async function worktree(id: string): Promise<ExecutorResult> {
    const dir = wtOf(id);
    if (!existsSync(join(dir, ".git"))) {
      const r = await git(repo, ["worktree", "add", "-q", "-b", `job/${id}`, dir, "main"]);
      if (r.code !== 0) return { ok: false, said: `The worktree could not be made: ${r.err.slice(0, 140)}`, verified: false };
    }
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
    const ok = head.code === 0 && branch === `job/${id}`;
    return { ok, said: ok ? `Isolated worktree on branch ${branch}, based on ${head.out.trim().slice(0, 8)}.` : "The worktree is not on the expected branch.", verified: ok, evidence: `branch ${branch}`, data: { branch, base: head.out.trim() } };
  }

  async function apply(id: string, files: unknown, message: string): Promise<ExecutorResult> {
    const dir = wtOf(id);
    if (!existsSync(join(dir, ".git"))) return { ok: false, said: "There is no worktree for this job yet.", verified: false };
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return refused(`Give 1 to ${MAX_FILES} files.`);
    const staged: { path: string; content: string }[] = [];
    for (const f of files) {
      const p = typeof (f as { path?: unknown })?.path === "string" ? (f as { path: string }).path : "";
      const content = typeof (f as { content?: unknown })?.content === "string" ? (f as { content: string }).content : null;
      if (!PATH.test(p)) return refused(`"${p.slice(0, 50)}" is not a file this workspace writes (components/<name>.html|css|js or pages/<name>.html).`);
      if (/^pages\/.*\.(?:css|js)$/.test(p)) return refused("Pages are HTML only.");
      if (content === null || Buffer.byteLength(content) > MAX_FILE_BYTES) return refused(`"${p}" is empty or larger than ${MAX_FILE_BYTES / 1024} KB.`);
      staged.push({ path: p, content });
    }
    for (const f of staged) {
      const target = inside(dir, f.path);
      if (!target) return refused("That path leaves the worktree.");
      mkdirSync(dirname(target), { recursive: true }); // (lexically inside the worktree: `inside` checked it)
      if (!noEscape(dir, target)) return refused("That path leaves the worktree.");
      writeFileSync(`${target}.tmp`, f.content);
      renameSync(`${target}.tmp`, target);
    }
    const add = await git(dir, ["add", "-A"]);
    const msg = message.replace(/[^\x20-\x7e]/g, " ").slice(0, 120) || "Component change";
    const commit = await git(dir, ["commit", "-q", "-m", msg]);
    if (add.code !== 0 || commit.code !== 0) return { ok: false, said: commit.out.includes("nothing to commit") || commit.err.includes("nothing to commit") ? "The files are identical to what is already there, so nothing changed." : `The commit failed: ${(commit.err || commit.out).slice(0, 140)}`, verified: false };
    const sha1 = (await git(dir, ["rev-parse", "HEAD"])).out.trim();
    const names = (await git(dir, ["diff", "--name-status", "main..HEAD"])).out.split("\n").filter(Boolean);
    // Read-back: every file on disk is what was sent.
    const same = staged.every((f) => sha(readFileSync(join(dir, f.path), "utf8")) === sha(f.content));
    return { ok: same, said: `Committed ${staged.length} file${staged.length === 1 ? "" : "s"} as ${sha1.slice(0, 8)} on job/${id}; ${names.length} changed against main.`, verified: same, evidence: `commit ${sha1.slice(0, 12)}`, data: { commit: sha1, changes: names } };
  }

  async function check(id: string): Promise<ExecutorResult> {
    const dir = wtOf(id);
    if (!existsSync(join(dir, ".git"))) return { ok: false, said: "There is no worktree for this job yet.", verified: false };
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const changed = (await git(dir, ["diff", "--name-only", "main..HEAD"])).out.split("\n").filter(Boolean);
    checks.push({ name: "something changed against main", ok: changed.length > 0, detail: `${changed.length} file${changed.length === 1 ? "" : "s"}` });
    for (const f of changed) {
      const p = join(dir, f);
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      const text = readFileSync(p, "utf8");
      if (f.endsWith(".html")) checks.push(...checkHtml(f, text));
      else if (f.endsWith(".css")) checks.push(...checkCss(f, text));
      else if (f.endsWith(".js")) {
        const r = await nodeCheck(p);
        checks.push({ name: `${f}: javascript parses`, ok: r.ok, detail: r.detail });
        const bad = JS_FORBIDDEN.test(text);
        checks.push({ name: `${f}: no network or dynamic code`, ok: !bad, detail: bad ? "uses a network, navigation, element-building or dynamic-code call" : "none" });
      }
    }
    const ws = await git(dir, ["diff", "--check", "main..HEAD"]);
    checks.push({ name: "no whitespace errors (git diff --check)", ok: ws.code === 0, detail: ws.code === 0 ? "clean" : ws.out.split("\n")[0].slice(0, 100) });
    const status = await git(dir, ["status", "--porcelain"]);
    checks.push({ name: "worktree is clean after the commit", ok: status.out.trim() === "", detail: status.out.trim() === "" ? "clean" : "uncommitted files" });
    const failed = checks.filter((c) => !c.ok);
    return { ok: failed.length === 0, said: failed.length ? `${failed.length} of ${checks.length} checks failed: ${failed.slice(0, 2).map((c) => c.name).join("; ")}.` : `All ${checks.length} checks passed.`, verified: true, evidence: `${checks.length - failed.length}/${checks.length} passed`, data: { checks } };
  }

  async function diff(id: string): Promise<ExecutorResult> {
    const dir = wtOf(id);
    if (!existsSync(join(dir, ".git"))) return { ok: false, said: "There is no worktree for this job yet.", verified: false };
    const stat = (await git(dir, ["diff", "--stat", "--no-color", "main..HEAD"])).out.trim();
    const full = (await git(dir, ["diff", "--no-color", "--no-ext-diff", "main..HEAD"])).out;
    const names = (await git(dir, ["diff", "--name-status", "main..HEAD"])).out.split("\n").filter(Boolean);
    const text = full.length > DIFF_CAP ? `${full.slice(0, DIFF_CAP)}\n... (diff cut at ${DIFF_CAP / 1024} KB)\n` : full;
    const name = `change-${id}.diff`;
    writeFileSync(join(workdir, name), text, { mode: 0o600 });
    return { ok: full.length > 0, said: `Diff against main: ${names.length} file${names.length === 1 ? "" : "s"}.`, verified: full.length > 0, evidence: stat.split("\n").at(-1)?.slice(0, 120) ?? "", data: { file: name, bytes: Buffer.byteLength(text), stat, names, sha256: sha(text).slice(0, 16) } };
  }

  async function preview(id: string): Promise<ExecutorResult> {
    const dir = wtOf(id);
    if (!existsSync(join(dir, "index.html"))) return { ok: false, said: "There is no worktree for this job yet.", verified: false };
    const list = (sub: string, ext: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).filter((f) => f.endsWith(ext)).sort() : []);
    const read = (p: string) => readFileSync(join(dir, p), "utf8");
    const css = list("components", ".css").map((f) => `/* ${f} */\n${read(`components/${f}`)}`).join("\n");
    const js = list("components", ".js").map((f) => `/* ${f} */\n${read(`components/${f}`)}`).join("\n");
    const comps = list("components", ".html").map((f) => `<!-- components/${f} -->\n${read(`components/${f}`)}`).join("\n");
    const pages = list("pages", ".html").map((f) => `<!-- pages/${f} -->\n${read(`pages/${f}`)}`).join("\n");
    let page = read("index.html").replace("<!--components-->", `${comps}\n${pages}`);
    page = page.replace("</head>", `<style>\nbody{margin:0;padding:24px;font-family:system-ui,sans-serif;color:#1d1d1b}.site-header{margin-bottom:24px}\n${css}\n</style>\n</head>`);
    if (js) page = page.replace("</body>", `<script>\n${js}\n</script>\n</body>`);
    const name = `preview-${id}.html`;
    writeFileSync(join(workdir, name), page, { mode: 0o600 });
    return { ok: true, said: `Preview page built (${Buffer.byteLength(page)} bytes) from ${list("components", ".html").length + list("pages", ".html").length} component or page file${list("components", ".html").length + list("pages", ".html").length === 1 ? "" : "s"}.`, verified: true, evidence: `sha256 ${sha(page).slice(0, 12)}`, data: { file: name, bytes: Buffer.byteLength(page), sha256: sha(page).slice(0, 16) } };
  }

  return async (args) => {
    const action = String(args.action ?? "");
    const id = String(args.id ?? "");
    try {
      if (action === "init") return await init();
      if (!ID.test(id)) return refused("A job id is 4 to 24 lowercase letters, digits or dashes.");
      if (!existsSync(join(repo, ".git"))) return { ok: false, said: "The base site hasn't been set up yet (run init first).", verified: false };
      if (action === "worktree") return await worktree(id);
      if (action === "apply") return await apply(id, args.files, String(args.message ?? ""));
      if (action === "check") return await check(id);
      if (action === "diff") return await diff(id);
      if (action === "preview") return await preview(id);
      return refused("Unknown build action.");
    } catch (e) {
      return { ok: false, said: `The workspace step failed: ${e instanceof Error ? e.message.slice(0, 140) : "unknown error"}`, verified: false };
    }
  };
}
