// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { CANCEL_QUEUED, VOICE_TEXT, acceptJarvisRequest, sendDecision, sendJarvisRequest } from "./jarvis-send";

describe("a typed Jarvis request is never dropped silently and never sent twice (R11 M5)", () => {
  test("delivered: the companion's acceptance for this id settles 'accepted'; the id is a valid command eventId", async () => {
    const bus = new EventTarget();
    const seen: Array<{ request: string; requestId: string }> = [];
    bus.addEventListener(VOICE_TEXT, (e) => {
      seen.push((e as CustomEvent).detail);
      acceptJarvisRequest((e as CustomEvent).detail, bus);
    });
    const p = sendJarvisRequest("  check the site  ", { target: bus });
    expect(await p.done).toBe("accepted");
    expect(seen[0].request).toBe("check the site");
    expect(seen[0].requestId).toBe(p.requestId);
    expect(/^[\w:.-]{6,80}$/.test(p.requestId)).toBe(true);
  });

  test("a slow companion: it says 'still connecting' once and keeps waiting; a late acceptance (the shell's replay) still counts", async () => {
    const bus = new EventTarget();
    let detail: unknown = null;
    bus.addEventListener(VOICE_TEXT, (e) => (detail = (e as CustomEvent).detail));
    let slow = 0;
    const p = sendJarvisRequest("check the site", { target: bus, slowMs: 10, onSlow: () => slow++ });
    await new Promise((r) => setTimeout(r, 40));
    expect(slow).toBe(1);
    acceptJarvisRequest(detail, bus); // the overlay finally mounted and the replay reached it
    expect(await p.done).toBe("accepted");
  });

  test("editing before it was taken cancels it and asks the shell to drop the queued replay for that id", async () => {
    const bus = new EventTarget();
    const cancels: unknown[] = [];
    bus.addEventListener(CANCEL_QUEUED, (e) => cancels.push((e as CustomEvent).detail));
    const p = sendJarvisRequest("check the site", { target: bus, slowMs: 1000 });
    p.cancel();
    expect(await p.done).toBe("cancelled");
    expect(cancels).toEqual([{ type: VOICE_TEXT, requestId: p.requestId }]);
    // an acceptance arriving afterwards changes nothing
    acceptJarvisRequest({ requestId: p.requestId }, bus);
    expect(await p.done).toBe("cancelled");
  });

  test("an acceptance for a different request does not count", async () => {
    const bus = new EventTarget();
    bus.addEventListener(VOICE_TEXT, () => acceptJarvisRequest({ requestId: "someone-else" }, bus));
    const p = sendJarvisRequest("x y", { target: bus, slowMs: 1000 });
    const r = await Promise.race([p.done, new Promise((res) => setTimeout(() => res("waiting"), 30))]);
    expect(r).toBe("waiting");
    p.cancel();
  });

  test("Send again on the same words while it waits is the same request; changed words are a new one", () => {
    expect(sendDecision(null, "check the site")).toBe("new");
    expect(sendDecision({ text: "check the site" }, " check the site ")).toBe("same");
    expect(sendDecision({ text: "check the site" }, "check the leads")).toBe("new");
  });
});
