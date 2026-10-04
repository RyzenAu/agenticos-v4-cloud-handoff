import { expect, test } from "bun:test";
import { npmCommand } from "./next-templates";

// npm.cmd can't be spawned without a shell on Windows (EINVAL): the template build runs npm's CLI script with node instead.
// It prefers the node.exe installed beside npm.cmd, and falls back to `node` from PATH.
test("on Windows npm runs as node + npm-cli.js, never the .cmd shim or a shell", () => {
  const cli = "C:\nodejs\node_modules\npm\bin\npm-cli.js";
  expect(npmCommand(["ci"], "win32", () => ({ cli, node: "C:\nodejs\node.exe" }))).toEqual(["C:\nodejs\node.exe", [cli, "ci"]]);
  expect(npmCommand(["ci"], "win32", () => ({ cli, node: "node" }))).toEqual(["node", [cli, "ci"]]);
  expect(() => npmCommand(["ci"], "win32", () => null)).toThrow(/npm was not found/);
  expect(npmCommand(["ci"], "linux")).toEqual(["npm", ["ci"]]);
});

test("the real lookup on this PC finds node.exe beside npm.cmd when it exists", () => {
  if (process.platform !== "win32") return;
  const [cmd, args] = npmCommand(["--version"]);
  expect(args.at(-1)).toBe("--version");
  expect(cmd === "node" || /node\.exe$/i.test(cmd)).toBe(true);
});
