/**
 * Pure helpers for scripts/memory/t6-verify-live.ts (REVIEW-T6 "Post-deploy live verification"), kept
 * apart so the tests can check them without running a verification:
 *
 *   - runFacts:       each run's test facts, worded so no two runs can ever look like a contradiction
 *                     (derived.ts likelyConflict: token Jaccard >= 0.5);
 *   - sessionCheck:   is the script's session a CONFIRMED human one (/__devices/me)? If not, every forget
 *                     it asked for would be a program's request, and each one texts the owner a code;
 *   - findLeftovers:  "T6 live check" items or zz-t6 notes from an earlier run (the preflight);
 *   - cleanupOutcome: what a clean-up forget really did (a 202 is "needs approval", never "removed").
 */

/** Every test item carries this label, then the run id. The preflight looks for it. */
export const TAG_PREFIX = "T6 live check";
/** Test notes are written as wiki/topics/general/zz-t6-<what>-<run>.md. */
export const NOTE_PREFIX = "zz-t6-";

// Word pools for the parts of a fact that aren't bound to the run id. Plain, distinct words (no stopwords,
// none a plural of another), so a fact reads like a fact to Hindsight's extraction model.
const NAMES = ["Ashcombe", "Birchall", "Carrow", "Dunmore", "Elsworth", "Fairleigh", "Glenrock", "Harwell", "Inverly", "Jarrah", "Kestrel", "Larkfield", "Marlow", "Norbury", "Oakhurst", "Pellow", "Quenby", "Redcliff", "Sallow", "Tarrant", "Umber", "Vantage", "Wexcombe", "Yarrow"];
const STREETS = ["Acacia", "Bellbird", "Cobalt", "Driftwood", "Emberly", "Fernhill", "Granite", "Heather", "Ironbark", "Juniper", "Kingfisher", "Lantern", "Mulberry", "Nightjar", "Orchard", "Pebble", "Quarry", "Riverstone", "Saltbush", "Thistle", "Wattle", "Willowmere", "Yellowbox", "Zircon"];
const SUBURBS = ["Aldhaven", "Brookvale", "Coralind", "Dawesly", "Eastmere", "Foxleigh", "Greyridge", "Hollins", "Ivelwood", "Kurrawa", "Lowmead", "Moorcliff", "Northcote", "Ormiston", "Pinegrove", "Ravensby", "Stanmere", "Tallowood", "Upwey", "Westbury"];
const PLACES = ["bakery", "clinic", "depot", "gallery", "library", "museum", "nursery", "pharmacy", "studio", "workshop", "laundromat", "bookshop", "florist", "garage", "kiosk", "pottery", "tailor", "surgery", "dispensary", "cannery"];

export type RunFacts = {
  /** Saved through /remember. */
  fact: string;
  /** The correction of `fact` (/correct): the same place, an hour later. */
  fixed: string;
  /** Asks about the place (Hindsight recall). */
  question: string;
  /** The place's run-bound name (the recall checks look for it). */
  name: string;
};

/**
 * One run's facts. `pick(n)` returns an integer in [0, n) (crypto in the script, seeded in tests).
 *
 * Why two runs can never collide: tokenised (derived.ts tokenize), a fact has 11 tokens. Four of them contain
 * the run id (the id itself, and the place's name, street and suburb glued to it), so they differ between runs.
 * Five are fixed (t6, live, check, synthetic, open) and two are drawn (the kind of place, the minutes of the
 * time). Even if both drawn words match, two runs share 7 tokens of a 15-token union: Jaccard 0.47, below
 * likelyConflict's 0.5. Usually they share only the 5 fixed ones (0.29). The correction (`fixed`) has the same
 * shape (only the hour differs), so the same bound holds for any pair of texts from two runs.
 */
export function runFacts(run: string, pick: (n: number) => number): RunFacts {
  if (!/^[0-9a-f]{6,}$/.test(run)) throw new Error("run id must be lowercase hex");
  const name = `${NAMES[pick(NAMES.length)]}${run}`;
  const street = `${STREETS[pick(STREETS.length)]}${run}`;
  const suburb = `${SUBURBS[pick(SUBURBS.length)]}${run}`;
  const kind = PLACES[pick(PLACES.length)];
  const hour = 6 + pick(3); // 6..8, so the correction (an hour later) stays a single digit: one token either way
  const minute = 5 * (1 + pick(11)); // 05..55, never :00 (a lone "am" token)
  const time = `${hour}:${String(minute).padStart(2, "0")}am`;
  // The correction moves the time by one hour: the same token shape, so the bound above holds for it too.
  const later = `${hour + 1}:${String(minute).padStart(2, "0")}am`;
  const tag = `${TAG_PREFIX} ${run}`;
  const place = `synthetic ${name} ${kind} on ${street} in ${suburb}`;
  return {
    fact: `${tag}: the ${place} opens at ${time}.`,
    fixed: `${tag}: the ${place} opens at ${later}.`,
    question: `When does the synthetic ${name} ${kind} on ${street} open?`,
    name,
  };
}

/** A uniform integer in [0, n) from crypto (the script's `pick`). */
export function cryptoPick(randomBytes: (n: number) => Uint8Array): (n: number) => number {
  return (n: number) => {
    if (!Number.isInteger(n) || n <= 0 || n > 65536) throw new Error("bad range");
    const limit = 65536 - (65536 % n);
    for (;;) {
      const b = randomBytes(2);
      const v = (b[0] << 8) | b[1];
      if (v < limit) return v % n;
    }
  };
}

export type SessionCheck = {
  /** A confirmed person's browser session: its forgets are the person's own requests (the card's button). */
  human: boolean;
  actor: "human" | "process" | null;
  /** The hub session a navigation minted is still waiting to be confirmed (AUDIT-A1-3 / S1). */
  pending: boolean | null;
  reason: string;
};

/**
 * Reads GET /__devices/me (the OS's own view of this request: B1's principal with its actor, and whether the
 * hub session is pending). Anything missing or unexpected counts as NOT human: the safe answer, since a
 * forget from a program's session sends the owner a real Telegram code.
 */
export function sessionCheck(status: number, body: any): SessionCheck {
  const actor = body?.principal?.actor === "human" || body?.principal?.actor === "process" ? (body.principal.actor as "human" | "process") : null;
  const pending = typeof body?.hubSession?.pending === "boolean" ? (body.hubSession.pending as boolean) : null;
  if (status !== 200 || !body || typeof body !== "object")
    return { human: false, actor: null, pending: null, reason: `the OS didn't say who this session is (/__devices/me answered ${status})` };
  if (actor === "human" && pending !== true) return { human: true, actor, pending, reason: "a confirmed human session: its forgets are its own requests, approved with the page's button" };
  if (pending === true)
    return {
      human: false,
      actor,
      pending,
      reason:
        "this script's browser session was minted by a page load and nobody has confirmed it (S1), so the OS treats it as a program. A program's forget needs a person's approval and texts the owner a Telegram code, so the forget checks are skipped",
    };
  return { human: false, actor, pending, reason: `the OS treats this session as ${actor ?? "unknown"}, not a confirmed person, so the forget checks are skipped (a program's forget would text the owner a Telegram code)` };
}

export type Leftover = { id: string; kind: string; status: string; path?: string };

/**
 * Items from an earlier run: a row whose text or title carries the "T6 live check" label, or a row / a file
 * for a zz-t6 test note. Rows come from GET /__memory/items?superseded=1 (every row, superseded included).
 */
export function findLeftovers(rows: any[], vaultFiles: string[] = []): Leftover[] {
  const out: Leftover[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const path = typeof r?.source?.path === "string" ? r.source.path : undefined;
    const tagged = [r?.text, r?.title].some((v) => typeof v === "string" && v.includes(TAG_PREFIX));
    const note = !!path && path.split("/").pop()!.startsWith(NOTE_PREFIX);
    if (!tagged && !note) continue;
    const id = String(r?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: String(r?.kind ?? "?"), status: String(r?.status ?? "?"), ...(path ? { path } : {}) });
  }
  for (const f of vaultFiles) if (!out.some((l) => l.path === f)) out.push({ id: f, kind: "file", status: "in the vault", path: f });
  return out;
}

export type CleanupOutcome = { target: string; state: "removed" | "needs-approval" | "failed"; detail: string; approval_id?: string };

/**
 * What one clean-up forget really did. 200 = removed. 202 = the OS is waiting for a person's approval,
 * which is NOT removed, whatever the message says. `asked: false` = the script didn't ask at all (a
 * program's session: asking would text the owner), so a person has to forget it.
 */
export function cleanupOutcome(target: string, f: { asked: boolean; ask?: { status: number; body?: any } | null; done?: { status: number; body?: any } | null } | null): CleanupOutcome {
  if (!f) return { target, state: "failed", detail: "the request itself failed" };
  if (!f.asked)
    return { target, state: "needs-approval", detail: "not asked: this session isn't a confirmed person, so a person must forget it on the Memory page (the script never asks for approval from a program's session)" };
  if (f.done?.status === 200) return { target, state: "removed", detail: String(f.done.body?.message ?? "removed").slice(0, 200) };
  const approval = f.ask?.body?.approval?.id;
  if (f.ask?.status === 202)
    return {
      target,
      state: "needs-approval",
      detail: `still there: the OS answered 202 (approval required${f.ask.body?.approval?.requested_actor ? `, asked by a ${f.ask.body.approval.requested_actor}` : ""}) and it wasn't approved here`,
      ...(approval ? { approval_id: String(approval) } : {}),
    };
  if (f.ask?.status === 422 && f.ask.body?.code === "not-found") return { target, state: "removed", detail: "already gone (not found)" };
  return { target, state: "failed", detail: `forget answered ${f.done?.status ?? f.ask?.status ?? "nothing"}: ${String(f.done?.body?.message ?? f.ask?.body?.message ?? f.ask?.body?.error ?? "").slice(0, 160)}` };
}
