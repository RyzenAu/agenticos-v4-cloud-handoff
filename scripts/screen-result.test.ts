import { expect, test } from "bun:test";
import { parseScreenResult, runVoiceToolBatch } from "../src/lib/screen-result";
import { protocolFollowUp, frontFailureLine, CONFIRM_MARK } from "./free-voice";
const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const envelope = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "screen_result", ok: true, said: "I stopped there. Please direct me.", ...extra });

for (const extra of [{ outcome: "unverified" }, { outcome: "step_limit" }, { outcome: "no_progress" }, { ask: true }, { stopped: true }, { ok: false }]) {
  test(`mixed batch pauses for ${JSON.stringify(extra)} and fresh direction can act`, async () => {
    const calls = [call("a", "skill"), call("b", "screen_act"), call("c", "control_pc")];
    const ran: string[] = [], recorded: string[] = [];
    const pause = await runVoiceToolBatch(calls, async c => { ran.push(c.id); return c.id === "b" ? envelope(extra) : "Done"; }, (id, content) => recorded.push(`${id}:${content}`));
    expect(ran).toEqual(["a", "b"]);
    expect(pause).toBe("I stopped there. Please direct me.");
    expect(recorded[2]).toContain("c:Not run");
    expect(await runVoiceToolBatch([call("fresh", "screen_act")], async c => { ran.push(c.id); return envelope({ said: "Clicked." }); }, () => {})).toBeNull();
    expect(ran).toEqual(["a", "b", "fresh"]);
  });
}

test("verified success continues mixed batch; unrelated JSON does not pause", async () => {
  const ran: string[] = [];
  expect(await runVoiceToolBatch([call("a", "screen_act"), call("b", "skill")], async c => { ran.push(c.id); return envelope(); }, () => {})).toBeNull();
  expect(ran).toEqual(["a", "b"]);
  expect(parseScreenResult('{"said":"ordinary JSON"}')).toBeNull();
  expect(parseScreenResult("legacy spoken line")).toBeNull();
});

for (const extra of [{}, { ok: false }, { outcome: "unverified" }, { outcome: "step_limit" }, { outcome: "no_progress" }, { ask: true }, { stopped: true }]) {
  test(`protocol follow-up speaks said for ${JSON.stringify(extra)}`, () => {
    expect(protocolFollowUp([{ role: "assistant", content: null, tool_calls: [call("a", "screen_act"), call("b", "skill")] }, { role: "tool", tool_call_id: "a", content: envelope(extra) }, { role: "tool", tool_call_id: "b", content: "Other result." }])).toBe("I stopped there. Please direct me. Other result.");
  });
}
test("legacy confirmation remains plain speech", () => {
  expect(protocolFollowUp([{ role: "assistant", content: null, tool_calls: [call("a", "screen_act")] }, { role: "tool", tool_call_id: "a", content: `${CONFIRM_MARK}Shall I submit?` }])).toBe("Shall I submit?");
});

test("front refusal uses envelope said, not metadata", () => {
  const assistant = { role: "assistant" as const, content: null, tool_calls: [call("a", "screen_act")] };
  const said = "Notepad isn't the window in front, so I left everything alone.";
  expect(frontFailureLine([assistant, { role: "tool", tool_call_id: "a", content: envelope({ ok: false, said }) }])).toBe(said);
  expect(frontFailureLine([assistant, { role: "tool", tool_call_id: "a", content: envelope({ said: "Done.", metadata: said }) }])).toBeNull();
});
