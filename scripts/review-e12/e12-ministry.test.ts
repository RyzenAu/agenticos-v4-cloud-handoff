import { expect, test } from "bun:test";
import modelIntel from "../../src/data/model-intel.json";
import { hermesRef } from "../model-router/pickers";
import { providerModelId } from "../model-router/catalogue";
const CLAUDE_SUB = new Set(["claude/opus-5-5", "claude/sonnet-5", "claude/fable-5-1", "claude/haiku-4-5"].map(providerModelId));
test("ministry default keys unchanged", () => {
  const list = ((modelIntel as any).models ?? []).filter((x: any) => x.openrouterId && x.price && typeof x.price.inputPerM === "number" && typeof x.price.outputPerM === "number" && x.status !== "retired" && x.id !== "claude-opus-4-7")
    .map((x: any) => { const orId = String(x.openrouterId); const isOpenAI = String(x.vendorKey) === "openai"; const isC = CLAUDE_SUB.has(String(x.id));
      return { key: String(x.id), provider: isOpenAI ? "openai-codex" : isC ? "claude-sub" : "openrouter", model: isOpenAI ? orId.split("/").slice(1).join("/") : isC ? String(x.id) : orId }; });
  const seat = (id: string) => { const r = hermesRef(id); return list.find((o: any) => o.provider === r.provider && o.model === r.name)?.key ?? id; };
  const got = [seat("codex/gpt-6-sol"), ...["claude/opus-5-5", "codex/gpt-6-astra", "openrouter/deepseek-v4-pro"].map(seat)];
  console.log(got);
  expect(got).toEqual(["gpt-6-sol", "claude-opus-5-5", "gpt-6-astra", "deepseek-v4-pro"]);
});
