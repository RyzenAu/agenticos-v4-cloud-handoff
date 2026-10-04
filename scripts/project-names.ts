// Readable names for Claude Code project folders. A folder key such as
// "C--Users-Nebula-PC-source-repos-MU-Workspace" flattens every separator, space and dash into
// "-", so decoding it by string replacement printed "C//Users/Nebula/PC/…" on the Workspaces and
// Mission Control cards. The transcript's own `cwd` is the truth; when it is missing, the path is
// rebuilt by walking the disk and keeping the segment split that exists.
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export function projectPathFromKey(key: string, exists: (path: string) => boolean = existsSync) {
  const drive = /^([A-Za-z])--(.*)$/.exec(key);
  const [base, rest] = drive ? [`${drive[1]}:/`, drive[2]] : ["/", key.replace(/^-/, "")];
  const parts = rest.split("-");
  let path = base;
  let i = 0;
  while (i < parts.length) {
    let matched = 0;
    // Longest run of parts that names an existing entry: "MU-Workspace", "Nebula PC", ".claude".
    for (let j = parts.length; j > i && !matched; j--) {
      const run = parts.slice(i, j);
      const names = new Set([run.join("-"), run.join(" "), run.join("."), run.join("_")]);
      if (run[0] === "" && run.length > 1) names.add("." + run.slice(1).join("-"));
      for (const name of names) {
        if (name && exists(path + name)) {
          path += name + "/";
          matched = j - i;
          break;
        }
      }
    }
    if (!matched) return null;
    i += matched;
  }
  return path.replace(/\/$/, "");
}

/** { displayName: "MU-Workspace", path: "~/source/repos/MU-Workspace" } for cards and lists. */
export function projectNames(
  key: string,
  cwd?: string,
  options: { home?: string; exists?: (path: string) => boolean } = {},
) {
  const home = (options.home ?? homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  const real = (cwd || projectPathFromKey(key, options.exists) || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const path = real
    ? real.toLowerCase() === home.toLowerCase() || real.toLowerCase().startsWith(home.toLowerCase() + "/")
      ? "~" + real.slice(home.length)
      : real
    : "";
  const name =
    path === "~"
      ? "Home folder"
      : real.split("/").filter(Boolean).pop() || key.split("-").filter(Boolean).pop() || key;
  return { displayName: name, path: path || key };
}
