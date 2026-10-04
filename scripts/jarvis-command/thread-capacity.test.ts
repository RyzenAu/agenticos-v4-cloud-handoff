import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { conversationStore, jarvisThreadId } from "../conversations";
import type { Principal } from "../identity/principal";
import { commandRoute } from "./route";
import { createCommandService } from "./service";
import { createJobThreads } from "./threads";

const principal: Principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Fixture Owner" };
test("thread/say acknowledges accepted and duplicate keys, but returns the existing failure shape at capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-capacity-route-"));
  const store = conversationStore(root);
  const jobs = () => { throw new Error("Saving a transcript must not start or read a job"); };
  const threads = createJobThreads({ conversations: store, jobs });
  const service = createCommandService({ threads, jobs, entry: () => null, hubDeviceId: "fixture", resolveTarget: () => ({ ok: false, reason: "none" }) });
  const say = async (requestId: string, caller = principal) => {
    let response: { value: unknown; status: number } | undefined;
    const handled = await commandRoute({ path: "/screen/command/thread/say", method: "POST", url: new URL("http://fixture/screen/command/thread/say"), body: { requestId, part: "user", role: "user", text: "Synthetic typed request", personId: "forged-owner" }, principal: caller, service, req: {} as never, res: { setHeader() {} } as never, send: (value, status = 200) => { response = { value, status }; } });
    expect(handled).toBe(true);
    return response!;
  };
  try {
    const thread = store.ensureThread({ personId: principal.personId })!;
    store.save({ ...thread, messages: Array.from({ length: 499 }, () => ({ role: "user", text: "Synthetic history" })) }, { personId: principal.personId, hub: true });
    expect(await say("accepted-request")).toEqual({ status: 200, value: { ok: true, conversationId: thread.id } });
    expect(await say("accepted-request")).toEqual({ status: 200, value: { ok: true, conversationId: thread.id } });
    expect(await say("rejected-request")).toEqual({ status: 503, value: { ok: false, error: "A conversation can contain up to 500 messages. This update was not saved." } });
    expect(conversationStore(root).get(thread.id)!.messages).toHaveLength(500);
    expect(store.get(jarvisThreadId("forged-owner"))).toBeNull();
    const other: Principal = { ...principal, personId: "mehroz", displayName: "Second Founder" };
    expect(await say("rejected-request", other)).toEqual({ status: 200, value: { ok: true, conversationId: jarvisThreadId(other.personId) } });
    expect(store.get(jarvisThreadId(other.personId))!.messages).toHaveLength(1);
  } finally {
    threads.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
