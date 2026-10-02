import { describe, expect, test } from "bun:test";
import { RfbGate, messageLength } from "./rfb";

const version = Buffer.from("RFB 003.008\n", "latin1");
const serverInit = (name = "x") => Buffer.concat([Buffer.alloc(20), Buffer.from([0, 0, 0, name.length]), Buffer.from(name)]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const pointer = Buffer.from([5, 1, 0, 10, 0, 10]);
const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);
const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);

/** Drive a whole handshake the way a server and a viewer would, returning the gate ready for messages. */
function open(canInput: () => boolean) {
  const g = new RfbGate(canInput);
  g.fromServer(version);
  expect(g.fromClient(version).length).toBe(12);
  g.fromServer(Buffer.from([1, 1]));
  expect([...g.fromClient(Buffer.from([1]))]).toEqual([1]);
  g.fromServer(Buffer.alloc(4));
  g.fromServer(serverInit());
  expect(g.state).toBe("open");
  expect(g.fromClient(Buffer.from([1])).length).toBe(1); // ClientInit
  return g;
}

describe("RFB gate: what a viewer can do to a computer", () => {
  test("framebuffer requests always pass; key, pointer and clipboard only while the lease is held", () => {
    let held = false;
    const g = open(() => held);
    expect(g.fromClient(update).length).toBe(10);
    expect(g.fromClient(Buffer.concat([key, pointer, cut])).length).toBe(0);
    expect(g.dropped).toMatchObject({ key: 1, pointer: 1, cut: 1 });
    held = true;
    const out = g.fromClient(Buffer.concat([update, key, pointer, cut]));
    expect(out.length).toBe(10 + 8 + 6 + 11);
    held = false; // the lease was just taken back: the very next key is dropped
    expect(g.fromClient(key).length).toBe(0);
  });

  test("a message split across packets is reassembled before it is judged", () => {
    let held = true;
    const g = open(() => held);
    expect(g.fromClient(key.subarray(0, 3)).length).toBe(0);
    expect(g.fromClient(key.subarray(3)).length).toBe(8);
    held = false;
    expect(g.fromClient(key.subarray(0, 5)).length).toBe(0);
    expect(g.fromClient(key.subarray(5)).length).toBe(0); // whole key, dropped
    expect(g.dropped.key).toBe(1);
  });

  test("a viewer that pipelines input before the server answers cannot slip it through, and nothing flows before the server's version", () => {
    const g = new RfbGate(() => false);
    expect(g.fromClient(Buffer.concat([version, Buffer.from([1, 1]), key, pointer])).length).toBe(0); // viewer spoke first: held back
    g.fromServer(version);
    const out = g.fromClient(new Uint8Array(0));
    // the 12-byte version, the security choice and ClientInit pass; the pipelined key and pointer do not
    expect(out.length).toBe(12 + 1 + 1);
    expect(g.dropped).toMatchObject({ key: 1, pointer: 1, cut: 0 });
  });

  test("an unknown message type closes the stream", () => {
    const g = open(() => true);
    expect(g.fromClient(Buffer.from([0xff, 1, 2, 3])).length).toBe(0);
    expect(g.state).toBe("closed");
    expect(g.error).toMatch(/unknown message/);
    expect(g.fromClient(update).length).toBe(0);
  });

  test("a viewer asking for any security type but None is cut off", () => {
    const g = new RfbGate(() => true);
    g.fromServer(version);
    g.fromClient(version);
    g.fromServer(Buffer.from([2, 1, 2]));
    g.fromClient(Buffer.from([2]));
    expect(g.state).toBe("closed");
  });

  test("a server that needs a VNC password is refused rather than carried through a browser", () => {
    const g = new RfbGate(() => true);
    g.fromServer(version);
    g.fromServer(Buffer.from([1, 2]));
    expect(g.state).toBe("closed");
    expect(g.error).toMatch(/password/);
  });

  test("what noVNC adds: fence passes; resize and the extended key are input", () => {
    let held = false;
    const g = open(() => held);
    const fence = Buffer.concat([Buffer.from([248, 0, 0, 0, 0, 0, 0, 1, 2]), Buffer.from([7, 8])]);
    const resize = Buffer.concat([Buffer.from([251, 0, 0, 0, 0, 0, 1, 0]), Buffer.alloc(16)]);
    const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 38]);
    expect(g.fromClient(fence).length).toBe(11);
    expect(g.fromClient(Buffer.concat([resize, qemuKey])).length).toBe(0);
    expect(g.dropped).toMatchObject({ resize: 1, key: 1 });
    held = true;
    expect(g.fromClient(Buffer.concat([resize, qemuKey])).length).toBe(24 + 12);
    expect(g.fromClient(Buffer.from([255, 9, 0, 0])).length).toBe(0); // an extension we don't know closes the stream
    expect(g.state).toBe("closed");
  });

  test("message lengths", () => {
    expect(messageLength(Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe(12);
    expect(messageLength(Buffer.from([6, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]))).toBe(-1);
    expect(messageLength(Buffer.from([0]))).toBe(20);
  });
});
