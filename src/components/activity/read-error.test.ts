// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { jobsReadMessage } from "./read-error";

test("the server's reason keeps every letter and loses only its full stop", () => {
  expect(jobsReadMessage("The job and approval stores are unavailable.", 503)).toBe("The job and approval stores are unavailable (HTTP 503)");
  expect(jobsReadMessage("Stores are unavailable", 503)).toBe("Stores are unavailable (HTTP 503)");
  expect(jobsReadMessage("", 500)).toBe("The server answered HTTP 500");
});
