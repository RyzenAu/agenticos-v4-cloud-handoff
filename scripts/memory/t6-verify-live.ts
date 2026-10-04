/**
 * Track 6 extended LIVE verification of shared memory, through the live OS on 127.0.0.1:8081 as the
 * owner's browser at this PC (a navigation mints the browser session; every POST carries the page token).
 *
 * Everything it writes is tagged synthetic test data ("T6 live check <run>") and removed again:
 *   A · memory:  save → model receipt → sourced recall → correction (old version leaves Hindsight)
 *                → forget kind b (approval in the owner's own session)
 *   B · note:    a test note in the real vault: create → indexed → edit → rename (same id)
 *                → forget kind a (unindex; file stays) → re-include → delete the file (retracted)
 *   C · note:    a second test note: forget kind c of one section (vault edited, Hindsight re-indexed
 *                without it) → forget kind c of the whole note (file deleted, document gone)
 * It checks the pilot proxy's document store (read-only GETs) at every step, and the proxy's
 * document-delete budget (20 an hour) before it starts. It prints PASS/FAIL/SKIP per line and writes the
 * observed outputs (synthetic lines only; no keys, no other memory content) as JSON.
 *
 * Since S1 (AUDIT-A1-3) the session a page load mints stays PENDING until the owner confirms it, and the OS
 * treats a pending session as a program. A program's forget needs a person's approval and texts the owner a
 * Telegram code (REVIEW-T6 "Post-deploy live verification"). So, before anything is written:
 *   - setup asks the OS who this session is (GET /__devices/me). Not a confirmed person → part A (a saved
 *     memory can only be removed by an approved forget) and the forget kind c checks are SKIPPED with that
 *     reason; part C's note is removed by deleting its file instead. The script never sends a forget that
 *     would need a program's approval, so it never texts the owner.
 *   - preflight looks for "T6 live check" items or zz-t6 notes from an earlier run and stops, listing them.
 * Each run's facts are worded so they can't look like a contradiction of another run's (t6-verify-lib.ts).
 * Clean-up reports what really happened: a forget answered 202 is "needs approval", never "removed", and
 * anything left over goes into the JSON (`leftovers`) so a person can remove it.
 *
 *   bun --no-env-file scripts/memory/t6-verify-live.ts --live [--out <file.json>]      (the live OS; --live is required)
 *   bun --no-env-file scripts/memory/t6-verify-live.ts --os-port 8098 --proxy-port 8883 --bank syn-x --vault <copy> --proxy-log <log>
 *        [--poll-ms 3000] [--max-wait-ms <cap on every wait>]   (a synthetic copy; the tests poll faster)
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupOutcome, cryptoPick, findLeftovers, NOTE_PREFIX, runFacts, sessionCheck, TAG_PREFIX, type CleanupOutcome, type Leftover, type SessionCheck } from "./t6-verify-lib";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OS_PORT = Number(arg("os-port", "8081"));
const PROXY_PORT = Number(arg("proxy-port", "8878"));
const BANK = arg("bank", "mu-shared");
const VAULT = arg("vault", join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki"));
const PROXY_LOG = arg("proxy-log", "D:\\hindsight\\service\\run\\pilot\\proxy.jsonl");
const OUT = arg("out", "");
const POLL = Math.max(20, Number(arg("poll-ms", "3000")) || 3000);
const MAX_WAIT = Number(arg("max-wait-ms", "0")) || Infinity;
// Production needs an explicit --live (REVIEW-T6 finding 8): one mistyped command must never write the real
// shared pool or the real vault.
const TOUCHES_LIVE = OS_PORT === 8081 || PROXY_PORT === 8878 || PROXY_PORT === 8888 || BANK === "mu-shared" || VAULT === join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki");
if (TOUCHES_LIVE && !process.argv.includes("--live")) {
  console.error("Refusing: this targets the LIVE OS / pilot / shared pool / the real vault. Add --live to run it there on purpose, or point it at a synthetic copy (--os-port, --proxy-port, --bank syn-..., --vault).");
  process.exit(2);
}
const RUN = randomBytes(3).toString("hex");
const TAG = `${TAG_PREFIX} ${RUN}`;
const REL_DIR = "wiki/topics/general";
const noteA = `${REL_DIR}/${NOTE_PREFIX}sync-check-${RUN}.md`;
const noteA2 = `${REL_DIR}/${NOTE_PREFIX}sync-check-${RUN}-renamed.md`;
const noteB = `${REL_DIR}/${NOTE_PREFIX}forget-check-${RUN}.md`;
const abs = (rel: string) => join(VAULT, ...rel.split("/"));

type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
/** One HTTP call; an idempotent GET is tried once more if the connection is reset (seen on the live OS mid-drain). */
async function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  try {
    return await raw1(url, init);
  } catch (e) {
    if ((init.method ?? "GET") !== "GET" || !/ECONNRESET|socket hang up/i.test((e as Error).message)) throw e;
    resets.push({ at: new Date().toISOString(), url: new URL(url).pathname });
    await sleep(2000);
    return raw1(url, init);
  }
}
const resets: { at: string; url: string }[] = [];
function raw1(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const u = new URL(url);
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json" } : {}), ...init.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* html or empty */
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.setTimeout(300_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OS = `http://127.0.0.1:${OS_PORT}`;
const host = { Host: `localhost:${OS_PORT}` };
let session = "";
let token = "";
/** Who this session is, per the OS. Until setup has asked, nobody: no forget is ever sent. */
let who: SessionCheck = { human: false, actor: null, pending: null, reason: "setup hasn't identified the session yet" };
const page = () => ({ ...host, Origin: `http://localhost:${OS_PORT}`, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session } : {}) });
const get = (path: string) => raw(`${OS}/__memory${path}`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } });
const post = (path: string, body: unknown) => raw(`${OS}/__memory${path}`, { method: "POST", headers: { ...page(), "x-claude-os-token": token }, body });
const doc = (id: string) => raw(`http://127.0.0.1:${PROXY_PORT}/v1/default/banks/${BANK}/documents/${encodeURIComponent(id)}`, { headers: { Host: `127.0.0.1:${PROXY_PORT}` } });

type Result = { step: string; ok: boolean; skipped?: true; what: string; observed: unknown };
const results: Result[] = [];
function check(step: string, what: string, ok: boolean, observed?: unknown) {
  results.push({ step, ok, what, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${what}`);
  if (observed !== undefined) console.log(`      ${typeof observed === "string" ? observed : JSON.stringify(observed).slice(0, 600)}`);
  return ok;
}
/** A check that wasn't run, and why. Not a pass and not a failure. */
function skip(step: string, what: string, reason: string) {
  results.push({ step, ok: true, skipped: true, what, observed: reason });
  console.log(`SKIP  [${step}] ${what}`);
  console.log(`      ${reason}`);
}
const model = (p: any) => (p ? `${p.provider}/${p.model} (${p.basis}${p.tokens != null ? `, ${p.tokens} tokens` : ""}${p.fallback_from?.length ? `, fell back from ${p.fallback_from.map((m: any) => `${m.provider}/${m.model}`).join(", ")}` : ""})` : null);
async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean, ms = 300_000, every = POLL): Promise<T> {
  const end = Date.now() + Math.min(ms, MAX_WAIT);
  for (;;) {
    const v = await probe();
    if (done(v) || Date.now() > end) return v;
    await sleep(every);
  }
}
const SLOW = Math.round((POLL * 5) / 3);
const itemOf = async (id: string) => (await get(`/item/${encodeURIComponent(id)}`)).body;
/** Waits for indexed + its model receipt. A receipt that wasn't there at save time is read again at the end
 * of the next drain, so every ~20 s this asks for a sync (the live OS also syncs every minute by itself). */
async function confirmed(id: string) {
  let last = Date.now();
  return until(
    async () => {
      if (Date.now() - last > POLL * 7) (last = Date.now()), await sync();
      return itemOf(id);
    },
    (r) => r?.row?.indexed === "confirmed" && !!r.row.processed_by,
  );
}
const docStatus = (id: string, want: number) => until(async () => (await doc(id)).status, (s) => s === want, 180_000);
/** Best effort: a sync only speeds things up (the live OS syncs every minute by itself). */
async function sync() {
  try {
    return await post("/sync", {});
  } catch (e) {
    resets.push({ at: new Date().toISOString(), url: `/__memory/sync (${(e as Error).message})` });
    return null;
  }
}
async function noteRow(q: string, path: string) {
  const items = (await get(`/items?kind=note&q=${encodeURIComponent(q)}`)).body?.items ?? [];
  return items.find((r: any) => r.source?.path === path) ?? null;
}
const recallHit = async (query: string, id: string) => ((await post("/recall", { query })).body?.facts ?? []).find((f: any) => f.id === id) ?? null;

type Forgot = { asked: boolean; ask: Res | null; grant: Res | null; done: Res | null; note?: string };
/**
 * Forget with approval in the owner's own CONFIRMED session: his own request, approved with the Memory page's
 * card button (a confirm nonce for this browser session), and the server runs the forget itself.
 * From any other session this refuses to ask at all: a program's forget texts the owner a Telegram code.
 */
async function forgetApproved(body: Record<string, unknown>): Promise<Forgot> {
  if (!who.human) return { asked: false, ask: null, grant: null, done: null, note: who.reason };
  const ask = await post("/forget", body);
  const apr = ask.body?.approval?.id;
  if (ask.status !== 202 || !apr) return { asked: true, ask, grant: null, done: ask.status === 200 ? ask : null };
  // Belt and braces: a confirmed session's request is a person's own. If the OS says a program asked, stop here:
  // no grant attempts (they can't succeed and would only add noise); the approval expires by itself.
  if (ask.body?.approval?.requested_actor !== "human") return { asked: true, ask, grant: null, done: null, note: "the OS filed this as a program's request" };
  const card = await post("/approvals/card", { approval_id: apr });
  if (card.status !== 200 || !card.body?.card_nonce) return { asked: true, ask, grant: card, done: null, note: "no approval card for this session" };
  const grant = await post("/approvals/grant", { approval_id: apr, card_nonce: card.body.card_nonce });
  const r = grant.body?.result;
  return { asked: true, ask, grant, done: r ? { status: r.ok ? 200 : 422, body: r, headers: {} } : null };
}

function deletesLastHour() {
  try {
    const cut = Date.now() - 3600_000;
    return readFileSync(PROXY_LOG, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.method === "DELETE" && r.decision === "allow" && Date.parse(r.ts) > cut).length;
  } catch {
    return null;
  }
}

/** Ids of this run's items the index lists (current ones; the search covers text and titles). */
async function runItems(): Promise<string[]> {
  return ((await get(`/items?q=${encodeURIComponent(RUN)}`)).body?.items ?? []).filter((r: any) => String(r.text ?? r.title ?? "").includes(RUN)).map((r: any) => String(r.id));
}

/** zz-t6 test notes already in the vault's test folder (an earlier run's). */
function vaultTestNotes(): string[] {
  try {
    return readdirSync(abs(REL_DIR))
      .filter((f) => f.startsWith(NOTE_PREFIX) && f.endsWith(".md"))
      .map((f) => `${REL_DIR}/${f}`);
  } catch {
    return [];
  }
}

const cleanup = { mems: new Set<string>(), files: new Set<string>() };
let preflightLeftovers: Leftover[] = [];
let cleanupReport: CleanupOutcome[] = [];
let endLeftovers: string[] = [];

async function main() {
  // ── setup ────────────────────────────────────────────────────────────────────────────
  const nav = await raw(`${OS}/memory/vault`, { headers: { ...host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
  session = ([] as string[]).concat((nav.headers["set-cookie"] as string[] | string | undefined) ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mu_session=")) ?? "";
  token = (await raw(`${OS}/__token`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } })).body?.token ?? "";
  if (!check("setup", "a browser session and page token at this PC", !!session && !!token, { session: !!session, token: !!token })) return;
  // Who is this session, per the OS? Read-only; never a code, never a confirm.
  const me = await raw(`${OS}/__devices/me`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } }).catch(() => ({ status: 0, body: null, headers: {} }) as Res);
  who = sessionCheck(me.status, me.body);
  check("setup", `the OS says who this session is: ${who.human ? "a confirmed person" : "not a confirmed person (the forget checks will be skipped)"}`, me.status === 200, { actor: who.actor, pending: who.pending, human: who.human });
  const st0 = (await get("/status")).body;
  const s = st0?.settings ?? {};
  if (!check("setup", "memory is on, this is the one writer, Hindsight through the proxy, no key in the OS", s.mode === "on" && s.writes === true && !s.writer && s.api_key === "missing", { mode: s.mode, writes: s.writes, writer: s.writer ?? null, url: s.hindsight_url, bank: s.bank, api_key: s.api_key, pending: st0?.pending }))
    return;
  const budget = deletesLastHour();
  if (!check("setup", "the proxy's document-delete budget has room (this run uses about 7 of 20 an hour)", budget !== null && budget <= 12, { deletes_last_hour: budget })) return;
  if (!check("setup", "the vault is where the OS reads it", existsSync(join(VAULT, "wiki")), { vault: VAULT })) return;
  const models0: Record<string, number> = { ...(st0.models ?? {}) };

  // ── preflight: nothing from an earlier run may be left ─────────────────────────────────
  // An earlier run's leftover makes this run's checks meaningless (and used to fail "[A save]" as a
  // contradiction), so stop before writing anything and say what to remove.
  const all = await get("/items?superseded=1");
  preflightLeftovers = findLeftovers(all.body?.items ?? [], vaultTestNotes());
  if (
    !check(
      "preflight",
      preflightLeftovers.length
        ? `an earlier run left ${preflightLeftovers.length} "${TAG_PREFIX}" item(s); stopped before saving anything. Remove them (a person, on the Memory page: forget each one; delete any zz-t6 file), then run again`
        : `no "${TAG_PREFIX}" items or zz-t6 notes from an earlier run`,
      all.status === 200 && preflightLeftovers.length === 0,
      all.status === 200 ? { leftovers: preflightLeftovers } : { items_status: all.status },
    )
  )
    return;

  // ── A · memory ───────────────────────────────────────────────────────────────────────
  // Plain facts: Hindsight's extraction model kept nothing from text labelled "(test data, removed by the
  // check)" in the dry run (0 memory units), so the tag is the run id and the word "synthetic". The rest is
  // drawn per run so no two runs' facts look like a contradiction (t6-verify-lib.ts runFacts).
  if (!who.human) {
    const why = `${who.reason}. A saved memory can only be removed by an approved forget, so nothing is saved here (it would be left behind).`;
    for (const [step, what] of [
      ["A save", '"remember" through the live OS'],
      ["A receipt", "confirmed in Hindsight with the model that processed it"],
      ["A recall", "recall answers through Hindsight with its source"],
      ["A correction", "correction saved as a new version; the old one leaves Hindsight"],
      ["A forget b", "forget kind b, approved in the owner's own session"],
    ])
      skip(step, what, why);
  } else {
    const facts = runFacts(RUN, cryptoPick((n) => randomBytes(n)));
    const saved = await post("/remember", { text: facts.fact });
    const mem1: string = saved.body?.memory?.id ?? "";
    if (mem1) cleanup.mems.add(mem1);
    if (!check("A save", '"remember" through the live OS', saved.status === 200 && !!mem1, saved.body?.message)) return;
    const i1 = await confirmed(mem1);
    check("A receipt", "confirmed in Hindsight with the model that processed it (Hindsight's own receipt)", i1?.row?.indexed === "confirmed" && !!i1.row.processed_by, { id: mem1, processed_by: model(i1?.row?.processed_by) });
    check("A save", "the document is in the pilot's shared pool", (await docStatus(mem1, 200)) === 200, { id: mem1 });
    const h1 = await until(() => recallHit(facts.question, mem1), (h) => !!h?.via?.includes("hindsight"), 60_000, SLOW);
    check("A recall", "recall answers through Hindsight with its source", !!h1?.via?.includes("hindsight"), h1 ? { id: h1.id, via: h1.via, source: h1.source } : null);
    const fix = await post("/correct", { id: mem1, text: facts.fixed });
    const mem2: string = fix.body?.id ?? "";
    if (mem2) cleanup.mems.add(mem2);
    check("A correction", "correction saved as a new version", fix.status === 200 && !!mem2, fix.body?.message);
    if (mem2) {
      const i2 = await confirmed(mem2);
      const old = await docStatus(mem1, 404);
      const h2 = await until(() => recallHit(facts.question, mem2), (h) => !!h?.via?.includes("hindsight"), 60_000, SLOW);
      const oldHit = await recallHit(facts.question, mem1);
      check("A correction", "the new version is recalled; the old one left Hindsight and is never recalled", !!h2 && !oldHit && old === 404, { new_id: mem2, processed_by: model(i2?.row?.processed_by), old_document: old });
      const f = await forgetApproved({ kind: "memory", target: mem2 });
      check("A forget b", "forget kind b asks for approval first (the owner's own request)", f.ask?.status === 202 && f.ask.body?.approval?.requested_actor === "human", { message: f.ask?.body?.message, requested_actor: f.ask?.body?.approval?.requested_actor ?? null });
      check("A forget b", "approved in the owner's own session (his own request, the page's button)", f.grant?.status === 200, f.grant?.body ?? f.note);
      const gone = await docStatus(mem2, 404);
      check("A forget b", "deleted from the app and from Hindsight (both versions)", f.done?.status === 200 && gone === 404 && (await doc(mem1)).status === 404, { message: f.done?.body?.message, document: gone });
      if (f.done?.status === 200) (cleanup.mems.delete(mem1), cleanup.mems.delete(mem2));
    }
  }

  // ── B · note: create, edit, rename, unindex/re-include, delete (no approvals anywhere) ──────
  const quokka = `Quokka${RUN}`;
  const bodyA = (hour: string) => `---\ntitle: ${TAG} sync\n---\n# ${TAG} sync\n\nThe synthetic ${quokka} depot opens at ${hour} on weekdays and closes at 5pm.\n`;
  writeFileSync(abs(noteA), bodyA("6am"), "utf8");
  cleanup.files.add(noteA);
  await sync();
  const rowA = await until(() => noteRow(quokka, noteA), (r) => !!r, 120_000, SLOW);
  const idA: string = rowA?.id ?? "";
  if (!check("B create", "a new vault note is picked up by the sync", !!idA, rowA ? { id: idA, path: rowA.source?.path } : null)) return;
  const iA = await confirmed(idA);
  check("B create", "indexed in Hindsight with its model receipt", iA?.row?.indexed === "confirmed" && !!iA.row.processed_by, { id: idA, processed_by: model(iA?.row?.processed_by) });
  const dA = await until(() => doc(idA), (r) => r.status === 200, 120_000);
  check("B create", "the note's document is in the pilot's shared pool", dA.status === 200 && String(dA.body?.original_text ?? "").includes("6am"), { status: dA.status });
  const qA = `When does the synthetic ${quokka} depot open?`;
  const hA = await until(() => recallHit(qA, idA), (h) => !!h?.via?.includes("hindsight"), 90_000, SLOW);
  check("B recall", "recall cites the vault note as the source", !!hA && hA.source?.kind === "vault" && hA.source?.path === noteA, hA ? { via: hA.via, source: hA.source } : null);

  // edit
  const hashBefore = iA?.row?.version_hash;
  writeFileSync(abs(noteA), bodyA("9am"), "utf8");
  await sync();
  const iA2 = await until(() => itemOf(idA), (r) => r?.row?.version_hash && r.row.version_hash !== hashBefore && r.row.indexed === "confirmed" && !!r.row.processed_by);
  const dA2 = await until(() => doc(idA), (r) => String(r.body?.original_text ?? "").includes("9am"), 120_000);
  const hA2 = await until(() => recallHit(qA, idA), (h) => !!h?.text?.includes("9am"), 60_000, SLOW);
  check("B edit", "the Obsidian edit is re-indexed: Hindsight holds the new wording and not the old; recall shows the new", !!hA2 && String(dA2.body?.original_text ?? "").includes("9am") && !String(dA2.body?.original_text ?? "").includes("6am"), {
    same_id: iA2?.row?.id === idA,
    processed_by: model(iA2?.row?.processed_by),
  });

  // rename
  renameSync(abs(noteA), abs(noteA2));
  cleanup.files.delete(noteA);
  cleanup.files.add(noteA2);
  await sync();
  const rowA2 = await until(() => noteRow(quokka, noteA2), (r) => !!r, 120_000, SLOW);
  const iA3 = rowA2 ? await until(() => itemOf(rowA2.id), (r) => r?.row?.indexed === "confirmed", 120_000) : null;
  check("B rename", "a rename keeps the note id and its Hindsight document (new path, no duplicate)", rowA2?.id === idA && iA3?.row?.indexed === "confirmed" && (await doc(idA)).status === 200 && !(await noteRow(quokka, noteA)), {
    id: rowA2?.id,
    path: rowA2?.source?.path,
  });

  // forget kind a (unindex), then re-include: neither needs an approval, from any session
  const un = await post("/forget", { kind: "unindex", target: idA });
  const unDoc = await docStatus(idA, 404);
  check("B forget a", "forget kind a needs no approval: out of Hindsight, the file stays in the vault", un.status === 200 && unDoc === 404 && existsSync(abs(noteA2)), { message: un.body?.message, document: unDoc });
  const re = await post("/reindex", { target: idA });
  const reDoc = await docStatus(idA, 200);
  const iA4 = await confirmed(idA);
  check("B re-include", "re-included: back in Hindsight, with a fresh model receipt", re.status === 200 && reDoc === 200 && iA4?.row?.indexed === "confirmed", { message: re.body?.message, processed_by: model(iA4?.row?.processed_by) });

  // delete the file (as a person would in Obsidian)
  unlinkSync(abs(noteA2));
  cleanup.files.delete(noteA2);
  await sync();
  const delDoc = await docStatus(idA, 404);
  const stillListed = await noteRow(quokka, noteA2);
  check("B delete", "deleting the note in the vault retracts it from Hindsight and the index", delDoc === 404 && !stillListed, { document: delDoc });

  // ── C · note: forget kind c (a section, then the whole note) ───────────────────────────
  const numbat = `Numbat${RUN}`;
  const wombat = `Wombat${RUN}`;
  writeFileSync(
    abs(noteB),
    `---\ntitle: ${TAG} forget\n---\n# ${TAG} forget\n\n## Keep\n\nThe synthetic ${wombat} office has a blue sign on its front door.\n\n## Drop\n\nThe synthetic ${numbat} delivery van is always parked in bay 4.\n`,
    "utf8",
  );
  cleanup.files.add(noteB);
  await sync();
  const rowB = await until(() => noteRow(wombat, noteB), (r) => !!r, 120_000, SLOW);
  const idB: string = rowB?.id ?? "";
  if (!check("C create", "the second test note is indexed", !!idB, rowB ? { id: idB } : null)) return;
  const iB = await confirmed(idB);
  const dB = await until(() => doc(idB), (r) => r.status === 200, 120_000);
  check("C create", "confirmed in Hindsight with its model receipt", iB?.row?.indexed === "confirmed" && String(dB.body?.original_text ?? "").includes(numbat), { processed_by: model(iB?.row?.processed_by) });

  if (!who.human) {
    skip("C forget c (section)", "forget kind c of one section, approved in the owner's own session", `${who.reason}.`);
    skip("C forget c (note)", "forget kind c of the whole note, approved in the owner's own session", `${who.reason}. The test note is removed by deleting its file instead (no approval needed).`);
    unlinkSync(abs(noteB));
    cleanup.files.delete(noteB);
    await sync();
    const goneB = await docStatus(idB, 404);
    check("C delete", "the second test note is removed by deleting its file: retracted from Hindsight and the index", goneB === 404 && !(await noteRow(wombat, noteB)), { document: goneB });
  } else {
    const fs1 = await forgetApproved({ kind: "full", target: idB, heading: "Drop" });
    check("C forget c (section)", "forget kind c of one section asks for approval, and the owner's own session approves it", fs1.ask?.status === 202 && fs1.grant?.status === 200, { ask: fs1.ask?.body?.message, grant: fs1.grant?.body?.ok ?? fs1.grant?.body ?? fs1.note });
    const textB = existsSync(abs(noteB)) ? readFileSync(abs(noteB), "utf8") : "";
    const dB2 = await until(() => doc(idB), (r) => r.status === 200 && !String(r.body?.original_text ?? "").includes(numbat), 180_000);
    const iB2 = await confirmed(idB);
    const hNumbat = await recallHit(`Where is the synthetic ${numbat} delivery van parked?`, idB);
    check(
      "C forget c (section)",
      "the section is removed from the vault note; Hindsight re-indexed the note without it; recall never shows it",
      fs1.done?.status === 200 && !textB.includes(numbat) && textB.includes(wombat) && dB2.status === 200 && !String(dB2.body?.original_text ?? "").includes(numbat) && !(hNumbat?.text ?? "").includes(numbat),
      { message: fs1.done?.body?.message, processed_by: model(iB2?.row?.processed_by) },
    );

    const fs2 = await forgetApproved({ kind: "full", target: idB });
    const goneB = await docStatus(idB, 404);
    check("C forget c (note)", "forget kind c of the whole note: approved, the file is deleted from the vault and the document from Hindsight", fs2.ask?.status === 202 && fs2.grant?.status === 200 && fs2.done?.status === 200 && !existsSync(abs(noteB)) && goneB === 404, {
      message: fs2.done?.body?.message,
      document: goneB,
    });
    if (!existsSync(abs(noteB))) cleanup.files.delete(noteB);
  }

  // ── receipts and end state ─────────────────────────────────────────────────────────────
  const stEnd = (await get("/status")).body;
  const delta: Record<string, number> = {};
  for (const [k, v] of Object.entries(stEnd.models ?? {})) if ((v as number) - (models0[k] ?? 0) > 0) delta[k] = (v as number) - (models0[k] ?? 0);
  check("receipts", "every save this run has a model receipt (saves per model, this run)", Object.keys(delta).length > 0, delta);
  endLeftovers = await runItems();
  check("end state", "nothing from this run is left in the index; nothing pending; no errors", endLeftovers.length === 0 && stEnd.pending === 0 && (stEnd.errors?.length ?? 0) === 0, {
    leftovers: endLeftovers,
    pending: stEnd.pending,
    errors: stEnd.errors?.length ?? 0,
    tombstones: stEnd.counts?.tombstones,
    deletes_last_hour: deletesLastHour(),
  });
}

/**
 * Best effort: never leave a test file in the vault or a test memory in the pool, and say honestly what
 * couldn't be removed. A test file is just deleted (no approval). A test memory needs an approved forget:
 * asked only from a confirmed person's session; otherwise it is reported as needing a person.
 */
async function tidy(): Promise<CleanupOutcome[]> {
  const out: CleanupOutcome[] = [];
  for (const rel of cleanup.files)
    try {
      if (existsSync(abs(rel))) unlinkSync(abs(rel));
      out.push({ target: rel, state: "removed", detail: "test file deleted from the vault" });
    } catch (e) {
      out.push({ target: rel, state: "failed", detail: `could not delete the test file: ${(e as Error).message}` });
    }
  if (cleanup.files.size) await sync().catch(() => undefined);
  // Part A's memories are one chain (a save and its correction): forgetting the newest removes every version.
  const mems = [...cleanup.mems];
  if (mems.length) {
    const newest = mems[mems.length - 1];
    const o = cleanupOutcome(newest, await forgetApproved({ kind: "memory", target: newest }).catch(() => null));
    out.push(o);
    for (const older of mems.slice(0, -1))
      out.push({ target: older, state: o.state, detail: `an older version of ${newest}: ${o.state === "removed" ? "removed with it" : "still there; it goes with that one (same approval)"}`, ...(o.approval_id ? { approval_id: o.approval_id } : {}) });
  }
  for (const o of out) console.log(`      cleanup: ${o.target}: ${o.state === "removed" ? "removed" : o.state === "needs-approval" ? "NEEDS APPROVAL" : "FAILED"} (${o.detail}${o.approval_id ? `; approval ${o.approval_id}` : ""})`);
  return out;
}

let aborted = "";
main()
  .catch((e) => {
    aborted = (e as Error).message;
    console.error("verification aborted:", aborted);
  })
  .finally(async () => {
    cleanupReport = await tidy().catch((e) => [{ target: "(clean-up)", state: "failed" as const, detail: (e as Error).message }]);
    // Anything this run couldn't remove, plus anything of this run the index still lists after the clean-up.
    const still = session && token ? await runItems().catch(() => endLeftovers) : endLeftovers;
    const left: CleanupOutcome[] = [
      ...cleanupReport.filter((o) => o.state !== "removed"),
      ...still.filter((id) => !cleanupReport.some((o) => o.target === id && o.state !== "removed")).map((id) => ({ target: id, state: "failed" as const, detail: "still listed in the index after the clean-up" })),
    ];
    const skipped = results.filter((r) => r.skipped);
    // A leftover is a failure of its own: the run promised to leave nothing behind.
    const failedTotal = results.filter((r) => !r.ok).length + (aborted ? 1 : 0) + (left.length ? 1 : 0);
    if (left.length) console.log(`FAIL  [clean-up] ${left.length} item(s) from this run are still there; see "leftovers" in the JSON`);
    if (OUT)
      writeFileSync(
        OUT,
        JSON.stringify(
          {
            run: RUN,
            connection_resets: resets,
            target: `OS 127.0.0.1:${OS_PORT} → proxy ${PROXY_PORT} bank ${BANK}`,
            at: new Date().toISOString(),
            session: { human: who.human, actor: who.actor, pending: who.pending, reason: who.reason },
            passed: results.filter((r) => r.ok && !r.skipped).length,
            skipped: skipped.length,
            failed: failedTotal,
            aborted: aborted || undefined,
            preflight_leftovers: preflightLeftovers,
            leftovers: left,
            cleanup: cleanupReport,
            results,
          },
          null,
          2,
        ) + "\n",
      );
    const ran = results.length - skipped.length;
    console.log(
      failedTotal
        ? `\n${failedTotal} check(s) FAILED${skipped.length ? ` (${skipped.length} skipped)` : ""}`
        : `\nAll ${ran} checks passed${skipped.length ? `; ${skipped.length} skipped (this session isn't a confirmed person, so no forget was asked for; see the SKIP lines).` : "."}`,
    );
    process.exitCode = failedTotal ? 1 : 0;
  });
