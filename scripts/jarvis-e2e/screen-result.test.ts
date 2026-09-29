import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runVoiceToolBatch } from "../../src/lib/screen-result";

// Execute the actual adapter case in isolation. Importing suite.ts would start the live
// desktop harness (PowerShell, guard and main), which is forbidden in synthetic tests.
const source = readFileSync(new URL("./suite.ts", import.meta.url), "utf8");
const start = source.indexOf('    case "screen_act": {');
const end = source.indexOf('    case "screen_teach": {', start);
if (start < 0 || end < 0) throw new Error("screen_act adapter not found");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
  `async function adapter(a, ctx, op, CONFIRM_MARK) { switch ("screen_act") { ${source.slice(start, end)} } }`,
);
const adapter = new Function(`${js}; return adapter;`)();
const MARK = "CONFIRM BUTTON: ";

// Exercise the real conversation loop with fake turn/tool ports, never live imports.
const loopStart = source.indexOf("async function converse(");
const loopEnd = source.indexOf("// --- the PC:", loopStart);
if (loopStart < 0 || loopEnd < 0) throw new Error("conversation loop not found");
const loopJs = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(loopStart, loopEnd));
const makeConverse = new Function("op", "execute", "runVoiceToolBatch", `${loopJs}; return converse;`);

for (const outcome of ["unverified", "step_limit", "no_progress"]) {
  test(`conversation pauses ${outcome}, records skipped calls, and never follows up with model`, async () => {
    const calls = [
      { id: "screen", function: { name: "screen_act" } },
      { id: "later", function: { name: "pc_act" } },
    ];
    let turns = 0;
    let history: any[] = [];
    const executed: string[] = [];
    const envelope = JSON.stringify({ type: "screen_result", ok: false, said: "Completion could not be verified. Which control?", outcome });
    const converse = makeConverse(async (_path: string, body: any) => {
      turns++;
      history = body.messages;
      if (turns > 1) throw new Error("unexpected model follow-up");
      return { status: 200, data: { content: null, tool_calls: calls, model: "synthetic" } };
    }, async (call: any) => {
      executed.push(call.id);
      return envelope;
    }, runVoiceToolBatch);
    const out = await converse("synthetic task", ["yes"], { tools: [], lastUser: "" });
    expect(out.said).toBe("Completion could not be verified. Which control?");
    expect(turns).toBe(1);
    expect(executed).toEqual(["screen"]);
    expect(history.filter((m) => m.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "screen", content: envelope },
      { role: "tool", tool_call_id: "later", content: "Not run: screen action needs new user direction." },
    ]);
    expect(history.at(-1)).toEqual({ role: "assistant", content: out.said });
  });
}

test("conversation continues a successful screen batch to the model", async () => {
  let turns = 0;
  const executed: string[] = [];
  const calls = [{ id: "screen", function: { name: "screen_act" } }, { id: "later", function: { name: "skill" } }];
  const converse = makeConverse(async () => ({ status: 200, data: ++turns === 1 ? { tool_calls: calls } : { content: "Finished." } }), async (call: any) => {
    executed.push(call.id);
    return call.id === "screen" ? JSON.stringify({ type: "screen_result", ok: true, said: "Done." }) : "Done.";
  }, runVoiceToolBatch);
  expect((await converse("synthetic task", [], { tools: [] })).said).toBe("Finished.");
  expect(turns).toBe(2);
  expect(executed).toEqual(["screen", "later"]);
});

async function run(events: unknown[], a: Record<string, unknown> = {}, ctx: any = { pendingScreen: null }) {
  const calls: unknown[] = [];
  const result = await adapter(a, ctx, async (...args: unknown[]) => {
    calls.push(args);
    return { text: ["bad json", ...events.map((e) => JSON.stringify(e))].join("\n") };
  }, MARK);
  return { result, ctx, calls };
}

for (const outcome of ["unverified", "step_limit", "no_progress"]) {
  test(`e2e preserves failure ${outcome} and does not call again`, async () => {
    const { result, calls } = await run([{ type: "done", ok: false, said: "A step changed; completion was not verified.", outcome, ask: true, stopped: false }]);
    expect(JSON.parse(result)).toEqual({ type: "screen_result", ok: false, said: "A step changed; completion was not verified.", outcome, ask: true, stopped: false });
    expect(calls).toHaveLength(1);
  });
}

test("e2e preserves success and stopped reports", async () => {
  for (const done of [{ ok: true, said: "Done." }, { ok: false, said: "Stopped.", stopped: true }]) {
    const { result } = await run([{ type: "done", ...done }]);
    expect(JSON.parse(result)).toEqual({ type: "screen_result", ...done });
  }
});

test("e2e missing report is explicitly unverified", async () => {
  const { result } = await run([{ type: "step", said: "Clicked." }]);
  expect(JSON.parse(result)).toMatchObject({ type: "screen_result", ok: false, outcome: "unverified" });
});

test("e2e confirmation keeps its marker and requires pending approval", async () => {
  const { result, ctx } = await run([{ type: "done", ok: false, said: "Press Save?", confirm: "Save", ask: true }]);
  expect(result).toBe(`${MARK}Press Save?`);
  expect(ctx.pendingScreen.button).toBe("Save");
  const confirmed = await run([{ type: "done", ok: true, said: "Saved." }], { confirmed: true }, ctx);
  expect(confirmed.calls[0]).toEqual(["/screen/act", { goal: "click Save", confirm: "Save", vision: false }, 180_000]);
  expect(ctx.pendingScreen).toBeNull();
  const missing = await run([], { confirmed: true });
  expect(missing.calls).toHaveLength(0);
});
