import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountConnections } from "./account-connections";
import { skoolMessages } from "./skool-messages";
import { EMPTY_STATE } from "../src/lib/operator";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "optional-accounts-")); roots.push(root); const home = join(root, "new-user"); mkdirSync(home); return { root, home }; }
test("fresh-user Slack and Skool remain optional, disconnected and network-free without local files", async () => {
  const { root, home } = fixture(); let calls = 0;
  const accounts = accountConnections(root, () => structuredClone(EMPTY_STATE), () => { throw new Error("No writes expected"); }, { homeDir: home });
  const status = await accounts.handle("/connections", "GET", {}, {});
  expect(status.accounts.find((account: any) => account.id === "slack")).toMatchObject({ configured: false, connected: false, detectedWorkspaces: [] });
  const skool = skoolMessages(root, { homeDir: home, connectionFile: join(home, "optional.env"), request: (async () => { calls++; throw new Error("No network expected"); }) as typeof fetch });
  expect(await skool.handle("/connections/skool/status", "GET")).toMatchObject({ configured: false, connected: false, count: 0 });
  await expect(skool.sync({ limit: 1 })).rejects.toThrow("Skool is optional");
  expect(calls).toBe(0); expect(existsSync(join(root, ".operator-data/accounts.json"))).toBe(false);
});
test("an explicitly chosen Skool integration file works without a personal home project path", async () => {
  const { root, home } = fixture(), file = join(root, "my-integration.env");
  writeFileSync(file, "SKOOL_COOKIE='auth_token=synthetic-token; client_id=synthetic-client'\n");
  const skool = skoolMessages(root, { homeDir: home, connectionFile: file, request: (async () => { throw new Error("No network expected"); }) as typeof fetch });
  const status = await skool.handle("/connections/skool/status", "GET");
  expect(status).toMatchObject({ configured: true, connected: false });
  expect(JSON.stringify(status)).not.toMatch(/synthetic-token|synthetic-client|my-integration.env/);
  expect(existsSync(join(home, "Skool Scraper"))).toBe(false);
});
test("relative and oversized optional integration files never establish a Skool connection", () => {
  const { root, home } = fixture(), file = join(root, "oversized.env");
  writeFileSync(file, "SKOOL_COOKIE=auth_token=synthetic\n" + "x".repeat(65536));
  expect(skoolMessages(root, { homeDir: home, connectionFile: file }).snapshot().configured).toBe(false);
  expect(skoolMessages(root, { homeDir: home, connectionFile: "relative.env" }).snapshot().configured).toBe(false);
});
