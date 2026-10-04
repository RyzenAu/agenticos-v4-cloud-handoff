import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevShim } from "../jev-hermes";
import { CALLER_KINDS, makeRig } from "./role-matrix";
import { createLocalOwnerProof, ensureLocalOwnerToken, tokenFileProtected, hasLocalOwnerProof, localOwnerHeaders, localOwnerTokenPath, readLocalOwnerToken } from "./local-owner-token";
import { ROUTES } from "./routes";

/**
 * MU_HUB_ROLE=server: a loopback request is the loopback owner only with the local-owner proof. Synthetic tokens in
 * temp folders only; the tests never print a token value.
 */

const rig = makeRig("server");
const pcRig = makeRig("pc");
afterAll(() => {
  rig.close();
  pcRig.close();
});
const MODES = ["none", "wrong"] as const;
const SHARED = ["/__operator/leads", "/__receptionist/dashboard", "/__workspace", "/__memory/buckets", "/__jobs", "/__health", "/__events"];
const LOCAL = ["/__claude_chat", "/__hermes_chat", "/__lead-sites/generate", "/__memory_note", "/__brand_new", "/__claude/v1/models", "/__jev/v1/models"];
const CONSOLE = ["/__design_set_key", "/__hermes_cmd", "/__dev_restart", "/__ccr_pin_routes", "/__hermes_effort"];

describe("server role: loopback without the proof is nobody", () => {
  for (const mode of MODES)
    test(`proof ${mode}: 401 on shared, local-owner and console-only routes, reads and writes, and on the app shell and /__token`, () => {
      for (const path of [...SHARED, ...LOCAL, ...CONSOLE, "/__token", "/"])
        for (const method of path === "/__token" || path === "/" ? ["GET"] : ["GET", "POST"]) {
          const r = rig.decide("loopback-owner", method, path, {}, undefined, { proof: mode });
          expect([mode, method, path, r.status]).toEqual([mode, method, path, 401]);
          expect(r.reached).toBe(false);
        }
    });

  test("every ROUTES entry that is not a self route is 401 without the proof", () => {
    for (const route of Object.keys(ROUTES).filter((r) => ROUTES[r].read !== "self"))
      for (const method of ["GET", "POST"]) {
        if (route === "/__version" && method === "GET") continue; // the data-free liveness, below
        expect([route, method, rig.decide("loopback-owner", method, route, {}, undefined, { proof: "none" }).status]).toEqual([route, method, 401]);
      }
  });

  test("with the proof (header or bearer) it is today's loopback owner: every route, console-only included", () => {
    for (const proof of ["header", "bearer"] as const)
      for (const path of [...SHARED, ...LOCAL, ...CONSOLE, "/__token", "/"])
        for (const method of path === "/__token" || path === "/" ? ["GET"] : ["GET", "POST"]) {
          const r = rig.decide("loopback-owner", method, path, {}, undefined, { proof });
          expect([proof, method, path, r.status]).toEqual([proof, method, path, 200]);
        }
  });

  test("with the proof, the whole generated matrix for the loopback owner equals pc's (it is the owner, nothing else changed)", () => {
    for (const route of Object.keys(ROUTES))
      for (const method of ["GET", "POST"]) {
        const a = rig.decide("loopback-owner", method, route).status;
        const b = pcRig.decide("loopback-owner", method, route).status;
        expect([method, route, a]).toEqual([method, route, b]);
      }
  });

  test("the proof never reaches a handler: both carriers are stripped, and the request is marked proven for the bridges", () => {
    for (const proof of ["header", "bearer", "wrong"] as const) {
      let seen: Record<string, unknown> | null = null;
      let proven = false;
      rig.decide("loopback-owner", "POST", "/__claude_chat", {}, (req) => {
        seen = { ...req.headers };
        proven = hasLocalOwnerProof(req);
      }, { proof });
      if (proof === "wrong") expect(seen).toBeNull(); // refused at the gate: never reached
      else {
        expect(seen).not.toBeNull();
        expect((seen as any).authorization).toBeUndefined();
        expect((seen as any)["x-mu-local-owner"]).toBeUndefined();
        expect(proven).toBe(true);
      }
    }
  });

  test("wrong, stale and rotated tokens are refused; the new one works at once", () => {
    const token = rig.token()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { "x-mu-local-owner": token }, undefined, { proof: "none" }).status).toBe(200);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { "x-mu-local-owner": token.slice(0, -1) + (token.endsWith("A") ? "B" : "A") }, undefined, { proof: "none" }).status).toBe(401);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { "x-mu-local-owner": `${token}x` }, undefined, { proof: "none" }).status).toBe(401);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { "x-mu-local-owner": "" }, undefined, { proof: "none" }).status).toBe(401);
    // Rotate the file: the old value stops working without a restart.
    const old = token;
    const fresh = "R".repeat(43);
    writeFileSync(rig.tokenFile, fresh);
    const later = new Date(Date.now() + 5_000);
    utimesSync(rig.tokenFile, later, later);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { "x-mu-local-owner": old }, undefined, { proof: "none" }).status).toBe(401);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { authorization: `Bearer ${fresh}` }, undefined, { proof: "none" }).status).toBe(200);
    // Deleting it locks every loopback caller out (fail closed) rather than falling back to open.
    rmSync(rig.tokenFile);
    expect(rig.decide("loopback-owner", "GET", "/__operator/leads", { authorization: `Bearer ${fresh}` }, undefined, { proof: "none" }).status).toBe(401);
    // A file that reappears must be PROTECTED like a fresh one to count (final review 5): restore it the way the hub does.
    ensureLocalOwnerToken("/repo", { MU_LOCAL_OWNER_TOKEN_FILE: rig.tokenFile });
  });

  test("a Linux user over mirrored networking: a plain loopback request with any Authorization and any forged Serve headers is nobody", () => {
    for (const extra of [{ authorization: "Bearer sk-local-dummy" }, { "x-forwarded-for": "100.64.0.9" }, { "tailscale-user-login": "owner@example.test", host: "x.ts.net" }, { "x-mu-bridge": "1" }])
      expect(rig.decide("loopback-owner", "POST", "/__claude_chat", extra, undefined, { proof: "none" }).status).toBe(401);
    for (const kind of ["forged-loopback", "forged-lan", "anonymous-lan"] as const) expect(rig.decide(kind, "POST", "/__claude_chat").status).toBe(401);
  });
});

describe("what keeps working on loopback with no local-owner proof", () => {
  test("self routes: /__devices (companion and pairing tokens) and /__away (relay bearer) reach their own handlers", () => {
    for (const path of ["/__devices/companion/heartbeat", "/__devices/companion/pair", "/__devices/pair/redeem", "/__away/telegram"])
      expect([path, rig.decide("loopback-owner", "POST", path, {}, undefined, { proof: "none" }).status]).toEqual([path, 200]);
  });

  test("a companion's bearer token over loopback is still its identity (not stripped, not mistaken for the proof)", () => {
    let auth: unknown = null;
    const r = rig.decide("companion-local", "POST", "/__devices/companion/heartbeat", {}, (req) => (auth = req.headers.authorization));
    expect(r.status).toBe(200);
    expect(String(auth)).toMatch(/^Bearer .{20,}/);
    // ...and it is a companion, not the owner: the gate still sends it to /__devices/companion only.
    expect(rig.decide("companion-local", "POST", "/__claude_chat").status).toBe(403);
    expect(rig.decide("companion-local", "GET", "/__operator/leads").status).toBe(403);
  });

  test("remote founders (Serve) need no local-owner proof", () => {
    expect(rig.decide("paired-founder", "GET", "/__operator/leads").status).toBe(200);
    // A bare tailnet login (no confirmed session) reads no shared data at all (acceptance #18), proof or not.
    expect(rig.decide("tailnet-founder", "GET", "/__operator/leads").status).toBe(403);
    expect(rig.decide("paired-founder", "POST", "/__claude_chat").status).toBe(200);
  });

  test("supervisor liveness: an unproven loopback GET/HEAD /__version answers only {ok:true}; nothing else is open", () => {
    const r = rig.decide("loopback-owner", "GET", "/__version", {}, undefined, { proof: "none" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(rig.decide("loopback-owner", "HEAD", "/__version", {}, undefined, { proof: "none" }).status).toBe(200);
    for (const path of ["/__version/x", "/__health", "/__app_version", "/__token"]) expect([path, rig.decide("loopback-owner", "GET", path, {}, undefined, { proof: "none" }).status]).toEqual([path, 401]);
    expect(rig.decide("loopback-owner", "POST", "/__version", {}, undefined, { proof: "none" }).status).toBe(401);
    // Not for a non-loopback caller, and the liveness never reaches the route handler.
    expect(rig.decide("anonymous-lan", "GET", "/__version").status).toBe(401);
    let reached = false;
    rig.decide("loopback-owner", "GET", "/__version", {}, () => (reached = true), { proof: "none" });
    expect(reached).toBe(false);
    // With the proof the real handler answers, as ever.
    let handler = false;
    rig.decide("loopback-owner", "GET", "/__version", {}, () => (handler = true));
    expect(handler).toBe(true);
  });

  test("the Jev bridge accepts the local-owner token as its one key (the gate marked the request); without it the shim's own token is still required", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-proof-"));
    try {
      const shim = jevShim(root, { key: () => "unused" });
      // The request goes through the real gate first; the shim then sees it as connect would (mount prefix stripped).
      const call = async (proven: boolean, authorization?: string) => {
        const res: any = { statusCode: 0, setHeader() {}, end(b?: string) { this.body = b; } };
        let pending: Promise<unknown> = Promise.resolve();
        rig.decide(
          "loopback-owner", "GET", "/__jev/v1/models", authorization ? { authorization } : {},
          (req) => {
            req.url = "/v1/models";
            pending = shim(req, res, () => undefined) as Promise<unknown>;
          },
          { proof: proven ? "header" : "none" },
        );
        await pending;
        return res.statusCode;
      };
      expect(await call(true)).toBe(200);
      // Not through the server-role gate (pc/cloud, or a request that was never proven): the shim's own token is still required.
      const direct = async (authorization?: string) => {
        const res: any = { statusCode: 0, setHeader() {}, end() {} };
        await shim({ url: "/v1/models", method: "GET", socket: { remoteAddress: "127.0.0.1" }, headers: authorization ? { authorization } : {} } as any, res, () => undefined);
        return res.statusCode;
      };
      expect(await direct()).toBe(401);
      expect(await direct("Bearer nope")).toBe(401);
      // And through the server-role gate without the proof it never gets that far.
      expect(await call(false)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pc and cloud never touch the proof", () => {
  test("pc: no token file is created, a loopback request needs nothing, and a presented header is left alone", () => {
    expect(existsSync(pcRig.tokenFile)).toBe(false);
    expect(pcRig.token()).toBeNull();
    let header: unknown = null;
    expect(pcRig.decide("loopback-owner", "POST", "/__claude_chat", { "x-mu-local-owner": "anything" }, (r) => (header = r.headers["x-mu-local-owner"])).status).toBe(200);
    expect(header).toBe("anything");
    expect(existsSync(pcRig.tokenFile)).toBe(false);
  });
  test("the helpers are inert where there is no token file", () => {
    const root = mkdtempSync(join(tmpdir(), "no-token-"));
    try {
      expect(readLocalOwnerToken(root, {})).toBeNull();
      expect(localOwnerHeaders(root, {})).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-token-"));
  const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "t", "local-owner.token") };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("created once at startup (random, 256 bits), kept across restarts, regenerated when unusable", () => {
    expect(localOwnerTokenPath("/repo", env)).toBe(env.MU_LOCAL_OWNER_TOKEN_FILE);
    expect(localOwnerTokenPath("/repo", {}).replace(/\\/g, "/")).toMatch(/\/repo\/\.operator-data\/local-owner\.token$/);
    expect(localOwnerTokenPath("/repo", { MU_DATA_DIR: "/srv/mu" }).replace(/\\/g, "/")).toMatch(/\/srv\/mu\/local-owner\.token$/);
    const file = ensureLocalOwnerToken("/repo", env);
    const first = readFileSync(file, "utf8");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureLocalOwnerToken("/repo", env)).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(first);
    writeFileSync(file, "short");
    ensureLocalOwnerToken("/repo", env);
    const second = readFileSync(file, "utf8");
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(readLocalOwnerToken("/repo", env)).toBe(second);
    expect(localOwnerHeaders("/repo", env)).toEqual({ "X-MU-Local-Owner": second });
  });

  test("owner-only: Windows ACL has inheritance removed and no broad group; POSIX mode 0600", () => {
    const file = ensureLocalOwnerToken("/repo", env);
    if (process.platform === "win32") {
      const out = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [file], { encoding: "utf8" }).stdout;
      expect(out).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users|NT AUTHORITY\\INTERACTIVE|CREATOR OWNER/i);
      expect(out).toMatch(/NT AUTHORITY\\SYSTEM:\(F\)/);
      expect(out).toMatch(/BUILTIN\\Administrators:\(F\)/);
      expect(out).not.toMatch(/\(I\)/); // nothing inherited
      expect((out.match(/:\(F\)/g) ?? []).length).toBe(3); // the current account, SYSTEM, Administrators
    } else expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("the CLI prints the file path, never the value", () => {
    const file = ensureLocalOwnerToken("/repo", env);
    const token = readFileSync(file, "utf8");
    const r = spawnSync(process.execPath, [join(import.meta.dir, "local-owner-token.ts"), "path"], { encoding: "utf8", env: { ...process.env, MU_LOCAL_OWNER_TOKEN_FILE: file } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(file);
    expect(r.stdout + r.stderr).not.toContain(token);
    expect(spawnSync(process.execPath, [join(import.meta.dir, "local-owner-token.ts")], { encoding: "utf8" }).status).toBe(2);
  });

  test("the token is never logged, and never appears in any response the gate produces", () => {
    const token = rig.token()!;
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => {
      const original = console[m];
      console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      return () => (console[m] = original);
    });
    try {
      const bodies: string[] = [];
      for (const kind of CALLER_KINDS)
        for (const route of ["/__token", "/__claude_chat", "/__design_set_key", "/__version", "/__operator/leads", "/"])
          for (const proof of ["header", "bearer", "wrong", "none"] as const) bodies.push(JSON.stringify(rig.decide(kind, "POST", route, {}, undefined, { proof }).body));
      const proof = createLocalOwnerProof("/repo", env);
      proof.check({ headers: { authorization: `Bearer ${token}` } });
      expect(bodies.join("\n")).not.toContain(token);
      expect(logged.join("\n")).not.toContain(token);
    } finally {
      for (const restore of spies) restore();
    }
  });
});

describe("S1: an existing token file is trusted only if it is protected exactly right", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-token-acl-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const icacls = (...args: string[]) => spawnSync(join(process.env.SystemRoot ?? "C:\Windows", "System32", "icacls.exe"), args, { encoding: "utf8" });
  const warnings = async <T>(fn: () => T) => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    try {
      return { value: fn(), seen };
    } finally {
      console.warn = original;
    }
  };

  test("a correctly protected token is kept across restarts (Hermes stores its value)", async () => {
    const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "keep", "t") };
    const file = ensureLocalOwnerToken("/repo", env);
    const first = readFileSync(file, "utf8");
    for (let i = 0; i < 3; i++) {
      const { seen } = await warnings(() => ensureLocalOwnerToken("/repo", env));
      expect(seen).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(first);
    }
  });

  test("a PLANTED file (well-formed secret, inherited ACL) is not trusted: rotated to a new value with the right ACL, logged without the value", async () => {
    const file = join(dir, "planted", "t");
    mkdirSync(join(dir, "planted"), { recursive: true });
    const planted = "P".repeat(43);
    writeFileSync(file, planted); // inherits the folder's ACL (Windows) / default umask mode (POSIX)
    if (process.platform !== "win32") chmodSync(file, 0o644);
    const { seen } = await warnings(() => ensureLocalOwnerToken("/repo", { MU_LOCAL_OWNER_TOKEN_FILE: file }));
    const now = readFileSync(file, "utf8");
    expect(now).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(now).not.toBe(planted);
    expect(seen.join("\n")).toMatch(/local-owner token rotated: permissions were wrong/);
    expect(seen.join("\n")).not.toContain(planted);
    expect(seen.join("\n")).not.toContain(now);
    expect(tokenFileProtected(file)).toBe(true);
    // The planted value no longer works.
    const proof = createLocalOwnerProof("/repo", { MU_LOCAL_OWNER_TOKEN_FILE: file });
    expect(proof.check({ headers: { "x-mu-local-owner": planted } })).toBe(false);
    expect(proof.check({ headers: { "x-mu-local-owner": now } })).toBe(true);
  });

  test("a good file later widened (an extra ACE, or loosened mode) is rotated at the next start", async () => {
    const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "widen", "t") };
    const file = ensureLocalOwnerToken("/repo", env);
    const before = readFileSync(file, "utf8");
    if (process.platform === "win32") expect(icacls(file, "/grant", "*S-1-1-0:R").status).toBe(0); // Everyone: read
    else chmodSync(file, 0o640);
    expect(tokenFileProtected(file)).toBe(false);
    await warnings(() => ensureLocalOwnerToken("/repo", env));
    expect(readFileSync(file, "utf8")).not.toBe(before);
    expect(tokenFileProtected(file)).toBe(true);
    if (process.platform === "win32") expect(icacls(file).stdout).not.toMatch(/Everyone/i);
  });

  test("inheritance back on (the folder's ACEs flow in) is also refused", async () => {
    if (process.platform !== "win32") return;
    const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir, "inherit", "t") };
    const file = ensureLocalOwnerToken("/repo", env);
    expect(icacls(file, "/inheritance:e").status).toBe(0);
    expect(tokenFileProtected(file)).toBe(false);
    await warnings(() => ensureLocalOwnerToken("/repo", env));
    expect(tokenFileProtected(file)).toBe(true);
  });

  test("creation leaves no temp or reference files behind, and a link at the final name is replaced, not written through", async () => {
    const folder = join(dir, "clean");
    const file = join(folder, "t");
    ensureLocalOwnerToken("/repo", { MU_LOCAL_OWNER_TOKEN_FILE: file });
    expect(readdirSync(folder)).toEqual(["t"]);
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "untouched");
    rmSync(file);
    try {
      symlinkSync(target, file);
    } catch {
      return; // no symlink privilege on this machine
    }
    ensureLocalOwnerToken("/repo", { MU_LOCAL_OWNER_TOKEN_FILE: file });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(readFileSync(file, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("final review 5: a changed token file is re-verified (protection and owner) before it counts", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "owner-token-recheck-"));
  afterAll(() => rmSync(dir2, { recursive: true, force: true }));
  const icacls = (...args: string[]) => spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { encoding: "utf8" });
  const quiet = () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    return { seen, restore: () => (console.warn = original) };
  };

  test("a file replaced or widened while the hub runs stops being proof at once, with ONE log line and no value", () => {
    const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir2, "live", "t") };
    const proof = createLocalOwnerProof("/repo", env);
    const good = readFileSync(proof.path, "utf8");
    expect(proof.peek({ headers: { "x-mu-local-owner": good } })).toBe(true);
    const log = quiet();
    try {
      // Widen the protection (a change by someone who should not be able to): ctime moves, the content may not.
      if (process.platform === "win32") expect(icacls(proof.path, "/grant", "*S-1-1-0:R").status).toBe(0);
      else chmodSync(proof.path, 0o644);
      expect(proof.peek({ headers: { "x-mu-local-owner": good } })).toBe(false);
      expect(proof.peek({ headers: { authorization: `Bearer ${good}` } })).toBe(false);
      expect(proof.check({ headers: { "x-mu-local-owner": good } })).toBe(false);
      expect(log.seen.filter((l) => /local-owner token ignored/.test(l)).length).toBe(1); // once, not per request
      expect(log.seen.join(" | ")).not.toContain(good);
    } finally {
      log.restore();
    }
    // The hub's own restart rotates it back to a protected value.
    const rotated = quiet();
    try {
      ensureLocalOwnerToken("/repo", env);
    } finally {
      rotated.restore();
    }
    const again = createLocalOwnerProof("/repo", env);
    expect(again.peek({ headers: { "x-mu-local-owner": readFileSync(again.path, "utf8") } })).toBe(true);
    expect(again.peek({ headers: { "x-mu-local-owner": good } })).toBe(false);
  });

  test("a protected file with the wrong OWNER is not trusted; the hub's own account, Administrators and SYSTEM are", () => {
    const env = { MU_LOCAL_OWNER_TOKEN_FILE: join(dir2, "owner", "t") };
    const file = ensureLocalOwnerToken("/repo", env);
    expect(tokenFileProtected(file)).toBe(true);
    if (process.platform === "win32") {
      // The reference file's owner is the hub's account (or Administrators when elevated): that, Administrators and SYSTEM pass.
      const hub = "DESKTOP\\hub";
      expect(tokenFileProtected(file, { ownerOf: (p) => (p === file ? "BUILTIN\\Administrators" : hub) })).toBe(true);
      expect(tokenFileProtected(file, { ownerOf: (p) => (p === file ? "NT AUTHORITY\\SYSTEM" : hub) })).toBe(true);
      expect(tokenFileProtected(file, { ownerOf: (p) => (p === file ? hub : hub) })).toBe(true);
      expect(tokenFileProtected(file, { ownerOf: (p) => (p === file ? "DESKTOP-OTHER\\mallory" : hub) })).toBe(false);
      expect(tokenFileProtected(file, { ownerOf: () => null })).toBe(false);
    } else {
      expect(statSync(file).uid).toBe(process.getuid!());
    }
  });
});
