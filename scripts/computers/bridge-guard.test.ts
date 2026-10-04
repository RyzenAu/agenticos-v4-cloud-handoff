import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { BRIDGE_HEADER, forwardHeaders } from "./bridge";
import { startComputersHub, type ComputersHub } from "./test-harness";

/** Anything that can reach the computers bridge's port on another host must be able to do ONE thing: pair and drive a cloud computer. */

setDefaultTimeout(30_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

const post = (h: ComputersHub, path: string, body: unknown, bridged: boolean, token?: string) =>
  fetch(`${h.base}/__devices/companion/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: `127.0.0.1:${h.port}`, ...(bridged ? { "x-mu-bridge": "1" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe("the bridge stamps its traffic", () => {
  test("every forwarded request carries x-mu-bridge: 1, and a caller's own copy is replaced, never trusted to say 'not bridged'", () => {
    expect(BRIDGE_HEADER).toBe("x-mu-bridge");
    expect(forwardHeaders({ host: "a" }, "h:1")["x-mu-bridge"]).toBe("1");
    expect(forwardHeaders({ host: "a", "x-mu-bridge": "0" }, "h:1")["x-mu-bridge"]).toBe("1");
    expect(forwardHeaders({ host: "a", "X-MU-Bridge": "2" } as never, "h:1")["x-mu-bridge"]).toBe("1");
  });
});

describe("a hub receiving bridged traffic", () => {
  test("a PERSON pairing code cannot be redeemed through the bridge (and is not burnt by trying)", async () => {
    hub = await startComputersHub();
    const code = hub.devices.store.createCode("usman", "companion", "usman").code;
    const r = await post(hub, "pair", { code, label: "evil" }, true);
    expect(r.status).toBe(403);
    // the owner's genuine local pairing, with the same code, still works
    const ok = await post(hub, "pair", { code, label: "my pc" }, false);
    expect(ok.status).toBe(200);
  });

  test("a stolen personal-companion token is refused through the bridge but works directly", async () => {
    hub = await startComputersHub();
    const code = hub.devices.store.createCode("usman", "companion", "usman").code;
    const paired: any = await (await post(hub, "pair", { code, label: "my pc" }, false)).json();
    const beat = (bridged: boolean) => post(hub!, "heartbeat", { busy: false }, bridged, paired.token);
    expect((await beat(true)).status).toBe(403);
    expect((await beat(false)).status).toBe(200);
  });

  test("a cloud computer's one-time code and token DO work through the bridge", async () => {
    hub = await startComputersHub();
    const made = hub.devices.store.createComputerCode("usman", { name: "research", adapter: "test-host" });
    if ("error" in made) throw new Error("x");
    const paired: any = await (await post(hub, "pair", { code: made.code, label: "bot" }, true)).json();
    expect(paired.owner).toBe("shared");
    expect((await post(hub, "heartbeat", { busy: false }, true, paired.token)).status).toBe(200);
  });

  test("wrong codes through the bridge lock only the bridge's own bucket, never the shared hub bucket the owner pairs from", async () => {
    hub = await startComputersHub();
    const made = hub.devices.store.createComputerCode("mehroz", { name: "x", adapter: "test-host" });
    if ("error" in made) throw new Error("x");
    for (let i = 0; i < 15; i++) await post(hub, "pair", { code: `WRNG-${1000 + i}`, label: "probe" }, true);
    // locked out at the bridge...
    expect((await post(hub, "pair", { code: made.code, label: "bot" }, true)).status).toBe(403);
    // ...but the owner's own pairing at this PC is untouched
    const code = hub.devices.store.createCode("usman", "companion", "usman").code;
    expect((await post(hub, "pair", { code, label: "my pc" }, false)).status).toBe(200);
  });
});
