// The Coding page's "Mark superseded" offer (2 Oct 2026): where the job's files have newer commits the reason is
// prefilled; a paused job without a hint still gets a quiet way to mark it; a closed job reads Superseded, never Needs you.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SupersedeControl } from "../../src/components/coding/supersede-control";
import { jobLabel, type JobView } from "../../src/lib/coding-client";
import { needsYou } from "../../src/components/coding/needs-you";

const view = (job: Record<string, unknown>, hint: JobView["supersedeHint"] = null) => ({ job, supersedeHint: hint, receipts: [], approvals: [], handoff: null, events: [], liveRoles: [], specDigest: "x" }) as unknown as JobView;
const html = (v: JobView) => renderToStaticMarkup(<SupersedeControl view={v} busy={false} onSupersede={async () => undefined} />);

describe("Mark superseded (synthetic)", () => {
  test("a paused job whose files have newer commits is told so and offered the button, with the reason ready", () => {
    const out = html(view({ state: "needs_owner" }, { ref: "6193bcf", commits: 2, reason: "2 newer commits on main already change the files this job was about" }));
    expect(out).toContain("Newer work may already cover this");
    expect(out).toContain("2 newer commits on main already change the files this job was about.");
    expect(out).toContain("Mark superseded");
  });
  test("a paused job with no hint gets only a quiet text button; a running, finished or already-closed job gets nothing", () => {
    expect(html(view({ state: "interrupted" }))).toContain("Mark superseded");
    expect(html(view({ state: "interrupted" }))).not.toContain("Newer work");
    for (const state of ["building", "completed", "cancelled", "awaiting_confirmation"]) expect(html(view({ state }))).toBe("");
    expect(html(view({ state: "cancelled", supersededBy: { ref: "abc1234" } }))).toBe("");
  });
  test("a superseded job reads Superseded and never waits on you", () => {
    const job = { state: "cancelled", runs: [], supersededBy: { ref: "abc1234", reason: "landed", at: "2026-10-02T00:00:00.000Z", by: "usman" } } as never;
    expect(jobLabel(job)).toEqual({ label: "Superseded", tone: "neutral" });
    expect(needsYou(job)).toBe(false);
    expect(jobLabel({ state: "needs_owner" } as never).label).toBe("Needs you");
  });
});
