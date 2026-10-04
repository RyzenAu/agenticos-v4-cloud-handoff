// The palette, the registry and their guards load in the BROWSER. A server-only import anywhere in their
// graph (bun:sqlite, node:crypto, …) takes the whole page down, as T6's approvals import did through
// scripts/memory/voice-intents.ts (28 Sep, found in the review-fix render). This bundles them for the
// browser and fails on any such import; and it keeps rule-guard's copy of memory's triggers in step.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { memoryWords } from "../src/lib/commands/rule-guard";
import { parseMemoryIntent } from "./memory/voice-intents";

const ROOT = join(import.meta.dir, "..");
const ENTRIES = [
  "src/components/shell/command-palette-body.tsx",
  "src/lib/commands/registry.ts",
  "src/lib/commands/jarvis-route.ts",
  "src/lib/commands/rule-guard.ts",
  "src/lib/commands/action-guard.ts",
  "src/lib/commands/client.ts",
  "src/lib/page-context.ts",
  "src/lib/honest-state.ts",
  "src/lib/motion.ts",
  "src/components/shell/command-scene/command-scene.tsx",
  // Loaded by rule-guard and client through Vite's import.meta.glob, which Bun.build doesn't expand, so they
  // are bundled here directly (REVIEW-T1 R2: that glob is how voice-intents → approvals once reached the page).
  "src/lib/jarvis-intents.ts",
  "src/lib/jarvis-command.ts",
].filter((e) => existsSync(join(ROOT, e)));

describe("browser-safe command modules", () => {
  test("no server-only module in the browser graph", async () => {
    const result = await Bun.build({
      entrypoints: ENTRIES.map((e) => join(ROOT, e)),
      target: "browser",
      external: ["react", "react-dom", "react/jsx-runtime", "@tanstack/*", "@radix-ui/*", "cmdk", "lucide-react", "clsx", "tailwind-merge", "*.css"],
      tsconfig: join(ROOT, "tsconfig.json"),
      throw: false,
    });
    const errors = result.logs.filter((l) => l.level === "error").map((l) => String(l.message));
    expect(errors).toEqual([]);
    for (const out of result.outputs) {
      const code = await out.text();
      expect({ file: out.path, server: /from\s*["'](?:bun:sqlite|node:crypto|node:fs|node:child_process)["']/.test(code) }).toMatchObject({ server: false });
    }
  }, 60_000);

  test("rule-guard's memory triggers agree with parseMemoryIntent", () => {
    const corpus = [
      "remember that Synthetic Dental Co prefers calls before 10 am", "remember to call Mehroz at 5 pm", "make a note that the demo is Friday",
      "save this to the vault: pricing is settled", "save that to the vault", "what do we know about Synthetic Dental Co",
      "what did we decide about the receptionist pricing", "correct that: they prefer calls after 2 pm", "correct the pricing fact to A$1,099",
      "forget that", "forget about the old pilot", "remove the pilot from memory", "unindex that", "any pending forgets",
      "what's waiting for my approval", "open finance", "receptionist status", "what did I spend this month", "forget it",
    ];
    for (const t of corpus) expect({ t, same: memoryWords(t) === !!parseMemoryIntent(t) }).toEqual({ t, same: true });
  });
});
