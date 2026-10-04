import { Halt, WORKFLOW_LABEL, cut, csvCell, gate, haltResult, makeProgress, mustCall, note, parseJson, slug, type WorkflowIO, type WorkflowResult } from "./common";

/**
 * Business preparation: a comparison table or a draft proposal, made from SYNTHETIC information (nothing here is a real client, price or quote), kept
 * as an artifact that opens from the OS and also written into the computer's own working folder.
 *
 *   1 gather   the information: what the request supplied, or the built-in synthetic sample (named as synthetic everywhere it appears)
 *   2 draft    the table and the proposal's sections; every figure is COMPUTED here from the information (a model never does the arithmetic),
 *              a model may only write the short framing paragraphs, from the information alone
 *   3 check    every figure in the draft is recomputed from the information and compared; a mismatch ends the work instead of being saved
 *   4 save     the draft is written to the computer's working folder and read back
 *   5 return   the artifact on the hub and one result entry in the conversation
 *
 * It sends, quotes and publishes nothing: a "proposal" here is a draft for a person to read.
 */

export const BIZPREP_EXECUTOR = "bizprep";
export const BIZPREP_STEPS = ["gather", "draft", "check", "save on the computer", "return result"] as const;
const GST = 0.1;

export type Option = { name: string; priceCents: number; billing: "once" | "monthly"; features: Record<string, string> };
export type SyntheticInfo = { client: string; business: string; need: string; options: Option[]; criteria: string[] };

export const SYNTHETIC_INFO: SyntheticInfo = {
  client: "Harbour Street Clinic (synthetic client, not a real business)",
  business: "a small local clinic",
  need: "a simple website that lets patients find opening hours and book a visit",
  criteria: ["Pages", "Booking form", "Edits per month", "Support"],
  options: [
    { name: "Starter", priceCents: 69_000, billing: "once", features: { Pages: "3", "Booking form": "No (phone link)", "Edits per month": "0", Support: "Email" } },
    { name: "Standard", priceCents: 109_000, billing: "once", features: { Pages: "6", "Booking form": "Yes", "Edits per month": "2", Support: "Email and phone" } },
    { name: "Plus", priceCents: 199_000, billing: "once", features: { Pages: "10", "Booking form": "Yes, with reminders", "Edits per month": "5", Support: "Priority" } },
  ],
};

export type BizParams = { kind: "comparison" | "proposal"; brief: string; info?: unknown };

/** A request's own information, validated and bounded, or null (then the synthetic sample is used). Pure. */
export function readInfo(raw: unknown): SyntheticInfo | null {
  const o = raw as Partial<SyntheticInfo> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.options) || o.options.length < 2 || o.options.length > 5) return null;
  const options: Option[] = [];
  for (const x of o.options) {
    const p = x as Partial<Option>;
    if (typeof p.name !== "string" || !p.name.trim() || !Number.isInteger(p.priceCents) || (p.priceCents as number) < 0 || (p.priceCents as number) > 100_000_000) return null;
    const features: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.features ?? {}).slice(0, 8)) if (typeof v === "string") features[cut(k, 30)] = cut(v, 60);
    options.push({ name: cut(p.name.trim(), 30), priceCents: p.priceCents as number, billing: p.billing === "monthly" ? "monthly" : "once", features });
  }
  const criteria = [...new Set(options.flatMap((p) => Object.keys(p.features)))].slice(0, 8);
  return { client: cut(String(o.client ?? "A synthetic client"), 80), business: cut(String(o.business ?? "a small business"), 60), need: cut(String(o.need ?? "a business need"), 160), options, criteria };
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const gstCents = (cents: number) => Math.round(cents * GST);
export const incGstCents = (cents: number) => cents + gstCents(cents);

/** The comparison table and the figures it rests on. Pure; every figure comes from `info`. */
export function buildTable(info: SyntheticInfo): { markdown: string; csv: string; figures: { name: string; exGst: number; gst: number; incGst: number }[] } {
  const figures = info.options.map((o) => ({ name: o.name, exGst: o.priceCents, gst: gstCents(o.priceCents), incGst: incGstCents(o.priceCents) }));
  const head = ["", ...info.options.map((o) => o.name)];
  const rows: string[][] = [
    ["Price (ex GST)", ...figures.map((f, i) => `${dollars(f.exGst)}${info.options[i].billing === "monthly" ? " / month" : ""}`)],
    ["GST (10%)", ...figures.map((f) => dollars(f.gst))],
    ["Price (inc GST)", ...figures.map((f) => dollars(f.incGst))],
    ...info.criteria.map((c) => [c, ...info.options.map((o) => o.features[c] ?? "-")]),
  ];
  const md = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c, i) => (i === 0 ? `**${c}**` : c)).join(" | ")} |`)].join("\n");
  const csv = [[...head], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return { markdown: md, csv, figures };
}

/** Which option best fits is a judgement for a person; the draft says what each is best for from the table alone. Pure. */
export function fitLines(info: SyntheticInfo): string[] {
  const sorted = [...info.options].sort((a, b) => a.priceCents - b.priceCents);
  const cheapest = sorted[0];
  const dearest = sorted[sorted.length - 1];
  const lines = [`- **${cheapest.name}** is the lowest cost at ${dollars(cheapest.priceCents)} ex GST (${dollars(incGstCents(cheapest.priceCents))} inc GST).`];
  if (sorted.length > 2) lines.push(`- **${sorted[1].name}** sits in the middle at ${dollars(sorted[1].priceCents)} ex GST.`);
  lines.push(`- **${dearest.name}** is the most complete at ${dollars(dearest.priceCents)} ex GST (${dollars(incGstCents(dearest.priceCents))} inc GST).`);
  return lines;
}

/** Recompute every dollar figure in the draft from the information and compare. Returns the problems (empty = every figure matches). Pure. */
export function checkFigures(markdown: string, info: SyntheticInfo): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>();
  for (const o of info.options) for (const c of [o.priceCents, gstCents(o.priceCents), incGstCents(o.priceCents)]) allowed.add(dollars(c));
  for (const m of markdown.matchAll(/\$\d[\d,]*(?:\.\d{2})?/g)) if (!allowed.has(m[0])) problems.push(`${m[0]} is not a figure that follows from the information`);
  for (const o of info.options) {
    for (const c of [o.priceCents, gstCents(o.priceCents), incGstCents(o.priceCents)]) if (!markdown.includes(dollars(c))) problems.push(`${o.name}: ${dollars(c)} is missing from the draft`);
    if (gstCents(o.priceCents) + o.priceCents !== incGstCents(o.priceCents)) problems.push(`${o.name}: ex GST plus GST does not equal inc GST`);
  }
  return [...new Set(problems)];
}

export async function runBizprep(input: { params: BizParams; io: WorkflowIO }): Promise<WorkflowResult> {
  const { io } = input;
  const clock = io.now ?? Date.now;
  const t0 = clock();
  const mark = makeProgress(io, "bizprep", BIZPREP_STEPS);
  const kind = input.params.kind === "proposal" ? "proposal" : "comparison";
  const brief = input.params.brief.replace(/\s+/g, " ").trim().slice(0, 400);
  try {
    // 1 gather
    mark(0, "started", "Collecting the information for the draft");
    const own = readInfo(input.params.info);
    const info = own ?? SYNTHETIC_INFO;
    mark(0, "done", own ? `Using the ${info.options.length} options the request gave` : `Using the built-in synthetic sample: ${info.options.length} website packages for "${info.client}"`);

    // 2 draft
    await gate(io);
    mark(1, "started", `Drafting the ${kind}`);
    const table = buildTable(info);
    let framing = `This ${kind === "proposal" ? "draft proposal" : "comparison"} is built from synthetic information for practice: ${info.client} needs ${info.need}. Three packages are compared on price and what they include.`;
    if (io.delegate) {
      await gate(io);
      const r = await io.delegate({ system: "You write ONE short framing paragraph (at most 60 words, plain text, no numbers, no dollar amounts, no promises) for a draft business document, using only the information given. Reply with the paragraph and nothing else.", user: `Document: ${kind}\nRequest: ${brief}\nClient (synthetic): ${info.client}\nBusiness: ${info.business}\nNeed: ${info.need}\nOptions: ${info.options.map((o) => o.name).join(", ")}`, maxTokens: 220, label: "framing" }, io.signal).catch(() => null);
      const t = r?.text.trim().replace(/\s+/g, " ") ?? "";
      if (t.length >= 30 && t.length <= 600 && !/\d|\$/.test(t) && !/^[{[]/.test(t)) framing = t;
    }
    const title = kind === "proposal" ? `Draft proposal: ${cut(info.need, 60)}` : `Comparison: ${info.options.map((o) => o.name).join(" / ")}`;
    const body =
      kind === "proposal"
        ? [
            `# ${title}`,
            "",
            `**Synthetic information, for practice. Not a real client, price or offer. A draft for a person to read: nothing was sent.**`,
            "",
            "## Summary",
            framing,
            "",
            "## Options compared",
            table.markdown,
            "",
            "## Where each option fits",
            ...fitLines(info),
            "",
            "## Proposed next steps (for a person to decide)",
            "1. Confirm which option fits the need.",
            "2. Confirm the scope and what is out of scope.",
            "3. Confirm the price and GST treatment before anything is quoted.",
            "",
            "## Assumptions",
            "- Prices are synthetic, in Australian dollars; GST is 10% of the ex-GST price.",
            "- The features listed are the only ones included.",
            `- Request: ${brief || "(none)"}`,
          ].join("\n")
        : [`# ${title}`, "", "**Synthetic information, for practice. Not a real client or price.**", "", framing, "", table.markdown, "", "## Where each option fits", ...fitLines(info)].join("\n");
    mark(1, "done", `${kind === "proposal" ? "Proposal" : "Comparison"} drafted: ${info.options.length} options, ${info.criteria.length + 3} rows`);

    // 3 check
    mark(2, "started", "Recomputing every figure from the information");
    const problems = checkFigures(body, info);
    if (problems.length) {
      mark(2, "failed", `${problems.length} figure${problems.length === 1 ? "" : "s"} did not match: ${problems[0]}`);
      throw new Halt("failed", `The draft was not saved: ${problems[0]}.`);
    }
    mark(2, "done", `Every dollar figure (${info.options.length * 3}) matches the information; GST is 10% and each total adds up`);

    // 4 save on the computer
    const file = `${kind}-${slug(info.options.map((o) => o.name).join("-"), 24) || "draft"}.md`;
    mark(3, "started", `Writing ${file} in the computer's working folder`);
    const saved = await mustCall(io, "file.write", { name: file, text: body }, `save ${file}`);
    if (saved.verified !== true) throw new Halt("failed", `${file} could not be read back from the computer.`);
    mark(3, "done", `${file} written and read back`);

    // 5 return
    await gate(io);
    mark(4, "started", "Keeping the result and returning it to the conversation");
    const summary = `${kind === "proposal" ? "Draft proposal" : "Comparison table"} of ${info.options.length} synthetic options (${info.options.map((o) => `${o.name} ${dollars(o.priceCents)}`).join(", ")} ex GST), every figure recomputed and matched.`;
    const saveRes = io.artifact({
      kind: "bizprep", title: cut(title, 100), summary, outcome: "complete", main: `${kind}.md`,
      files: [
        { name: `${kind}.md`, data: body },
        { name: "comparison.csv", data: table.csv },
        { name: "data.json", data: JSON.stringify({ synthetic: true, info, figures: table.figures }, null, 2) },
      ],
    });
    const back = await io.deliver(`${WORKFLOW_LABEL.bizprep}: ${cut(title, 90)}\n${summary}\nAll information is synthetic. Nothing was sent. A copy is in the computer's working folder as ${file}.`, { artifact: saveRes.ok ? saveRes.title : null, label: WORKFLOW_LABEL.bizprep, web: false }).catch(() => ({ delivered: false, where: "delivery failed" }));
    mark(4, saveRes.ok ? "done" : "failed", saveRes.ok ? `Saved result kept${back.delivered ? " and returned to your conversation" : ` (${back.where})`}` : `The result could not be kept on the hub (${saveRes.reason})`);
    note(io, "bizprep", `business preparation ${saveRes.ok ? "complete" : "partial"}: ${kind} of ${info.options.length} options in ${Math.round((clock() - t0) / 1000)} s`, saveRes.ok ? "ok" : "unknown");
    const wallMs = clock() - t0;
    return saveRes.ok
      ? { ok: true, outcome: "complete", note: `${kind === "proposal" ? "Draft proposal" : "Comparison"} ready and saved (${info.options.length} synthetic options, figures verified).`, wallMs }
      : { ok: true, outcome: "partial", note: `The ${kind} was made and saved on the computer as ${file}, but the hub could not keep it (${saveRes.reason}).`, wallMs };
  } catch (e) {
    return haltResult(e, t0, clock);
  }
}
export { parseJson as _parseJson };
