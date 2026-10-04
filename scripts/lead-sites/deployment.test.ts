import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPreviewDesign } from "./design";
import { deploymentError, liveCheck, liveCheckProblem, previewAssets, timeoutMessage } from "./deploy";
import { bannerText } from "./fill";

const temporary: string[] = [];
afterAll(() => { for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

describe("public preview verification", () => {
  test("deploy errors show the failed step rather than the upload's CLI help", () => {
    const message = deploymentError('MU_STEP deploy: Uploaded. vercel curl https://sample.vercel.app; View build logs: lots of help\nMU_STEP domain: Error: Unsupported Media Type (415) token=synthetic-secret\nMU_ERROR domain failed\n');
    expect(message).toContain("domain: Error: Unsupported Media Type (415)");
    expect(message).not.toContain("vercel curl");
    expect(message).not.toContain("View build logs");
    expect(message).not.toContain("synthetic-secret");
  });
  test("an error that names its own failure is not blamed on an earlier step that succeeded", () => {
    const message = deploymentError(["MU_STEP project inspect: created the project", "MU_STEP deploy: Uploaded fine", "MU_ERROR domain lookup returned an invalid response", ""].join("\n"));
    expect(message).toBe("domain lookup returned an invalid response");
  });
  test("a two-word step keeps its own output", () => {
    const message = deploymentError(["MU_STEP project add: ok", "MU_STEP project inspect: Error: not found (404)", "MU_ERROR project inspect failed", ""].join("\n"));
    expect(message).toContain("project inspect: Error: not found (404)");
    expect(message).not.toContain("project add");
  });
  test("a timed-out deploy says which step it had reached", () => {
    const out = ["MU_STEP project add: ok", "MU_STEP deploy: Uploading"].join(String.fromCharCode(10));
    expect(timeoutMessage(out)).toBe("timed out after deploy");
    expect(timeoutMessage("")).toBe("timed out before any step reported");
    expect(deploymentError(out + String.fromCharCode(10) + "MU_ERROR " + timeoutMessage(out))).toBe("timed out after deploy");
  });
  test("a failed live check names what failed, in words", () => {
    expect(liveCheckProblem({ status: 0, banner: false, noindexHeader: false })).toMatch(/didn't answer/);
    expect(liveCheckProblem({ status: 404, banner: false, noindexHeader: false })).toBe("Uploaded, but the address answered HTTP 404. Check that before sharing the link.");
    expect(liveCheckProblem({ status: 200, banner: false, noindexHeader: true })).toMatch(/banner wasn't on the page/);
    expect(liveCheckProblem({ status: 200, banner: true, noindexHeader: false })).toMatch(/noindex header was missing/);
    expect(liveCheckProblem({ status: 200, banner: true, noindexHeader: true, matchesPreview: false })).toMatch(/different build/);
  });
  test("a 200 page with the right business but different built assets fails verification", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
      `<p>${bannerText("Sample Dental")}</p><link href="/_next/static/other.css">`,
      { headers: { "X-Robots-Tag": "noindex" } }) });
    try {
      const result = await liveCheck(`http://127.0.0.1:${server.port}/`, "Sample Dental", ["/_next/static/expected.css"]);
      expect(result).toEqual({ status: 200, banner: true, noindexHeader: true, matchesPreview: false });
    } finally { server.stop(true); }
  });
  test("the uploaded assets and disclosure pass", async () => {
    const html = `<p>${bannerText("Sample Dental")}</p><link href="/_next/static/a.css"><script src="/_next/static/a.js"></script>`;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(html, { headers: { "X-Robots-Tag": "noindex" } }) });
    try { expect((await liveCheck(`http://127.0.0.1:${server.port}/`, "Sample Dental", previewAssets(html))).matchesPreview).toBe(true); }
    finally { server.stop(true); }
  });
  test("dental cannot silently switch to a generic design", () => {
    expect(() => assertPreviewDesign("dental", '<div class="generic">Marigold</div>')).toThrow(/selected Dental Care Plus flagship/);
    expect(() => assertPreviewDesign("dental", '<div class="FlagshipOpening-module__hero"><img src="/_img/640/img/generated/r15/lantern-room-wide.webp"></div>')).not.toThrow();
  });
});

/** Executes the real PowerShell deploy helper with a fake CLI. No Vercel/auth/network. */
function deployScenario(failure: string) {
  const root = mkdtempSync(join(tmpdir(), "mu-deploy-fixture-")); temporary.push(root);
  const stage = join(root, "stage"); mkdirSync(join(stage, ".vercel"), { recursive: true });
  writeFileSync(join(stage, "index.html"), "<h1>Sample</h1>");
  writeFileSync(join(stage, ".vercel", "project.json"), JSON.stringify({ projectName: "unrelated-old-project" }));
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const calls = join(root, "calls.jsonl");
  const wrapper = join(root, "run.ps1");
  writeFileSync(wrapper, `
function global:vercel {
  param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
  ConvertTo-Json -InputObject @($CommandArgs) -Compress | Add-Content -LiteralPath ${quote(calls)}
  $global:LASTEXITCODE = 0
  $step = $CommandArgs[0]
  if ($step -eq 'project') { $step = 'project ' + $CommandArgs[1] }
  if ($step -eq 'api') {
    if ($CommandArgs -contains 'POST') { $step = 'domain post' } else { $step = 'domain lookup' }
  }
  if (${quote(failure)} -eq 'project add' -and $step -eq 'project inspect') { $global:LASTEXITCODE = 1; return 'not found' }
  if ($step -eq ${quote(failure)}) { $global:LASTEXITCODE = 1; return 'synthetic failure' }
  if ($step -eq 'domain lookup' -and ${quote(failure)} -ne 'existing domain') { $global:LASTEXITCODE = 1; return 'Error: domain not found (404)' }
  if ($step -eq 'domain lookup' -or $step -eq 'domain post') { return '{"name":"harbour-dental.muventures.com.au","verified":true}' }
  if ($step -eq 'deploy') {
    if (${quote(failure)} -eq 'wrong project') { return 'https://muventures-synthetic.vercel.app' }
    return 'https://mu-preview-harbour-dental-synthetic.vercel.app'
  }
  return 'synthetic success'
}
& ${quote(resolve("scripts/lead-sites/vercel.ps1"))} -Action deploy -Project mu-preview-harbour-dental -Stage ${quote(stage)} -Domain harbour-dental.muventures.com.au -Scope synthetic
exit $LASTEXITCODE
`, "utf8");
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  return { code: run.status, text: run.stdout + run.stderr,
    calls: exists(calls) ? readFileSync(calls, "utf8").trim().split(/\r?\n/).map((row) => JSON.parse(row) as string[]) : [] };
}
function exists(file: string) { try { return readFileSync(file).length >= 0; } catch { return false; } }

describe("Windows deployment routing", () => {
  test.skipIf(process.platform !== "win32")("relinks the staging folder and attaches both the production domain and exact deployment alias", () => {
    const run = deployScenario("");
    expect(run.code).toBe(0); expect(run.text).toContain("MU_DONE");
    expect(run.calls[1]).toEqual(["link", "--yes", "--project", "mu-preview-harbour-dental", "--scope", "synthetic"]);
    expect(run.calls.slice(-2)).toEqual([
      ["api", "/v10/projects/mu-preview-harbour-dental/domains", "-X", "POST", "-F", "name=harbour-dental.muventures.com.au", "-H", "Content-Type: application/json", "--scope", "synthetic"],
      ["alias", "set", "https://mu-preview-harbour-dental-synthetic.vercel.app", "harbour-dental.muventures.com.au", "--scope", "synthetic"],
    ]);
  });
  test.skipIf(process.platform !== "win32")("retries reuse a domain already attached to the expected project", () => {
    const run = deployScenario("existing domain");
    expect(run.code).toBe(0);
    expect(run.calls.some((call) => call.includes("POST"))).toBe(false);
    expect(run.calls.some((call) => call[0] === "alias")).toBe(true);
  });
  for (const failure of ["project add", "link", "deploy", "domain lookup", "domain post", "alias", "wrong project"]) {
    test.skipIf(process.platform !== "win32")(`a ${failure} failure never reports success or proceeds to later commands`, () => {
      const run = deployScenario(failure);
      expect(run.code).toBe(1); expect(run.text).not.toContain("MU_DONE"); expect(run.text).toContain("MU_ERROR");
      if (failure !== "alias") expect(run.calls.some((call) => call[0] === "alias")).toBe(false);
    });
  }
});
