// Behavioural test of deploy/bin/restore-data.sh with stubbed systemctl/runuser/chown/mv/smoke in a temp dir (Git Bash or Linux bash).
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const BASH = [process.env.GIT_BASH, "C:/Program Files/Git/bin/bash.exe", "/usr/bin/bash", "/bin/bash"].find((p) => p && existsSync(p));
const TMP_BASE = existsSync("D:/") ? "D:/tmp" : undefined;

function sandbox() {
  if (TMP_BASE) mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE ?? require("node:os").tmpdir(), "mu-rd-")).split("\\").join("/");
  const bin = join(dir, "stubs");
  const dep = join(dir, "deploy/bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dep, { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("id", "echo 0");
  stub("date", "echo T1");
  stub("systemctl", 'echo "systemctl $*" >> "$STUB_LOG"; exit 0');
  stub("chown", '[ -z "$FAIL_CHOWN" ]');
  stub("runuser", 'echo "runuser $*" >> "$STUB_LOG"; if [[ "$*" == *" restore "* ]]; then while [ $# -gt 0 ]; do [ "$1" = --to ] && { mkdir -p "$2"; echo restored > "$2/restored.txt"; }; shift; done; fi; exit 0');
  stub("mv", 'if [ -n "$FAIL_MV" ] && [[ "$*" == *"$FAIL_MV"* ]]; then echo "mv stub failing: $*" >&2; exit 1; fi; exec "$REAL_MV" "$@"');
  copyFileSync(join(root, "deploy/bin/restore-data.sh"), join(dep, "restore-data.sh"));
  writeFileSync(join(dep, "smoke.sh"), '#!/usr/bin/env bash\necho "smoke $*" >> "$STUB_LOG"\n[ -z "$SMOKE_FAIL" ] || { [ -n "$SMOKE_ALWAYS" ] || { rm -f "$SMOKE_FLAG"; [ -e "$SMOKE_FLAG.used" ] && exit 0; touch "$SMOKE_FLAG.used"; }; exit 1; }\nexit 0\n');
  const backup = join(dir, "backup-1");
  mkdirSync(backup);
  writeFileSync(join(backup, "manifest.json"), "{}");
  const base = join(dir, "lib");
  mkdirSync(base);
  const run = (env: Record<string, string> = {}) => {
    const real = Bun.spawnSync([BASH!, "-c", "command -v mv"]).stdout.toString().trim();
    // Git Bash puts /usr/bin first whatever PATH says, so the stubs are put in front by a BASH_ENV file the shell sources at start.
    writeFileSync(join(dir, "env.sh"), 'd="$STUBS"; command -v cygpath >/dev/null 2>&1 && d="$(cygpath -u "$STUBS")"; PATH="$d:$PATH"');
    const r = Bun.spawnSync([BASH!, join(dep, "restore-data.sh"), "staging", backup], {
      env: { ...process.env, STUBS: bin, BASH_ENV: join(dir, "env.sh"), MU_DATA_BASE: base, STUB_LOG: join(dir, "log.txt"), SMOKE_FLAG: join(dir, "smoke-flag"), REAL_MV: real, ...env },
    });
    return { code: r.exitCode, err: r.stderr.toString(), log: existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8") : "" };
  };
  const live = join(base, "staging");
  const seedLive = () => {
    mkdirSync(live);
    writeFileSync(join(live, "orig.txt"), "original");
  };
  return { dir, base, live, run, seedLive, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const has = (p: string) => existsSync(p);

describe.skipIf(!BASH)("restore-data.sh behaviour (stubbed systemctl, runuser, chown, mv, smoke)", () => {
  test("success: restored data live, previous data parked and kept", () => {
    const s = sandbox();
    s.seedLive();
    const r = s.run();
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""]);
    expect(has(join(s.live, "restored.txt"))).toBe(true);
    expect(has(join(s.base, "staging.pre-restore-T1", "orig.txt"))).toBe(true);
    s.done();
  });

  test("THE REVIEW CASE: park mv fails -> real live data stays put and untouched, nothing moved aside, service restarted", () => {
    const s = sandbox();
    s.seedLive();
    const r = s.run({ FAIL_MV: "pre-restore" });
    expect(r.code).not.toBe(0);
    expect(has(join(s.live, "orig.txt"))).toBe(true);
    expect(has(join(s.base, "staging.failed-restore-T1"))).toBe(false);
    expect(r.log.trim().split("\n").filter((l) => l.startsWith("systemctl")).slice(-1)[0]).toBe("systemctl start mu-hub@staging");
    s.done();
  });

  test("move-in fails after a successful park -> previous data back in place, service restarted", () => {
    const s = sandbox();
    s.seedLive();
    const r = s.run({ FAIL_MV: "restoring-T1" });
    expect(r.code).not.toBe(0);
    expect(has(join(s.live, "orig.txt"))).toBe(true);
    expect(has(join(s.base, "staging.pre-restore-T1"))).toBe(false);
    expect(r.log).toContain("systemctl start mu-hub@staging");
    s.done();
  });

  test("chown fails after the swap -> restored data set aside, previous data back", () => {
    const s = sandbox();
    s.seedLive();
    const r = s.run({ FAIL_CHOWN: "1" });
    expect(r.code).not.toBe(0);
    expect(has(join(s.live, "orig.txt"))).toBe(true);
    expect(has(join(s.base, "staging.failed-restore-T1", "restored.txt"))).toBe(true);
    s.done();
  });

  test("smoke fails on the restored data -> same rollback", () => {
    const s = sandbox();
    s.seedLive();
    const r = s.run({ SMOKE_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(has(join(s.live, "orig.txt"))).toBe(true);
    expect(has(join(s.base, "staging.failed-restore-T1", "restored.txt"))).toBe(true);
    s.done();
  });

  test("first restore (no live folder): succeeds, nothing parked; and a failing first restore still restarts the service", () => {
    const s = sandbox();
    const ok = s.run();
    expect(ok.code).toBe(0);
    expect(has(join(s.live, "restored.txt"))).toBe(true);
    expect(has(join(s.base, "staging.pre-restore-T1"))).toBe(false);
    s.done();
    const f = sandbox();
    const bad = f.run({ FAIL_CHOWN: "1" });
    expect(bad.code).not.toBe(0);
    expect(bad.log.trim().split("\n").filter((l) => l.startsWith("systemctl")).slice(-1)[0]).toBe("systemctl start mu-hub@staging");
    f.done();
  });

  test("refuses (and stops nothing) when a target folder already exists, instead of nesting", () => {
    const s = sandbox();
    s.seedLive();
    mkdirSync(join(s.base, "staging.pre-restore-T1"));
    const r = s.run();
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
    expect(r.log).not.toContain("systemctl stop");
    expect(has(join(s.live, "orig.txt"))).toBe(true);
    s.done();
  });
});
