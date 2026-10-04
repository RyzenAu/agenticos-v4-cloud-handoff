// R9 ops: host facts -> plain checks, alert conditions, dedupe (one alert, a reminder every 6 h, one resolved), the owner-only Telegram
// path with its switch, and the `host` component of /__health.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHealth } from "../cloud/health";
import { runEvaluation } from "./host-alerts";
import {
  alertStateFile,
  conditionsFrom,
  describeChecks,
  evaluate,
  healthFile,
  hostComponent,
  messageFor,
  readAlertSettings,
  writeJsonAtomic,
  type AlertState,
  type HostFacts,
  type HostHealthFile,
} from "./host-health";

const TMP_BASE = existsSync("D:/") ? "D:/tmp" : tmpdir();
let dir: string;
beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  dir = mkdtempSync(join(TMP_BASE, "mu-host-health-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = new Date("2026-10-03T08:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const healthy: HostFacts = {
  hub: { answering: true, port: 8081, gaveUp: false, gaveUpAt: null, supervisorTask: "Running, last result 0x41301" },
  hindsight: { answering: true, proxyAnswering: true, state: "running", crashloopLock: false, supervisorTask: "Running, last result 0x41301" },
  searxng: { answering: true },
  hermes: { answering: true },
  wsl: { running: true, keepAliveTask: "Running" },
  staging: { gateway: true, hub: false },
  backup: { present: true, ok: true, verified: true, time: "2026-10-03T06:16:58+00:00", ageHours: 2, error: null },
  disks: [
    { drive: "C:", freeGb: 383.9, sizeGb: 464.7, freePct: 82.6 },
    { drive: "D:", freeGb: 928.2, sizeGb: 931.5, freePct: 99.6 },
  ],
  sessionStore: { readable: true, problem: null },
};
const file = (facts: HostFacts, when = T0): HostHealthFile => ({ version: 1, checkedAt: when.toISOString(), host: "RYZEN-PC", facts });
const withFacts = (patch: Partial<HostFacts>): HostFacts => ({ ...healthy, ...patch });

describe("plain checks", () => {
  test("a healthy host: every check ok, staging is report-only", () => {
    const checks = describeChecks(healthy);
    expect(checks.map((c) => c.id)).toEqual(["hub", "hindsight", "searxng", "hermes", "wsl", "staging", "backup", "disk_C", "disk_D", "sign_in_records"]);
    expect(checks.filter((c) => c.state === "problem")).toEqual([]);
    expect(checks.find((c) => c.id === "staging")!.state).toBe("info");
    expect(checks.find((c) => c.id === "backup")!.detail).toBe("Checked, 2.0 h ago.");
    expect(checks.find((c) => c.id === "disk_C")!.detail).toBe("384 GB free of 465 GB (83%).");
  });

  test("staging down never becomes a problem or a condition", () => {
    const f = withFacts({ staging: { gateway: false, hub: false } });
    expect(describeChecks(f).find((c) => c.id === "staging")!.state).toBe("info");
    expect(conditionsFrom(f)).toEqual([]);
  });

  test("problems are worded plainly", () => {
    const f = withFacts({ hub: { answering: true, gaveUp: true, gaveUpAt: "2026-10-03 18:09:03" }, wsl: { running: false } });
    const c = describeChecks(f);
    expect(c.find((x) => x.id === "hub")!.detail).toContain("Stopped restarting itself at 2026-10-03 18:09:03");
    expect(c.find((x) => x.id === "wsl")!.state).toBe("problem");
  });
});

describe("conditions", () => {
  test("healthy: none", () => expect(conditionsFrom(healthy)).toEqual([]));

  test("supervisor gave up: immediate, and it replaces hub_down", () => {
    const c = conditionsFrom(withFacts({ hub: { answering: false, gaveUp: true } }));
    expect(c.map((x) => [x.id, x.immediate])).toEqual([["hub_gave_up", true]]);
  });

  test("hub or Hindsight not answering wait for the grace period; a crash-loop lock does not", () => {
    expect(conditionsFrom(withFacts({ hub: { answering: false } })).map((x) => [x.id, x.immediate])).toEqual([["hub_down", false]]);
    expect(conditionsFrom(withFacts({ hindsight: { answering: false } })).map((x) => [x.id, x.immediate])).toEqual([["hindsight_down", false]]);
    expect(conditionsFrom(withFacts({ hindsight: { answering: true, crashloopLock: true } })).map((x) => [x.id, x.immediate])).toEqual([["hindsight_down", true]]);
  });

  test("backup: failed, unverified, missing or older than 26 h", () => {
    const b = (backup: HostFacts["backup"]) => conditionsFrom(withFacts({ backup })).map((x) => x.id);
    expect(b({ present: true, ok: false, verified: false, error: "verify failed (exit 1)" })).toEqual(["backup"]);
    expect(b({ present: true, ok: true, verified: false })).toEqual(["backup"]);
    expect(b({ present: false })).toEqual(["backup"]);
    expect(b({ present: true, ok: true, verified: true, ageHours: 26.5 })).toEqual(["backup"]);
    expect(b({ present: true, ok: true, verified: true, ageHours: 25.9 })).toEqual([]);
  });

  test("disk: below 10% or below 20 GB", () => {
    const d = (freeGb: number, sizeGb: number) => conditionsFrom(withFacts({ disks: [{ drive: "C:", freeGb, sizeGb, freePct: (100 * freeGb) / sizeGb }] })).map((x) => x.id);
    expect(d(40, 464.7)).toEqual(["disk_C"]); // 8.6%
    expect(d(19, 100)).toEqual(["disk_C"]); // 19% but under 20 GB
    expect(d(60, 464.7)).toEqual([]);
  });

  test("sign-in records not checked (null from -SkipSessionStore): no check line, no condition", () => {
    const f = withFacts({ sessionStore: null as unknown as HostFacts["sessionStore"] });
    expect(conditionsFrom(f)).toEqual([]);
    expect(describeChecks(f).find((c) => c.id === "sign_in_records")).toBeUndefined();
  });

  test("unreadable sign-in records: immediate", () => {
    expect(conditionsFrom(withFacts({ sessionStore: { readable: false, problem: "devices.json is not valid JSON" } })).map((x) => x.id)).toEqual(["sign_in_records"]);
  });
});

describe("evaluate: dedupe, grace, reminders, resolved", () => {
  test("Hindsight down: nothing for 10 minutes, then one alert", () => {
    const down = file(withFacts({ hindsight: { answering: false } }));
    let r = evaluate(down, null, at(0));
    expect(r.events).toEqual([]);
    r = evaluate(down, r.state, at(5));
    expect(r.events).toEqual([]);
    r = evaluate(down, r.state, at(10));
    expect(r.events.map((e) => [e.kind, e.id])).toEqual([["alert", "hindsight_down"]]);
    r = evaluate(down, r.state, at(15));
    expect(r.events).toEqual([]);
  });

  test("a blip shorter than the grace period says nothing, even when it clears", () => {
    let r = evaluate(file(withFacts({ hub: { answering: false } })), null, at(0));
    r = evaluate(file(healthy), r.state, at(5));
    expect(r.events).toEqual([]);
    expect(r.state.conditions).toEqual({});
  });

  test("one alert, a reminder every 6 hours, then one resolved", () => {
    const bad = file(withFacts({ backup: { present: true, ok: false, verified: false, error: "backup command failed" } }));
    let r = evaluate(bad, null, at(0));
    expect(r.events.map((e) => e.kind)).toEqual(["alert"]);
    const kinds: string[] = [];
    for (let m = 5; m <= 12 * 60; m += 5) {
      r = evaluate(bad, r.state, at(m));
      kinds.push(...r.events.map((e) => e.kind));
    }
    expect(kinds).toEqual(["reminder", "reminder"]); // at 6 h and 12 h
    r = evaluate(file(healthy), r.state, at(12 * 60 + 5));
    expect(r.events).toEqual([]); // clear 1 of 3
    r = evaluate(file(healthy), r.state, at(12 * 60 + 10));
    expect(r.events).toEqual([]); // clear 2 of 3
    r = evaluate(file(healthy), r.state, at(12 * 60 + 15));
    expect(r.events.map((e) => [e.kind, e.id])).toEqual([["resolved", "backup"]]);
    r = evaluate(file(healthy), r.state, at(12 * 60 + 20));
    expect(r.events).toEqual([]);
  });

  test("conditions are independent", () => {
    const f = file(withFacts({ hub: { answering: false, gaveUp: true }, disks: [{ drive: "D:", freeGb: 10, sizeGb: 931.5, freePct: 1 }] }));
    const r = evaluate(f, null, at(0));
    expect(r.events.map((e) => e.id).sort()).toEqual(["disk_D", "hub_gave_up"]);
  });

  test("the message is one text, plain, and says RESOLVED for a clear", () => {
    const r = evaluate(file(withFacts({ hub: { answering: false, gaveUp: true } })), null, at(0));
    const text = messageFor(r.events, "RYZEN-PC");
    expect(text).toStartWith("M&U RYZEN-PC: ALERT: The hub supervisor gave up.");
    expect(text).toContain("Fix: ");
    let cleared = evaluate(file(healthy), r.state, at(5));
    cleared = evaluate(file(healthy), cleared.state, at(10));
    cleared = evaluate(file(healthy), cleared.state, at(15));
    expect(messageFor(cleared.events, "RYZEN-PC")).toBe("M&U RYZEN-PC: RESOLVED: The hub supervisor gave up.");
  });
});

describe("hysteresis: flapping and corrupt state", () => {
  const disk = (freePct: number, freeGb = (464.7 * freePct) / 100): HostFacts => withFacts({ disks: [{ drive: "C:", freeGb, sizeGb: 464.7, freePct }] });
  const run = (facts: HostFacts[], start: AlertState | null = null) => {
    let state = start;
    const kinds: string[] = [];
    facts.forEach((f, i) => {
      const r = evaluate(file(f), state, at(i * 5));
      state = r.state;
      kinds.push(r.events.map((e) => `${e.kind}:${e.id}`).join(",") || "-");
    });
    return { kinds, state: state! };
  };

  test("disk flapping around the limit: one alert, held by the margin, resolved once after 3 clear runs above 12%", () => {
    // 9% alerts; 11% is above the alert line but below the resolve margin, so it stays active; 13% twice then 9% again continues
    // the same alert; three runs at 13% resolve it.
    const { kinds } = run([disk(9), disk(11), disk(9.5), disk(11), disk(13), disk(13), disk(9), disk(13), disk(13), disk(13), disk(13)]);
    expect(kinds).toEqual(["alert:disk_C", "-", "-", "-", "-", "-", "-", "-", "-", "resolved:disk_C", "-"]);
  });

  test("disk margin also applies to GB: 22 GB free on a 150 GB disk (15%) stays low until above 25 GB", () => {
    const big = (gbFree: number) => withFacts({ disks: [{ drive: "D:", freeGb: gbFree, sizeGb: 150, freePct: (100 * gbFree) / 150 }] });
    const { kinds } = run([big(19), big(22), big(22), big(22), big(26), big(26), big(26)]);
    expect(kinds).toEqual(["alert:disk_D", "-", "-", "-", "-", "-", "resolved:disk_D"]);
  });

  test("a disk that was never alerted uses the plain limit (11% is fine)", () => {
    expect(run([disk(11), disk(11)]).kinds).toEqual(["-", "-"]);
  });

  test("backup flapping (fails, succeeds once, fails): one alert, no resolved in between", () => {
    const bad = withFacts({ backup: { present: true, ok: false, verified: false } });
    const { kinds } = run([bad, healthy, bad, healthy, healthy, healthy]);
    expect(kinds).toEqual(["alert:backup", "-", "-", "-", "-", "resolved:backup"]);
  });

  test("while clearing, the alert is still listed on the page", () => {
    const { state } = run([withFacts({ backup: { present: false } }), healthy]);
    expect(state.conditions.backup.clearRuns).toBe(1);
    expect(state.conditions.backup.alertedAt).not.toBeNull();
  });

  test("corrupt state shapes are cleaned, never trusted or thrown on", () => {
    for (const bad of [null, "nonsense", [], { conditions: [] }, { conditions: { backup: { since: "not a date" } } }, { conditions: { "bad id!": { since: T0.toISOString() } } }]) {
      const r = evaluate(file(withFacts({ backup: { present: false } })), bad as unknown as AlertState, at(0));
      expect(r.events.map((e) => e.kind)).toEqual(["alert"]);
      expect(Object.keys(r.state.conditions)).toEqual(["backup"]);
    }
    const partial = { version: 1, evaluatedAt: null, conditions: { backup: { since: T0.toISOString(), alertedAt: T0.toISOString(), notifiedAt: "garbage", clearRuns: -4, title: 7 } } };
    const r = evaluate(file(withFacts({ backup: { present: false } })), partial as unknown as AlertState, at(5));
    expect(r.events).toEqual([]); // already alerted: no repeat
    expect(r.state.conditions.backup.clearRuns).toBe(0);
  });
});

describe("runEvaluation: owner-only Telegram, switch, state saved first", () => {
  const dataDir = () => join(dir, "data");
  const writeHealth = (facts: HostFacts, when = T0) => writeJsonAtomic(healthFile(dataDir()), file(facts, when));
  const recorder = () => {
    const sent: string[] = [];
    return { sent, notifier: async (n: { text: string }) => (sent.push(n.text), { ok: true, detail: "sent" }) };
  };

  test("no report: not ok, nothing sent", async () => {
    const rec = recorder();
    const r = await runEvaluation({ dataDir: dataDir(), now: at(0), send: true, notifier: rec.notifier, env: {} });
    expect(r.ok).toBe(false);
    expect(rec.sent).toEqual([]);
  });

  test("an alert is sent once; the next run sends nothing; the state file names it", async () => {
    writeHealth(withFacts({ hub: { answering: false, gaveUp: true } }));
    const rec = recorder();
    const r1 = await runEvaluation({ dataDir: dataDir(), now: at(0), send: true, notifier: rec.notifier, env: {} });
    expect(r1.telegram).toBe("sent");
    expect(r1.active).toEqual(["hub_gave_up"]);
    const r2 = await runEvaluation({ dataDir: dataDir(), now: at(5), send: true, notifier: rec.notifier, env: {} });
    expect(r2.telegram).toBe("nothing-to-send");
    expect(rec.sent.length).toBe(1);
    const st = JSON.parse(readFileSync(alertStateFile(dataDir()), "utf8")) as AlertState;
    expect(st.conditions.hub_gave_up.alertedAt).toBe(at(0).toISOString());
  });

  test("a corrupt state file: the run still works, alerts once more, and rewrites a valid file", async () => {
    writeHealth(withFacts({ backup: { present: false } }));
    mkdirSync(join(dataDir(), "ops"), { recursive: true });
    writeFileSync(alertStateFile(dataDir()), "{ truncated");
    const rec = recorder();
    const r = await runEvaluation({ dataDir: dataDir(), now: at(0), send: true, notifier: rec.notifier, env: {} });
    expect(r.ok).toBe(true);
    expect(r.events.map((e) => e.id)).toEqual(["backup"]);
    expect((JSON.parse(readFileSync(alertStateFile(dataDir()), "utf8")) as AlertState).conditions.backup.alertedAt).toBe(at(0).toISOString());
    const r2 = await runEvaluation({ dataDir: dataDir(), now: at(5), send: true, notifier: rec.notifier, env: {} });
    expect(r2.events).toEqual([]);
    expect(rec.sent.length).toBe(1);
  });

  test("switched off (file or env): the event is recorded but nothing is sent", async () => {
    writeHealth(withFacts({ disks: [{ drive: "C:", freeGb: 5, sizeGb: 464.7, freePct: 1 }] }));
    writeJsonAtomic(join(dataDir(), "ops", "alert-settings.json"), { telegram: false });
    const rec = recorder();
    const r = await runEvaluation({ dataDir: dataDir(), now: at(0), send: true, notifier: rec.notifier, env: {} });
    expect(r.telegram).toBe("off");
    expect(r.events.map((e) => e.id)).toEqual(["disk_C"]);
    expect(rec.sent).toEqual([]);
    expect(readAlertSettings(dataDir(), {}).telegram).toBe(false);
    rmSync(join(dataDir(), "ops", "alert-settings.json"));
    expect(readAlertSettings(dataDir(), {}).telegram).toBe(true);
    expect(readAlertSettings(dataDir(), { MU_OPS_ALERTS_TELEGRAM: "off" }).telegram).toBe(false);
  });

  test("--no-send: nothing sent, and a failed send never repeats the alert", async () => {
    writeHealth(withFacts({ sessionStore: { readable: false, problem: "devices.json is not valid JSON" } }));
    const rec = recorder();
    const r = await runEvaluation({ dataDir: dataDir(), now: at(0), send: false, notifier: rec.notifier, env: {} });
    expect(r.telegram).toBe("not-sent");
    expect(rec.sent).toEqual([]);
    writeHealth(withFacts({ disks: [{ drive: "D:", freeGb: 1, sizeGb: 931.5, freePct: 0.1 }] }));
    const failing = async () => ({ ok: false, detail: "hermes send exit 1" });
    const r2 = await runEvaluation({ dataDir: dataDir(), now: at(5), send: true, notifier: failing, env: {} });
    expect(r2.telegram).toBe("failed");
    const r3 = await runEvaluation({ dataDir: dataDir(), now: at(10), send: true, notifier: rec.notifier, env: {} });
    expect(r3.events).toEqual([]);
  });

  test("the default notifier targets the owner from people.json and nobody else", async () => {
    const src = readFileSync(join(import.meta.dir, "host-alerts.ts"), "utf8");
    expect(src).toContain("hermesNotifier(() => ownerTelegram(");
    expect(src.match(/hermesNotifier\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/\d{8,}/); // no hard-coded chat id here: the only target is ownerTelegram()
  });
});

describe("/__health host component", () => {
  const dataDir = () => join(dir, "data");

  test("not set up (a PC hub): ok and empty", () => {
    mkdirSync(dataDir(), { recursive: true });
    const c = hostComponent(dataDir(), T0, {});
    expect(c.status).toBe("ok");
    expect(c.checkedAt).toBeNull();
    expect(c.checks).toEqual([]);
  });

  test("fresh healthy report: ok with the plain list", () => {
    writeJsonAtomic(healthFile(dataDir()), file(healthy));
    const c = hostComponent(dataDir(), at(3), {});
    expect(c.status).toBe("ok");
    expect(c.detail).toBe("Every service on the hub host is answering.");
    expect(c.checks.length).toBe(10);
    expect(c.telegram).toBe(true);
  });

  test("stale report: degraded with the task to check", () => {
    writeJsonAtomic(healthFile(dataDir()), file(healthy));
    const c = hostComponent(dataDir(), at(40), {});
    expect(c.status).toBe("degraded");
    expect(c.detail).toContain("last ran 40 min ago");
    expect(c.recovery).toContain("MU Health Check");
  });

  test("an active alert: degraded, listed, and the hub report stays 200-degraded (never failed)", async () => {
    writeJsonAtomic(healthFile(dataDir()), file(withFacts({ hub: { answering: true, gaveUp: false }, hindsight: { answering: true, crashloopLock: true } })));
    await runEvaluation({ dataDir: dataDir(), now: at(0), send: false, env: {} });
    const c = hostComponent(dataDir(), at(1), {});
    expect(c.status).toBe("degraded");
    expect(c.alerts.map((a) => a.id)).toEqual(["hindsight_down"]);
    const report = await collectHealth({
      root: dir,
      env: { MU_DATA_DIR: dataDir(), HINDSIGHT_URL: "off" },
      version: async () => ({ version: "9.9.9", gitSha: "abc1234", dirty: false, buildTime: "" }),
      jobs: () => ({ owner: true }),
      companions: () => ({ online: 0, total: 0 }),
      now: () => at(1),
    });
    expect(report.components.host.status).toBe("degraded");
    expect(report.status).toBe("degraded");
    expect(report.failed.find((f) => f.component === "host")?.detail).toBe("Memory (Hindsight) is down.");
  });

  test("an unreadable report is degraded and flagged, not a crash", () => {
    mkdirSync(join(dataDir(), "ops"), { recursive: true });
    writeFileSync(healthFile(dataDir()), "{ not json");
    const c = hostComponent(dataDir(), T0, {});
    expect(c.status).toBe("degraded");
    expect(c.reportUnreadable).toBe(true);
    expect(c.detail).toBe("The hub computer's health report can't be read.");
  });

  test("page text is plain words: no paths, commands, script or document names in any check line or alert's plain text", async () => {
    const worst = withFacts({
      hub: { answering: false, gaveUp: true, gaveUpAt: "2026-10-03 18:09:03", supervisorTask: "Ready, last result 0x2" },
      hindsight: { answering: false, proxyAnswering: false, crashloopLock: true, supervisorTask: "Ready" },
      searxng: { answering: false },
      hermes: { answering: false },
      wsl: { running: false },
      backup: { present: true, ok: false, verified: false, error: "verify failed: C:\\mu-hub\\data\\x.sqlite differs (scripts/cloud/backup-cli.ts)" },
      disks: [{ drive: "C:", freeGb: 3, sizeGb: 464.7, freePct: 0.6 }],
      sessionStore: { readable: false, problem: "devices.json is not valid JSON" },
    });
    writeJsonAtomic(healthFile(dataDir()), file(worst));
    await runEvaluation({ dataDir: dataDir(), now: at(0), send: false, env: {} });
    const c = hostComponent(dataDir(), at(1), {});
    const pageText = [...c.checks.map((x) => `${x.label} ${x.detail}`), ...c.alerts.map((a) => `${a.title} ${a.plain}`), c.detail].join("\n");
    expect(c.alerts.length).toBeGreaterThanOrEqual(4);
    for (const bad of [/[A-Z]:\\/, /\\MU\\/, /ScheduledTask/, /\.(ps1|ts|md|log|json|sqlite)\b/, /supervisor\.py/, /R8-F-OPS/, /0x[0-9A-F]/]) expect(pageText).not.toMatch(bad);
    // ...while the Event Log / Telegram text keeps the commands
    expect(c.alerts.find((a) => a.id === "hub_gave_up")!.recovery).toContain("Start-ScheduledTask");
  });
});
