import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type RegistryLaunch = { file: string; args: string[] };
type LaunchOptions = {
  platform?: NodeJS.Platform;
  /** Platform-injected file probe for synthetic Windows tests. Must exclude directories. */
  isFile?: (path: string) => boolean;
};

// win32.isAbsolute also accepts a drive-relative root (\\tools). A launch must not depend on
// the current drive, current directory or the job's worktree when looking up installed tools.
const fullyQualified = (path: string) => /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path);

/**
 * Resolve a validated registry argv on the CHILD's allowlisted, Bun-shim-free environment.
 * No shell, shim parsing, package metadata or implicit installation. On Windows native .exe
 * files win across PATH; only bare npm/npx may map a .cmd installation to its known JS entry.
 * Explicit shims stay forbidden by registry validation. POSIX keeps ordinary argv execution.
 */
export function resolveRegistryLaunch(argv: readonly string[], env: NodeJS.ProcessEnv, options: LaunchOptions = {}): RegistryLaunch {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? win32 : posix;
  const isFile = options.isFile ?? ((file: string) => {
    try {
      if (!windows) accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  });
  const program = argv[0];
  if (!program) throw new Error("A registry command needs a program.");
  const args = argv.slice(1);
  if (/\.(?:cmd|bat)$/i.test(program)) throw new Error("A registry command must not launch a .cmd/.bat shim.");
  const pathKey = Object.keys(env).find((key) => windows ? key.toLowerCase() === "path" : key === "PATH");
  const dirs = (pathKey ? env[pathKey] ?? "" : "").split(p.delimiter)
    .map((dir) => windows ? dir.trim().replace(/^"(.*)"$/, "$1") : dir)
    .filter((dir) => dir && (!windows || fullyQualified(dir)))
    // Unquoting/normalizing PATH must not resurrect a Bun-as-Node folder the upstream scrub
    // could not recognize. Resolve aliases such as a trailing \\. before applying the same ban.
    .filter((dir) => !windows || !/[\\/]bun-node-[0-9a-f]+[\\/]?$/i.test(p.normalize(dir)));
  if (!windows) {
    const file = program.includes("/") ? program : dirs.map((dir) => p.join(dir, program)).find(isFile) ?? program;
    return { file, args };
  }

  // No fallback to spawn's implicit cwd/PATH search on Windows: it could reselect a rejected shim.
  const hasPath = /[\\/:]/.test(program);
  if (/^\.+$/.test(program) || (hasPath && !fullyQualified(program))) throw new Error("A Windows registry program path must be fully qualified.");
  const extension = p.extname(program);
  if (extension && extension.toLowerCase() !== ".exe") throw new Error("A Windows registry program must be a real .exe or a supported bare npm/npx command.");
  const executable = extension ? program : `${program}.exe`;
  const native = hasPath ? (isFile(executable) ? executable : undefined) : dirs.map((dir) => p.join(dir, executable)).find(isFile);
  if (native) return { file: native, args };

  const name = program.toLowerCase();
  if (!hasPath && (name === "npm" || name === "npx")) {
    const shim = dirs.map((dir) => p.join(dir, `${name}.cmd`)).find(isFile);
    if (shim) {
      const directory = p.dirname(shim);
      const script = p.join(directory, "node_modules", "npm", "bin", `${name}-cli.js`);
      const siblingNode = p.join(directory, "node.exe");
      const node = isFile(siblingNode) ? siblingNode : dirs.map((dir) => p.join(dir, "node.exe")).find(isFile);
      if (node && isFile(script)) return { file: node, args: [script, ...args] };
      throw new Error(`The registered ${name} check needs its installed ${name}-cli.js and a real node.exe on the child's PATH or beside the shim.`);
    }
  }
  throw new Error("The registered Windows check has no real .exe on the child's PATH; only standard npm/npx .cmd installations can be resolved without a shell.");
}
