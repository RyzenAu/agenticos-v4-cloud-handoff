// "What can you do on my PC?": Jarvis's PC abilities, spoken in three sentences and shown as a page.
//
// Built from what's really wired (the skills' own descriptions, the direct routes, screen hands,
// lessons) and marked with the last end-to-end suite run (scripts/jarvis-e2e/suite.ts writes
// .operator-data/jarvis-e2e-last.json): each ability shows the plain-English checks that passed,
// failed or were skipped, so nothing is claimed that hasn't been seen to work.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { norm } from "./text";

export type CapabilitiesRequest = { skill: "capabilities"; action: "say" | "show" };
export type SuiteRow = { id: string; say: string; ok: boolean; skipped?: string; ms: number };
export type Ability = { area: string; can: string; examples: string[]; checks: string[]; how: string };

/** The abilities, each with the suite checks that prove it. */
export const ABILITIES: Ability[] = [
  { area: "Apps, folders and sites", can: "open any app, your folders and named sites, several at once", examples: ["open Notepad", "open my Downloads folder", "open GitHub and Vercel in new tabs", "search YouTube for lo-fi beats", "open Spotify and play my liked songs"], checks: ["downloads-folder", "snipping-tool", "chrome-tabs", "youtube-search", "spotify-liked"], how: "direct (pc_act, open_url)" },
  { area: "Quick answers and timers", can: "timers, reminders, the time anywhere, maths, units, currency, weather, battery and disk space", examples: ["set a timer for 2 minutes", "what time is it in London", "what's 18% of 4,850", "how much free space is on my C drive"], checks: ["timer-2min", "time-london", "maths", "battery", "disk-space"], how: "direct (skills, no model)" },
  { area: "PC settings", can: "Bluetooth and Wi-Fi, Do not disturb, dark or light mode, clipboard history", examples: ["turn on Bluetooth", "mute notifications", "switch Windows to dark mode", "open my clipboard history"], checks: ["bluetooth-on", "focus-timer-mute", "dark-mode"], how: "direct (Windows APIs; Do not disturb through Settings)" },
  { area: "Windows and screens", can: "bring any app up (minimised too) on the screen you name, move it between screens, say which screen it's on, switch, snap and maximise", examples: ["bring Chrome up on my main screen", "move it to my other screen", "which screen is that on", "switch to Notepad"], checks: ["window-main", "window-other", "switch-window"], how: "direct (Windows APIs; nothing clicked or typed)" },
  { area: "Files", can: "zip, copy and move files, save as PDF, take screenshots, rename by date (with undo), make folders", examples: ["zip the reports folder in my Downloads", "copy report.txt from my Downloads to my Documents", "save report.txt in my Downloads as a PDF", "take a screenshot", "rename my screenshots by date"], checks: ["zip-folder", "copy-file", "move-file", "pdf-export", "screenshot", "rename-screenshots", "desktop-folder"], how: "direct (never over an existing file)" },
  { area: "Office", can: "total a column in the open Excel sheet, format the open Word document", examples: ["put the total of the Sales column in the cell under it", "make the first line bold"], checks: ["excel-sum", "word-bold"], how: "direct (Office automation)" },
  { area: "Your screen", can: "click, type, fill forms with your details and finish small tasks in the app in front", examples: ["fill this form with my details", "turn off email alerts in this app", "click Next", "type hello in there"], checks: ["form-fill", "open-goal-screen", "notepad-list"], how: "screen hands (UI Automation, Jev, then the planner)" },
  { area: "Teaching", can: "teach you an app as a course, show, guide or quiz you step by step, including drags", examples: ["teach me Excel pivot tables", "next lesson", "quiz me on File Explorer", "what does this panel do?"], checks: ["take-over-dark"], how: "lessons and courses (the companion cursor)" },
  { area: "Business", can: "your latest Vercel deploys, inbox summary, bank and Stripe figures", examples: ["what's the last deploy status", "anything important in my inbox"], checks: ["vercel-status"], how: "direct (read-only)" },
  { area: "Bigger jobs", can: "multi-step work across apps through Hermes, with your yes before anything goes out", examples: ["open VS Code in the AgenticOS repo and run the tests"], checks: ["vscode-tests"], how: "Hermes (slower)" },
];
const GUARDRAILS = "I ask before anything that sends, pays, deletes or publishes, and I never touch passwords, banking or password managers.";

export function capabilitiesIntent(utterance: string): CapabilitiesRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is");
  if (u.length > 90) return null;
  const about = /(?:what (?:can|could) you do|what you (?:can|could) do|what are you able to do|what do you know how to do|what are your (?:abilities|skills|capabilities)|list your (?:abilities|skills|capabilities)|your capabilities)(?: (?:on|with|for) (?:my|this|the) (?:pc|computer|laptop|machine|windows))?$/;
  if (!about.test(u.replace(/^(?:show me|tell me|jarvis|so|okay|ok)\s+/, "").trim())) return null;
  return { skill: "capabilities", action: /^show\b|\b(?:list|on screen)\b/.test(u) ? "show" : "say" };
}

/** The last suite run, by task id (or null when there's none). */
export function lastSuite(root: string): { at: string; rows: Map<string, SuiteRow> } | null {
  try {
    const data = JSON.parse(readFileSync(join(root, ".operator-data", "jarvis-e2e-last.json"), "utf8")) as { at?: string; rows?: SuiteRow[] };
    return { at: String(data.at ?? ""), rows: new Map((data.rows ?? []).map((r) => [r.id, r])) };
  } catch {
    return null;
  }
}
export function tally(suite: ReturnType<typeof lastSuite>) {
  const rows = suite ? [...suite.rows.values()] : [];
  const ran = rows.filter((r) => !r.skipped);
  return { passed: ran.filter((r) => r.ok).length, ran: ran.length };
}

/** Three short spoken sentences. Pure. */
export function capabilitiesLine(suite: ReturnType<typeof lastSuite>, shown: boolean) {
  const { passed, ran } = tally(suite);
  const proof = ran ? ` In my last check-up, ${passed} of ${ran} everyday tasks worked end to end.` : "";
  return `On this PC I can open apps, folders and sites; handle timers, settings like Bluetooth, Do not disturb and dark mode; zip, copy, move, PDF and screenshot files; total Excel columns and format Word; click, type and fill forms on your screen; and teach you an app step by step.${proof} ${shown ? "The full list is on screen." : "Say \"show me what you can do\" for the full list."} ${GUARDRAILS}`.replace(/\s+/g, " ").trim();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** The page: every ability, its examples, how it's done, and its checks from the last run. Pure. */
export function capabilitiesPage(suite: ReturnType<typeof lastSuite>, extra: Record<string, string> = {}) {
  const { passed, ran } = tally(suite);
  const badge = (id: string) => {
    const r = suite?.rows.get(id);
    if (!r) return `<span class="b none" title="not in the last run">not checked</span>`;
    if (r.skipped) return `<span class="b skip" title="${esc(r.skipped)}">skipped</span>`;
    return r.ok ? `<span class="b ok">works · ${(r.ms / 1000).toFixed(1)} s</span>` : `<span class="b fail">failed last run</span>`;
  };
  const cards = ABILITIES.map(
    (a) => `<section><h2>${esc(a.area)}</h2><p>${esc(a.can.charAt(0).toUpperCase() + a.can.slice(1))}.</p><p class="how">${esc(a.how)}</p><ul>${a.examples.map((e) => `<li>“${esc(e)}”</li>`).join("")}</ul><div class="checks">${a.checks
      .map((id) => `<div><code>${esc(suite?.rows.get(id)?.say ?? id)}</code> ${badge(id)}</div>`)
      .join("")}</div></section>`,
  ).join("\n");
  const skills = Object.entries(extra)
    .map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>What Jarvis can do on this PC</title><style>
:root{--bg:#0f1115;--card:#171a21;--ink:#e8eaf0;--mute:#9aa3b2;--ok:#3ecf8e;--fail:#ff6b6b;--skip:#d9a441}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#5b6473}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:24px 16px}
main{max-width:980px;margin:0 auto}h1{margin:0 0 4px;font-size:24px}.sub{color:var(--mute);margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
section{background:var(--card);border-radius:10px;padding:14px 16px}h2{font-size:16px;margin:0 0 6px}.how{color:var(--mute);font-size:13px;margin:0 0 8px}
ul{margin:0 0 10px;padding-left:18px;color:var(--mute)}.checks div{font-size:13px;margin:3px 0}code{font-family:inherit;color:var(--ink)}
.b{font-size:12px;padding:1px 7px;border-radius:9px;margin-left:6px;white-space:nowrap}.ok{background:color-mix(in srgb,var(--ok) 22%,transparent);color:var(--ok)}
.fail{background:color-mix(in srgb,var(--fail) 22%,transparent);color:var(--fail)}.skip{background:color-mix(in srgb,var(--skip) 22%,transparent);color:var(--skip)}.none{color:var(--mute)}
details{margin-top:18px;color:var(--mute)}</style></head><body><main>
<h1>What Jarvis can do on this PC</h1>
<p class="sub">${ran ? `Last check-up ${esc(suite!.at.slice(0, 16).replace("T", " "))} UTC: ${passed} of ${ran} everyday tasks worked end to end.` : "No check-up has run yet."} ${esc(GUARDRAILS)}</p>
<div class="grid">${cards}</div>
${skills ? `<details><summary>Every instant skill</summary><ul>${skills}</ul></details>` : ""}
</main></body></html>`;
}

/** Answer: the spoken line; for "show", the page is written to .operator-data and opened in his browser. */
export async function answerCapabilities(req: CapabilitiesRequest, deps: { root: string; skills?: Record<string, string>; open?: (file: string) => void }): Promise<string> {
  const suite = lastSuite(deps.root);
  if (req.action === "show") {
    const dir = join(deps.root, ".operator-data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, "jarvis-capabilities.html");
    writeFileSync(file, capabilitiesPage(suite, deps.skills));
    (deps.open ?? ((f: string) => void execFile("explorer.exe", [f], { windowsHide: true }, () => undefined)))(file);
  }
  return capabilitiesLine(suite, req.action === "show");
}
