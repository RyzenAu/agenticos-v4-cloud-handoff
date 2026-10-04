#!/usr/bin/env bun
/**
 * R12 rollout: make a FRESH synthetic hub and seed every page the rollout touches. Never the live hub; all data synthetic.
 *
 *   bun scripts/r12-rollout-seed.ts <port 8150-8199> <D:\AgenticOS-r12-data\rollout-<label>>
 *
 * Steps (each script refuses anything that isn't a synthetic port and folder):
 *   1. scripts/acceptance/r7/hub.ts seed + start --role pc  (HINDSIGHT_URL=off, MU_MEMORY_WRITES=off, MU_TRIGGERS=off are the hub's defaults)
 *   2. scripts/r12-ui-seed.ts      jobs in every state, bots, the Jarvis thread, three CRM companies
 *   3. scripts/r11-visual-seed.ts  six CRM companies with contacts, deals, tasks, every quote/invoice state, lead stages, memory notes
 *   4. scripts/r11-visual-seed2.ts calendar events, inbox mail + triage log, design images
 * Stop the hub afterwards with: bun scripts/acceptance/r7/hub.ts stop --data <folder>
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = process.argv[2] ?? "8160";
const data = process.argv[3] ?? "";
if (!/^81[5-9]\d$/.test(port)) throw new Error("port 8150-8199 only");
if (!/^D:\\AgenticOS-r12-data\\rollout-[\w-]+$/i.test(data)) throw new Error("data must be D:\\AgenticOS-r12-data\\rollout-<label>");
if (existsSync(join(data, ".gate-seed.json"))) throw new Error(`${data} is already seeded: use a fresh folder (restart recovery changes seeded running jobs).`);

const run = (args: string[]) => {
  console.log(`> bun ${args.join(" ")}`);
  const r = Bun.spawnSync(["bun", ...args], { cwd: join(import.meta.dir, ".."), stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${args[0]}`);
};
run(["scripts/acceptance/r7/hub.ts", "seed", "--data", data]);
run(["scripts/acceptance/r7/hub.ts", "start", "--port", port, "--data", data, "--role", "pc"]);
run(["scripts/r12-ui-seed.ts", port, data]);
run(["scripts/r11-visual-seed.ts", port]);
run(["scripts/r11-visual-seed2.ts", port, data]);
console.log(JSON.stringify({ ready: true, port: Number(port), data }));
