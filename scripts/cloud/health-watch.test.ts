import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, newestBackup, runChecks, sendTelegram, type Finding } from "./health-watch";

const TMP_BASE = existsSync("D:/") ? "D:/tmp" : undefined;
let work: string;
beforeEach(() => {
  if (TMP_BASE) mkdirSync(TMP_BASE, { recursive: true });
  work = mkdtempSync(join(TMP_BASE ?? require("node:os").tmpdir(), "mu-watch-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const base = { hub: "http://127.0.0.1:1", maxBackupHours: 26, minFreeGb: 5 };

function backup(name: string, ageHours: number) {
  const d = join(work, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), "{}");
  const t = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(join(d, "manifest.json"), t, t);
}

describe("health watch checks", () => {
  test("ok hub, fresh backup, enough disk: all ok", async () => {
    backup("backup-a", 3);
    const f = await runChecks({ ...base, fetchImpl: reply(200, { status: "ok" }), backupsDir: work, dataDir: work, freeBytes: () => 50e9 });
    expect(f.map((x) => x.level)).toEqual(["ok", "ok", "ok"]);
  });

  test("degraded is reported but is not a page", async () => {
    const f = await runChecks({ ...base, fetchImpl: reply(200, { status: "degraded", failed: [{ component: "hindsight", detail: "down" }] }) });
    expect(f[0]!.level).toBe("degraded");
    expect(decide(f, null, new Date()).alert).toBeNull();
  });

  test("a failed hub (503) names the failing component", async () => {
    const f = await runChecks({ ...base, fetchImpl: reply(503, { status: "failed", failed: [{ component: "stores", detail: "crm.sqlite will not open" }] }) });
    expect(f[0]!.level).toBe("bad");
    expect(f[0]!.line).toContain("crm.sqlite");
  });

  test("unreachable hub is bad", async () => {
    const f = await runChecks({ ...base, fetchImpl: (async () => { throw new TypeError("refused"); }) as unknown as typeof fetch });
    expect(f[0]!.level).toBe("bad");
    expect(f[0]!.line).toContain("unreachable");
  });

  test("a stale backup, a missing backup folder and low disk are each bad", async () => {
    backup("backup-old", 40);
    const stale = await runChecks({ ...base, fetchImpl: reply(200, { status: "ok" }), backupsDir: work });
    expect(stale.find((x) => x.check === "backup")!.level).toBe("bad");
    expect(newestBackup(join(work, "nope"), new Date())).toBeNull();
    const low = await runChecks({ ...base, fetchImpl: reply(200, { status: "ok" }), dataDir: work, freeBytes: () => 1e9 });
    expect(low.find((x) => x.check === "disk")!.level).toBe("bad");
    const unreadable = await runChecks({ ...base, fetchImpl: reply(200, { status: "ok" }), dataDir: work, freeBytes: () => null });
    expect(unreadable.find((x) => x.check === "disk")!.level).toBe("bad");
  });
});

describe("alert only on a change", () => {
  const bad: Finding[] = [{ check: "hub", level: "bad", line: "hub unreachable" }];
  const good: Finding[] = [{ check: "hub", level: "ok", line: "hub ok" }];
  const t0 = new Date("2026-10-01T00:00:00Z");
  const t1 = new Date("2026-10-01T00:02:00Z");

  test("ok -> bad alerts once; staying bad is quiet and keeps the original since", () => {
    const first = decide(bad, { level: "ok", since: t0.toISOString(), lastLines: [] }, t0);
    expect(first.alert).toContain("ALERT");
    const second = decide(bad, first.state, t1);
    expect(second.alert).toBeNull();
    expect(second.state.since).toBe(t0.toISOString());
  });

  test("bad -> ok sends one recovery; ok -> ok is quiet; a first ever run that is ok is quiet", () => {
    expect(decide(good, { level: "bad", since: t0.toISOString(), lastLines: [] }, t1).alert).toContain("RECOVERED");
    expect(decide(good, { level: "ok", since: t0.toISOString(), lastLines: [] }, t1).alert).toBeNull();
    expect(decide(good, null, t1).alert).toBeNull();
    expect(decide(bad, null, t1).alert).toContain("ALERT");
  });
});

describe("telegram route", () => {
  test("not configured without both names; never throws on a network failure; sends the text, not the token, in the body", async () => {
    expect(await sendTelegram("x", {})).toBe("not-configured");
    expect(await sendTelegram("x", { TELEGRAM_BOT_TOKEN: "t" })).toBe("not-configured");
    const seen: Array<{ url: string; body: string }> = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendTelegram("hub down", { TELEGRAM_BOT_TOKEN: "TESTTOKEN", MU_ALERT_TELEGRAM_CHAT_ID: "42" }, ok)).toBe("sent");
    expect(seen[0]!.url).toContain("api.telegram.org");
    expect(seen[0]!.body).not.toContain("TESTTOKEN");
    expect(seen[0]!.body).toContain("hub down");
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await sendTelegram("x", { TELEGRAM_BOT_TOKEN: "t", MU_ALERT_TELEGRAM_CHAT_ID: "1" }, boom)).toBe("failed");
  });
});

describe("watch and restore units", () => {
  const root = join(import.meta.dir, "..", "..");
  test("the watch unit runs the script as muhub with no secrets inline; the timer is every 2 minutes; install.sh installs both", () => {
    const svc = readFileSync(join(root, "deploy/systemd/mu-hub-watch@.service"), "utf8");
    const timer = readFileSync(join(root, "deploy/systemd/mu-hub-watch@.timer"), "utf8");
    expect(svc).toContain("scripts/cloud/health-watch.ts");
    expect(svc).toContain("User=muhub");
    expect(svc).not.toMatch(/TOKEN=|KEY=/);
    expect(timer).toContain("OnUnitActiveSec=2min");
    const install = readFileSync(join(root, "deploy/bin/install.sh"), "utf8");
    expect(install).toContain("mu-hub-watch@.service");
    expect(install).toContain("mu-hub-watch@.timer");
  });

  test("restore-data.sh never deletes live data: it renames it and can swap it back", () => {
    const sh = readFileSync(join(root, "deploy/bin/restore-data.sh"), "utf8");
    expect(sh).not.toMatch(/\brm\s+-/);
    expect(sh).toContain(".pre-restore-");
    expect(sh).toContain("backup-cli.ts");
  });

  test("restore-data.sh: any failure after the stop restores parked data and restarts; no nesting; first restore handled", () => {
    const sh = readFileSync(join(root, "deploy/bin/restore-data.sh"), "utf8");
    expect(sh).toContain("trap rollback ERR");
    expect(sh).toContain("trap rollback ERR INT TERM HUP");
    expect(sh).toMatch(/mv -T "\$live" "\$old"; parked=1/); // parked only after the park succeeded
    expect(sh).toMatch(/mv -T "\$fresh" "\$live"; swapped=1/); // swapped only after the move-in succeeded
    expect(sh).toMatch(/if \[ "\$swapped" = 1 \]; then mv -T "\$live"/); // real data is never moved aside unless swapped
    expect(sh).toMatch(/mv -T "\$live" "\$old"/);
    expect(sh).toMatch(/mv -T "\$fresh" "\$live"/);
    expect(sh).not.toMatch(/^\s*mv "/m); // every mv is -T
    expect(sh).toMatch(/already exists/);
    expect(sh).toMatch(/if \[ -e "\$live" \]; then mv -T/); // missing live folder: nothing to park
    expect(sh).toMatch(/systemctl start "mu-hub@\$inst" \|\| true/); // rollback always restarts
  });

  test("restore-rehearsal.ts refuses a scratch folder that is not throwaway", () => {
    const ts = readFileSync(join(root, "scripts/cloud/restore-rehearsal.ts"), "utf8");
    expect(ts).toContain(".mu-rehearsal-scratch");
    expect(ts).toContain("tmpdir()");
    expect(ts).toMatch(/Refusing --scratch/);
    const r = Bun.spawnSync([process.execPath, join(root, "scripts/cloud/restore-rehearsal.ts"), "--scratch", join(root, "deploy")], { cwd: root });
    expect(r.exitCode).not.toBe(0);
    expect(String(r.stderr)).toContain("Refusing --scratch");
  });
});
