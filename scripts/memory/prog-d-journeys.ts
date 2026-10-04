/**
 * PROG-D memory journeys (1 Oct 2026): the shared memory's save / recall+cite / dedupe / correct / delete and the
 * vault note edit / rename / copy / reindex / delete journeys, proven against the REAL architecture with SYNTHETIC
 * data only:
 *
 *   - Hindsight: the dedicated Stage D instance (API 8893, client proxy 8883), which runs the same Hindsight, proxy
 *     (writer capability ON), supervisor and LLM chain as the pilot. A fresh disposable bank syn-prog-d-<run>.
 *   - The OS's own memory module, in-process: createMemoryApi over the real connector, the real Hindsight client
 *     (registering the per-process writer capability with the proxy: this process owns the writer port) and the real
 *     approvals service. The vault is a TEMP copy of the synthetic mini-wiki under --scratch.
 *   - The principal is the owner's CONFIRMED browser session (actor "human"), as the harness plays it. The live OS
 *     cannot give a script one: since S1 a page load's session is pending (a program) and a program's forget needs a
 *     Telegram code sent to the owner, which this run must never do (no messages).
 *
 * Everything carries the tag SYNTHETIC-PROG-20261001 and is removed at the end; the end state is proved (Hindsight
 * documents, recall, items, vault files). Never 8081, the pilot or the real vault.
 *
 *   bun --no-env-file scripts/memory/prog-d-journeys.ts --scratch D:/prog-scratch --out <file.json>
 *        [--proxy-port 8883] [--writer-port 8097] [--secret D:\hindsight\stage-d\secrets\stage-d-docdelete.key]
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createMemoryApi } from "./api";
import { handoffFact, handoffFactNeutral, handoffFactTitle } from "../coding/orchestrator";
import { localApprovals } from "./approvals";
import { resolveMemorySettings } from "./settings";
import { agentOf, usman } from "./testing/harness";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";

const ROOT = resolve(import.meta.dir, "..", "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PROXY_PORT = Number(arg("proxy-port", "8883"));
const WRITER_PORT = Number(arg("writer-port", "8097"));
if ([8878, 8888, 8081].includes(PROXY_PORT) || WRITER_PORT === 8081) throw new Error("Refusing the live OS or the pilot.");
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const SECRET_FILE = arg("secret", "D:\\hindsight\\stage-d\\secrets\\stage-d-docdelete.key");
const SCRATCH = arg("scratch", "D:/prog-scratch");
const OUT = arg("out", "");
const RUN = randomBytes(3).toString("hex");
const BANK = `syn-prog-d-${RUN}`;
const TAG = "SYNTHETIC-PROG-20261001";
mkdirSync(SCRATCH, { recursive: true });
const WORK = mkdtempSync(join(SCRATCH, "mu-prog-d-mem-"));
const VAULT = join(WORK, "vault");
const STATE = join(WORK, "app", ".operator-data", "memory");
cpSync(join(ROOT, "scripts", "memory", "fixtures", "mini-wiki"), VAULT, { recursive: true });

type Check = { step: string; check: string; ok: boolean; observed: unknown };
const results: Check[] = [];
const check = (step: string, name: string, ok: boolean, observed: unknown) => {
  results.push({ step, check: name, ok, observed });
  console.log(`${ok ? "PASS" : "FAIL"}  [${step}] ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Read-only calls to the synthetic proxy (no key, no header: it holds the key). */
const proxy = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const r = await fetch(`${PROXY}/v1/default/banks/${BANK}${path}`, { method: init.method ?? "GET", headers: init.body ? { "Content-Type": "application/json" } : undefined, body: init.body ? JSON.stringify(init.body) : undefined });
  let body: any = null;
  try { body = await r.json(); } catch { /* no body */ }
  return { status: r.status, body };
};
const docIds = async (): Promise<string[]> => (((await proxy("/documents?limit=500")).body?.items ?? []) as { id: string }[]).map((d) => d.id).sort();
const hsDoc = async (id: string) => proxy(`/documents/${id}`);

async function main() {
  const health = await fetch(`${PROXY}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) throw new Error(`The synthetic Hindsight proxy isn't healthy on ${PROXY_PORT} (run scripts/hindsight/stage-d-instance.ps1 start).`);
  // This process owns the writer port, exactly as the OS does on 8081: the proxy lets only that process register as the writer.
  const holder = createServer((_q, s) => s.end("writer port held by the prog-d journeys")).listen(WRITER_PORT, "127.0.0.1");
  await new Promise((ok, fail) => (holder.once("listening", ok), holder.once("error", fail)));

  const env: Record<string, string> = {
    MU_MEMORY_WRITES: "on",
    HINDSIGHT_URL: PROXY,
    HINDSIGHT_BANK: BANK,
    HINDSIGHT_APPROVAL_SECRET_FILE: SECRET_FILE,
    MU_WIKI_ROOT: VAULT,
    MU_WIKI_VAULT_NAME: "prog-d-synthetic",
    MEMORY_STATE_DIR: STATE,
  };
  const settings = resolveMemorySettings(env, join(WORK, "app"));
  const spoken = new SpokenConfirmationLedger();
  const telegram: string[] = [];
  const api = createMemoryApi({
    settings, env, spoken, indexWaitMs: 240_000,
    timeouts: { retain: 240_000, recall: 60_000, other: 60_000 },
    approvals: () => localApprovals(settings.stateDir, { spoken, notify: (_p, text) => (telegram.push(text), { ok: true, detail: "captured, never sent" }) }),
  });
  const who = usman; // the owner's confirmed browser session (see the header)
  const settle = async (ms = 900_000) => {
    const until = Date.now() + ms;
    for (;;) {
      await api.sync({ force: true, waitMs: 120_000 });
      const st = api.status();
      if (st.pending === 0 || Date.now() > until) return st;
      await sleep(3000);
    }
  };
  const noteRows = (q: string) => api.list({ kind: "note", q });
  const approve = async (approvalId: string) => {
    const card = api.approvals.card(approvalId, who);
    return api.approvals.grant(approvalId, who, "ui", { cardNonce: card?.cardNonce ?? "00000000-0000-4000-8000-000000000000" });
  };

  check("setup", "dedicated synthetic Hindsight healthy; this process is the writer (owns the writer port); writes on; no key in the OS process", api.settings.writes === true && api.settings.hindsight.enabled === true, { proxy: PROXY, bank: BANK, tag: TAG, writer_port: WRITER_PORT, scratch: WORK, hindsight_url: api.settings.hindsight.url });
  const st0 = await settle();
  check("setup", "initial sync of the temporary vault: nothing pending, every note indexed", st0.pending === 0 && st0.counts.indexed === st0.counts.docs, { pending: st0.pending, counts: st0.counts, errors: st0.errors });
  const baseDocs = await docIds();

  // 1 · save ────────────────────────────────────────────────────────────────────────────
  const text1 = `${TAG} The synthetic Cormorant${RUN} depot opens at 6:10am on Tuesdays.`;
  const s1 = await api.remember(who, { text: text1, note: TAG, channel: "ui" });
  if (!s1.ok) throw new Error(`save refused: ${s1.code} ${s1.message}`);
  const memId = s1.memory.id;
  const doc1 = await hsDoc(memId);
  check("1 save", "saved as a Hindsight memory, indexed, and present as a document in the bank", s1.destination.indexed === "confirmed" && doc1.status === 200, { id: memId, message: s1.message, indexed: s1.destination.indexed, hindsight_doc: doc1.status });

  // 2 · recall with the source cited ─────────────────────────────────────────────────────
  const rec1 = await api.recall(who, `When does the Cormorant${RUN} depot open?`);
  const hit1 = rec1.facts.find((f) => f.id === memId);
  check("2 recall+cite", "recall returns the memory via Hindsight with its source cited", !!hit1 && hit1.via.includes("hindsight") && rec1.hindsight === "ok" && !!hit1.source, { hindsight: rec1.hindsight, hit: hit1 && { id: hit1.id, via: hit1.via, source: hit1.source, text: hit1.text }, spoken: rec1.spoken.slice(0, 200) });

  // 3 · which model/route Hindsight says processed the save ──────────────────────────────
  const item1 = api.item(memId);
  const stA = api.status();
  check("3 model record", "the save records the provider and model Hindsight reports processing it (receipts, no text)", !!item1?.row.processed_by?.model, { processed_by: item1?.row.processed_by, models: stA.models });

  // 4 · dedupe ──────────────────────────────────────────────────────────────────────────
  const docsBeforeDup = await docIds();
  const s1b = await api.remember(who, { text: text1, note: TAG, channel: "ui" });
  const docsAfterDup = await docIds();
  check("4 dedupe", "saving the same text again returns the same memory (duplicate); no new Hindsight document", s1b.ok && s1b.duplicate === true && s1b.memory.id === memId && same(docsBeforeDup, docsAfterDup), { message: s1b.ok ? s1b.message : s1b.message, docs_before: docsBeforeDup.length, docs_after: docsAfterDup.length });

  // 4b · credential screening (round 3): a fake secret-shaped string is refused and stored nowhere ─────────
  const fakeSecret = `${TAG} The synthetic Xero${RUN} password is now Zq${RUN}-Fake-Pw-7781`;
  const docsBeforeSecret = await docIds();
  const itemsBeforeSecret = api.list({ q: `Xero${RUN}` }).length;
  const sSecret = await api.remember(who, { text: fakeSecret, note: TAG, channel: "ui" });
  const recSecret = await api.recall(who, `What is the Xero${RUN} password?`);
  const rawSecret = await proxy("/memories/recall", { method: "POST", body: { query: `Xero${RUN} password Fake-Pw-7781` } });
  const secretInBank = ((rawSecret.body?.results ?? []) as any[]).some((r) => String(r.text ?? "").includes(`Fake-Pw-7781`));
  check("4b credential screen", "a synthetic password-shaped string is refused; not in the bank, the app, or recall; no new document", !sSecret.ok && same(docsBeforeSecret, await docIds()) && api.list({ q: `Xero${RUN}` }).length === itemsBeforeSecret && !secretInBank && !JSON.stringify(recSecret).includes("Fake-Pw-7781"), { code: sSecret.ok ? "ok" : sSecret.code, message: sSecret.ok ? "" : sSecret.message });

  // 5 · correct ─────────────────────────────────────────────────────────────────────────
  const c5 = await api.correct(who, memId, { text: `${TAG} The synthetic Cormorant${RUN} depot opens at 7:40am on Tuesdays.`, channel: "ui" });
  if (!c5.ok) throw new Error(`correct refused: ${c5.code} ${c5.message}`);
  const newId = c5.id;
  await settle();
  const rec5 = await api.recall(who, `When does the Cormorant${RUN} depot open on Tuesdays?`);
  const ids5 = rec5.facts.map((f) => f.id);
  const texts5 = rec5.facts.map((f) => f.text).join(" | ");
  const old5 = await hsDoc(memId);
  const oldItem = api.item(memId);
  check("5 correct", "the new fact supersedes: recalled as current; the old one is never recalled and is retracted from Hindsight", ids5.includes(newId) && !ids5.includes(memId) && !texts5.includes("6:10am") && old5.status === 404 && oldItem?.row.status === "superseded", { correct: c5.message, new_id: newId, recalled: rec5.facts.filter((f) => JSON.stringify(f).includes(RUN)).map((f) => ({ id: f.id, via: f.via, text: f.text })), old_doc_in_hindsight: old5.status, old_row_status: oldItem?.row.status });

  const item5 = api.item(newId);
  check("5 model record", "the correction save also records the model Hindsight reports processing it", !!item5?.row.processed_by?.model, { save1: item1?.row.processed_by, correction: item5?.row.processed_by });

  // 6 · delete (approval on the Memory page) ─────────────────────────────────────────────
  const f6 = await api.forget(who, { kind: "memory", target: newId });
  const still6 = await hsDoc(newId);
  check("6 delete", "deleting a saved memory asks for approval first; nothing is removed yet", !f6.ok && f6.code === "approval-required" && still6.status === 200, { code: f6.ok ? "ok" : f6.code, hindsight_doc: still6.status });
  const asProgram = await api.forget(agentOf(who), { kind: "memory", target: newId, approval_id: (f6 as any).approval?.id });
  check("6 delete", "a program (the same person's agent, no browser session) cannot use that approval; nothing is removed", !asProgram.ok && (await hsDoc(newId)).status === 200, { code: asProgram.ok ? "ok" : asProgram.code });
  const g6 = await approve((f6 as any).approval.id);
  const gone6 = await hsDoc(newId);
  const rec6 = await api.recall(who, `When does the Cormorant${RUN} depot open on Tuesdays?`);
  check("6 delete", "after the page approval the memory is gone: Hindsight document 404, not in recall, not in the app", g6.ok && (g6 as any).result?.ok === true && gone6.status === 404 && !rec6.facts.some((f) => f.id === newId || f.id === memId) && api.item(newId) === null, { grant: g6.ok, result: (g6 as any).result?.message, hindsight_doc: gone6.status, recall_has_run: rec6.facts.some((f) => JSON.stringify(f).includes(RUN)) });
  check("6 delete", "the approval is single use (replaying it removes nothing more and is refused)", !(await approve((f6 as any).approval.id)).ok, {});

  // 7 · vault note: create, edit, rename, copy, reindex, delete ──────────────────────────
  const dir = "wiki/topics/business";
  const rel = `${dir}/zz-prog-d-${RUN}.md`;
  const rel2 = `${dir}/zz-prog-d-${RUN}-renamed.md`;
  const relCopy = `${dir}/zz-prog-d-${RUN}-copy.md`;
  const title = `Synthetic Plover${RUN} Depot Note`;
  const body = (when: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n\n${TAG}. The synthetic Plover${RUN} depot opens at ${when} on Fridays.\n`;
  writeFileSync(join(VAULT, rel), body("5:55am"));
  await settle();
  const n1 = noteRows(`Plover${RUN}`).find((r) => r.title === title);
  const noteId = n1?.id ?? "";
  const nd1 = await hsDoc(noteId);
  check("7 note", "a new note in the vault is indexed with a stable id and is a Hindsight document", !!noteId && nd1.status === 200, { id: noteId, path: (n1?.source as any)?.path, indexed: n1?.indexed, hindsight_doc: nd1.status });

  writeFileSync(join(VAULT, rel), body("6:25am"));
  await settle();
  const n2 = noteRows(`Plover${RUN}`).find((r) => r.title === title);
  const nd2 = await hsDoc(noteId);
  const rec7 = await api.recall(who, `When does the Plover${RUN} depot open on Fridays?`);
  const t7 = rec7.facts.find((f) => f.id === noteId);
  const orig2 = String(nd2.body?.original_text ?? "");
  check("7 note edit", "an edit keeps the note's identity and replaces the old wording in Hindsight and in recall", n2?.id === noteId && orig2.includes("6:25am") && !orig2.includes("5:55am") && !!t7 && t7.text.includes("6:25am") && !t7.text.includes("5:55am"), { same_id: n2?.id === noteId, hindsight_has_new: orig2.includes("6:25am"), hindsight_has_old: orig2.includes("5:55am"), recall: t7 && { via: t7.via, text: t7.text } });

  const docsBeforeRename = await docIds();
  renameSync(join(VAULT, rel), join(VAULT, rel2));
  const sy = await api.sync({ force: true, waitMs: 120_000 });
  await settle();
  const n3 = noteRows(`Plover${RUN}`).filter((r) => r.title === title);
  const docsAfterRename = await docIds();
  check("7 note rename", "a rename keeps the note id: one note, the new path, the same set of Hindsight documents (no duplicate)", n3.length === 1 && n3[0].id === noteId && (n3[0].source as any)?.path === rel2 && same(docsBeforeRename, docsAfterRename), { renames: sy.renames, notes_with_title: n3.length, id: n3[0]?.id, path: (n3[0]?.source as any)?.path, docs_before: docsBeforeRename.length, docs_after: docsAfterRename.length });

  copyFileSync(join(VAULT, rel2), join(VAULT, relCopy));
  await settle();
  const docsAfterCopy = await docIds();
  const n4 = noteRows(`Plover${RUN}`).filter((r) => r.title === title);
  check("7 note copy", "a copy of the note is not indexed as a second note: no new Hindsight document", same(docsAfterRename, docsAfterCopy) && n4.length === 1 && n4[0].id === noteId, { notes_with_title: n4.length, docs_before: docsAfterRename.length, docs_after: docsAfterCopy.length, ids: n4.map((r) => r.id) });

  const ri = await api.reindex(who, noteId);
  await settle();
  const docsAfterReindex = await docIds();
  const n5 = noteRows(`Plover${RUN}`).filter((r) => r.title === title);
  check("7 reindex", "re-indexing the note and a full sync do not duplicate it: same ids, same documents", same(docsAfterCopy, docsAfterReindex) && n5.length === 1 && n5[0].id === noteId, { reindex: (ri as any).message ?? ri, docs_after: docsAfterReindex.length, ids: n5.map((r) => r.id) });

  unlinkSync(join(VAULT, relCopy));
  unlinkSync(join(VAULT, rel2));
  await settle();
  const nd8 = await hsDoc(noteId);
  const rec8 = await api.recall(who, `Plover${RUN} depot Fridays`);
  check("7 note delete", "deleting the note removes it from Hindsight, from recall and from the index", nd8.status === 404 && !rec8.facts.some((f) => f.id === noteId) && noteRows(`Plover${RUN}`).every((r) => r.title !== title), { hindsight_doc: nd8.status, recall_has_note: rec8.facts.some((f) => f.id === noteId) });

  // 8 · the receipts: which provider/model Hindsight reported across the run ─────────────
  const stEnd = api.status();
  check("8 model record", "Hindsight's own receipts name the provider and model that processed these saves", Object.keys(stEnd.models ?? {}).length > 0, { models: stEnd.models, recent: (stEnd.recent ?? []).filter((r: any) => r.processed_by).slice(0, 4).map((r: any) => ({ op: r.op, outcome: r.outcome, processed_by: r.processed_by })) });
  const llm = await proxy("/llm-requests?limit=50");
  const rows = ((llm.body?.items ?? []) as any[]).map((r) => `${r.provider}/${r.model}/${r.status}`);
  const tally = rows.reduce((m: Record<string, number>, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  check("8 model record", "the bank's llm-requests receipts list provider, model and status per call (no prompt text)", llm.status === 200 && rows.length > 0, { status: llm.status, calls: tally });

  // 8b · the coding handoff (round 3): a normal handoff is SAVED to the vault through the real save path, a request carrying a fake secret is
  //      refused as a full fact but its neutral form saves, and the fake secret is in no saved text and not in the bank ─────────────────────
  const handoffOf = (objective: string) => ({
    id: "00000000-0000-4000-8000-000000000000", jobId: `674f43aa-1b2c-4d3e-8f90-${RUN}000000`.slice(0, 36), repoId: "synthetic-repo", baseSha: "a".repeat(40), jobBranch: `coding/synthetic-${RUN}`,
    headSha: "0123456789abcdef0123456789abcdef01234567", outcome: "failed", objective, changedFiles: [{ path: "src/a.ts", status: "M" }],
    tests: [{ commandId: "bun-test", passed: 3, failed: 1, exitCode: 1 }], review: { verdict: "request-changes", blockers: 1, majors: 0, minors: 0 },
    usage: [{ roleId: "builder", model: "claude-sonnet-5-5", accountSlot: "claude:max-2", turns: 1, inputTokens: 1, outputTokens: 1 }], followUps: [], notDone: [],
    links: { job: `/coding/synthetic-${RUN}`, work: "", memory: null }, createdAt: new Date().toISOString(),
  }) as any;
  const normalObjective = `${TAG} Make sure the password is stored hashed and the api key is never logged (run ${RUN})`;
  const nh = handoffOf(normalObjective);
  const saveH = (title: string, text: string, id: string, keep: boolean) => api.saveToVault(who, { title, text, bucket: "business", channel: "agent", note: `coding job synthetic-${id}`, ...(keep ? { onConflict: "keep-both" as const } : {}) });
  const sNormal = await saveH(handoffFactTitle(normalObjective), handoffFact(nh, `h${RUN}`), RUN, true);
  // A second job's handoff on the same repo: without keep-both the memory's disagreement check refuses it ("conflict"); the orchestrator passes keep-both.
  const secondObjective = `${TAG} Add a retry to the sync (run ${RUN}b)`;
  const sSecondPlain = await saveH(handoffFactTitle(secondObjective), handoffFact(handoffOf(secondObjective), `b${RUN}`), `b${RUN}`, false);
  const sSecond = await saveH(handoffFactTitle(secondObjective), handoffFact(handoffOf(secondObjective), `b${RUN}`), `b${RUN}`, true);
  const handoffSecret = `Zq${RUN}-Fake-Pw-7781`;
  const secretObjective = `${TAG} Set the Xero password is now ${handoffSecret} in the config`;
  const sh = handoffOf(secretObjective);
  const sFull = await saveH(handoffFactTitle(secretObjective), handoffFact(sh, `s${RUN}`), `s${RUN}`, true);
  const neutral = handoffFactNeutral(sh, `s${RUN}`);
  const sNeutral = await saveH(neutral.title, neutral.text, `s${RUN}`, true);
  await settle();
  const recHandoff = await api.recall(who, `${TAG} password stored hashed api key never logged ${RUN}`);
  const rawSecret2 = await proxy("/memories/recall", { method: "POST", body: { query: `${handoffSecret} Xero password` } });
  const secretInBank2 = ((rawSecret2.body?.results ?? []) as any[]).some((r) => String(r.text ?? "").includes(handoffSecret));
  check("8b handoff", "two handoffs on one repo: the second is refused as a conflict unless saved keep-both (the cause of a second failure mode); with keep-both both are saved", sNormal.ok === true && !sSecondPlain.ok && (sSecondPlain as any).code === "conflict" && sSecond.ok === true, { first: sNormal.ok ? "saved" : (sNormal as any).code, second_plain: sSecondPlain.ok ? "saved" : (sSecondPlain as any).code, second_keep_both: sSecond.ok ? "saved" : (sSecond as any).code });
  check("8b handoff", "a normal coding handoff about credentials is saved to the vault and recalled; a request carrying a fake secret is refused as a full fact (prohibited-content), its neutral form saves, and the secret is nowhere in the bank or the recall", sNormal.ok === true && !sFull.ok && (sFull as any).code === "prohibited-content" && sNeutral.ok === true && !secretInBank2 && !JSON.stringify(recHandoff).includes(handoffSecret), { normal: sNormal.ok ? "saved" : (sNormal as any).code, full_with_secret: sFull.ok ? "SAVED (bad)" : (sFull as any).code, neutral: sNeutral.ok ? "saved" : (sNeutral as any).code, recalled_normal: recHandoff.facts.some((f) => String(f.text).includes("stored hashed")), secret_in_bank: secretInBank2 });
  // Put the vault back exactly as it was copied, so the cleanup proof below covers these saves too.
  const restore = (dir: string, mini: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const orig = join(mini, name);
      if (readdirSync(dir, { withFileTypes: true }).find((e) => e.name === name)?.isDirectory()) {
        if (!existsSync(orig)) rmSync(full, { recursive: true, force: true });
        else restore(full, orig);
      } else if (!existsSync(orig)) unlinkSync(full);
    }
  };
  const miniWiki = join(ROOT, "scripts", "memory", "fixtures", "mini-wiki");
  restore(VAULT, miniWiki);
  cpSync(miniWiki, VAULT, { recursive: true, force: true });
  await settle();

  // 9 · cleanup and proof ───────────────────────────────────────────────────────────────
  const endDocs = await docIds();
  const leftoverDocs = endDocs.filter((id) => !baseDocs.includes(id));
  const recT = await api.recall(who, `${TAG} Cormorant${RUN} Plover${RUN} depot opens`);
  const rawRecall = await proxy("/memories/recall", { method: "POST", body: { query: `${TAG} Cormorant${RUN} Plover${RUN} depot opens` } });
  const rawHits = ((rawRecall.body?.results ?? []) as any[]).filter((r) => String(r.text ?? "").includes(RUN));
  const items = api.list({ q: RUN, includeSuperseded: false }).filter((i) => JSON.stringify(i).includes(RUN));
  const vaultLeft = readdirSync(join(VAULT, dir)).filter((f) => f.includes(`zz-prog-d-${RUN}`));
  check("9 cleanup", "nothing synthetic is left: no extra Hindsight documents, recall empty for the tag, no current items, no vault files", leftoverDocs.length === 0 && recT.facts.filter((f) => JSON.stringify(f).includes(RUN)).length === 0 && rawHits.length === 0 && items.length === 0 && vaultLeft.length === 0, { leftover_docs: leftoverDocs, recall_hits_with_run: recT.facts.filter((f) => JSON.stringify(f).includes(RUN)).length, raw_bank_recall_hits_with_run: rawHits.length, current_items_with_run: items.length, vault_files_left: vaultLeft, bank_docs_now: endDocs.length, bank_docs_at_start: baseDocs.length });
  check("9 cleanup", "no Telegram message was sent or needed (captured count)", telegram.length === 0, { captured: telegram.length });

  holder.close();
  const out = { run: RUN, bank: BANK, tag: TAG, work: WORK, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ passed: out.passed, failed: out.failed, bank: BANK, work: WORK }));
}

main()
  .catch((e) => {
    console.error("journeys aborted:", (e as Error).message);
    process.exitCode = 1;
    if (OUT) writeFileSync(OUT, JSON.stringify({ run: RUN, bank: BANK, tag: TAG, aborted: (e as Error).message, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2) + "\n");
  })
  .finally(() => process.exit());
