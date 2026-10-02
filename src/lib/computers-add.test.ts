// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import { COMPUTER_NAME, hostLabel, hostProblem, nameProblem, provisionComputer, provisionSequence, suggestPair, type HostEntry } from "./computers-client";

const host = (kind: string, ok: boolean, name: string, extra: Partial<HostEntry["check"]> = {}): HostEntry => ({ kind, check: { ok, host: name, present: [], missing: [], installCommand: null, notes: [], ...extra } });
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));
const answer = (replies: { status: number; json: unknown }[]) => {
  const sent: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("__token")) return new Response(JSON.stringify({ token: "t" }), { headers: { "content-type": "application/json" } });
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = replies.shift() ?? { status: 200, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return sent;
};

describe("host words and problems", () => {
  test("plain labels: this PC's WSL, the reported host name for ssh hosts", () => {
    expect(hostLabel(host("wsl-local", true, "DESKTOP-D8QCTMG"))).toBe("This PC (WSL)");
    expect(hostLabel(host("vps-ssh", true, "Ryzen-PC"))).toBe("Ryzen-PC");
  });
  test("a host that is not ok says what is missing and cannot be chosen; an ok one is selectable", () => {
    expect(hostProblem(host("vps-ssh", true, "Ryzen-PC"))).toBeNull();
    expect(hostProblem(host("vps-ssh", false, "Ryzen-PC", { missing: ["Xvfb", "fonts"], notes: ["the SSH tunnel is down"] }))).toBe("missing Xvfb, fonts; the SSH tunnel is down");
    expect(hostProblem(host("wsl-local", false, "x"))).toBe("it didn't answer");
  });
});

describe("the name rule is the server's", () => {
  test("accepts what the server accepts and refuses the rest, with a reason", () => {
    for (const ok of ["research", "r5-local-check", "a", "9lives", "x".repeat(32)]) expect(COMPUTER_NAME.test(ok)).toBe(true);
    for (const bad of ["Research", "-lead", "has space", "under_score", "", "x".repeat(33)]) expect(COMPUTER_NAME.test(bad)).toBe(false);
    expect(nameProblem("", [])).toMatch(/Give it a name/);
    expect(nameProblem("Bad Name", [])).toMatch(/lowercase letters, digits or hyphens/);
    expect(nameProblem("research", ["research"])).toBe('A computer called "research" already exists.');
    expect(nameProblem("builder", ["research"])).toBeNull();
  });
});

describe("the Research and Builder suggestion", () => {
  const ryzen = host("vps-ssh", true, "Ryzen-PC");
  test("appears only when a host is available (the SSH host preferred) and neither computer exists", () => {
    expect(suggestPair([host("wsl-local", true, "pc"), ryzen], [])?.check.host).toBe("Ryzen-PC");
    expect(suggestPair([ryzen], ["research"])).toBeNull();
    expect(suggestPair([ryzen], ["builder"])).toBeNull();
    expect(suggestPair([host("vps-ssh", false, "Ryzen-PC", { missing: ["node"] })], [])).toBeNull();
    expect(suggestPair([host("wsl-local", true, "pc")], [])?.kind).toBe("wsl-local"); // round 6b: this PC's WSL gets the same one-click pair when no SSH host is ready
  });
});

describe("provisioning and refusals", () => {
  test("sends name, host and label to POST /__computers; an empty label is left out", async () => {
    const sent = answer([{ status: 200, json: { computer: {} } }, { status: 200, json: {} }]);
    expect(await provisionComputer({ name: "research", adapter: "vps-ssh", label: "Research" })).toEqual({ ok: true, name: "research" });
    await provisionComputer({ name: "builder", adapter: "vps-ssh", label: "  " });
    expect(sent[0]).toEqual({ url: "/__computers", body: { name: "research", adapter: "vps-ssh", label: "Research" } });
    expect(sent[1].body).toEqual({ name: "builder", adapter: "vps-ssh" });
  });

  test("the server's exact refusal comes back, the human-only one included", async () => {
    answer([{ status: 403, json: { error: "Only a person using a confirmed browser or paired device can do that, not a program." } }]);
    expect(await provisionComputer({ name: "research", adapter: "vps-ssh" })).toEqual({ ok: false, name: "research", message: "Only a person using a confirmed browser or paired device can do that, not a program." });
    answer([{ status: 409, json: { error: 'A computer called "research" already exists.' } }]);
    expect((await provisionComputer({ name: "research", adapter: "vps-ssh" }))).toMatchObject({ ok: false, message: 'A computer called "research" already exists.' });
    answer([{ status: 502, json: {} }]);
    expect(await provisionComputer({ name: "x", adapter: "a" })).toMatchObject({ ok: false, message: "That didn't work (502)." });
  });

  test("a sequence goes one after the other and stops at the first refusal, naming it and what was made before", async () => {
    const sent = answer([{ status: 200, json: {} }, { status: 502, json: { error: "provisioning failed: the SSH tunnel to the host did not come up" } }]);
    const r = await provisionSequence([{ name: "research", adapter: "vps-ssh" }, { name: "builder", adapter: "vps-ssh" }, { name: "third", adapter: "vps-ssh" }]);
    expect(r).toEqual({ ok: false, made: ["research"], message: "builder: provisioning failed: the SSH tunnel to the host did not come up (research was already created.)" });
    expect(sent.map((s) => s.body.name)).toEqual(["research", "builder"]); // the third was never tried
    answer([{ status: 200, json: {} }, { status: 200, json: {} }]);
    expect(await provisionSequence([{ name: "research", adapter: "a" }, { name: "builder", adapter: "a" }])).toEqual({ ok: true, made: ["research", "builder"], message: "Created research and builder." });
  });
});
