import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, withoutBunNodeShim } from "../assistant-runtime";
import type { CommandId, GitSha } from "./contracts";
import { runRegistryCommand } from "./gate";
import { cleanup, commitIn, fixtureRepo, gitIn, type FixtureRepo } from "./test-fixtures";

// Ryzen, 4 Oct 2026: the hub runs under `bun --bun run`, whose bun-node-<hash> folder (a fake node.exe that is Bun) sits first on
// PATH. A registry lint `node --check serve.mjs` then RAN the site's server and the coding gate timed out. Children must get real Node.
setDefaultTimeout(60_000);
const repos: FixtureRepo[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  for (const r of repos.splice(0)) cleanup(r.root);
});

test("the Bun fake-node folder is dropped from a child's PATH; other folders stay in order", () => {
  expect(withoutBunNodeShim("C:\\Users\\x\\AppData\\Local\\Temp\\bun-node-744846f84;C:\\Program Files\\nodejs;C:\\Windows")).toBe("C:\\Program Files\\nodejs;C:\\Windows");
  expect(withoutBunNodeShim("C:\\tools\\bun-node-thing-not-hex;C:\\a")).toBe("C:\\tools\\bun-node-thing-not-hex;C:\\a");
  const env = childEnv({ env: { PATH: "D:\\t\\bun-node-abc123\\;C:\\nodejs", SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv });
  expect(env.PATH).toBe("C:\\nodejs");
});

test.skipIf(process.platform !== "win32")("a registry `node --check` runs real Node even with a fake node first on the hub's PATH", async () => {
  const r = fixtureRepo();
  repos.push(r);
  const shim = join(r.root, "bun-node-abc123");
  mkdirSync(shim, { recursive: true });
  // The fake node: says so and fails (Bun-as-node never honours --check).
  writeFileSync(join(shim, "node.cmd"), "@echo FAKE-NODE\r\n@exit /b 7\r\n");
  process.env.PATH = `${shim};${savedPath}`;
  commitIn(r.canonical, { "ok.mjs": "export const ok = 1;\n" });
  const sha = gitIn(r.canonical, "rev-parse", "HEAD").trim() as GitSha;
  const entry = { ...r.entry, commands: [{ id: "fx.lint" as CommandId, kind: "lint", argv: ["node", "--check", "ok.mjs"], cwd: ".", timeoutMs: 20_000, counts: "none" }] } as typeof r.entry;
  const run = await runRegistryCommand({ entry, commandId: "fx.lint", worktreePath: r.canonical, sha });
  expect(run.output).not.toContain("FAKE-NODE");
  expect(run.result.timedOut).toBe(false);
  expect(run.result.exitCode).toBe(0);
});
