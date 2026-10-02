import { BASE_FILES, JS_FORBIDDEN, externalRefs } from "../../../companion/linux/build-workspace";
import { Halt, WORKFLOW_LABEL, cut, gate, haltResult, makeProgress, mustCall, note, parseJson, pullFile, slug, tryCall, type WorkflowIO, type WorkflowResult } from "./common";

/**
 * Builder: make or change ONE small website component, on the Builder computer, in an isolated git worktree, run the checks, and hand back a preview, a
 * readable summary, the diff and the evidence. Nothing is merged, pushed or deployed: the work stays on its own branch (`job/<id>`) in the computer's
 * folder; the base site (`main`) is never touched.
 *
 *   1 workspace  the base site is made (once) and this job gets its OWN worktree on its own branch
 *   2 write      the component (a connected model writes it from the request; with none, a fixed template for the kind of component does) is
 *                validated here (names, sizes, no remote loads) and committed in the worktree
 *   3 check      the computer runs the checks: tags balance, images have alt text, nothing loads from elsewhere, scripts parse, no whitespace errors
 *   4 preview    a self-contained preview page is built and photographed at desktop and phone width
 *   5 return     the diff, preview, screenshots, changed files and the check evidence are kept as one artifact; one result entry goes to the conversation
 */

export const BUILDER_EXECUTOR = "builder";
export const BUILDER_STEPS = ["workspace", "write component", "check", "preview", "return result"] as const;
export type BuilderParams = { brief: string };
export type ComponentFile = { path: string; content: string };
export type Component = { name: string; title: string; summary: string; files: ComponentFile[]; via: "model" | "template" };

const HEX_JOB = /^[a-z0-9-]{4,24}$/;
const MAX_BYTES = 12 * 1024;
const EXT = /\.(?:html|css|js)$/;

/** A component's files, validated for the workspace. Returns the problem, or null when they may be written. Pure. */
export function validateComponent(c: { name: string; files: ComponentFile[] }): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(c.name)) return "the component name is not a plain lowercase name";
  if (c.files.length < 1 || c.files.length > 4) return "a component is one to four files";
  const seen = new Set<string>();
  for (const f of c.files) {
    if (!new RegExp(`^components/${c.name}\\.(?:html|css|js)$`).test(f.path)) return `${f.path} is not components/${c.name}.html, .css or .js`;
    if (seen.has(f.path)) return `${f.path} appears twice`;
    seen.add(f.path);
    if (typeof f.content !== "string" || !f.content.trim() || Buffer.byteLength(f.content) > MAX_BYTES) return `${f.path} is empty or larger than ${MAX_BYTES / 1024} KB`;
    if (/(?:src|href|action)\s*=\s*["']\s*(?:https?:)?\/\//i.test(f.content) && /<(?:script|img|iframe|link|form)\b/i.test(f.content)) return `${f.path} loads something from another address`;
    if (/@import\b|url\(\s*["']?\s*(?:https?:)?\/\//i.test(f.content)) return `${f.path} loads something from another address`;
    if (f.path.endsWith(".js") && JS_FORBIDDEN.test(f.content)) return `${f.path} uses a network, navigation or dynamic-code call`;
    if (f.path.endsWith(".html") && externalRefs(f.content).length) return `${f.path} loads something from another address`;
  }
  if (!c.files.some((f) => f.path.endsWith(".html"))) return "a component needs an .html file";
  return null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the request is about, for the template fallback and for naming. Pure. */
export function templateFor(brief: string): Component {
  const b = brief.toLowerCase();
  const text = esc(brief.replace(/\s+/g, " ").trim().slice(0, 120));
  if (/\b(?:pric|plan|packag|fee|cost)/.test(b) && /\b(?:update|change|edit|modify|improve|add)\b/.test(b)) {
    // An UPDATE of the component the base site already has.
    return {
      name: "pricing-card", title: "Update the pricing card", via: "template",
      summary: "Updated the existing pricing card: a 'Most popular' badge, a second line for the price including GST, and a larger booking button.",
      files: [
        { path: "components/pricing-card.html", content: `<section class="pricing-card" aria-labelledby="pc-title">\n  <p class="pricing-card__badge">Most popular</p>\n  <h2 id="pc-title">Standard visit</h2>\n  <p class="pricing-card__price">$80</p>\n  <p class="pricing-card__gst">$88 including GST</p>\n  <p>A standard 30 minute consultation.</p>\n  <a class="pricing-card__cta" href="#book">Book a visit</a>\n</section>\n` },
        { path: "components/pricing-card.css", content: `${BASE_FILES["components/pricing-card.css"].replace("padding: 10px 16px;", "padding: 14px 22px; min-height: 44px;")}.pricing-card__badge { display: inline-block; margin: 0 0 8px; padding: 2px 10px; background: #e7f1ed; color: #1f4a3f; border-radius: 999px; font-size: 0.85rem; }\n.pricing-card__gst { margin: 0 0 8px; color: #4a4a47; }\n` },
      ],
    };
  }
  if (/\b(?:hours|opening|open)\b/.test(b))
    return {
      name: "opening-hours", title: "Opening hours", via: "template",
      summary: "Added an opening-hours component: a labelled table of days and times (synthetic hours).",
      files: [
        { path: "components/opening-hours.html", content: `<section class="opening-hours" aria-labelledby="oh-title">\n  <h2 id="oh-title">Opening hours</h2>\n  <table>\n    <tbody>\n      <tr><th scope="row">Monday to Friday</th><td>8:00 am to 5:30 pm</td></tr>\n      <tr><th scope="row">Saturday</th><td>9:00 am to 12:00 pm</td></tr>\n      <tr><th scope="row">Sunday</th><td>Closed</td></tr>\n    </tbody>\n  </table>\n  <p class="opening-hours__note">Synthetic hours for practice.</p>\n</section>\n` },
        { path: "components/opening-hours.css", content: `.opening-hours { max-width: 360px; font-family: system-ui, sans-serif; margin: 16px 0; }\n.opening-hours table { border-collapse: collapse; width: 100%; }\n.opening-hours th, .opening-hours td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #dcd9d0; }\n.opening-hours__note { color: #66645e; font-size: 0.9rem; }\n` },
      ],
    };
  if (/\b(?:testimonial|review|quote)\b/.test(b))
    return {
      name: "testimonial", title: "Testimonial", via: "template",
      summary: "Added a testimonial component: a quote with its attribution (a synthetic patient).",
      files: [
        { path: "components/testimonial.html", content: `<figure class="testimonial">\n  <blockquote>The team were kind and on time, and explained everything clearly.</blockquote>\n  <figcaption>A synthetic patient</figcaption>\n</figure>\n` },
        { path: "components/testimonial.css", content: `.testimonial { max-width: 420px; margin: 16px 0; padding: 16px 20px; border-left: 4px solid #2f6f5e; background: #f4f7f5; font-family: system-ui, sans-serif; }\n.testimonial blockquote { margin: 0 0 8px; font-size: 1.05rem; }\n.testimonial figcaption { color: #66645e; font-size: 0.9rem; }\n` },
      ],
    };
  return {
    name: "notice-banner", title: "Notice banner", via: "template",
    summary: `Added a notice banner component${text ? ` for: ${text}` : ""}.`,
    files: [
      { path: "components/notice-banner.html", content: `<aside class="notice-banner" role="note">\n  <strong>Notice</strong>\n  <span>${text || "Please call ahead to confirm your visit."}</span>\n</aside>\n` },
      { path: "components/notice-banner.css", content: `.notice-banner { display: flex; gap: 10px; align-items: baseline; padding: 12px 16px; margin: 16px 0; background: #fff6df; border: 1px solid #ecd9a0; border-radius: 8px; font-family: system-ui, sans-serif; }\n` },
    ],
  };
}

async function writeWithModel(io: WorkflowIO, brief: string): Promise<Component | null> {
  if (!io.delegate) return null;
  const r = await io.delegate({
    system: 'You write ONE small website component as plain HTML, CSS and optional JavaScript for a static site. Reply with JSON only: {"name":"lowercase-name-with-dashes","title":"short title","summary":"one sentence on what it is","html":"...","css":"...","js":""}. Rules: the html is a fragment (no html, head or body tags); every image needs alt; no external addresses (no http, no CDN, no web fonts); no fetch, eval or document.write; keep css selectors under one class prefix equal to the name; at most 80 lines in total; the base site already has components/pricing-card.html and .css (a card with a title, a price and a booking link) which you may update by using the name "pricing-card". Titles and text are plain Australian English.',
    user: `Request: ${brief}\nBase files:\n--- components/pricing-card.html\n${BASE_FILES["components/pricing-card.html"]}\n--- components/pricing-card.css\n${BASE_FILES["components/pricing-card.css"]}`,
    maxTokens: 1800,
    label: "component",
  }, io.signal).catch(() => null);
  const j = r ? parseJson(r.text) : null;
  if (!j || typeof j.name !== "string" || typeof j.html !== "string" || typeof j.css !== "string") return null;
  const name = slug(j.name, 38);
  const files: ComponentFile[] = [{ path: `components/${name}.html`, content: `${j.html.trim()}\n` }, { path: `components/${name}.css`, content: `${j.css.trim()}\n` }];
  if (typeof j.js === "string" && j.js.trim()) files.push({ path: `components/${name}.js`, content: `${j.js.trim()}\n` });
  const c: Component = { name, title: cut(String(j.title ?? name), 60), summary: cut(String(j.summary ?? ""), 200) || `Component ${name}.`, files, via: "model" };
  return validateComponent(c) ? null : c;
}

/** A readable change summary from the diff the computer made. Pure. */
export function changeSummary(input: { component: Component; names: string[]; stat: string }): string {
  const verb = (s: string) => (s.startsWith("A") ? "added" : s.startsWith("D") ? "removed" : "changed");
  const lines = input.names.map((n) => {
    const [status, ...rest] = n.split(/\s+/);
    return `- ${verb(status)} \`${rest.join(" ")}\``;
  });
  return [input.component.summary, "", ...lines, "", `Size of the change: ${input.stat.split("\n").at(-1)?.trim() || "see the diff"}.`].join("\n");
}

export async function runBuilder(input: { params: BuilderParams; io: WorkflowIO; limits?: { wallMs?: number } }): Promise<WorkflowResult> {
  const { io } = input;
  const clock = io.now ?? Date.now;
  const t0 = clock();
  const over = () => clock() - t0 > (input.limits?.wallMs ?? 6 * 60_000);
  const mark = makeProgress(io, "builder", BUILDER_STEPS);
  const brief = input.params.brief.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!brief) return { ok: false, outcome: "failed", note: "Say what to build or change. Nothing was started.", wallMs: 0 };
  const id = io.jobId.replace(/-/g, "").slice(0, 12);
  if (!HEX_JOB.test(id)) return { ok: false, outcome: "failed", note: "The job has no usable id.", wallMs: 0 };
  try {
    // 1 workspace
    mark(0, "started", "Preparing the base site and an isolated worktree");
    const init = await mustCall(io, "build.component", { action: "init" }, "set up the base site", over);
    const wt = await mustCall(io, "build.component", { action: "worktree", id }, "make an isolated worktree", over);
    const branch = String((wt.data as { branch?: unknown } | undefined)?.branch ?? `job/${id}`);
    mark(0, "done", `Worktree on branch ${branch}, from main ${String((init.data as { base?: unknown } | undefined)?.base ?? "").slice(0, 8)}; main is not touched`);

    // 2 write
    await gate(io, over);
    mark(1, "started", "Writing the component");
    let comp = await writeWithModel(io, brief);
    if (!comp) comp = templateFor(brief);
    const bad = validateComponent(comp);
    if (bad) throw new Halt("failed", `The component was not written: ${bad}.`);
    note(io, "builder", comp.via === "model" ? `component "${comp.name}" written by a connected model, validated here` : `component "${comp.name}" from a fixed template (no connected model answered)`, "note");
    const applied = await mustCall(io, "build.component", { action: "apply", id, files: comp.files, message: `${comp.title}: ${cut(brief, 80)}` }, `commit ${comp.files.length} file${comp.files.length === 1 ? "" : "s"}`, over);
    mark(1, "done", `${comp.files.length} file${comp.files.length === 1 ? "" : "s"} committed on ${branch}: ${comp.files.map((f) => f.path.replace("components/", "")).join(", ")}`);

    // 3 check
    mark(2, "started", "Running the checks in the worktree");
    const chk = await tryCall(io, "build.component", { action: "check", id }, "run the checks", over);
    const checks = ((chk.kind === "failed" ? null : (chk.data as { checks?: { name: string; ok: boolean; detail: string }[] } | undefined)?.checks) ?? []);
    const failed = checks.filter((c) => !c.ok);
    if (!checks.length) throw new Halt("failed", `The checks did not run: ${chk.kind === "failed" ? chk.said : "no result"}.`);
    mark(2, failed.length ? "failed" : "done", failed.length ? `${failed.length} of ${checks.length} checks FAILED: ${failed[0].name}` : `All ${checks.length} checks passed`);

    // 4 preview
    mark(3, "started", "Building the preview and photographing it");
    const diff = await mustCall(io, "build.component", { action: "diff", id }, "make the diff", over);
    const dd = diff.data as { file?: string; names?: string[]; stat?: string } | undefined;
    const prev = await mustCall(io, "build.component", { action: "preview", id }, "build the preview page", over);
    const previewFile = String((prev.data as { file?: unknown } | undefined)?.file ?? "");
    const opened = await tryCall(io, "fixture.open", { name: previewFile }, "open the preview", over);
    const shotNames: { name: string; label: string }[] = [];
    if (opened.kind !== "failed") {
      const tab = String((opened.data as { tabId?: unknown } | undefined)?.tabId ?? "");
      for (const [label, size] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const) {
        const s = await tryCall(io, "page.audit", { label: `preview-${label}`, width: size.width, height: size.height, analyse: false, ...(tab ? { tabId: tab } : {}) }, `photograph the preview at ${size.width} px`, over);
        const f = s.kind === "failed" ? null : (s.data as { shot?: string } | undefined)?.shot;
        if (f) shotNames.push({ name: f, label });
      }
    }
    mark(3, shotNames.length ? "done" : "skipped", shotNames.length ? `Preview built and photographed at ${shotNames.map((s) => s.label).join(" and ")}` : "The preview page was built but the computer has no browser to photograph it");

    // 5 return
    await gate(io, over);
    mark(4, "started", "Bringing the diff, preview and pictures back");
    const diffBytes = dd?.file ? await pullFile(io, dd.file, 1024 * 1024, over) : null;
    const previewBytes = previewFile ? await pullFile(io, previewFile, 1024 * 1024, over) : null;
    const shots: { name: string; data: Buffer }[] = [];
    for (const s of shotNames) {
      const b = await pullFile(io, s.name, 2 * 1024 * 1024, over);
      if (b) shots.push({ name: s.name, data: b });
    }
    const summaryText = changeSummary({ component: comp, names: dd?.names ?? [], stat: dd?.stat ?? "" });
    const checkLines = checks.map((c) => `| ${c.ok ? "pass" : "FAIL"} | ${cut(c.name, 70).replace(/\|/g, "/")} | ${cut(c.detail, 70).replace(/\|/g, "/")} |`);
    const complete = failed.length === 0 && !!diffBytes && !!previewBytes && shots.length === shotNames.length && shotNames.length > 0;
    const md = [
      `# Builder: ${comp.title}`,
      "",
      `**Request:** ${brief}`,
      "",
      `**Isolated:** worktree on branch \`${branch}\` in the ${io.computer} computer's own folder. The base site (\`main\`) was not changed, and nothing was merged, pushed or deployed.`,
      "",
      "## What changed",
      summaryText,
      "",
      "## Verification",
      `${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? ` (${failed.length} FAILED, see below)` : ""}. The computer ran them in the worktree after committing.`,
      "",
      "| Result | Check | Detail |",
      "| --- | --- | --- |",
      ...checkLines,
      "",
      "## Preview",
      ...shots.map((s) => `![${s.name.replace(/^shot-preview-/, "").replace(/\.jpg$/, "")} preview](${s.name})`),
      shots.length ? "" : "No screenshot is available (the computer has no browser, or it could not be brought back).",
      previewBytes ? "The page itself is `preview.html` (open it from the Files list below)." : "",
      "",
      "## Files and diff",
      ...comp.files.map((f) => `- \`${f.path}\`: component-${f.path.replace(/^components\//, "")}`),
      diffBytes ? "- The full diff is `change.diff`." : "- The diff could not be brought back.",
      "",
      `Made by ${comp.via === "model" ? "a connected model, then validated and checked" : "a fixed template (no connected model answered), then validated and checked"}.`,
    ].join("\n");
    const saveRes = io.artifact({
      kind: "builder", title: `Builder: ${comp.title}`, outcome: complete ? "complete" : "partial", main: previewBytes && !failed.length ? "builder.md" : "builder.md",
      summary: `${comp.summary} ${checks.length - failed.length}/${checks.length} checks passed; ${shots.length} preview screenshot${shots.length === 1 ? "" : "s"}.`,
      files: [
        { name: "builder.md", data: md },
        ...(previewBytes ? [{ name: "preview.html", data: previewBytes }] : []),
        ...(diffBytes ? [{ name: "change.diff", data: diffBytes }] : []),
        ...comp.files.map((f) => ({ name: `component-${f.path.replace(/^components\//, "")}`, data: f.content })),
        { name: "checks.json", data: JSON.stringify({ branch, commit: (applied.data as { commit?: string } | undefined)?.commit ?? null, checks }, null, 2) },
        ...shots,
      ],
    });
    const back = await io.deliver(`${WORKFLOW_LABEL.builder}: ${comp.title}\n${comp.summary}\nChecks: ${checks.length - failed.length} of ${checks.length} passed${failed.length ? ` (${failed.length} failed: ${cut(failed[0].name, 50)})` : ""}. Preview: ${shots.length ? shots.map((s) => s.name.replace(/^shot-preview-/, "").replace(/\.jpg$/, "")).join(" and ") : "none"}. Work is on branch ${branch}; nothing was merged or deployed.`, { artifact: saveRes.ok ? saveRes.title : null, label: WORKFLOW_LABEL.builder, web: false }).catch(() => ({ delivered: false, where: "delivery failed" }));
    mark(4, saveRes.ok ? "done" : "failed", saveRes.ok ? `Saved result kept${back.delivered ? " and returned to your conversation" : ` (${back.where})`}` : `The result could not be kept on the hub (${saveRes.reason})`);
    const ok = complete && saveRes.ok;
    note(io, "builder", `builder ${ok ? "complete" : "partial"}: ${comp.files.length} files, ${checks.length - failed.length}/${checks.length} checks in ${Math.round((clock() - t0) / 1000)} s`, ok ? "ok" : "unknown");
    return { ok: true, outcome: ok ? "complete" : "partial", note: `${ok ? "Component ready" : "Partial result"}: ${comp.title}; ${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? ` (${failed.length} failed)` : ""}; ${shots.length} preview screenshot${shots.length === 1 ? "" : "s"}.`, wallMs: clock() - t0 };
  } catch (e) {
    return haltResult(e, t0, clock);
  }
}
