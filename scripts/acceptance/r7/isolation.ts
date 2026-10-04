#!/usr/bin/env bun
/**
 * Round 7 acceptance, personal-device isolation rows (ISO-1..4), the parts a synthetic hub can show through the app's own target resolver
 * (GET /__commands/target, the same resolveTarget the command path uses) and the job/approval APIs:
 *   - pc role: Usman's "here" is his own device; "on Mehroz's PC" is refused by name; a shared computer is reachable by its exact name only;
 *   - server role (--role server on the same synthetic data): the hub (the Ryzen desktop in production) is never a target or a fallback.
 * What this does NOT prove: that a process on the bot computer cannot reach a personal device, or that the two founders' companions are isolated
 * at the OS level. A browser profile or a data folder is a separation of STATE, not a security boundary; the proof is process and filesystem
 * evidence on the real machines (see ACCEPTANCE-R7.md, ISO rows).
 *
 *   bun scripts/acceptance/r7/isolation.ts [--hub http://127.0.0.1:8128]     (run once in pc role; then restart the hub with --role server and run again)
 */
import { api, closeAll, expect, HUB, me, record, session, SIZES, writeResults } from "./lib";

const ROW = "ISO";
let roleTag = "unknown";

async function main() {
  const s = await session(SIZES[0]);
  const p = s.page;
  await p.goto(`${HUB}/agents/workspace`, { waitUntil: "domcontentloaded" });
  const health = (await api(p, "GET", "/__health")).json;
  const role = health?.hubRole ?? "unknown";
  roleTag = role;
  const who = await me(p);
  const target = async (spoken: string) => {
    const r = await api(p, "GET", `/__commands/target?spoken=${encodeURIComponent(spoken)}`);
    return { status: r.status, ...(r.json ?? {}) };
  };
  if (!who.actor) {
    // Server role: a loopback browser without the local-owner proof is nobody (docs/IDENTITY-ROUTES.md), and a person needs a tailnet login.
    record(ROW, `hub role ${role}: this browser is nobody, so no person-scoped check can run here`, "BLOCKED", { who, health: health?.error ?? null });
    const program = await fetch(`${HUB}/__commands/target?spoken=here`);
    expect(ROW, "a program with no session cannot read targets (401/403)", [401, 403].includes(program.status), { status: program.status });
    record(ROW, "ISO-4 (server role): the hub is never a target or a fallback", "BLOCKED", "needs a confirmed founder session in the server role (tailnet): owner-run on Ryzen, or the lead's staging hub; unit-covered by scripts/devices/server-role.test.ts");
    return;
  }
  record(ROW, `hub role ${role}; caller`, "PASS", who);
  const here = await target("here");
  const other = await target("on Mehroz's PC");
  const otherLaptop = await target("on mehroz's laptop");
  const sharedByName = await target("the research computer");
  const sharedById = await target("computer:research");
  if (role === "pc") {
    expect(ROW, "ISO-1 (pc role): Usman's 'here' resolves to his own device", here.status === 200 && JSON.stringify(here).includes("usman"), here);
  } else {
    expect(ROW, `ISO-4 (${role} role): the hub itself is never a target or a fallback ('here' finds no device of the caller's)`, !JSON.stringify(here).includes("usman-pc"), here);
  }
  expect(ROW, "ISO-3: 'on Mehroz's PC' and 'on mehroz's laptop' are refused for Usman (named as someone else's, never run)", ![other, otherLaptop].some((t) => /"ok":true/.test(JSON.stringify(t))) && /belongs to mehroz|isn.t yours|own devices/i.test(JSON.stringify(other)), { other, otherLaptop });
  record(ROW, "ISO-2: a shared bot computer by name / exact id (both founders may)", /"ok":true/.test(JSON.stringify(sharedByName)) ? "PASS" : "BLOCKED", { sharedByName, sharedById, note: "this hub has no shared computers (host none): a refusal 'no such shared computer' is the correct answer here, so the positive half is BLOCKED" });
  // A program with no session cannot use the resolver or start device work
  const program = await fetch(`${HUB}/__commands/target?spoken=here`);
  expect(ROW, "a program with no session cannot read targets (401/403)", [401, 403].includes(program.status), { status: program.status });
  for (const step of ["ISO-1 real: Usman's companion runs a command on his own PC; Mehroz's companion on his own (two real devices)", "ISO-3 real: Mehroz asks for Usman's PC and is refused before dispatch AND at execution (companion ledger shows nothing)", "ISO-4 real: on Ryzen (server role) no agent job, takeover or command targets the Ryzen physical desktop (process list and companion ledger)", "ISO process/filesystem proof: the bot computers' run-as users cannot read the founders' home folders or companion tokens (ls/icacls/id evidence)"])
    record(ROW, step, "OUT OF SCOPE", "owner-run on real devices (Mehroz's PC, Ryzen): not reachable from this worktree");
}

try {
  await main();
} catch (e) {
  record(ROW, "ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults(`isolation-${roleTag}`);
  await closeAll();
}
