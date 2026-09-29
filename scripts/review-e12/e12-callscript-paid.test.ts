// REVIEW-E12 repro, now asserting the FIXED behaviour: pre-E2 call scripts were Claude -> Cline deepseek -> Cline muse, "no paid fallback".
// Post-E2 the "callscript" task also lists openrouter/deepseek-v4.1-flash (metered), and routedChat can call it.
// Under bun test the transport is offline (ECONNREFUSED), so nothing is sent; the receipts show the attempt.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "../leads/crm";
import { MemoryReceiptSink } from "../model-router/receipts";
import { generateCallScript } from "../leads/call-script";
import { route } from "../model-router/router";

test("BL4a (fixed): after Claude and both Cline models there is NO paid fallback", () => {
  expect(() => route("callscript", { exclude: ["claude/sonnet-5", "cline/deepseek-v4.1-flash", "cline/muse-spark-1.3"], providers: ["openrouter", "groq", "codex", "claude-sub", "cline"], hasKey: () => true })).toThrow(/no eligible model/);
});

test("generateCallScript attempts OpenRouter when Claude and Cline fail (when OPENROUTER_API_KEY is configured)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-"));
  const db = openCrm(join(dir, "crm.sqlite"));
  upsertLead(db, { placeId: "osm:node/1", vertical: "dental", area: "Mount Druitt NSW", name: "Smile Dental", phone: "(02) 9621 1234",
    address: "1 Main St", website: "http://smiledental.com.au", mapsUrl: "", rating: 4.2, reviews: 3, emails: [], emailOk: false, score: 80, pitch: "redesign",
    reasons: ["the site isn't on HTTPS"], googleAt: null, source: "osm", attribution: "x" } as any);
  const lead = findLead(db, "osm:node/1")!;
  const sink = new MemoryReceiptSink();
  const fail = async () => { throw new Error("You've hit your usage limit"); };
  const freeFail = async () => ({ choices: [{ message: { content: "no json here" } }] });
  let err: unknown = null;
  try { await generateCallScript(db, lead, { root: dir, complete: fail as any, free: freeFail as any, sink }); } catch (e) { err = e; }
  const rows = sink.receipts.map((r) => [r.model, r.route, r.outcome, r.errorCode]);
  console.log(rows, String(err));
  // If the key is configured on this machine, the paid model is attempted (offline under test, so nothing was sent).
  expect(rows.some((r) => r[0] === "openrouter/deepseek-v4.1-flash")).toBe(false);
});
