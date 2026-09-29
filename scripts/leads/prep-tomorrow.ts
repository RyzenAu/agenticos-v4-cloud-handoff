// Nightly prep: builds tomorrow's morning pack -- the founder's ready-to-go call list, each with a
// fresh SEO audit, a local (never deployed) preview, and an opener + call script. Meant to run
// unattended overnight via a Hermes cron job (see docs/NIGHTLY-PREP.md for the job definition and
// install command -- this file never registers it). Every step is best-effort: a failed SEO audit,
// preview build or script generation notes itself in the pack instead of failing the whole run, so
// one flaky lead never blocks the other nine.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { generateCallScript, type CallScript, type LlmComplete } from "./call-script";
import { callList, type Lead } from "./crm";
import { generatePreview, previewBlocker, type GenerateOptions } from "../lead-sites/generate";
import { callOpener, callWindow, DEFAULT_SENDER, type Sender } from "./outreach";
import { runSeoAudit, type SeoAuditRecord } from "./seo-audit";

export function tomorrow(now = new Date()): Date {
  return new Date(now.getTime() + 24 * 3_600_000);
}

export function prepDir(root: string, date: string) {
  return join(root, ".operator-data", "prep", date);
}

export type PrepItem = {
  lead: Lead;
  opener: string;
  seo: { ok: boolean; note: string };
  preview: { ok: boolean; note: string; dir?: string };
  script: { ok: boolean; note: string; script?: CallScript };
};

export type PrepPack = {
  date: string;
  generatedAt: string;
  callWindow: { open: boolean; why: string };
  items: PrepItem[];
};

export async function buildMorningPack(
  db: Database,
  opts: {
    root: string;
    draftsRoot: string;
    top?: number;
    by?: string;
    now?: Date;
    sender?: Sender;
    runSeoAuditFn?: typeof runSeoAudit;
    generatePreviewFn?: (db: Database, ref: string | number, opts: GenerateOptions) => ReturnType<typeof generatePreview>;
    complete?: LlmComplete;
  },
): Promise<PrepPack> {
  const now = opts.now ?? new Date();
  const target = tomorrow(now);
  const date = target.toISOString().slice(0, 10);
  const window = callWindow(target);
  const sender = opts.sender ?? DEFAULT_SENDER;
  const runSeoAuditFn = opts.runSeoAuditFn ?? runSeoAudit;
  const generatePreviewFn = opts.generatePreviewFn ?? generatePreview;

  // Telecommunications Industry Standard 2017: no calls Sunday. Building a pack for a day nobody
  // may call on would just be waste -- the pack says so plainly and stops there.
  if (!window.open) {
    return { date, generatedAt: now.toISOString(), callWindow: window, items: [] };
  }

  const leads = callList(db, opts.top ?? 10, target);
  const items: PrepItem[] = [];
  for (const lead of leads) {
    const opener = callOpener(lead, sender);

    let seo: PrepItem["seo"] = { ok: false, note: "No website on file." };
    if (lead.website) {
      try {
        const record: SeoAuditRecord = await runSeoAuditFn(lead, { root: opts.root });
        seo = { ok: record.ok, note: record.ok ? `Refreshed -- top: ${record.topFindings.map((f) => f.title).slice(0, 2).join("; ") || "no findings"}` : record.error ?? "Audit reported no result." };
      } catch (err) {
        seo = { ok: false, note: `Skipped: ${(err as Error).message}` };
      }
    }

    let preview: PrepItem["preview"] = { ok: false, note: "Not attempted." };
    const blocker = previewBlocker(lead);
    if (blocker) {
      preview = { ok: false, note: `Skipped: ${blocker}` };
    } else {
      try {
        const result = await generatePreviewFn(db, lead.id, { root: opts.root, draftsRoot: opts.draftsRoot, by: opts.by, now });
        preview = { ok: true, note: `Built locally (never deployed): ${result.dir}`, dir: result.dir };
      } catch (err) {
        preview = { ok: false, note: `Skipped: ${(err as Error).message}` };
      }
    }

    let script: PrepItem["script"] = { ok: false, note: "Not attempted." };
    try {
      const generated = await generateCallScript(db, lead, { root: opts.root, now, complete: opts.complete });
      script = { ok: true, note: "Generated.", script: generated };
    } catch (err) {
      script = { ok: false, note: `Skipped: ${(err as Error).message}` };
    }

    items.push({ lead, opener, seo, preview, script });
  }

  return { date, generatedAt: now.toISOString(), callWindow: window, items };
}

export function renderMorningPack(pack: PrepPack): string {
  if (!pack.items.length && !pack.callWindow.open) {
    return [`# Morning pack -- ${pack.date}`, "", `No calls tomorrow: ${pack.callWindow.why}.`, "", `Generated ${pack.generatedAt}.`].join("\n");
  }
  const lines = [
    `# Morning pack -- ${pack.date}`,
    "",
    `Calling hours: ${pack.callWindow.why}. ${pack.items.length} lead(s) prepped.`,
    "",
  ];
  for (const [i, item] of pack.items.entries()) {
    const l = item.lead;
    lines.push(
      `## ${i + 1}. #${l.id} ${l.name || "(name expired: refresh)"} · ${l.vertical} · ${l.area}${l.phone ? ` · ${l.phone}` : ""}`,
      "",
      `**Opener:** ${item.opener}`,
      "",
      `**SEO:** ${item.seo.note}`,
      `**Local preview:** ${item.preview.note}`,
      `**Call script:** ${item.script.note}`,
    );
    if (item.script.ok && item.script.script) {
      const s = item.script.script;
      lines.push(
        "",
        `- Discovery: ${s.discovery.join(" | ")}`,
        `- Value pitch: ${s.valuePitch}`,
        `- Close: ${s.close}`,
      );
    }
    lines.push("");
  }
  lines.push("Draft opener/scripts only -- founder reads and adapts before every call. Previews stay local until deployed by hand.");
  return lines.join("\n");
}

export function writeMorningPack(root: string, pack: PrepPack): string {
  const dir = prepDir(root, pack.date);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.md");
  writeFileSync(file, renderMorningPack(pack));
  return file;
}
