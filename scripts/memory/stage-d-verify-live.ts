/**
 * Stage D switch-on verification, for the LEAD to run at this PC AFTER the switch-on runbook
 * (docs/stage-d/SWITCH-ON-RUNBOOK.md). It talks to the LIVE AgenticOS (127.0.0.1:8081) as the owner's
 * browser would (a page navigation mints the owner's human session; every POST carries its page token),
 * and to the pilot proxy (127.0.0.1:8878) for read-only document checks.
 *
 * It saves ONE clearly labelled synthetic fact into the real shared pool, recalls it (source cited),
 * corrects it (read back and confirmed), then deletes it with a forget of kind b through the approval
 * path, and prints each result and the model that processed each save. At the end nothing of it is left
 * in Hindsight (a tombstone with its id and hash, never its text, stays in the app store).
 * It also checks the agents' endpoint (/__memory/mcp tools/list; no save) and the pilot's MCP tool list.
 * No key is read or printed. Exit code 0 only if every check passed.
 *
 *   bun --no-env-file scripts/memory/stage-d-verify-live.ts --live      (--live is required for the live OS)
 *
 * The acceptance driver runs this same script against its synthetic copy with
 * --os-port <p> --proxy-port 8883 --bank syn-stage-d-<run> --expect-url <relay> --skip-hindsight-mcp;
 * the defaults are the live setup.
 */
import { SERVED_TOOLS } from "./mcp-tools";
import { randomBytes } from "node:crypto";
import { request } from "node:http";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OS_PORT = Number(arg("os-port", "8081"));
const PROXY_PORT = Number(arg("proxy-port", "8878"));
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const PROXY_HOST = `127.0.0.1:${PROXY_PORT}`;
const BANK = arg("bank", "mu-shared");
const EXPECT_URL = arg("expect-url", PROXY);
// Production needs an explicit --live (REVIEW-T6 finding 8): one mistyped command must never write the real
// shared pool or the real vault.
const TOUCHES_LIVE = OS_PORT === 8081 || PROXY_PORT === 8878 || PROXY_PORT === 8888 || BANK === "mu-shared";
if (TOUCHES_LIVE && !process.argv.includes("--live")) {
  console.error("Refusing: this targets the LIVE OS / pilot / shared pool. Add --live to run it there on purpose, or point it at a synthetic copy (--os-port, --proxy-port, --bank syn-...).");
  process.exit(2);
}

// The synthetic instance keeps Hindsight's default MCP tools; only the pilot is deployed read-only.
const CHECK_HINDSIGHT_MCP = !process.argv.includes("--skip-hindsight-mcp");
const RUN = randomBytes(3).toString("hex");
const FACT = `Stage D switch-on check ${RUN}: the synthetic Verifier clinic opens at 7am (test data, deleted by the check).`;
const FIXED = `Stage D switch-on check ${RUN}: the synthetic Verifier clinic opens at 8am (test data, deleted by the check).`;

type Res = { status: number; body: any; headers: Record<string, string | string[] | undefined> };
function raw(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<Res> {
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
    req.setTimeout(init.timeoutMs ?? 300_000, () => req.destroy(new Error("timeout")));
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
const page = () => ({ ...host, Origin: `http://localhost:${OS_PORT}`, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session } : {}) });
const get = (path: string) => raw(`${OS}/__memory${path}`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } });
const post = (path: string, body: unknown) => raw(`${OS}/__memory${path}`, { method: "POST", headers: { ...page(), "x-claude-os-token": token }, body });
const doc = (id: string) => raw(`${PROXY}/v1/default/banks/${BANK}/documents/${encodeURIComponent(id)}`, { headers: { Host: PROXY_HOST } });

let failed = 0;
function show(ok: boolean, what: string, detail: unknown) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (detail !== undefined) console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const model = (p: any) => (p ? `${p.provider}/${p.model} (${p.basis}${p.tokens != null ? `, ${p.tokens} tokens` : ""}${p.fallback_from?.length ? `, fell back from ${p.fallback_from.map((m: any) => `${m.provider}/${m.model}`).join(", ")}` : ""})` : "not recorded yet");
async function indexed(id: string, ms = 600_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = (await get(`/item/${id}`)).body;
    if ((r?.row?.indexed === "confirmed" && r.row.processed_by) || Date.now() > until) return r;
    await sleep(3000);
  }
}

async function main() {
  // The owner's browser session at this PC.
  // STAGE_D_SESSION: a synthetic copy's session cookie the caller already holds (stage-d-acceptance.ts). A second page load
  // there would mint a second, PENDING session (S1), which is a program and can't approve a forget.
  if (/^mu_session=[\w-]+$/.test(process.env.STAGE_D_SESSION ?? "")) session = process.env.STAGE_D_SESSION!;
  else {
    const nav = await raw(`${OS}/memory/vault`, { headers: { ...host, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
    session = ([] as string[]).concat((nav.headers["set-cookie"] as string[] | string | undefined) ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("mu_session=")) ?? "";
  }
  token = (await raw(`${OS}/__token`, { headers: { ...host, ...(session ? { Cookie: session } : {}) } })).body?.token ?? "";
  show(!!session && !!token, "owner's browser session and page token at this PC", { session: session ? "yes" : "no", token: token ? "yes" : "no" });

  const st = (await get("/status")).body;
  const s = st?.settings ?? {};
  show(s.mode === "on" && s.writes === true && !s.writer, "the memory switch is on and this is the one writer", { mode: s.mode, writes: s.writes, writer_refusal: s.writer ?? null, hindsight: st?.hindsight, url: s.hindsight_url, bank: s.bank, api_key: s.api_key });
  if (!(s.mode === "on" && s.writes === true && !s.writer)) return;
  show(s.hindsight_url === EXPECT_URL && s.bank === BANK && s.api_key === "missing", "Hindsight through the proxy, shared pool, no key in the OS", { url: s.hindsight_url, bank: s.bank, api_key: s.api_key });

  // The first switch-on indexes the whole vault first (oldest first); wait for that backlog so the test
  // save isn't timed against it.
  // Stops waiting at 0 pending, or once nothing has moved for 3 minutes (a held or failing item), or at 45 minutes.
  const backlogUntil = Date.now() + 45 * 60_000;
  let best = Infinity;
  let movedAt = Date.now();
  for (let last = 0; ; ) {
    const b = (await get("/status")).body;
    const pending: number = b?.pending ?? 0;
    if (pending < best) (best = pending), (movedAt = Date.now());
    if (!pending || Date.now() > backlogUntil || Date.now() - movedAt > 180_000) {
      console.log(`INFO  sync backlog before the test save: ${pending} pending, ${b?.errors?.length ?? 0} with errors${pending ? " (not moving; carrying on)" : ""}`);
      break;
    }
    if (Date.now() - last > 30_000) (last = Date.now()), console.log(`      waiting for the first sync: ${pending} pending, ${b?.errors?.length ?? 0} with errors`);
    await sleep(5000);
  }

  // 1 · save
  const saved = await post("/remember", { text: FACT });
  const id: string = saved.body?.memory?.id ?? "";
  show(saved.status === 200 && !!id, "save (\"remember\") through the live OS", saved.body?.message);
  if (!id) return;
  const item = await indexed(id);
  show(item?.row?.indexed === "confirmed", "indexed in Hindsight", { id, processed_by: model(item?.row?.processed_by) });
  show((await doc(id)).status === 200, "the document is in the pilot's shared pool", { id });

  // 2 · recall with the source
  const ask1 = () => post("/recall", { query: `When does the synthetic Verifier clinic ${RUN} open?` });
  let rec = await ask1();
  let hit = (rec.body?.facts ?? []).find((f: any) => f.id === id);
  for (let i = 0; i < 12 && !hit?.via?.includes("hindsight"); i++) {
    await sleep(5000);
    rec = await ask1();
    hit = (rec.body?.facts ?? []).find((f: any) => f.id === id);
  }
  show(!!hit && hit.via?.includes("hindsight"), "recall finds it through Hindsight, with its source", hit ? { id: hit.id, via: hit.via, source: hit.source } : rec.body);

  // 3 · correction (the page's correction; the old version leaves Hindsight)
  const fix = await post("/correct", { id, text: FIXED });
  const newId: string = fix.body?.id ?? "";
  show(fix.status === 200 && !!newId, "correction", fix.body?.message);
  if (!newId) return;
  const fixedItem = await indexed(newId);
  let oldStatus = 0;
  for (let i = 0; i < 20 && oldStatus !== 404; i++) (oldStatus = (await doc(id)).status), oldStatus !== 404 && (await sleep(3000));
  let ids2: string[] = [];
  for (let i = 0; i < 12 && !ids2.includes(newId); i++) {
    if (i) await sleep(5000);
    ids2 = ((await ask1()).body?.facts ?? []).map((f: any) => f.id);
  }
  show(oldStatus === 404 && ids2.includes(newId) && !ids2.includes(id), "the correction replaced the old version (old document gone, never recalled)", {
    new_id: newId,
    processed_by: model(fixedItem?.row?.processed_by),
    old_document: oldStatus,
  });

  // 4 · single delete (forget kind b) through the approval path
  const ask = await post("/forget", { kind: "memory", target: newId });
  const apr = ask.body?.approval?.id;
  show(ask.status === 202 && !!apr, "forget asks for approval first", ask.body?.message);
  if (!apr) return;
  if (process.argv.includes("--skip-approval")) {
    // A confirmed session belongs to the process that loaded the page (B1), so a second process can't press the card's
    // button even with the cookie. stage-d-acceptance.ts proves the approved single delete from its own process.
    console.log("SKIP  approval and delete (this process didn't load the page; stage-d-acceptance.ts covers the approved delete)");
    return;
  }
  // Track 6's OS: the card's confirm nonce, then its button (the server runs the forget). Stage D's: grant, then forget.
  const card = await post("/approvals/card", { approval_id: apr });
  const withCard = card.status === 200 && !!card.body?.card_nonce;
  const grant = await post("/approvals/grant", withCard ? { approval_id: apr, card_nonce: card.body.card_nonce } : { approval_id: apr });
  show(grant.status === 200, "approved in the owner's own session (a person's own request)", grant.body?.ok ? "granted" : grant.body);
  const done = withCard && grant.body?.result ? { status: grant.body.result.ok ? 200 : 422, body: grant.body.result } : await post("/forget", { kind: "memory", target: newId, approval_id: apr });
  let gone = 0;
  for (let i = 0; i < 20 && gone !== 404; i++) (gone = (await doc(newId)).status), gone !== 404 && (await sleep(3000));
  show(done.status === 200 && gone === 404 && (await doc(id)).status === 404, "deleted from the app and from Hindsight (both versions)", { message: done.body?.message, document: gone });

  // 5 · agents' endpoint and the pilot's MCP tools (no save)
  const mcp = await raw(`${OS}/__memory/mcp`, { method: "POST", headers: { ...host, "User-Agent": "stage-d-verify" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const tools = (mcp.body?.result?.tools ?? []).map((t: any) => t.name);
  show(JSON.stringify(tools) === JSON.stringify(SERVED_TOOLS), "agents' endpoint /__memory/mcp answers (remember, save_to_vault, recall, forget + the read-only tools)", tools);
  // Hindsight's MCP (streamable HTTP): initialize for a session, then list the tools (SSE or JSON reply).
  const hmcp = (sid: string, method: string, id?: number, params?: unknown) =>
    raw(`${PROXY}/mcp/${BANK}/`, {
      method: "POST",
      headers: { Host: PROXY_HOST, Accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) },
      body: { jsonrpc: "2.0", method, ...(id !== undefined ? { id } : {}), ...(params ? { params } : {}) },
    });
  const rpcData = (r: Res) => {
    if (typeof r.body !== "string") return r.body;
    const line = r.body.split(/\r?\n/).find((l) => l.startsWith("data:"));
    try {
      return line ? JSON.parse(line.slice(5).trim()) : null;
    } catch {
      return null;
    }
  };
  if (!CHECK_HINDSIGHT_MCP) {
    console.log("SKIP  Hindsight MCP tool list (not the pilot)");
  } else {
  const init = await hmcp("", "initialize", 1, { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stage-d-verify", version: "1" } });
  const sid = String(init.headers["mcp-session-id"] ?? "");
  if (sid) await hmcp(sid, "notifications/initialized");
  const plist = await hmcp(sid, "tools/list", 2);
  const ptools: string[] = (rpcData(plist)?.result?.tools ?? []).map((t: any) => t.name);
  show(
    ptools.includes("recall") && !ptools.some((t) => ["retain", "sync_retain", "update_memory", "invalidate_memory", "delete_memory", "delete_document"].includes(t)),
    "the pilot's Hindsight MCP is read-only (the Hindsight deploy is live)",
    { status: plist.status, tools: ptools.length ? ptools : rpcData(plist) ?? plist.body },
  );
  }

  const end = (await get("/status")).body;
  console.log(`\nStatus: hindsight=${end?.hindsight} pending=${end?.pending} errors=${end?.errors?.length ?? "?"} saves per model=${JSON.stringify(end?.models ?? {})}`);
}

main()
  .catch((e) => {
    failed++;
    console.error("verification aborted:", (e as Error).message);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed.");
    process.exitCode = failed ? 1 : 0;
  });
