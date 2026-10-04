// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { settingsTabFor } from "./settings-tab";

test("the Workspace tab is #workspace, and its old address keeps working", () => {
  expect(settingsTabFor("#workspace")).toBe("workspace");
  expect(settingsTabFor("#preferences")).toBe("workspace");
  expect(settingsTabFor("#connections")).toBe("connections");
  expect(settingsTabFor("#nonsense")).toBe("personal-profile");
  expect(settingsTabFor("")).toBe("personal-profile");
});
