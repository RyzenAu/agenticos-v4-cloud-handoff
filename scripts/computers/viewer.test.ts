import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Executor } from "../../companion/executors";
import { pageTokenFor } from "../identity/principal";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(30_000);

let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const executors = (): Record<string, Executor> => ({
  echo: async () => ({ ok: true, said: "Echoed.", verified: true }),
  "input.click": async () => ({ ok: true, said: "Clicked.", verified: null }),
});

const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const pointer = Buffer.from([5, 1, 0, 10, 0, 10]);
const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);

type Viewer = { ws: WebSocket; received: Buffer[]; closed: Promise<number>; opened: Promise<void> };

/** A browser's WebSocket to the hub's viewer path, carrying that founder's own confirmed session. */
function connect(h: ComputersHub, who: "usman" | "mehroz" | "program", name: string, extra: Record<string, string> = {}): Viewer {
  const headers = { ...h.headers(who, false), ...extra };
  const { host, ...rest } = headers;
  // Bun's WebSocket lets a test set the Host it poses as; the hub reads it like any other request.
  const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(`ws://127.0.0.1:${h.port}/__computers/${name}/vnc`, { headers: { ...rest, host } });
  ws.binaryType = "arraybuffer";
  const received: Buffer[] = [];
  ws.addEventListener("message", (e) => received.push(Buffer.from(e.data as ArrayBuffer)));
  return {
    ws,
    received,
    opened: new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("refused")));
    }),
    closed: new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code))),
  };
}

async function setup(leaseOptions?: { viewerCloseGraceMs?: number }) {
  hub = await startComputersHub({ leaseOptions });
  hub.host.executorsFor = executors;
  hub.host.vncUp = true;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  await hub.computers.tick(); // the first probe: the viewer is offered once a VNC server answers
  expect(hub.computers.view("research").viewer.vnc).toBe(true);
  return hub;
}

const handshake = (v: Viewer) => {
  v.ws.send(Buffer.from("RFB 003.008\n", "latin1"));
  v.ws.send(Buffer.from([1]));
  v.ws.send(Buffer.from([1]));
};

describe("the live viewer over the hub's authenticated WebSocket", () => {
  test("a founder watches: the computer's own handshake and frames arrive; input is dropped until they hold the lease", async () => {
    const h = await setup();
    const v = connect(h, "usman", "research");
    await v.opened;
    await h.waitFor("the server's greeting", () => v.received.length > 0);
    expect(Buffer.concat(v.received).subarray(0, 12).toString("latin1")).toBe("RFB 003.008\n");
    handshake(v);
    v.ws.send(update);
    v.ws.send(key);
    v.ws.send(pointer);
    await h.waitFor("the handshake and the update to reach the computer", () => Buffer.concat(h.host.vncInput).length >= 12 + 1 + 1 + 10);
    await new Promise((r) => setTimeout(r, 100));
    const sent = Buffer.concat(h.host.vncInput);
    expect(sent.length).toBe(12 + 1 + 1 + 10); // version, choice, ClientInit, the update: not the key or the pointer
    expect(sent.subarray(14).equals(update)).toBe(true);
    // Usman takes control through the API: from now on his keys and clicks go through
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    h.host.vncInput.length = 0;
    v.ws.send(key);
    v.ws.send(pointer);
    await h.waitFor("the input to arrive", () => Buffer.concat(h.host.vncInput).length >= 14);
    expect(Buffer.concat(h.host.vncInput).equals(Buffer.concat([key, pointer]))).toBe(true);
    // he returns it: the next key is dropped again
    expect((await h.api("usman", "POST", "/research/return", {})).status).toBe(200);
    h.host.vncInput.length = 0;
    v.ws.send(key);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.host.vncInput).toEqual([]);
    v.ws.close();
  });

  test("the other founder watching sees the screen but can do nothing while someone else holds it", async () => {
    const h = await setup();
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    const v = connect(h, "mehroz", "research");
    await v.opened;
    handshake(v);
    v.ws.send(key);
    v.ws.send(pointer);
    v.ws.send(update);
    await h.waitFor("the update", () => Buffer.concat(h.host.vncInput).length >= 24);
    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(h.host.vncInput).length).toBe(12 + 1 + 1 + 10);
    v.ws.close();
  });

  test("no session, a program, a cross-site page, or an unknown computer: refused before any bytes move", async () => {
    const h = await setup();
    await expect(connect(h, "program", "research").opened).rejects.toThrow(); // a local program: no confirmed session
    await expect(connect(h, "usman", "research", { origin: "http://evil.example" }).opened).rejects.toThrow(); // cross-site page
    await expect(connect(h, "usman", "nosuch").opened).rejects.toThrow();
    // a tailnet login with no paired session is only a process
    const process = { host: `hub.tail-test.ts.net:8443`, "tailscale-user-login": "partner@example.test", "x-forwarded-for": "100.64.0.12" };
    const ws = new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(`ws://127.0.0.1:${h.port}/__computers/research/vnc`, { headers: process });
    await expect(new Promise((resolve, reject) => (ws.addEventListener("open", resolve), ws.addEventListener("error", () => reject(new Error("refused")))))).rejects.toThrow();
    expect(h.host.vncInput).toEqual([]);
    void pageTokenFor;
  });

  test("a computer with no VNC server has no viewer, and says so", async () => {
    hub = await startComputersHub();
    hub.host.executorsFor = executors;
    await hub.api("usman", "POST", "/", { name: "research" });
    await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
    await expect(connect(hub, "usman", "research").opened).rejects.toThrow();
    expect(hub.computers.view("research").viewer.vnc).toBe(false);
  });
});

describe("leaving the viewer gives the computer back promptly (round 3)", () => {
  const holder = (h: ComputersHub) => h.computers.leases.current(h.computers.view("research").id!)?.holder;

  test("closing the last viewer socket releases the person's control after the grace, not after the lease expires", async () => {
    const h = await setup({ viewerCloseGraceMs: 80 });
    const v = connect(h, "usman", "research");
    await v.opened;
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    expect(holder(h)?.kind).toBe("person");
    v.ws.close();
    await h.waitFor("control released", () => !holder(h));
    expect(h.computers.view("research").state).toBe("online");
  });

  test("a viewer that comes back inside the grace keeps control (a page reload or a network blip)", async () => {
    const h = await setup({ viewerCloseGraceMs: 400 });
    const v1 = connect(h, "usman", "research");
    await v1.opened;
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    v1.ws.close();
    const v2 = connect(h, "usman", "research");
    await v2.opened;
    await new Promise((r) => setTimeout(r, 700));
    expect(holder(h)?.kind).toBe("person");
    v2.ws.close();
    await h.waitFor("control released after the last socket", () => !holder(h));
  });

  test("a page that is still heartbeating keeps control when its socket drops (it holds the lease the snapshot way)", async () => {
    const h = await setup({ viewerCloseGraceMs: 300 });
    const v = connect(h, "usman", "research");
    await v.opened;
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    v.ws.close();
    await new Promise((r) => setTimeout(r, 80));
    expect((await h.api("usman", "POST", "/research/lease/renew", {})).json.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(holder(h)?.kind).toBe("person");
  });

  test("the other founder closing their watch-only viewer never releases someone else's control", async () => {
    const h = await setup({ viewerCloseGraceMs: 80 });
    expect((await h.api("usman", "POST", "/research/takeover", {})).json.state).toBe("held");
    const m = connect(h, "mehroz", "research");
    await m.opened;
    m.ws.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(holder(h)?.kind).toBe("person");
  });
});
