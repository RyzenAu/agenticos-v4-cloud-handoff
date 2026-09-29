/**
 * Make a one-time code to confirm a new browser at this PC (AUDIT-A1-3, REVIEW-S1 F2b), for when no
 * confirmed browser is at hand (a fresh browser profile, cleared cookies, a session that lapsed unused):
 *
 *   bun scripts/identity/confirm-browser.ts [--root <AgenticOS folder>]
 *
 * Run it yourself in a terminal (PowerShell or Windows Terminal), then type the code it shows into
 * Profile on the new browser. A page navigation alone only ever makes a PENDING hub session (any local
 * program can send those two headers), and the pending browser is never shown a code of its own: the
 * code comes from here or from a browser Usman already uses, and a person types it in.
 *
 * It refuses without an interactive terminal on both ends and waits for Enter, so an agent's shell tool
 * (piped stdin/stdout) can't run it and read the code. That is a guard against agents and scripts, not
 * a wall: a program running as the owner with his full file access could write the devices store
 * directly or drive a console, which is the documented limit in scripts/identity/principal.ts.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DeviceStore } from "../devices/store";

export function interactive(io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process) {
  return io.stdin.isTTY === true && io.stdout.isTTY === true;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = resolve(at >= 0 && args[at + 1] ? args[at + 1] : resolve(import.meta.dir, "..", ".."));
  if (args.some((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1))) {
    console.error("New browsers no longer show a code to type here. Run this command with no code; it shows one to type into the new browser's Profile.");
    process.exit(2);
  }
  if (!interactive()) {
    console.error("Run this yourself in an interactive terminal on this PC (PowerShell or Windows Terminal). It won't run from a script or an agent's shell.");
    process.exit(3);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((done) => rl.question("Press Enter to make a code for the new browser at this PC (Ctrl+C to cancel): ", () => done()));
  rl.close();
  const { code, expiresAt } = new DeviceStore(root).createCode("usman", "hub", "usman");
  console.log(`\n  ${code}\n\nType it into Profile on the new browser within ${Math.round((expiresAt - Date.now()) / 60_000)} minutes. It works once.`);
}

if (import.meta.main) await main();
