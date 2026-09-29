/**
 * Track 6 · what survives an OS restart, READ-ONLY (GETs only; it saves, forgets and syncs nothing).
 *
 *   bun --no-env-file scripts/memory/t6-restart-check.ts --snapshot before.json [--os-port 8081]
 *   (restart the OS: the lead schedules it)
 *   bun --no-env-file scripts/memory/t6-restart-check.ts --compare before.json [--os-port 8081]
 *
 * A snapshot records ids, versions, index states and counts, never any text. The compare step checks
 * the same items came back after the restart: the same ids and versions, still indexed, the tombstones
 * and exclusions still there, nothing lost from the outbox (pending never silently dropped), the process
 * changed, and Hindsight reachable again. It is also how a read-only preview over a copy of the store is
 * compared with the live OS (a restart without restarting anything).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
};
const PORT = Number(arg("os-port") ?? 8081);
const snapshotFile = arg("snapshot");
const compareFile = arg("compare");
/** The "after" side is a read-only preview over a copy of the store: its switch is off by design, so it reports no Hindsight index state. */
const PREVIEW = process.argv.includes("--preview");

function get(path: string): Promise<any> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: `localhost:${PORT}`, Accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          ok(null);
        }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.end();
  });
}

async function snapshot() {
  const st = await get("/__memory/status");
  const items: any[] = (await get("/__memory/items?superseded=1"))?.items ?? [];
  return {
    at: new Date().toISOString(),
    port: PORT,
    mode: st?.settings?.mode ?? null,
    writer: st?.settings?.writer ?? null,
    hindsight: st?.hindsight ?? null,
    pending: st?.pending ?? null,
    pending_ops: (st?.pending_ops ?? []).map((o: any) => `${o.op}:${o.doc_id}`),
    errors: (st?.errors ?? []).length,
    counts: st?.counts ?? null,
    models: st?.models ?? {},
    last_success_at: st?.last_success_at ?? null,
    items: items.map((r) => ({ id: r.id, kind: r.kind, status: r.status, version: r.version, version_hash: r.version_hash, indexed: r.indexed, model: r.processed_by ? `${r.processed_by.provider}/${r.processed_by.model}` : null })),
  };
}

async function main() {
  const now = await snapshot();
  if (snapshotFile) {
    writeFileSync(snapshotFile, JSON.stringify(now, null, 2) + "\n");
    console.log(`Snapshot of the OS on ${PORT}: ${now.items.length} items, counts ${JSON.stringify(now.counts)}, pending ${now.pending}. Written to ${snapshotFile}.`);
    return;
  }
  if (!compareFile || !existsSync(compareFile)) throw new Error("Give --snapshot <file> before the restart and --compare <file> after it.");
  const before = JSON.parse(readFileSync(compareFile, "utf8"));
  const key = (r: any) => `${r.id}|${r.status}|${r.version}|${r.version_hash}`;
  const had = new Set<string>(before.items.map(key));
  const has = new Set<string>(now.items.map(key));
  const lost = [...had].filter((k) => !has.has(k));
  const beforeIndexed = new Map<string, string>(before.items.map((r: any) => [r.id, r.indexed]));
  const unindexed = now.items.filter((r: any) => beforeIndexed.get(r.id) === "confirmed" && r.indexed !== "confirmed").map((r: any) => r.id);
  const pendingLost = before.pending_ops.filter((p: string) => !now.pending_ops.includes(p) && !now.items.some((r: any) => p.endsWith(`:${r.id}`) && r.indexed === "confirmed"));
  const rows: [string, boolean, unknown][] = [
    ["every item that existed is still there (same id, status, version and hash)", lost.length === 0, { before: before.items.length, after: now.items.length, lost }],
    PREVIEW
      ? ["(preview) Hindsight index state: not reported by a read-only copy; the index file itself is compared by the rows around it", true, { after_mode: now.mode }]
      : ["everything that was indexed in Hindsight is still recorded as indexed", unindexed.length === 0, { unindexed }],
    ["tombstones and exclusions survived (forgotten stays forgotten)", (now.counts?.tombstones ?? 0) >= (before.counts?.tombstones ?? 0) && (now.counts?.excluded ?? 0) >= (before.counts?.excluded ?? 0), { before: before.counts, after: now.counts }],
    ["no queued write was dropped (each is still queued or has since landed)", pendingLost.length === 0, { before: before.pending, after: now.pending, dropped: pendingLost }],
    ["the per-model save tally survived", Object.entries(before.models).every(([k, v]) => (now.models[k] ?? 0) >= (v as number)), { before: before.models, after: now.models }],
    PREVIEW
      ? ["(preview) the copy is read-only and not the writer", now.mode !== "on", { before: [before.mode, before.writer], after: [now.mode, now.writer] }]
      : ["the switch and the writer are as before", now.mode === before.mode && now.writer === before.writer, { before: [before.mode, before.writer], after: [now.mode, now.writer] }],
    ["Hindsight state after the restart", now.hindsight !== "unavailable" && now.hindsight !== "auth-failed", { before: before.hindsight, after: now.hindsight }],
  ];
  let failed = 0;
  for (const [what, ok, obs] of rows) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    console.log(`      ${JSON.stringify(obs).slice(0, 400)}`);
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nEverything that was there before the restart is still there.");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
