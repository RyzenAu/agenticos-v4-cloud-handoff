// Runs the rendered tests (scripts/r7-behaviour/behaviour.inner.tsx) in their own process: they install a fake DOM at import time,
// which must not leak into any other test file in the same run. Same pattern as scripts/r6-ui-behaviour.test.ts.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("rendered behaviour: decision form focus, Escape and failed save; Settings tabs in history; Work count links; a double-click logs one call", () => {
  const root = join(import.meta.dir, "..");
  const out = Bun.spawnSync([process.execPath, "test", "./scripts/r7-behaviour/behaviour.inner.tsx"], { cwd: root });
  const text = out.stdout.toString() + out.stderr.toString();
  const pass = Number(text.match(/(\d+) pass/)?.[1] ?? 0);
  if (out.exitCode !== 0) console.log(text.slice(-3000));
  expect(out.exitCode).toBe(0);
  expect(pass).toBeGreaterThanOrEqual(10);
}, 120_000);

// Pins for wording and structure that a render in this harness cannot reach (the pages need a hub); each was checked in a browser on
// a synthetic hub (docs/programme-20261001/APP-INVENTORY-R7.md).
import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

test("Home's side doors (Command scene, Packages & economics) appear on the Home tab only", () => {
  const src = read("src/routes/business.tsx");
  expect(src).toContain('{view === "overview" && <CommandSceneButton');
  expect(src).toContain('{view === "overview" && <a className="biz-demo-toggle max-sm:hidden" href="/operations">Packages & economics</a>');
});
test("one statement per fact: Finance tiles, System tiles and the empty NAB tab do not repeat the step or the card below", () => {
  expect(read("src/components/shell/pages/finance-page.tsx")).toContain('bankNeedsImport && csv.state === "unknown" ? undefined');
  const system = read("src/components/shell/pages/system-page.tsx");
  expect(system).toContain("the Models card below says it");
  expect(system).toContain("the Tools card below says why");
  expect(read("src/components/finance/manual-finance.tsx")).toContain("{embedded && hasData && <div");
});
test("Activity shows the server's reason for a failed read, not only the status", () => {
  expect(read("src/routes/activity.tsx")).toContain("The server says why");
});

test("Websites lists each site once and says nothing about Vercel being unreadable when it is signed out", () => {
  const page = read("src/routes/websites.tsx");
  expect(page).not.toContain("<SitesGlance");
  // "Checking Vercel" only while a refresh is actually running; a signed-out hub shows the one notice and blank deploy times.
  expect(page).toContain('vercel.error ? "" : vercel.refreshing ? "Checking Vercel"');
});

test("the top bar keeps the search pill and the Jarvis chip whole and lets the breadcrumb give way", () => {
  const css = read("src/components/shell/shell.css");
  expect(css).toMatch(/\.sh-header \.sh-jarvis-chip \{[^}]*flex-shrink: 0;/);
  expect(css).toMatch(/\.sh-header \.cp-trigger \{[^}]*white-space: nowrap;/);
  expect(css).toMatch(/\.sh-crumb-current \{[^}]*text-overflow: ellipsis;/);
  expect(read("src/components/shell/command-palette.tsx")).toContain("hidden min-[1400px]:inline");
});

test("Home and Setup carry no vendor imagery, third-party links or duplicate tiles", () => {
  const welcome = read("src/components/operator/setup-welcome.tsx");
  expect(welcome).not.toMatch(/mp4|SourceBrand|AmbientVideo/);
  const setup = read("src/components/operator/workspace-onboarding.tsx");
  expect(setup).not.toMatch(/notion\.site|SetupLandscape|claude-logo|openai\.png|googlecalendar/);
  const brief = read("src/components/business/mu-brief.tsx");
  expect(brief).not.toContain('aria-label="Pipeline"');
  expect(brief).not.toContain('aria-label="Receptionist"');
  expect(read("src/components/shell/pages/today-page.tsx")).not.toContain("Start: {firstStep.title}");
});

test("the Receptionist page says the launch is on hold, and its gates tile reads as a count", () => {
  expect(read("src/components/shell/pages/receptionist-destination.tsx")).toContain("Receptionist launch is on hold.");
  expect(read("src/components/receptionist/dashboard/sell-status.tsx")).toContain("`${passed} of ${blockers.length} passed`");
});

test("Design opens without a quote, a rainbow frame or a tab named after the section it sits in", () => {
  const design = read("src/routes/design.tsx");
  expect(design).not.toContain("<blockquote");
  expect(design).toContain('label: "Workspaces"');
  expect(design).not.toContain("#ff7959");
});

test("Jarvis workflow previews are two steps across, so a step name is never broken inside a word", () => {
  expect(read("src/components/shell/pages/jarvis-page.css")).toMatch(/\.jv-page \.ps-list \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  expect(read("src/components/shell/experience.css")).toMatch(/\.ps-label \{[^}]*overflow-wrap: break-word;/);
  expect(read("src/components/shell/progress-panel.tsx")).toContain("Replay an example call");
  expect(read("src/components/shell/progress-panel.tsx")).not.toContain("Replay a synthetic call");
});

// Audit 2 polish (P1 to P15): structure that a render cannot reach without a hub.
test("P1: the palette names where a row acts only for device rows, and has Devices and people", async () => {
  expect(read("src/components/shell/command-palette-body.tsx")).toContain('target.kind === "device" || target.kind === "jarvis" ?');
  const { SECTION_ENTRIES } = await import("../src/lib/commands/registry");
  const devices = SECTION_ENTRIES.find((e) => e.id === "section:system/devices");
  expect(devices?.action).toEqual({ type: "navigate", to: "/system", hash: "system-devices" });
  expect(devices?.phrases).toContain("pair a browser");
  const { entryTarget } = await import("../src/components/shell/palette-target");
  expect(entryTarget({ id: "x", action: { type: "device" } as never }, { ok: true, deviceId: "d", label: "Usman's PC", owner: "usman", online: true, routing: "devices" } as never).text).toBe("Runs on Usman's PC");
});
test("P2: the leads table fits without its Source column, and says what its numbers mean", () => {
  const table = read("src/components/operator/leads-table.tsx");
  expect(table).not.toContain('label: "Source"');
  expect(table).toContain("in stage");
  expect(table).toContain("% likely");
  expect(table).toContain("weighted");
});
test("P3: the board has no chip row repeating its columns on a wide screen, starts with prospects open and says Today", () => {
  const board = read("src/components/operator/leads-board.tsx");
  expect(board).toContain('className="mb-3 flex gap-1.5 overflow-x-auto pb-1 md:hidden"');
  expect(board).toContain("useState(true)");
  expect(board).not.toContain("To do today");
  expect(read("src/components/operator/lead-bits.tsx")).toContain('"directory signal"');
  expect(read("src/components/operator/crm-overview.tsx")).toContain('callsOpen ? "Today" : "Next"');
});
test("P5: Pause and Disable are explained, and the Hermes sentence has no cron jargon", () => {
  expect(read("src/components/operator/triggers-panel.tsx")).toContain("Pause holds new jobs until you resume. Disable switches the trigger off altogether");
  expect(read("src/components/operator/automations-workspace.tsx")).toContain("No scheduled jobs are being reported");
  expect(read("src/components/operator/automations-workspace.tsx")).not.toContain("isn't reporting any cron");
});
test("P10 to P15: Workspace tab address, bigger switches, calm tags, meeting panel under its button, one calendar instruction", () => {
  expect(read("src/routes/settings.tsx")).toContain('{ id: "workspace", label: "Workspace"');
  expect(read("src/operator.css")).toMatch(/\.op-switch \{\s*width: 44px;\s*height: 26px;/);
  expect(read("src/components/shell/pages/models-page.tsx")).toContain("used for ${m.tasks.length}");
  expect(read("src/components/shell/pages/system-page.tsx")).toContain("xl:grid-cols-3");
  expect(read("src/components/operator/meeting-mode-hud.tsx")).toContain("fixed right-4 top-16");
  expect(read("src/components/operator/native-calendar-connection.tsx")).toContain('!(h.state === "none" && primary)');
});
