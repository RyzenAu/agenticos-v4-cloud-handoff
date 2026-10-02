// One default for a dental lead, whether the request comes from its drawer, Jarvis or Hermes.
// A fresh Claude design remains available only when the caller explicitly requests bespoke.
import type { Database } from "bun:sqlite";
import { findLead } from "../leads/crm";
import { generatePreview } from "../lead-sites/generate";
import { draftSite } from "./generate";
import { draftSiteV2, type DraftV2Options } from "./orchestrator";

export type DraftMode = "flagship" | "bespoke";
type Builders = { flagship: typeof generatePreview; bespoke: typeof draftSiteV2; fast: typeof draftSite };

export function draftMode(vertical: string, mode?: DraftMode): DraftMode {
  return mode ?? (vertical === "dental" ? "flagship" : "bespoke");
}

export async function draftForLead(db: Database, ref: string | number,
  opts: { root: string; draftsRoot: string; by: string; mode?: DraftMode; fast?: boolean; buildOptions?: DraftV2Options["buildOptions"] },
  builders: Builders = { flagship: generatePreview, bespoke: draftSiteV2, fast: draftSite }) {
  const lead = findLead(db, ref);
  if (!lead) throw new Error("Lead not found.");
  if (draftMode(lead.vertical, opts.mode) === "flagship")
    return { kind: "flagship" as const, result: await builders.flagship(db, lead.id, opts) };
  if (opts.fast) return { kind: "fast" as const, result: await builders.fast(db, lead.id, opts) };
  return { kind: "bespoke" as const, result: await builders.bespoke(db, lead.id, opts) };
}
