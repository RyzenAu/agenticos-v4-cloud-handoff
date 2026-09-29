import { expect, test } from "bun:test";
import { projectNames, projectPathFromKey } from "./project-names";

const disk = new Set([
  "C:/Users",
  "C:/Users/Nebula PC",
  "C:/Users/Nebula PC/source",
  "C:/Users/Nebula PC/source/repos",
  "C:/Users/Nebula PC/source/repos/MU-Workspace",
  "C:/Users/Nebula PC/source/repos/AgenticOS-v4",
  "C:/Users/Nebula PC/.claude",
]);
const exists = (path: string) => disk.has(path);
const home = "C:\\Users\\Nebula PC";

test("the transcript's cwd wins and shows as a folder name plus a home-relative path", () => {
  expect(
    projectNames("C--Users-Nebula-PC-source-repos-MU-Workspace", "C:\\Users\\Nebula PC\\source\\repos\\MU-Workspace", { home, exists }),
  ).toEqual({ displayName: "MU-Workspace", path: "~/source/repos/MU-Workspace" });
});

test("without a cwd the lossy key is rebuilt from the disk, spaces and dashes included", () => {
  expect(projectPathFromKey("C--Users-Nebula-PC-source-repos-MU-Workspace", exists)).toBe(
    "C:/Users/Nebula PC/source/repos/MU-Workspace",
  );
  expect(projectPathFromKey("C--Users-Nebula-PC--claude", exists)).toBe("C:/Users/Nebula PC/.claude");
  expect(projectNames("C--Users-Nebula-PC-source-repos-AgenticOS-v4", undefined, { home, exists })).toEqual({
    displayName: "AgenticOS-v4",
    path: "~/source/repos/AgenticOS-v4",
  });
  expect(projectNames("C--Users-Nebula-PC", undefined, { home, exists }).displayName).toBe("Home folder");
});

test("never prints the mangled C//Users form, even for a folder that no longer exists", () => {
  const gone = projectNames("C--Users-Nebula-PC-source-repos-old-thing", undefined, { home, exists });
  expect(gone.displayName).toBe("thing");
  expect(gone.path).not.toContain("//");
  expect(projectPathFromKey("C--Users-Nebula-PC-source-repos-old-thing", exists)).toBeNull();
});
