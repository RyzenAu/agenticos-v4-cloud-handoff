/**
 * PowerPoint through its own automation interface (COM), the "app/API" executor behind the Jarvis entry
 * (Wave 2, 27 Sep 2026): open PowerPoint, create or open a deck, edit a slide's title/body text, show it
 * (slide show), and read everything back from PowerPoint itself to verify it. No pixels, no clicks.
 *
 * Fences, in code:
 *  - Decks live only under an authorised root (default D:\tmp\jarvis-acceptance; JARVIS_DECK_ROOTS adds
 *    more, ;-separated). A path outside every root is refused before PowerPoint is touched.
 *  - Only presentations whose full path is under a root are ever edited, shown or closed: his own open
 *    decks are never touched, and PowerPoint itself is quit only if nothing else is open in it.
 *  - Text goes to PowerShell as base64 (never spliced into the script), so a title can't run code.
 *  - Nothing is sent, shared or published: no email, no OneDrive sharing, no export.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { findQuoted } from "./jarvis-command/quotes";
import { CLAUSE_ACTION, DECK_STEP, strayStep } from "./jarvis-command/plan";

export const DEFAULT_DECK_ROOTS = ["D:\\tmp\\jarvis-acceptance"];
export function deckRoots(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.JARVIS_DECK_ROOTS ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_DECK_ROOTS, ...extra].map((r) => resolvePath(r));
}
/** Is this .pptx path inside an authorised root? Pure. */
export function authorisedDeck(path: string, roots: string[] = deckRoots()): boolean {
  if (!isAbsolute(path) || !/\.pptx$/i.test(path)) return false;
  const p = resolvePath(path).toLowerCase();
  return roots.some((r) => p.startsWith(r.toLowerCase().replace(/[\\/]+$/, "") + sep));
}

export type DeckOp =
  | { op: "create"; path: string; title: string; subtitle?: string }
  | { op: "open"; path: string }
  | { op: "edit"; path: string; slide: number; title?: string; body?: string }
  | { op: "add"; path: string; title: string; body?: string }
  | { op: "show"; path: string; slide?: number }
  | { op: "end"; path: string; close?: boolean };
export type DeckState = { ok: boolean; said: string; path: string; exists: boolean; slides: number | null; titles: string[]; showing: boolean; showSlide: number | null; ms: number };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The PowerShell for one op; all text arrives base64-encoded. Pure. */
export function deckScript(op: DeckOp): string {
  const text = (s: string | undefined) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s ?? "")}'))`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${text(op.path)}`,
    "$app = New-Object -ComObject PowerPoint.Application",
    "try { $app.Visible = -1 } catch {}",
    "$pres = $null",
    "foreach ($p in $app.Presentations) { if ($p.FullName -ieq $path) { $pres = $p } }",
  ];
  switch (op.op) {
    case "create":
      lines.push(
        "if (Test-Path -LiteralPath $path) { throw 'EXISTS' }",
        "$pres = $app.Presentations.Add(-1)",
        "$s = $pres.Slides.Add(1, 1)",
        `$s.Shapes.Item(1).TextFrame.TextRange.Text = ${text(op.title)}`,
        `if ($s.Shapes.Count -ge 2) { $s.Shapes.Item(2).TextFrame.TextRange.Text = ${text(op.subtitle ?? "")} }`,
        "$pres.SaveAs($path)",
      );
      break;
    case "open":
      lines.push("if (-not $pres) { if (-not (Test-Path -LiteralPath $path)) { throw 'MISSING' }; $pres = $app.Presentations.Open($path, 0, 0, -1) }");
      break;
    case "edit":
      lines.push(
        "if (-not $pres) { if (-not (Test-Path -LiteralPath $path)) { throw 'MISSING' }; $pres = $app.Presentations.Open($path, 0, 0, -1) }",
        `$n = ${Math.trunc(op.slide)}`,
        "if ($n -lt 1 -or $n -gt $pres.Slides.Count) { throw 'NOSLIDE' }",
        "$s = $pres.Slides.Item($n)",
        ...(op.title !== undefined ? [`$s.Shapes.Item(1).TextFrame.TextRange.Text = ${text(op.title)}`] : []),
        ...(op.body !== undefined ? [`if ($s.Shapes.Count -ge 2) { $s.Shapes.Item(2).TextFrame.TextRange.Text = ${text(op.body)} } else { throw 'NOBODY' }`] : []),
        "$pres.Save()",
      );
      break;
    case "add":
      lines.push(
        "if (-not $pres) { if (-not (Test-Path -LiteralPath $path)) { throw 'MISSING' }; $pres = $app.Presentations.Open($path, 0, 0, -1) }",
        "$s = $pres.Slides.Add($pres.Slides.Count + 1, 2)",
        `$s.Shapes.Item(1).TextFrame.TextRange.Text = ${text(op.title)}`,
        `if ($s.Shapes.Count -ge 2) { $s.Shapes.Item(2).TextFrame.TextRange.Text = ${text(op.body ?? "")} }`,
        "$pres.Save()",
      );
      break;
    case "show":
      lines.push(
        "if (-not $pres) { if (-not (Test-Path -LiteralPath $path)) { throw 'MISSING' }; $pres = $app.Presentations.Open($path, 0, 0, -1) }",
        "$set = $pres.SlideShowSettings",
        `$set.StartingSlide = ${Math.max(1, Math.trunc(op.slide ?? 1))}`,
        "$set.EndingSlide = $pres.Slides.Count",
        "[void]$set.Run()",
        "Start-Sleep -Milliseconds 900",
      );
      break;
    case "end":
      lines.push(
        "if ($pres) { foreach ($w in @($app.SlideShowWindows)) { if ($w.Presentation.FullName -ieq $path) { $w.View.Exit() } } }",
        "Start-Sleep -Milliseconds 400",
        ...(op.close ? ["if ($pres) { $pres.Close() ; $pres = $null }"] : []),
      );
      break;
  }
  // Read back from PowerPoint itself (the independent check), then quit only if nothing else is open.
  lines.push(
    "$titles = @(); $count = $null; $showing = $false; $showSlide = $null",
    "if ($pres) { $count = $pres.Slides.Count; foreach ($s in $pres.Slides) { try { $titles += $s.Shapes.Item(1).TextFrame.TextRange.Text } catch { $titles += '' } } }",
    "foreach ($w in @($app.SlideShowWindows)) { if ($w.Presentation.FullName -ieq $path) { $showing = $true; $showSlide = $w.View.CurrentShowPosition } }",
    ...(op.op === "end" && op.close ? ["if ($app.Presentations.Count -eq 0) { $app.Quit() }"] : []),
    "$titles64 = @($titles | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) })",
    "[pscustomobject]@{ slides = $count; titles = $titles64; showing = $showing; showSlide = $showSlide } | ConvertTo-Json -Compress",
  );
  // One block: any error ends the script with exit 1 (a line-by-line stdin script would carry on).
  return ["try {", ...lines.map((l) => `  ${l}`), "} catch {", "  [Console]::Error.WriteLine([string]$_.Exception.Message)", "  $t = (Get-Process POWERPNT -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowTitle", "  if ($t -match 'Unlicensed') { [Console]::Error.WriteLine('UNLICENSED') }", "  exit 1", "}"].join("\n");
}

export type RunPs = (script: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
/** Runs the whole script as one command (-EncodedCommand), so errors stop it and set the exit code. */
export const runPowerShell: RunPs = (script, timeoutMs) =>
  new Promise((done) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: String(e.message) });
    });
  });

const REASONS: Record<string, string> = {
  EXISTS: "a deck with that name already exists, so I didn't overwrite it",
  MISSING: "that deck isn't there",
  NOSLIDE: "that slide number isn't in the deck",
  NOBODY: "that slide has no body text box",
  // Seen live 27 Sep: Office showed "PowerPoint (Unlicensed Product)" and refused Presentations.Add.
  UNLICENSED: "PowerPoint is running as an Unlicensed Product (reduced functionality), so it won't create or edit decks until Office is activated",
};

/** One deck operation, fenced and verified by reading PowerPoint back. Never throws. */
export async function deckOp(input: DeckOp, deps: { run?: RunPs; roots?: string[]; now?: () => number } = {}): Promise<DeckState> {
  const now = deps.now ?? Date.now;
  // One spelling of the path everywhere (PowerPoint's FullName uses backslashes).
  const op: DeckOp = { ...input, path: isAbsolute(input.path) ? resolvePath(input.path) : input.path };
  const t0 = now();
  const base: DeckState = { ok: false, said: "", path: op.path, exists: false, slides: null, titles: [], showing: false, showSlide: null, ms: 0 };
  if (!authorisedDeck(op.path, deps.roots ?? deckRoots())) return { ...base, said: "That deck isn't in a folder I'm allowed to use, so I left PowerPoint alone." };
  if (process.platform !== "win32" && !deps.run) return { ...base, said: "PowerPoint automation runs on Windows only." };
  const r = await (deps.run ?? runPowerShell)(deckScript(op), 60_000).catch((e: Error) => ({ code: -1, stdout: "", stderr: e.message }));
  const exists = existsSync(op.path);
  if (r.code !== 0) {
    const key = Object.keys(REASONS).find((k) => r.stderr.includes(k) || r.stdout.includes(k));
    return { ...base, exists, ms: now() - t0, said: `PowerPoint didn't do it: ${key ? REASONS[key] : "the automation call failed"}.` };
  }
  let parsed: { slides?: number | null; titles?: string[] | string | null; showing?: boolean; showSlide?: number | null } = {};
  try {
    parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}");
  } catch {
    return { ...base, exists, ms: now() - t0, said: "PowerPoint answered, but I couldn't read its state back, so I can't say it worked." };
  }
  const titles = (Array.isArray(parsed.titles) ? parsed.titles : parsed.titles ? [parsed.titles] : []).map((t) => Buffer.from(String(t), "base64").toString("utf8"));
  const state: DeckState = { ...base, exists, slides: typeof parsed.slides === "number" ? parsed.slides : null, titles, showing: parsed.showing === true, showSlide: typeof parsed.showSlide === "number" ? parsed.showSlide : null, ms: now() - t0 };
  const name = basename(op.path);
  switch (op.op) {
    case "create": {
      const ok = exists && titles[0] === op.title;
      return { ...state, ok, said: ok ? `Created ${name} with the title slide, saved and read back.` : `I made the deck but couldn't confirm ${name} on disk with that title.` };
    }
    case "open":
      return { ...state, ok: state.slides !== null, said: state.slides !== null ? `Opened ${name} (${state.slides} slide${state.slides === 1 ? "" : "s"}).` : `I couldn't confirm ${name} is open.` };
    case "edit": {
      const ok = op.title === undefined || titles[op.slide - 1] === op.title;
      return { ...state, ok, said: ok ? `Edited slide ${op.slide} of ${name}; PowerPoint reads it back as changed.` : `I edited slide ${op.slide}, but it doesn't read back as asked.` };
    }
    case "add": {
      const ok = titles[titles.length - 1] === op.title;
      return { ...state, ok, said: ok ? `Added slide ${titles.length} to ${name}.` : "I added a slide but it doesn't read back as asked." };
    }
    case "show":
      return { ...state, ok: state.showing, said: state.showing ? `${name} is showing full screen, on slide ${state.showSlide ?? 1}.` : `I started the slide show, but PowerPoint doesn't report it showing ${name}.` };
    case "end":
      return { ...state, ok: !state.showing, said: !state.showing ? `Stopped showing ${name}${op.close ? " and closed it" : ""}.` : "The slide show is still running." };
  }
}

/** "create a deck called Q3 plan with the title Synthetic Review" → the ops. Pure, bounded, synthetic-friendly. */
/**
 * A named-deck request → the ops, in order. `ask` is set (and nothing should run) when part of it names a slide
 * this parser couldn't place, so a deck is never created or edited with a slide silently dropped (REVIEW-T2 R5).
 */
export function parseDeckRequest(text: string, roots: string[] = deckRoots()): { ops: DeckOp[]; path: string; ask?: string } | null {
  if (!/\b(?:powerpoint|deck|slides?|presentation)\b/i.test(text)) return null;
  // The text in quotes right after a lead-in ("called", "the title", "subtitle", "to"), with the SAME paired-
  // quote parser as the command rules (jarvis-command/quotes.ts): an apostrophe inside ("Usman's plan",
  // 'it's done', “it’s done”) never cuts the text short (REVIEW-T2 R3).
  const quotedAfter = (lead: RegExp): string | undefined => {
    const m = lead.exec(text);
    if (!m) return undefined;
    const rest = text.slice(m.index + m[0].length);
    const q = findQuoted(rest);
    return q && rest.slice(0, q.index).trim() === "" ? q.text : undefined;
  };
  const bare = (re: RegExp) => re.exec(text)?.[1]?.trim();
  // Where an UNQUOTED deck name ended, so "Sales and Marketing" is never quietly cut to "Sales" (REVIEW-T2 R7).
  let bareEnd = -1;
  const bareName = (re: RegExp) => {
    const m = re.exec(text);
    const v = m?.[1]?.trim();
    if (m && v) bareEnd = m.index + m[0].length;
    return v;
  };
  // The DECK's name comes from "the deck X" / "a deck called X" — never from "a slide called Y", which names the
  // new slide (REVIEW-T2 R4 F2: "open the deck Q3 plan and add a slide called Notes" edits Q3 plan.pptx).
  const DECK_CALLED = /\b(?:deck|presentation|powerpoint|slide ?show)\s+(?:called|named)\s*/i;
  const TO_DECK = /\bto\s+(?:the\s+|my\s+)?(?:deck|presentation|powerpoint)\s+(?!called\b|named\b)/i;
  const DECK_NAMED_DIRECT = /\b(?:open|show|edit|present)\s+(?:the\s+|my\s+)?(?:deck|presentation)\s+(?!called\b|named\b)/i;
  const name =
    quotedAfter(DECK_CALLED)?.slice(0, 60) ??
    quotedAfter(DECK_NAMED_DIRECT)?.slice(0, 60) ??
    bareName(/\b(?:deck|presentation|powerpoint|slide ?show)\s+(?:called|named)\s+([\w .-]{1,60}?)(?=\s+(?:with|and|then|,)|$|[,.])/i) ??
    bareName(/\b(?:open|show|edit|present)\s+(?:the\s+|my\s+)?(?:deck|presentation)\s+(?!called\b|named\b)([\w .-]{1,60}?)(?=\s+(?:and|then|,)|$|[,.])/i) ??
    // "add a slide called Notes to the deck Q3 plan" (REVIEW-T2 R6).
    quotedAfter(TO_DECK)?.slice(0, 60) ??
    bareName(/\bto\s+(?:the\s+|my\s+)?(?:deck|presentation|powerpoint)\s+(?!called\b|named\b)([\w .-]{1,60}?)(?=\s+(?:and|then|,)|$|[,.!?])/i) ??
    // "…called X" with no deck word right before it, as long as it isn't a slide's name.
    quotedAfter(/(?<!\bslide\s)(?<!\bslides\s)\b(?:called|named)\s*/i)?.slice(0, 60) ??
    bareName(/(?<!\bslide\s)(?<!\bslides\s)\b(?:called|named)\s+([\w .-]{1,60}?)(?=\s+(?:with|and|then|,)|$|[,.])/i);
  if (!name) return null;
  const file = /\.pptx$/i.test(name) ? name : `${name}.pptx`;
  const path = resolvePath(roots[0], file.replace(/[\\/:*?"<>|]/g, "-"));
  // An unquoted name followed by "and <words>" that is neither a deck step nor another action ("a deck called Buy
  // and Sell", "the deck Sales and Marketing and add…") may be ONE name: ask for it in quotes, never guess — a cut
  // name can change a different, existing deck (REVIEW-T2 R7). "…called X and add a slide called Y" still runs.
  if (bareEnd >= 0) {
    const rest = /^\s+and\s+(.+)$/is.exec(text.slice(bareEnd))?.[1]?.replace(/^(?:then|also)\s+/i, "") ?? "";
    if (rest && !CLAUSE_ACTION.test(rest) && !DECK_STEP.test(rest) && !/^(?:with\b|(?:the\s+|a\s+)?(?:sub)?title\b|(?:please|thanks|thank you)\b)/i.test(rest)) {
      const guess = `${name} and ${rest.split(/\s+(?:and|then|with|to)\b|[,.;!?]/i)[0].trim()}`.slice(0, 60);
      return { ops: [], path, ask: `Say the deck's name in quotes so I use the right one (is it "${guess}"?). I haven't done anything.` };
    }
  }
  const ops: DeckOp[] = [];
  const title = quotedAfter(/\b(?:with\s+)?(?:the\s+)?title\s*/i)?.slice(0, 120);
  const subtitle = quotedAfter(/\bsubtitle\s*/i)?.slice(0, 160);
  // A NEW deck, not "add a new slide" (which edits an existing one).
  if (/\b(?:create|make|start)\b|\bnew\s+(?:deck|presentation|powerpoint|power point|slide ?show)\b/i.test(text)) ops.push({ op: "create", path, title: title ?? name, ...(subtitle ? { subtitle } : {}) });
  else ops.push({ op: "open", path });
  const EDIT = /\b(?:change|edit|set)\s+slide\s+(\d{1,2})(?:'s)?\s+(?:title\s+)?to\s*/i;
  const editSlide = EDIT.exec(text)?.[1];
  const editTitle = editSlide ? quotedAfter(EDIT)?.slice(0, 120) : undefined;
  if (editSlide && editTitle) ops.push({ op: "edit", path, slide: Number(editSlide), title: editTitle });
  // "…and add a slide called Notes", "…with a slide named Intro", quoted or bare → an add after the create/open.
  const SLIDE_LEAD = /\b(?:(?:and\s+)?add|with|plus)\s+(?:a\s+|an\s+|one\s+)?(?:new\s+)?slide\s+(?:called|named|titled)\s*/i;
  const addTitle =
    quotedAfter(SLIDE_LEAD)?.slice(0, 120) ??
    bare(/\b(?:(?:and\s+)?add|with|plus)\s+(?:a\s+|an\s+|one\s+)?(?:new\s+)?slide\s+(?:called|named|titled)\s+([\w .'’-]{1,120}?)(?=\s+(?:and|then|with|to\s+(?:the\s+|my\s+)?(?:deck|presentation|powerpoint)\b|,)|$|[,.!?])/i);
  if (addTitle) ops.push({ op: "add", path, title: addTitle });
  // Every slide his words name must be one of the ops; anything left over means ask, never a partial run.
  const slidesNamed = (text.match(/\bslides?\s+(?:called|named|titled)\b/gi) ?? []).length;
  const slidesPlaced = ops.filter((o) => o.op === "add").length;
  if (slidesNamed > slidesPlaced)
    return { ops: [], path, ask: "I can make or open that deck, but I couldn't tell which slide to add, so I haven't done anything. Say the slide's name in quotes, one slide at a time." };
  // Any other step in the same breath ("…and email it to Bob", "…and delete slide 1") means nothing runs and the
  // step is named, as the Notepad, URL and file rules do (REVIEW-T2 R6): never half-done and called done. The
  // names he gave (deck, slide, titles) are masked first, so a deck called "Buy and Sell" isn't a step.
  let masked = text;
  for (const said of [name, title, subtitle, editTitle, addTitle]) if (said) masked = masked.split(said).join("NAMED");
  const extra = strayStep(masked, DECK_STEP);
  if (extra) return { ops: [], path, ask: `I can make or open that deck, but not "${extra}" in the same command, so I haven't done any of it. Ask me for one step at a time.` };
  if (/\b(?:show|present|play)\b/i.test(text)) ops.push({ op: "show", path });
  return { ops, path };
}
