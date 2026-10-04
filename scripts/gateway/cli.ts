/**
 * The founder's console for the Dot gateway. Run on the hub machine, as the account that runs the hub (it writes
 * MU_DATA_DIR/gateway/control.json; nobody else can).
 *
 *   bun scripts/gateway/cli.ts enrol-code --by usman [--minutes 10] [--identity-days 30] [--label "Dot"] [--session-hours 12 | --session-minutes 3] [--idle-minutes 120] [--origin https://...]
 *   bun scripts/gateway/cli.ts identities                       Dot's identities (also in System, Devices and people)
 *   bun scripts/gateway/cli.ts revoke-identity <id> | --all     immediate: its reconnect key and every access session it holds
 *   bun scripts/gateway/cli.ts grant operate --by usman [--hours 8 | --until-identity]   the operating set; --until-identity: as long as Dot's identity
 *   bun scripts/gateway/cli.ts renew --by usman [--days 30]    extend every active identity AND the grants in force, together
 *   bun scripts/gateway/cli.ts grant crm.write files.write --by usman [--hours 8]
 *   bun scripts/gateway/cli.ts grant debug --by usman [--hours 8]   ops.logs + ops.restart (not part of operate)
 *   bun scripts/gateway/cli.ts revoke-grant crm.write | --all
 *   bun scripts/gateway/cli.ts capabilities                     every capability and what it opens
 *   bun scripts/gateway/cli.ts authorise-mailbox <address> --by usman    mail.read / mail.draft may use this mailbox (none by default)
 *   bun scripts/gateway/cli.ts revoke-mailbox <address>        | mailboxes
 *   bun scripts/gateway/cli.ts sessions
 *   bun scripts/gateway/cli.ts revoke-session <id> | --all
 *   bun scripts/gateway/cli.ts kill on|off        (the emergency switch: the gateway and the hub refuse everything)
 *   bun scripts/gateway/cli.ts status
 *   bun scripts/gateway/cli.ts audit [--tail 40]
 *
 * It prints an enrolment code once (that is its job, like scripts/identity/pair-code.ts). It never prints a cookie, a
 * session token, a reconnect key or the assertion key (it never has them: only hashes are stored); `status` prints the key
 * file's PATH only.
 */
import { resolve } from "node:path";
import { readAudit } from "./audit";
import { gatewayDir, LIMITS } from "./config";
import { CAPABILITIES, CAPABILITY_SUMMARY, DEBUG_SET, GRANTABLE, isCapability, OPERATE_SET, type Capability } from "./policy";
import { normaliseMailbox } from "./mail";
import { gatewaySecretPath } from "./secret";
import { ControlFile, effectiveCapabilities, isKilled, listIdentities, renewAccess, SessionFile, setKilled } from "./store";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const FOUNDERS = ["usman", "mehroz"];

export function runCli(argv: string[], dir: string, print: (line: string) => void = console.log): number {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && rest[i - 1] !== "--all"));
  const control = new ControlFile(dir);
  const founder = () => {
    const by = (flag("by") ?? "").toLowerCase();
    if (!FOUNDERS.includes(by)) throw new Error(`Say which founder is doing this: --by ${FOUNDERS.join("|")}`);
    return by;
  };
  const when = (t: number) => new Date(t).toLocaleString("en-AU");
  try {
    switch (command) {
      case "enrol-code": {
        const by = founder();
        const out = control.mintCode({ by, minutes: num(flag("minutes")), sessionHours: num(flag("session-hours")), sessionMinutes: num(flag("session-minutes")), idleMinutes: num(flag("idle-minutes")), identityDays: num(flag("identity-days")), label: flag("label") });
        const minutes = Math.max(1, Math.round((out.expiresAt - Date.now()) / 60_000));
        print(`One-time sign-in code for Dot: ${out.code}   (single use, valid about ${minutes} minutes)`);
        print(`It creates an identity that lasts ${num(flag("identity-days")) ?? LIMITS.identityDaysDefault} days (its reconnect key is shown to Dot once, at sign-in). Revoke it any time: revoke-identity <id>.`);
        const origin = (flag("origin") ?? process.env.MU_GATEWAY_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
        if (origin) print(`Link (the code is after the #, so it is never sent in a URL): ${origin}/gw/enrol#code=${out.code}`);
        print("Give it to Dot over a private channel. It signs Dot in read-only; grant capabilities separately.");
        return 0;
      }
      case "identities": {
        const rows = listIdentities(dir);
        if (!rows.length) print("No gateway identities. Enrol Dot with: enrol-code --by <founder>");
        for (const i of rows) print(`${i.id}  ${i.state.padEnd(8)} "${i.label}"  enrolled ${when(i.createdAt)} by ${i.enrolledBy}  expires ${when(i.expiresAt)}  active sessions ${i.activeSessions}  renewed ${i.renewals}x${i.lastSeenAt ? `  last seen ${when(i.lastSeenAt)}` : ""}`);
        return 0;
      }
      case "revoke-identity": {
        if (rest.includes("--all")) {
          const rows = listIdentities(dir).filter((i) => i.state === "active");
          for (const i of rows) control.revokeIdentity(i.id);
          control.revokeAllSessions();
          print(`Revoked ${rows.length} ${rows.length === 1 ? "identity" : "identities"}, every session and every unused code. Dot is signed out everywhere within about a second and needs a new sign-in code.`);
          return 0;
        }
        const id = positional[0];
        if (!id || !/^[a-f0-9]{8,32}$/.test(id)) throw new Error("Give the identity id from `identities`, or --all.");
        if (!listIdentities(dir).some((i) => i.id === id)) throw new Error("No such identity. See `identities`.");
        control.revokeIdentity(id);
        print(`Revoked identity ${id}. Its reconnect key no longer works and every access session it holds is refused from the next request.`);
        return 0;
      }
      case "renew": {
        const by = founder();
        const out = renewAccess(dir, by, num(flag("days")) ?? 30);
        for (const i of out.identities) print(`Identity ${i.id} now lasts until ${when(i.expiresAt)}.`);
        for (const g of out.grants) print(`  ${g.capability} until ${when(g.expiresAt)}`);
        print(out.grants.length ? `Renewed by ${by}. Grants are capped at ${LIMITS.grantHoursMax / 24} days from now.` : `Renewed by ${by}. No capability was in force to renew; grant them with: grant operate --by ${by} --until-identity`);
        return 0;
      }
      case "authorise-mailbox": {
        const address = normaliseMailbox(positional[0]);
        if (!address) throw new Error("Give the mailbox address, e.g. authorise-mailbox hello@example.com.au --by usman");
        const row = control.authoriseMailbox(address, founder());
        print(`Authorised ${row.address} for the gateway (mail.read lists and reads it; mail.draft saves reply drafts as CRM records). Sending stays yours. Revoke: revoke-mailbox ${row.address}`);
        return 0;
      }
      case "revoke-mailbox": {
        const address = normaliseMailbox(positional[0]);
        if (!address) throw new Error("Give the mailbox address.");
        control.revokeMailbox(address);
        print(`Revoked ${address}: refused from the next request.`);
        return 0;
      }
      case "mailboxes": {
        const rows = control.read().mailboxes ?? [];
        if (!rows.length) print("No mailbox is authorised for the gateway.");
        for (const m of rows) print(`${m.address}  authorised by ${m.by} on ${when(m.at)}`);
        return 0;
      }
      case "capabilities": {
        for (const cap of CAPABILITIES) print(`${cap.padEnd(14)} ${cap === "view" ? "(every session)" : OPERATE_SET.includes(cap) ? "(in `grant operate`)" : DEBUG_SET.includes(cap) ? "(in `grant debug`)" : "(granted on its own)"}  ${CAPABILITY_SUMMARY[cap]}`);
        return 0;
      }
      case "grant": {
        const wanted: Capability[] = positional.flatMap((word) => (word === "operate" ? [...OPERATE_SET] : word === "debug" ? [...DEBUG_SET] : word.split(",").filter(Boolean).map((w) => w as Capability)));
        if (!wanted.length || wanted.some((cap) => !isCapability(cap) || !GRANTABLE.includes(cap))) throw new Error(`Grantable capabilities: operate (= ${OPERATE_SET.join(", ")}), debug (= ${DEBUG_SET.join(", ")}), or any of ${GRANTABLE.join(", ")}`);
        const by = founder();
        // --until-identity: the grant ends with Dot's identity (the latest active one), still capped at LIMITS.grantHoursMax.
        let until: number | undefined;
        if (rest.includes("--until-identity")) {
          const active = listIdentities(dir).filter((i) => i.state === "active");
          if (!active.length) throw new Error("No active identity: enrol Dot first, then grant --until-identity.");
          until = Math.max(...active.map((i) => i.expiresAt));
        }
        for (const capability of [...new Set(wanted)]) {
          const row = control.grant({ capability, by, ...(until !== undefined ? { until } : { hours: num(flag("hours")) }) });
          print(`Granted ${capability} to Dot until ${when(row.expiresAt)} (by ${row.by}).`);
        }
        print("In force from Dot's next request (a browser session's cookie rotates).");
        return 0;
      }
      case "revoke-grant": {
        const targets: Capability[] = rest.includes("--all") ? [...GRANTABLE] : positional.filter(isCapability);
        if (!targets.length) throw new Error(`Capabilities: ${GRANTABLE.join(", ")}, or --all`);
        for (const capability of targets) control.revokeGrant(capability);
        print(`Revoked ${rest.includes("--all") ? "every granted capability" : targets.join(", ")}. Refused from the next request; open connections that needed it close within about a second.`);
        return 0;
      }
      case "sessions": {
        const c = control.read();
        const now = Date.now();
        const rows = new SessionFile(dir).list();
        if (!rows.length) print("No sessions.");
        for (const s of rows) {
          const state = s.endedAt ? `ended (${s.endReason})` : c.revokedSessions[s.id] !== undefined || s.createdAt <= c.revokeAllBefore ? "revoked" : now >= s.expiresAt ? "expired" : now - s.lastSeenAt >= s.idleMs ? "idle-expired" : "active";
          print(`${s.id}  ${state.padEnd(16)} created ${when(s.createdAt)}  last seen ${when(s.lastSeenAt)}  expires ${when(s.expiresAt)}  code from ${s.enrolledBy}`);
        }
        return 0;
      }
      case "revoke-session": {
        if (rest.includes("--all")) {
          control.revokeAllSessions();
          print("Revoked every session and every unused code. Open pages and streams end within about a second.");
          return 0;
        }
        const id = positional[0];
        if (!id || !/^[a-f0-9]{16,64}$/.test(id)) throw new Error("Give the session id from `sessions`, or --all.");
        control.revokeSession(id);
        print(`Revoked session ${id}. Its open pages and streams end within about a second.`);
        return 0;
      }
      case "kill": {
        const word = positional[0];
        if (word !== "on" && word !== "off") throw new Error("kill on | kill off");
        setKilled(dir, word === "on", "cli");
        print(word === "on" ? "KILL SWITCH ON: the gateway and the hub refuse every gateway request. Also turn the Funnel off (deploy/windows/gateway/README.md)." : "Kill switch off.");
        return 0;
      }
      case "status": {
        const c = control.read();
        const { caps, grantedBy } = effectiveCapabilities(c);
        print(`kill switch: ${isKilled(dir) ? "ON (everything refused)" : "off"}`);
        print(`capabilities in force: ${caps.map((cap) => (grantedBy[cap] ? `${cap} (by ${grantedBy[cap]}, until ${when(c.grants.find((g) => g.capability === cap)!.expiresAt)})` : cap)).join(", ")}`);
        print(`unused sign-in codes: ${c.codes.filter((r) => r.expiresAt > Date.now()).length} (a used code stays listed until it expires)`);
        print(`data: ${dir}`);
        print(`assertion key file: ${gatewaySecretPath(dir)} (path only; the value is never shown)`);
        print(`defaults: code ${LIMITS.codeMinutesDefault} min, session ${LIMITS.sessionHoursDefault} h absolute / ${LIMITS.idleMinutesDefault} min idle, grant ${LIMITS.grantHoursDefault} h`);
        return 0;
      }
      case "audit": {
        const tail = Math.max(1, Math.min(500, num(flag("tail")) ?? 40));
        for (const e of readAudit(dir).slice(-tail)) print(JSON.stringify(e));
        return 0;
      }
      default:
        print("usage: bun scripts/gateway/cli.ts enrol-code|identities|revoke-identity|grant|renew|revoke-grant|capabilities|authorise-mailbox|revoke-mailbox|mailboxes|sessions|revoke-session|kill|status|audit   (see the top of the file)");
        return 2;
    }
  } catch (error) {
    print((error as Error).message);
    return 1;
  }
}

const num = (v: string | undefined) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

if (import.meta.main) process.exit(runCli(process.argv.slice(2), gatewayDir(REPO_ROOT)));
