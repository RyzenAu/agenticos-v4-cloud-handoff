import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Saved results of bot-computer workflows (research, builder, website audit, business preparation).
 *
 * One folder per JOB on the hub (`<data dir>/computers/artifacts/<jobId>/`): `meta.json` plus the files the workflow produced (a report,
 * screenshots, a preview page, a diff, a CSV). The hub keeps its own copy, so a result is still there after the computer is stopped, destroyed or
 * the hub restarts, and it opens from the OS (`GET /__computers/artifacts/<jobId>`) without the computer being online.
 *
 *  - ONE artifact per job: saving again for the same job returns the first one (a replayed step or a restart never makes a second).
 *  - It belongs to the person who asked: only that person can list or open it (the other founder's conversation never sees it).
 *  - File names are flat and plain; sizes and counts are capped; nothing is ever executed by the hub. HTML is served in a sandbox with a
 *    CSP that forbids network access (see `cspFor`), so a preview built by a bot cannot reach out of its own page.
 */

export type ArtifactKind = "research" | "builder" | "audit" | "bizprep";
export type ArtifactFileMeta = { name: string; bytes: number; mime: string };
export type ArtifactMeta = {
  id: string;
  personId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  /** Plain words for the host this ran on: "real LAN host (Ryzen-PC WSL)", "real local computer", "synthetic" and so on. */
  host: string;
  computer: string;
  createdAt: string;
  /** The file that opens first (`report.md`, `preview.html`...). */
  main: string;
  files: ArtifactFileMeta[];
  /** Outcome words from the workflow itself: "complete", "partial"... never decided by the store. */
  outcome: string;
};
export type ArtifactInput = { jobId: string; personId: string; kind: ArtifactKind; title: string; summary: string; host: string; computer: string; outcome: string; main: string; files: { name: string; data: Uint8Array | string }[] };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ARTIFACT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_FILES = 24;
const MAX_TOTAL = 12 * 1024 * 1024;
const MIME: Record<string, string> = { md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/json", csv: "text/csv; charset=utf-8", html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/plain; charset=utf-8", diff: "text/plain; charset=utf-8", patch: "text/plain; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
export const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function createArtifactStore(dir: string, now: () => number = Date.now) {
  mkdirSync(dir, { recursive: true });
  const folder = (id: string) => (ID.test(id) ? join(dir, id.toLowerCase()) : null);
  const readMeta = (id: string): ArtifactMeta | null => {
    const f = folder(id);
    if (!f || !existsSync(join(f, "meta.json"))) return null;
    try {
      return JSON.parse(readFileSync(join(f, "meta.json"), "utf8")) as ArtifactMeta;
    } catch {
      return null;
    }
  };
  return {
    dir,
    /** Save a job's artifact. Idempotent per job: the first save wins and later ones return it unchanged. */
    save(input: ArtifactInput): { ok: true; meta: ArtifactMeta; created: boolean } | { ok: false; reason: string } {
      const f = folder(input.jobId);
      if (!f) return { ok: false, reason: "That is not a job id." };
      const old = readMeta(input.jobId);
      if (old) return { ok: true, meta: old, created: false };
      if (!input.files.length || input.files.length > MAX_FILES) return { ok: false, reason: `An artifact holds 1 to ${MAX_FILES} files.` };
      const names = new Set<string>();
      let total = 0;
      for (const file of input.files) {
        if (!ARTIFACT_FILE.test(file.name) || names.has(file.name) || file.name === "meta.json") return { ok: false, reason: `"${file.name}" is not a usable file name.` };
        names.add(file.name);
        total += typeof file.data === "string" ? Buffer.byteLength(file.data) : file.data.byteLength;
      }
      if (total > MAX_TOTAL) return { ok: false, reason: "That artifact is too large to keep." };
      if (!names.has(input.main)) return { ok: false, reason: "The main file is not among the files." };
      mkdirSync(f, { recursive: true });
      const metas: ArtifactFileMeta[] = [];
      for (const file of input.files) {
        const bytes = typeof file.data === "string" ? Buffer.from(file.data, "utf8") : Buffer.from(file.data);
        const path = join(f, file.name);
        writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
        metas.push({ name: file.name, bytes: bytes.length, mime: mimeOf(file.name) });
      }
      const meta: ArtifactMeta = { id: input.jobId.toLowerCase(), personId: input.personId, kind: input.kind, title: input.title.slice(0, 160), summary: input.summary.slice(0, 600), host: input.host.slice(0, 120), computer: input.computer.slice(0, 40), createdAt: new Date(now()).toISOString(), main: input.main, files: metas, outcome: input.outcome.slice(0, 40) };
      // meta.json is written LAST: an artifact exists only when it is complete (a crash mid-save leaves no half artifact that opens).
      writeFileSync(join(f, "meta.json.tmp"), JSON.stringify(meta, null, 2), { mode: 0o600 });
      renameSync(join(f, "meta.json.tmp"), join(f, "meta.json"));
      return { ok: true, meta, created: true };
    },
    /** The artifact, only for the person it belongs to. */
    get(id: string, personId: string): ArtifactMeta | null {
      const m = readMeta(id);
      return m && m.personId === personId ? m : null;
    },
    /** Who a result belongs to (null when there is none), for the routes' shared-bot rule. */
    ownerOf(id: string): string | null {
      return readMeta(id)?.personId ?? null;
    },
    /** Every result on the hub (the routes filter it by who may see what). */
    listAll(): ArtifactMeta[] {
      const out: ArtifactMeta[] = [];
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        const m = readMeta(name);
        if (m) out.push(m);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    list(personId: string): ArtifactMeta[] {
      const out: ArtifactMeta[] = [];
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        const m = readMeta(name);
        if (m && m.personId === personId) out.push(m);
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    file(id: string, personId: string, name: string): { meta: ArtifactMeta; data: Buffer; mime: string } | null {
      const meta = this.get(id, personId);
      const entry = meta?.files.find((f) => f.name === name);
      const f = folder(id);
      if (!meta || !entry || !f) return null;
      const path = resolve(f, name);
      if (!path.startsWith(resolve(f) + sep) || !existsSync(path) || statSync(path).size > MAX_TOTAL) return null;
      return { meta, data: readFileSync(path), mime: entry.mime };
    },
  };
}
export type ArtifactStore = ReturnType<typeof createArtifactStore>;

// ------------------------------------------------------------------------------------------------------------- viewing
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Markdown to HTML for the small subset the workflows write: headings, paragraphs, bullet and numbered lists, tables, fenced code, bold, inline code,
 * links and images. Everything is escaped first; a link is kept only when it is http(s) or one of this artifact's own files, an image only when it is
 * one of this artifact's own files. Pure.
 */
export function renderMarkdown(md: string, ownFiles: ReadonlySet<string>, fileUrl: (name: string) => string, sameTab = false): string {
  const inline = (raw: string) => {
    let s = esc(raw);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => (ownFiles.has(src) ? `<img src="${esc(fileUrl(src))}" alt="${alt}" loading="lazy">` : alt));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
      if (/^https?:\/\/[^\s"'<>]+$/i.test(href)) return `<a href="${href}"${sameTab ? ' rel="noreferrer nofollow"' : ' target="_blank" rel="noopener noreferrer nofollow"'}>${text}</a>`;
      if (ownFiles.has(href)) return `<a href="${esc(fileUrl(href))}"${sameTab ? "" : ' target="_blank" rel="noopener"'}>${text}</a>`;
      return text;
    });
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:])/g, "$1<em>$2</em>");
    return s;
  };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))) items.push(lines[i++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\d+[.)]\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}

const KIND_WORDS: Record<ArtifactKind, string> = { research: "Research report", builder: "Builder result", audit: "Website audit", bizprep: "Business preparation" };

/** The page an artifact opens as: the result itself, then its files. Static HTML, no script, own styles, light and dark. */
export function artifactPage(meta: ArtifactMeta, mainText: string | null, base: string, options: { /** A browser that blocks new tabs (the Dot gateway): links open in place. */ sameTab?: boolean } = {}): string {
  const own = new Set(meta.files.map((f) => f.name));
  const newTab = options.sameTab ? "" : ' target="_blank" rel="noopener"';
  const url = (n: string) => `${base}/f/${encodeURIComponent(n)}`;
  const mainIsMd = /\.md$/i.test(meta.main);
  const mainIsHtml = /\.html?$/i.test(meta.main);
  const body = mainIsMd && mainText !== null ? renderMarkdown(mainText, own, url, options.sameTab === true) : mainIsHtml ? `<p><a class="btn" href="${esc(url(meta.main))}"${newTab}>Open the page this made</a></p>` : mainText !== null ? `<pre><code>${esc(mainText)}</code></pre>` : "<p>The main file could not be read.</p>";
  const files = meta.files.map((f) => `<li><a href="${esc(url(f.name))}"${newTab}>${esc(f.name)}</a> <span>${f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} KB`}</span> <a class="dl" href="${esc(url(f.name))}?download=1" download="${esc(f.name)}">Download</a></li>`).join("");
  // The page a builder made is shown in a sandboxed frame (no network, no access to the OS) above its summary.
  const previewFile = mainIsHtml ? meta.main : meta.files.some((f) => f.name === "preview.html") ? "preview.html" : null;
  const preview = previewFile ? `<iframe class="preview" title="Preview" sandbox="allow-scripts" src="${esc(url(previewFile))}"></iframe>` : "";
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.title)} - saved result</title>
<style>:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1d1d1b;--mut:#66645e;--line:#dcd9d0;--card:#fff;--acc:#2f6f5e}@media(prefers-color-scheme:dark){:root{--bg:#171715;--fg:#ecebe6;--mut:#a09d94;--line:#34332f;--card:#1f1f1c;--acc:#7fc4ae}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,Segoe UI,sans-serif}main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
header{border-bottom:1px solid var(--line);margin-bottom:20px;padding-bottom:12px}h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.2rem;margin-top:1.6em}h3{font-size:1.05rem}
.meta{color:var(--mut);font-size:.9rem}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:.8rem;margin-right:6px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.93rem}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:var(--card)}.scroll{overflow-x:auto}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:.85rem}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
a{color:var(--acc)}.btn{display:inline-block;border:1px solid var(--acc);border-radius:8px;padding:6px 12px;text-decoration:none}.files{margin-top:2em;border-top:1px solid var(--line);padding-top:12px}.files li{margin:3px 0}.files span{color:var(--mut);font-size:.85rem}
.preview{width:100%;height:520px;border:1px solid var(--line);border-radius:8px;background:#fff;margin:12px 0}</style></head>
<body><main><header><div><span class="pill">${esc(KIND_WORDS[meta.kind])}</span><span class="pill">${esc(meta.outcome)}</span></div><h1>${esc(meta.title)}</h1>
<div class="meta">${esc(meta.summary)}<br>Made on the ${esc(meta.computer)} computer (${esc(meta.host)}), ${esc(meta.createdAt.slice(0, 16).replace("T", " "))} UTC. Job ${esc(meta.id.slice(0, 8))}.</div></header>
${preview}${body}<div class="files"><h2>Files</h2><ul>${files}</ul></div></main></body></html>`;
}

/**
 * Content-Disposition for a saved file the person asked to download: an attachment with a plain ASCII file name (artifact file names are already flat and
 * plain, so this only guards what a header may carry), plus the RFC 5987 form for anything else.
 */
export function downloadDisposition(name: string): string {
  // Trim the NAME (by characters, never through a surrogate pair) before encoding, so an escape is never cut in half; RFC 5987 also needs ' ( ) * escaped.
  const trimmed = Array.from(name).slice(0, 120).join("");
  const plain = trimmed.replace(/[^A-Za-z0-9._-]/g, "_") || "result";
  const star = encodeURIComponent(trimmed).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${star}`;
}

/** Headers for a file served from an artifact. Anything a bot wrote is untrusted: HTML runs in a sandbox that cannot reach the network or the OS. */
export function headersFor(mime: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (mime.startsWith("text/html")) h["Content-Security-Policy"] = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
  else h["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
  return h;
}
