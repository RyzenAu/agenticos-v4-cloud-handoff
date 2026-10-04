import { test, expect } from "bun:test";
import { CLINE_BRIDGE_MODELS } from "../cline-bridge";
test("cline bridge model map vs pre-E2", () => {
  console.log(JSON.stringify(CLINE_BRIDGE_MODELS));
  expect(CLINE_BRIDGE_MODELS).toEqual({
    "space-bunny-alpha": "stealth/space-bunny-alpha",
    "deepseek-v4.1-flash": "cline-free/deepseek-v4.1-flash",
    "gemini-3.8-flash": "cline-free/gemini-3.8-flash",
    "mimo-v2.6-flash": "cline-free/mimo-v2.6-flash",
    "muse-spark-1.3": "cline-free/muse-spark-1.3-contributor",
  });
});
