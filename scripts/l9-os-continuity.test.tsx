// L9 (29 Sep 2026): the OS audit's P1 bugs and its naming, navigation, voice-UI, copy and accessibility
// continuity findings (AUDIT-OS.md). Pure functions run for real; UI wiring that only a browser can show is
// asserted from source, and the preview screenshots in D:\agent-scratch\l9 are the visual evidence.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESTINATIONS, EXTRA_PAGE_NAMES, OS_NAME, docTitle, drilldownFor, drilldownHref, locate, pageName } from "../src/components/shell/destinations";
import { buildCommandIndex, exactPageMatch, orderPaletteResults, parseCommandText, planCommand, resolveCommand, searchCommands, staticEntries, mayRunEntry } from "../src/lib/commands/registry";
import { actsOrPays } from "../src/lib/commands/action-guard";
import { BUSINESS_VIEWS, BUSINESS_VIEW_TITLE } from "../src/lib/business-view";
import { NO_BRIEF, NO_MAIL_READ, callsHeadline, inboxAnswer } from "../src/lib/quick-actions";
import { QUERY_DEFAULTS } from "../src/lib/query-defaults";
import { plural } from "../src/lib/plural";
import { isFolderKeyShape, isJobIdShape } from "../src/lib/route-checks";
import { restartTile } from "../src/components/shell/system-facts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** What the palette shows for typed words: the same pipeline as command-palette-body.tsx (without React). */
function palette(q: string, index = buildCommandIndex()) {
  const gate = actsOrPays(q);
  const obj = parseCommandText(q).object;
  const found = searchCommands(q, index, 40).filter((f) => (gate === "money" || gate === "action" ? f.entry.action.type !== "device" && f.entry.action.type !== "open-url" : mayRunEntry(f, obj)));
  const ask = gate ? { id: "rule:ask-jarvis", kind: "answer" as const, title: `Ask Jarvis: “${q}”`, detail: "", phrases: [], action: { type: "navigate" as const, to: "/jarvis" }, source: "static" as const } : null;
  return orderPaletteResults(q, found, index, { ask }).map((r) => r.entry);
}

describe("P1-1: the header holds at iPad-portrait width (768) and up", () => {
  const sidebar = read("src/components/app-sidebar.tsx");
  test("the sidebar is a drawer until lg (1024); the drawer button shows below it", () => {
    expect(sidebar).toContain('className="op-sidebar sh-sidebar hidden lg:flex"');
    expect(sidebar).toContain('className="lg:hidden op-icon-button shrink-0"');
    expect(read("src/operator.css")).toContain("@media (min-width: 1024px) {\n  .op-icon-button.lg\\:hidden");
    expect(sidebar).not.toContain('hidden md:flex" data-rail');
  });
  test("Share screen, Meeting and typed assistant entry show text only from xl; icons keep their accessible names", () => {
    const share = read("src/components/operator/screen-share-control.tsx");
    const meeting = read("src/components/operator/meeting-mode-hud.tsx");
    expect(share).toContain('aria-label="Share screen"');
    expect(share).toContain('labels === "always" ? "" : "hidden xl:inline"');
    expect(meeting).toContain('aria-label="Meeting mode"');
    expect(meeting).toContain('labels === "always" ? "" : "hidden xl:inline"');
    expect(read("src/routes/__root.tsx")).toContain('<span className="hidden xl:inline">Type a request</span>');
    // the drawer, which has room, keeps the words
    expect(sidebar).toContain('<ScreenShareControl labels="always" />');
    expect(sidebar).toContain('<MeetingModeControl labels="always" />');
  });
  test("Work's action buttons wrap instead of spilling out of their card", () => {
    const work = read("src/components/shell/pages/work-page.tsx");
    expect(work).not.toContain('className="h-10 rounded-full px-5"');
    expect(work).toContain("max-w-full whitespace-normal");
  });
});

describe("P1-2: the palette reaches every page by its name", () => {
  const index = buildCommandIndex();
  const pages = staticEntries().filter((e) => e.kind === "page" && e.action.type === "navigate");

  test("there are at least 38 page entries and each one typed by its title is the first result", () => {
    expect(pages.length).toBeGreaterThanOrEqual(38);
    for (const entry of pages) {
      const results = palette(entry.title, index);
      expect(results[0]?.id, `typing "${entry.title}"`).toBe(entry.id);
    }
  });
  test("Enter on each typed title lands on that page (destination and Business tab included)", () => {
    for (const entry of pages) {
      const first = palette(entry.title, index)[0];
      const plan = planCommand(first, parseCommandText(entry.title));
      expect(plan.kind).toBe("navigate");
      const want = entry.action.type === "navigate" ? entry.action : null;
      if (plan.kind === "navigate" && want) {
        expect(plan.to).toBe(want.to);
        expect(plan.search ?? null).toEqual(want.search ?? null);
      }
    }
  });
  test('"jarvis" and "go to jarvis" open the Jarvis page (the lead-in and trail words no longer eat the name)', () => {
    expect(parseCommandText("jarvis").object).toBe("jarvis");
    expect(parseCommandText("go to jarvis")).toMatchObject({ verb: "show", object: "jarvis" });
    expect(parseCommandText("open Jarvis")).toMatchObject({ verb: "open", object: "jarvis" });
    for (const q of ["jarvis", "go to jarvis", "Jarvis", "open jarvis"]) expect(palette(q, index)[0]?.id, q).toBe("page:/jarvis");
    expect(resolveCommand("go to jarvis", index)).toMatchObject({ status: "resolved", entry: { id: "page:/jarvis" } });
  });
  test("the wake word on its own is still not a request to open a page when spoken", () => {
    expect(resolveCommand("Hey Jarvis", index, { channel: "voice" }).status).toBe("unresolved");
    // ...and the ordinary framing still strips: "Hey Jarvis, could you open PowerPoint here please"
    expect(parseCommandText("Hey Jarvis, could you open PowerPoint here please")).toEqual({ verb: "open", object: "powerpoint", spokenTarget: "here" });
  });
  test('"share card" is the Share card page first, whatever the gate says; "Ask Jarvis" never outranks it', () => {
    const results = palette("share card", index);
    expect(results[0].id).toBe("page:/share");
    const ask = results.findIndex((e) => e.id === "rule:ask-jarvis");
    expect(ask === -1 || ask === 1).toBe(true);
    // With the gate forced on (a word the page guard does not clear), the page is still first and Ask Jarvis second.
    const forced = orderPaletteResults("share card", searchCommands("share card", index, 40), index, { ask: { id: "rule:ask-jarvis", kind: "answer", title: "Ask", detail: "", phrases: [], action: { type: "navigate", to: "/jarvis" }, source: "static" } });
    expect(forced.map((r) => r.entry.id).slice(0, 2)).toEqual(["page:/share", "rule:ask-jarvis"]);
  });
  test('"finances" is Finances, not Finance; "finance" is Finance', () => {
    expect(palette("finances", index)[0].id).toBe("page:/business?view=finance");
    expect(palette("finance", index)[0].id).toBe("page:/finance");
    expect(exactPageMatch("finances", index)?.title).toBe("Finances");
  });
  test("the money and action gate for real actions is untouched", () => {
    expect(actsOrPays("pay the telstra bill")).toBe("money");
    expect(actsOrPays("send the proposal to Brooke")).toBe("action");
    const results = palette("delete the vault", index);
    expect(results.some((e) => e.action.type === "device" || e.action.type === "open-url")).toBe(false);
  });
});

describe("P2-2: the palette follows the sidebar", () => {
  test("Mission Control and OpenClaw are listed only while their Settings switches are on", () => {
    const off = buildCommandIndex({}, 0, { settings: { mission: false, openclaw: false } }).entries.map((e) => e.id);
    expect(off).not.toContain("page:/dashboard");
    expect(off).not.toContain("page:/agents/openclaw");
    const on = buildCommandIndex({}, 0, { settings: { mission: true, openclaw: true } }).entries.map((e) => e.id);
    expect(on).toContain("page:/dashboard");
    expect(on).toContain("page:/agents/openclaw");
    // no settings given (voice and typed resolution): every page stays reachable by name
    expect(buildCommandIndex().entries.map((e) => e.id)).toContain("page:/dashboard");
  });
  test("the sidebar table has one description per page: the palette and Settings read it", () => {
    const mission = drilldownFor("/dashboard")!;
    const openclaw = drilldownFor("/agents/openclaw")!;
    const entries = buildCommandIndex().entries;
    expect(entries.find((e) => e.id === "page:/dashboard")?.detail).toBe(`Jarvis · ${mission.purpose}`);
    expect(entries.find((e) => e.id === "page:/agents/openclaw")?.detail).toBe(`System · ${openclaw.purpose}`);
    const prefs = read("src/components/operator/preferences.tsx");
    expect(prefs).toContain('drilldownFor("/dashboard")!.purpose');
    expect(prefs).toContain('drilldownFor("/agents/openclaw")!.purpose');
    expect(prefs).not.toContain("advanced agent and activity dashboard");
  });
  test("Audience and Inbox triage are pages you can reach (sidebar and palette)", () => {
    const home = DESTINATIONS.find((d) => d.id === "today")!;
    expect(home.drilldowns.map((d) => d.label)).toEqual(["Inbox", "Inbox triage", "Calendar", "Audience"]);
    expect(locate("/business", "audience")?.drilldown?.label).toBe("Audience");
    expect(locate("/inbox-triage")?.drilldown?.label).toBe("Inbox triage");
    const audience = buildCommandIndex().entries.find((e) => e.id === "page:/business?view=audience")!;
    expect(audience.action).toEqual({ type: "navigate", to: "/business", search: { view: "audience" } });
    expect(searchCommands("audience", buildCommandIndex(), 3)[0].entry.id).toBe("page:/business?view=audience");
    expect(searchCommands("inbox triage", buildCommandIndex(), 3)[0].entry.id).toBe("page:/inbox-triage");
    expect(drilldownHref({ to: "/business", view: "audience" })).toBe("/business?view=audience");
  });
  test('the Windows Settings app is "Windows settings"; "Settings" is the OS page only', () => {
    const index = buildCommandIndex({ apps: { state: "live", items: [{ name: "Settings" }, { name: "Notepad" }] } });
    const titles = index.entries.map((e) => e.title);
    expect(titles.filter((t) => t === "Settings")).toHaveLength(1);
    expect(titles).toContain("Windows settings");
    expect(palette("settings", index)[0].id).toBe("page:/settings");
    expect(palette("windows settings", index)[0].id).toBe("app:Settings");
  });
  test("no two page entries share a title", () => {
    const titles = staticEntries().filter((e) => e.kind === "page").map((e) => e.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("P1-3: an empty read is never reported as good news", () => {
  test("the inbox action says it can't tell when the total is 0 or unknown", () => {
    expect(inboxAnswer({ total: 0, urgent: 0, today: 0 })).toEqual({ summary: NO_MAIL_READ, headline: "No mail read" });
    expect(inboxAnswer({ urgent: 0, today: 0 }).summary).toBe(NO_MAIL_READ);
    expect(inboxAnswer({ total: null }).summary).toBe("No mail read in the last 24 hours (inbox not connected or not synced), so I can't say.");
    expect(inboxAnswer({ total: 12, urgent: 0, today: 0 })).toEqual({ summary: "Nothing important in the last 24 hours." });
    expect(inboxAnswer({ total: 12, urgent: 2, today: 1 }).summary).toBe("2 urgent in the last 24 hours.");
    expect(inboxAnswer({ total: 12, urgent: 0, today: 3 }).summary).toBe("Nothing urgent. 3 to handle today.");
  });
  test('"Brief loaded" and "Call list ready" only when there is a brief or a call', () => {
    expect(NO_BRIEF.headline).toBe("No brief yet");
    expect(NO_BRIEF.summary).toContain("No brief has been written yet");
    expect(callsHeadline(0, 0)).toBe("No calls to make");
    expect(callsHeadline(undefined, 0)).toBe("No calls to make");
    expect(callsHeadline(3, 0)).toBeUndefined();
    expect(callsHeadline(0, 4)).toBeUndefined();
    const src = read("src/components/business/quick-actions.tsx");
    expect(src).toContain("...inboxAnswer(d)");
    expect(src).toContain("...NO_BRIEF");
    expect(src).toContain("headline: callsHeadline(data.due, data.leads.length)");
    expect(src).toContain("${result.headline ?? def.done}");
  });
});

describe("P1-4: a source that is down says so straight away", () => {
  const src = read("src/components/operator/automations-workspace.tsx");
  test("Automations: no retries, an error card at once, and a Refresh that shows it is working", () => {
    expect(src).toContain("retry: 0,");
    expect(src).toContain("query.isError && !query.data");
    expect(src).toContain("Couldn't reach the scheduler");
    expect(src).toContain("The jobs are unknown, not missing.");
    expect(src).toContain("disabled={query.isFetching}");
    expect(src).toContain("aria-busy={query.isFetching}");
    expect(src).toContain('query.isFetching ? "animate-spin');
    expect(src).toContain("void query.refetch()");
  });
  test("every other page: one quick retry by default instead of 1 s + 2 s + 4 s of grey rows", () => {
    expect(QUERY_DEFAULTS.queries).toEqual({ retry: 1, retryDelay: 400, staleTime: 5_000 });
    const router = read("src/router.tsx");
    expect(router).toContain("new QueryClient({ defaultOptions: QUERY_DEFAULTS })");
  });
});

describe("P2-1: one name per page", () => {
  test("pageName reads the sidebar table; docTitle is one pattern", () => {
    for (const d of DESTINATIONS) {
      expect(pageName(d.to)).toBe(d.label);
      expect(docTitle(d.to)).toBe(`${d.label} — ${OS_NAME}`);
      for (const dd of d.drilldowns) expect(pageName(dd.to, dd.view), `${dd.to}${dd.view ?? ""}`).toBe(dd.label);
    }
    expect(pageName("/business")).toBe("Home");
    expect(pageName("/business", "progress")).toBe("Goals");
    expect(pageName("/business", "finance")).toBe("Finances");
    expect(pageName("/business", "audience")).toBe("Audience");
    expect(pageName("/dashboard")).toBe("Mission Control");
    expect(pageName("/operations")).toBe("Packages & economics");
    expect(pageName("/codegraph")).toBe("Knowledge graph");
    expect(pageName("/websites")).toBe("Websites");
    expect(pageName("/agents/hermes")).toBe("Hermes");
    expect(docTitle("/not-found")).toBe("Page not found — Agentic OS");
    expect(Object.keys(EXTRA_PAGE_NAMES)).toContain("/setup");
  });
  test("Progress is Goals: the Home tab, the Goals page and the sidebar agree", () => {
    expect(BUSINESS_VIEW_TITLE).toEqual({ overview: "Home", finance: "Finances", progress: "Goals", audience: "Audience" });
    const business = read("src/routes/business.tsx");
    expect(business).toContain("BUSINESS_VIEWS.map((key) => ({ key, label: BUSINESS_VIEW_TITLE[key] }))");
    expect(business).not.toContain('label: "Progress"');
    expect(business).toContain('docTitle("/business", businessViewOf(match.search as never))');
    expect(BUSINESS_VIEWS.map((v) => BUSINESS_VIEW_TITLE[v])).toEqual(["Home", "Finances", "Goals", "Audience"]);
    expect(drilldownFor("/leads")?.purpose).toBe("Calls to make and the pipeline.");
  });
  test("every route's browser title comes from the table (one 'X — Agentic OS' pattern)", () => {
    const files = readdirSync(join(ROOT, "src/routes")).filter((f) => f.endsWith(".tsx"));
    const redirectOnly = new Set(["index.tsx", "today.tsx", "workspace.tsx"]);
    for (const f of files) {
      const src = read(`src/routes/${f}`);
      if (redirectOnly.has(f)) continue;
      expect(src, f).toMatch(/title: docTitle\(/);
      expect(src, f).not.toMatch(/title: "[^"]*(Agentic OS|Agentic)"/);
      expect(src, f).not.toMatch(/title: "[^"]*\| Agentic OS"/);
    }
    const root = read("src/routes/__root.tsx");
    expect(root).toContain('title: docTitle("/not-found")');
    expect(read("src/components/operator/workspace-onboarding.tsx")).toContain("document.title = docTitle(");
  });
  test("page headings read the table: Packages & economics, Mission Control, Vault", () => {
    expect(read("src/components/business/mu-operations.tsx")).toContain('<h1>{pageName("/operations")}</h1>');
    expect(read("src/routes/-pages/dashboard.tsx")).toContain('title={pageName("/dashboard")}');
    expect(read("src/components/memory/memory-vault.tsx")).toContain('title={pageName("/memory/vault")}');
    expect(read("src/components/business/mu-operations.tsx")).not.toContain("M&U operations");
    expect(read("src/routes/business.tsx")).toContain(">Packages & economics</a>");
  });
  test("Mission Control names one thing: the Hermes mission panel and the Claude Code page no longer borrow it", () => {
    const mission = read("src/components/hermes-mission-control.tsx");
    expect(mission).toContain('title="Long-term mission"');
    expect(mission).not.toContain('title="Mission Control"');
    expect(mission).toContain("Couldn't read the long-term mission");
    expect(read("src/routes/agents.claude-code.tsx")).not.toContain("(Mission Control)");
    expect(drilldownFor("/agents/claude-code")?.purpose).not.toContain("Mission Control");
    expect(read("src/components/floating-oracle.tsx")).not.toContain('title: "Mission Control (Home)"');
  });
  test("Settings links use the canonical names", () => {
    const prefs = read("src/components/operator/preferences.tsx");
    for (const to of ["/dashboard", "/usage", "/skills", "/codegraph"]) expect(prefs).toContain(`pageName("${to}")`);
    for (const old of ["Usage & Dream review", "Capabilities ↗", "Codebase graphs"]) expect(prefs).not.toContain(old);
  });
  test('calls: "Calls to make" is the queue everywhere; "Calls today" stays for received calls; the window is "Calling hours"', () => {
    expect(read("src/components/operator/call-queue.tsx")).toContain('title="Calls to make"');
    expect(read("src/components/workspace/other-panels.tsx")).toContain('title="Calls to make"');
    expect(read("src/components/operator/leads-workspace.tsx")).toContain("<h2>Calls to make</h2>");
    expect(read("src/lib/quick-actions.ts")).toContain('label: "Calls to make"');
    expect(read("src/components/receptionist/dashboard/sell-status.tsx")).toContain('label="Calls today"');
    expect(read("src/components/workspace/today-panel.tsx")).toContain('Calling hours {w.open ? "open" : "closed"}');
    expect(read("src/components/shell/today-facts.ts")).toContain('callQueue: "Calls to make"');
  });
});

describe("P2-3 and P2-4: the voice overlay and the chat send are gold, calm and keyboard-friendly", () => {
  test("the overlay repins the OS's dark gold tokens, not the old lilac (hue 286-304)", () => {
    const css = read("src/components/operator/voice-companion.css");
    expect(css).toContain("--brand: oklch(0.733 0.101 84);");
    expect(css).not.toMatch(/--brand[a-z-]*: oklch\([^)]* 30[0-9]\)/);
    expect(css).not.toContain("oklch(0.165 0.006 286)");
    expect(read("src/components/operator/jarvis-core.tsx")).toContain("const palette = [44, 38, 50, 33, 46, 42];");
  });
  test("the chat send is the brand gold, not the pink gradient", () => {
    const css = read("src/components/operator/chat-refinements.css");
    expect(css).not.toContain("#e8449a");
    expect(css).not.toContain("#d12b4b30");
    expect(css).toContain(".ar-agentic-prompt .agentic-prompt-send.is-send {\n  /* Gold, the one accent");
    expect(css).toContain("background: var(--brand);");
    expect(read("src/components/operator/chat-page-composer.css")).not.toContain("#286cd8");
    const input = read("src/components/ui/ai-chat-input.tsx");
    expect(input).toContain('"is-send bg-brand text-brand-foreground"');
    expect(input).not.toContain("bg-primary text-primary-foreground transition-all");
  });
  test('the overlay copy is plain: "Talk to Jarvis", "Type instead", "1 node"', () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain("Talk to Jarvis");
    expect(vc).toContain("Type instead");
    expect(vc).not.toContain("Let’s talk");
    expect(vc).not.toContain("Put an idea into motion");
    expect(vc).not.toContain('aria-label="Start conversation"\n                    onClick');
    const stage = read("src/components/operator/jarvis-memory-stage.tsx");
    expect(stage).toContain('plural(allowedNodes.length, "node")');
    expect(stage).not.toContain("Your world, connected.");
    expect(plural(1, "node")).toBe("1 node");
    expect(plural(2, "node")).toBe("2 nodes");
    expect(plural(1200, "node")).toBe("1,200 nodes");
  });
  test("focus moves into the dialog on open (even when the Memory mic focuses its textarea a beat later) and Esc closes it from anywhere", () => {
    const vc = read("src/components/operator/voice-companion.tsx");
    expect(vc).toContain('document.addEventListener("focusin", pullBack);');
    expect(vc).toContain("panel.current?.focus();");
    // Esc no longer needs focus inside the panel; it only stands aside for another dialog or menu that has focus
    expect(vc).toContain("if (panel.current?.contains(here) || !other || other === panel.current) closePanel.current();");
    // the composer's textarea handler collapses itself on Escape but never stops or cancels the event
    const input = read("src/components/ui/ai-chat-input.tsx");
    const handler = input.slice(input.indexOf("onKeyDown={(e) => {\n                if (e.key === \"Enter\""), input.indexOf("placeholder={placeholder}"));
    expect(handler).toContain('e.key === "Escape"');
    expect(handler).not.toContain("stopPropagation");
    expect(handler.match(/preventDefault/g)?.length).toBe(1); // Enter only
  });
});

describe("P2-8: owner-facing copy and 404s", () => {
  test("no developer commands or roadmap talk in owner-facing text", () => {
    const studio = read("src/components/shell/pages/studio-page.tsx");
    expect(studio).not.toContain("install-design-capture");
    expect(studio).toContain("Ask Jarvis to set this up.");
    expect(studio).not.toContain("arrives with the sales track");
    const design = read("src/routes/design.tsx");
    expect(design).not.toContain("bun run scripts/install-design-capture.ts");
    expect(design).toContain("Ask Jarvis to set this up.");
    expect(read("src/components/shell/pages/today-page.tsx")).not.toContain("Watcher not scheduled yet");
    expect(read("scripts/commands/plugin.ts")).not.toContain("Get-StartApps).");
  });
  test('"1 approval couldn\'t be read", never "1 approvals entry needs fixing"', () => {
    const work = read("src/components/shell/pages/work-page.tsx");
    expect(work).toContain('plural(v.errors, "approval")} couldn\'t be read');
    expect(work).not.toContain("entry needs");
    expect(plural(1, "approval")).toBe("1 approval");
    expect(plural(3, "approval")).toBe("3 approvals");
  });
  test('System says "Saves automatically", not a raw quiet-window length', () => {
    expect(restartTile({ pending: false, waitingFor: [], requestedAt: null, restartsAfter: null, quietMs: 4_000 }, null).hint).toBe("Saves automatically");
    expect(restartTile({ pending: true, waitingFor: [], requestedAt: 1, restartsAfter: null, quietMs: 4_000 }, null).hint).not.toContain("quiet window");
  });
  test("a job id or folder key that can't exist is a real 404; the not-found views have a heading and the way back", () => {
    expect(isJobIdShape("nope")).toBe(false);
    expect(isJobIdShape("9d3b0c1e-6f6a-4a55-8a4f-0e0a5d9b4f21")).toBe(true);
    expect(isFolderKeyShape("nope")).toBe(false);
    expect(isFolderKeyShape("C--Users-Nebula-PC-source-repos-x")).toBe(true);
    expect(isFolderKeyShape("-Users-usman-code-x")).toBe(true);
    const coding = read("src/routes/coding.$jobId.tsx");
    expect(coding).toContain("if (!isJobIdShape(params.jobId)) throw notFound();");
    expect(coding).toContain("notFoundComponent");
    expect(coding).toContain('backTo="/coding"');
    const ws = read("src/routes/workspaces.$id.tsx");
    expect(ws).toContain("if (!isWorkspaceId(params.id) && !isFolderKeyShape(params.id)) throw notFound();");
    expect(ws).toContain("The workspaces are M&U Ventures, Receptionist and Websites.");
    expect(ws).not.toContain("not used with Claude Code recently");
    const panel = read("src/components/shell/not-found-panel.tsx");
    expect(panel).toContain("<PageHeader title={title} description={description} />");
    expect(panel).toContain("<Link to={backTo as never}");
    expect(read("src/components/coding/job-detail.tsx")).toContain("no such coding job|unknown coding");
    const root = read("src/routes/__root.tsx");
    expect(root).toContain('<h1 className="mt-4 text-2xl font-semibold text-foreground">Page not found</h1>');
  });
});

describe("P2-9: accessibility quick wins", () => {
  test("Home: the h1 comes before the setup invitation's h2", () => {
    const business = read("src/routes/business.tsx");
    expect(business.indexOf("<PageHeader")).toBeGreaterThan(-1);
    expect(business.indexOf("<PageHeader")).toBeLessThan(business.indexOf("<SetupWelcome />"));
    expect(business.match(/<SetupWelcome/g)?.length).toBe(1);
  });
  test("Chat has one h1 (the welcome is an h2), and the HUD window has an h1", () => {
    expect(read("src/routes/chat.tsx")).toContain('<h1 className="sr-only">Chat</h1>');
    const oracle = read("src/components/floating-oracle.tsx");
    expect(oracle).toContain('<h2>{persona === "private-advisor" ? "Think bigger." : "Ask anything."}</h2>');
    for (const css of ["src/operator.css", "src/components/operator/chat-refinements.css"]) expect(read(css)).toContain(".ar-chat-welcome h2");
    expect(read("src/routes/hud.tsx")).toContain('<h1 className="sr-only">Jarvis HUD</h1>');
  });
  test('the header trigger\'s name contains its visible "Go to…"; the motion button no longer repeats itself', () => {
    expect(read("src/components/shell/command-palette.tsx")).toContain('aria-label="Go to… (open the command palette)"');
    const motion = read("src/components/shell/motion-control.tsx");
    expect(motion).not.toContain("aria-label=");
    expect(motion).toContain("aria-describedby={whyId}");
    expect(motion).toContain("Motion: {word}");
  });
  test("the palette and the Command scene give Radix a title and a real description", () => {
    for (const f of ["src/components/shell/command-palette-body.tsx", "src/components/shell/command-scene/command-scene.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("<DialogPrimitive.Title");
      expect(src, f).toContain("<DialogPrimitive.Description");
      expect(src, f).not.toMatch(/aria-describedby="c[ps]-help"/);
    }
  });
});

describe("P2-7: the Inbox has no second theme switch", () => {
  test("Inbox follows More > Dark mode; its own switch is gone", () => {
    const inbox = read("src/components/operator/inbox-workspace.tsx");
    expect(inbox).not.toContain("InboxThemeControl");
    expect(inbox).not.toContain("Inbox appearance");
    expect(inbox).not.toContain('localStorage.setItem("agentic-inbox-theme"');
    expect(inbox).toContain('const effectiveTheme = globalDark ? "dark" : "light";');
  });
});
