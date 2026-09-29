import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import confetti from "canvas-confetti";
import { cn } from "@/lib/utils";
import { useCopyState } from "@/lib/clipboard";
import {
  Badge,
  BrandMark,
  Button,
  EmptyState,
  Section,
  Skeleton,
  StatusDot,
  Surface,
} from "@/components/ds";
import { fmtAudProse, fmtDay } from "@/lib/format";

// ────────────────────────────────────────────────────────────────────────────
// Operator avatar (mirrors the SidebarIdentity in app-sidebar.tsx). The
// dashboard wizard stores the uploaded avatar at localStorage key
// "claude-os.avatar.v1" and the operator's name at "claude-os.operator-name.v1".
// We read both so the mini-goal "You" cards show the same face the user sees
// on the rest of the dashboard.
// ────────────────────────────────────────────────────────────────────────────
const OPERATOR_AVATAR_KEY = "claude-os.avatar.v1";
const OPERATOR_NAME_KEY = "claude-os.operator-name.v1";

function useOperatorIdentity() {
  const [avatar, setAvatar] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      try {
        setAvatar(window.localStorage.getItem(OPERATOR_AVATAR_KEY));
        setName(window.localStorage.getItem(OPERATOR_NAME_KEY));
      } catch {
        /* ignore */
      }
    };
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === OPERATOR_AVATAR_KEY || e.key === OPERATOR_NAME_KEY || e.key === null) {
        read();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const initials = useMemo(() => {
    const t = (name ?? "").trim();
    if (!t) return "OP";
    const parts = t.split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "OP";
  }, [name]);
  return { avatar, name, initials };
}

// ────────────────────────────────────────────────────────────────────────────
// Hermes Mission Control
// ────────────────────────────────────────────────────────────────────────────
// ONE consolidated panel. No modals. No popups.
//
// Empty state = headline + copy-paste long-term mission prompt. The prompt
// tells the agent to decompose the mission and write it to
// ~/.hermes/missions.json directly. User pastes it into the agent's chat;
// the panel polls the file every 5 seconds and renders the mission the
// moment it's written.
//
// Active state = the mission card with a progress bar + mini-goal cards.
// Tick = mini confetti. Drop = clears the file and returns to empty.
//
// Backend (unchanged from earlier):
//   GET  /__hermes_missions       → { mission | null }
//   POST /__hermes_missions/tick  → { mission }   (toggles a mini-goal)
//   POST /__hermes_missions/clear → { ok: true }
// ────────────────────────────────────────────────────────────────────────────

type Actor = "hermes" | "human";
type Status = "queued" | "active" | "done";

interface MiniGoal {
  id: string;
  num: number;
  title: string;
  actor: Actor;
  done_when?: string;
  full_prompt?: string;
  estimate?: string;
  status: Status;
}

interface Mission {
  id: string;
  title: string;
  binary_outcome?: string;
  deadline_days: number;
  deadline_iso: string;
  created_at: string;
  mini_goals: MiniGoal[];
  image_path?: string | null;
}

/**
 * The mission file as the panel can safely draw it, or null (W-B, 29 Sep 2026). missions.json is written
 * by agents (Hermes, Claude Code) from a pasted prompt, so a hand-written or half-written file must never
 * crash the page: anything without a title and a list of goals is "no mission"; goals get safe defaults.
 */
export function normaliseMission(raw: unknown): Mission | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.title !== "string" || !m.title.trim() || !Array.isArray(m.mini_goals)) return null;
  const goals = (m.mini_goals as unknown[])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g, i) => ({
      id: typeof g.id === "string" && g.id ? g.id : `goal-${i + 1}`,
      num: typeof g.num === "number" ? g.num : i + 1,
      title: typeof g.title === "string" ? g.title : `Goal ${i + 1}`,
      actor: (g.actor === "human" ? "human" : "hermes") as Actor,
      done_when: typeof g.done_when === "string" ? g.done_when : undefined,
      full_prompt: typeof g.full_prompt === "string" ? g.full_prompt : undefined,
      estimate: typeof g.estimate === "string" ? g.estimate : undefined,
      status: (g.status === "done" || g.status === "active" ? g.status : "queued") as Status,
    }));
  const deadline = typeof m.deadline_iso === "string" && !Number.isNaN(Date.parse(m.deadline_iso)) ? m.deadline_iso : "";
  return {
    id: typeof m.id === "string" ? m.id : "mission",
    title: m.title,
    binary_outcome: typeof m.binary_outcome === "string" ? m.binary_outcome : undefined,
    deadline_days: typeof m.deadline_days === "number" ? m.deadline_days : 0,
    deadline_iso: deadline,
    created_at: typeof m.created_at === "string" ? m.created_at : "",
    mini_goals: goals,
    image_path: typeof m.image_path === "string" ? m.image_path : null,
  };
}

/**
 * GET /__hermes_missions with a deadline. Before 29 Sep the panel awaited it with no timeout, so a busy
 * or stalled server left the page on skeletons with no way out, and a non-JSON reply was an unhandled
 * rejection. Now: an answer, or an honest error the page can show with a retry.
 */
export async function fetchMission(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<{ ok: true; mission: Mission | null } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl("/__hermes_missions", { signal: ctrl.signal, headers: { Accept: "application/json" } });
    const j = (await r.json().catch(() => null)) as { mission?: unknown; error?: string } | null;
    if (!r.ok || !j) return { ok: false, error: j?.error ?? `the server answered HTTP ${r.status}` };
    return { ok: true, mission: normaliseMission(j.mission) };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (e as Error).message || "the request failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(): Promise<string> {
  try {
    const r = await fetch("/__token");
    const j = await r.json();
    return j.token;
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// THE PROMPT — paste-into-Hermes-chat copy. This is the whole product.
// Short-term /goal flow lives outside the dashboard (Notion free-resource).
// ────────────────────────────────────────────────────────────────────────────

// LONG_PROMPT_BODY is everything from "This is NOT a /goal run..." onward.
// The opening line gets personalised per page via buildLongPrompt() below:
//   - On the Hermes page → "You are Hermes acting as my…"
//   - On the Claude page → "You are Claude Code acting as my…"
//   - On the home page   → neutral "You are my strategic planning partner…"
// The behavioural rules and JSON contract stay 100% identical between
// versions, so a mission created from one page runs unchanged in the other
// runtime. Only the prompt's self-addressing changes.
const LONG_PROMPT_BODY = `This is NOT a /goal run. Don't activate the Ralph loop. Don't start the mini-goals. Your single job: take ONE great goal from me, interrogate me until you actually understand it, decompose it carefully, then POST the result to my local Mission Control endpoint.

## ONE tool call. Total.

The first and ONLY tool you call is in Step 4 — a curl POST. The HTTP response is the verification. No filesystem tools. No write_file. No python. Just curl.

## What appears in chat vs. what stays silent

You think in passes. I only see three things:
  1. Your one-line greeting.
  2. Clarifying questions and discovery questions, as clean numbered lists.
  3. The final "Mission set" confirmation after curl returns success.

That's it. **Do not** print labels like "Pass 1", "Pass 2a", "Vet:", "Draft:", "Critique:", "Completeness", "Building curl payload", "Server response:". **Do not** print the rubric back at me. **Do not** print the JSON payload before or after the curl. **Do not** narrate your reasoning. If you're about to dump a numbered audit of mini-goals into chat — stop. That's scratch paper, not output.

## The model

- Great goal = a ship-able outcome with a binary deliverable. YES or NO at the deadline.
- Decomposed into 4–10 mini-goals. Sweet spot 5–7. **HARD CAP at 10.**
- Each mini-goal has ONE actor: **agent** (tagged \`"hermes"\` in the JSON schema for backwards-compatibility — but it just means "an agent runs this", and either Hermes or Claude Code can pick the card up) or **human**. Tag using the decision tree below — don't guess.
- **NOT a "You" task:** approvals, reviews, sign-offs. Those happen in chat, not on the dashboard.
- The goal is complete only when every mini-goal is checked off.

### The actor rule — ONE question. The session boundary.

For each candidate mini-goal, ask exactly this:

> **Can the agent (Hermes or Claude Code) finish this inside a single working session — with me sitting in the chat, picking and tweaking and answering as needed — without me having to leave the chat to do something the agent can't do, or wait on someone outside the chat?**

  - **YES** → tag actor \`"hermes"\` (the schema name; semantically "an agent runs this"). Tag it that way no matter how many chat messages it takes, no matter how many decisions I make along the way. Within a session I am present. I pick, tweak, give the nod. The agent figures out tools and skills on its own and doesn't stop until the work ships. All of that is agent-runnable.
  - **NO** → tag actor \`"human"\`. The work cannot finish in this session because of one of:
    - I have to be elsewhere physically (recording on camera as myself, on a live call with another person, attending an event in person, signing a contract legally as myself, biometric checks)
    - We're blocked waiting on someone outside the chat (a collaborator's reply, a counterparty's signature, a vendor's confirmation)
    - The work needs real time to pass beyond a single session

That's the whole rule. The chat IS the work surface for everything an agent can do. The card flips to human only when the work cannot finish in a session.

### Examples — generic patterns, no specific brands or tools

  - Draft and send outreach to a list of prospects → **agent** (\`hermes\`)
  - Reply to a contact on round 3 of an email negotiation → **agent** (agent drafts, I tweak tone in chat until it sounds like me, agent sends)
  - Run a live call with another person → **human** (must leave the chat)
  - Pick the final cut from a long video edit → **agent** (agent walks me through scenes in chat, I pick)
  - Record on-camera content → **human** (face + voice as deliverable)
  - Reply blitz across launch week → **agent** (agent drafts, I approve in chat, agent posts — even hundreds of messages, still chat)
  - Sign a contract → **human** (legal act as me)
  - Attend an in-person event → **human** (physical presence)
  - Wait for an editor's first cut, then ship → **human** (third party we're blocked on)

### When in doubt, tag agent.

The chat absorbs almost everything. The bar for a human card is high: my body, my face, my voice, my legal name, my physical presence elsewhere, OR a third party we cannot progress without.

### Mixed missions → split into two sequential cards

If a candidate has both halves (preparation the agent can do alone + a real-world step that needs me out of the chat), split it into TWO cards: **agent prep → human execute**. The agent card delivers the artifact; the human card uses it.

Generic patterns:
  - "Pitch a prospect on a deal" → split: [agent: Pre-call brief on the prospect + draft of the offer] + [human: Run the call]
  - "Launch a video" → split: [agent: Upload + schedule + thumbnail/title variants] + [human: Record on-camera intro]
  - "Close a batch of deals" → split: [agent: Outreach + reply handling] + [human: Run the discovery calls]

## STEP 0 — Greet, then wait.

Reply with EXACTLY this single line and STOP. Wait for my next message:

"What's the great goal you want me to help you ship? Give me a sentence or short paragraph and I'll turn it into a structured mission."

Don't preface. Don't list the rubric. Just ask, then wait.

## STEP 1 — Vet the goal silently. Speak only to fix it.

Run the rubric against my reply WITHOUT showing your work:

  1. **Binary deliverable.** YES or NO at the deadline. Concrete artifact, count, or revenue figure.
  2. **Time horizon 7–42 days.** Less = single /goal. More = strategy, not execution.
  3. **Decomposes into ≤10 mini-goals.**
  4. **At least one human action and one agent action.** Human action = physical/real-world, NOT an approval.
  5. **Mine to do.** Not "help my friend launch X".
  6. **No vague verbs.** "Improve", "optimize", "grow", "polish" — reject unless paired with a count or artifact.

If ANY criterion fails, ask ONE specific clarifying question and stop. Don't list the rubric. Don't announce "vetting". Just ask the missing piece:

  - Missing binary → "What's the YES/NO check at the deadline — a number, an artifact, or a revenue figure?"
  - Too big → "That feels like 3+ months. What's the smallest version that's still a win in 4 weeks?"
  - Vague verb → "Say more — 'grow' how? More signups? More revenue? What's the number?"

Loop silently until the rubric passes. Then move to Step 2 without announcing it.

## STEP 2 — Discovery. ALWAYS run this step. No skipping.

Before you write a single mini-goal, you need to know where I actually am. A mission built without current-state context produces generic done_when fields and wastes 4 weeks. This is the most important step in the whole flow.

Generate **4–8 discovery questions tailored to MY specific goal**. Ask them as one clean numbered list. Cover, where relevant:

  - **Current state** — what's already built, written, recorded, shipped? Real numbers if any.
  - **Subject / scope** — what's the actual topic, niche, deliverable, audience?
  - **Access** — what accounts, credentials, or assets can I hand you to work with? Don't name specific tools — let me tell you.
  - **Constraints** — fixed deadlines, dependencies on other people, non-negotiables, third parties we'd be waiting on.
  - **Definition of "ready"** — what does shipped look like from MY point of view, not yours?
  - **Past attempts** — have I tried this before? What worked, what didn't, what reusable assets exist?
  - **Audience reality** — who am I shipping to, where do they live, how big is the warm pool?

The questions must be SHARP and SPECIFIC to my goal — never generic. Lazy: "what's your timeline?" Sharp: "You said 500 signups — what's the current list size, where does the warm pool live, and have you run a launch like this before?"

Wait for my answers. If my reply reveals new gaps, ONE follow-up round only (max 2 rounds total). Then move silently to Step 3.

## STEP 3 — Decompose. SILENT.

Internally — none of this appears in chat — run:

  - **Draft** — 4–10 mini-goal candidates. Title ≤5 words, actor (\`hermes\`/\`human\`), done_when ≤8 words.
  - **Critique** — each one: title is action-phrase H1, done_when is punchy and USES THE STATE I gave you (not generic phrasing), measurable, right-sized (agent card ≈ 20 turns; human = one session/call/event), self-served (the agent has every credential it needs), right actor (approvals ≠ human — delete them).
  - **Completeness + balance** — does the union actually ship the binary outcome? Is the actor split between 40/60 and 60/40? If not, rebalance.
  - **Author full_prompt for every mini-goal.** done_when is the *card label*. full_prompt is the *briefing the operator copies into whichever agent they're working with (Hermes or Claude Code) to actually execute that mini-goal*. Write each one from scratch using the discovery state — never a template. See the full_prompt spec below.

Lock the list. Pick deadline_days (default 28, range 7–42). Write a binary_outcome (≤12 words). Mission title is 6–8 words, no articles, ship-able statement.

### full_prompt spec — the briefing that gets copied from each card

The Copy button on each mini-goal card hands this string straight to the operator. It must stand on its own — the agent (Hermes, Claude Code, or any other /goal-capable agent) reads it cold and knows exactly what to ship.

For **agent** (\`hermes\`) mini-goals, write a /goal slash-command prompt that:
  - **MUST begin with the literal 6 characters \`/goal \` (forward slash, the word \`goal\`, then a single space)**. The user copies this string straight into their Claude Code or Hermes chat; if the \`/goal \` prefix is missing, the agent treats it as a normal message and the slash command doesn't fire. The FIRST character of the string is \`/\`. No leading whitespace, no markdown fence, no preamble before it.
  - Right after \`/goal \`, names the mission, mini-goal number, and the binary outcome so the agent knows the larger context.
  - States the specific deliverable using the state from discovery. Describe WHAT needs to be accomplished, not WHICH tools to use — the agent figures out tools on its own.
  - Notes which accounts, credentials, or assets I told you are available, ONLY if they exist (don't invent tool names; don't prescribe a stack).
  - Explicitly tells the agent: "I'll be in the chat session with you. Pause and ask me in chat any time you need a decision, a taste pick, a tone tweak, or any input — I'm there. Don't stall, don't guess, just ask."
  - Names a workspace folder for artifacts.
  - Ends with: cap at 20 turns then pause; do NOT self-tick the Mission Control card; leave a one-paragraph summary in the workspace when done.
  - 80–250 words. No fluff. Plain text, no markdown headers, agent-agnostic (don't say "Hermes" or "Claude Code" — say "you").

For **human** mini-goals, write a structured briefing with these 8 sections, in order. 120–200 words total. The human reads it cold and knows what to do in the next 30 seconds without thinking. Use generic placeholders unless I gave you specifics in discovery — never invent names of people, brands, or tools.

  1. **Headline** — verb-first imperative, ≤8 words. ("Run the 30-minute discovery call.")
  2. **Why this matters** — one sentence tying the action to the mission outcome.
  3. **When / Where** — concrete time window + location/setup, if known.
  4. **What you need on hand** — short checklist (3–5 items: gear, tabs, doc, login).
  5. **Next physical action** — the literal first 30 seconds of motion.
  6. **Definition of done** — the artifact or status update that marks it complete + where it lands so the agent can pick up.
  7. **Agent has prepared** — links/paths to upstream prep artifacts. Skip the section if there are none.
  8. **Time-box** — expected minutes including any follow-up dump.

Render each section with its label, then a colon, then the content. Plain text, no markdown headers. Skip a section only if it's genuinely N/A — never pad with fluff.

## STEP 4 — POST the mission. Then confirm.

Execute exactly this curl in your bash tool. Substitute the JSON you built between the heredoc markers. **Do NOT print the JSON in chat before or after the curl.**

curl -sS -X POST http://localhost:8081/__hermes_missions/create \\
  -H "Content-Type: application/json" \\
  --data @- <<'JSON_BODY'
{
  "title": "<6-8 word ship-able mission statement>",
  "binary_outcome": "<≤12 words: the YES/NO check at the deadline>",
  "deadline_days": 28,
  "mini_goals": [
    {
      "num": 1,
      "title": "<≤5 word action phrase>",
      "actor": "hermes",
      "done_when": "<≤8 words, contextual, uses state from discovery>",
      "full_prompt": "<self-contained briefing per the full_prompt spec above — 80–250 words for hermes, 30–80 for human>"
    }
  ]
}
JSON_BODY

Schema (strict — server will 400 on violation):
  - mission title: 6–8 words, no articles
  - binary_outcome: ≤12 words
  - mini_goal title: ≤5 words
  - mini_goal done_when: ≤8 words
  - mini_goal full_prompt: REQUIRED, plain text, written using discovery state
  - deadline_days: integer 7–42
  - mini_goals array: 4–10 items, num 1-indexed sequential
  - actor: exactly "hermes" or "human"
  - No estimate field, no emojis, no comments

Read the response. Branch:

  - **Starts with {"mission":{** → success. Reply with EXACTLY this single line and stop:
    "✓ Mission set: \\"<title>\\" — <N> mini-goals (<H> for the agent, <M> for you), ship-by <human deadline date>. Check the Mission tab."
  - **Starts with {"error":** → read the error, silently fix the payload, re-run. Try at most 3 times. If still failing, ONE line: "Endpoint rejected: <short reason>. Need to check the dashboard server." Stop.
  - **HTML / 404 / connection refused** → the dashboard isn't registering the endpoint. ONE line: "Dashboard endpoint not live at localhost:8081/__hermes_missions/create. Start the dashboard or check the vite route." Stop. Do NOT pretend the mission was set.

## Hard rules (read these every turn)

  - Greet → vet silently → discovery (always) → decompose silently → POST → confirm.
  - **No internal labels in chat.** Never "Pass 1", "Vet:", "Draft:", "Critique:", "Building curl payload", "Server response:". I see questions and a final confirmation. Nothing else.
  - **No JSON in chat.** The payload goes through curl. The dashboard renders it.
  - **Discovery is non-negotiable.** Skipping it = generic done_when = useless mission. If you're about to decompose without asking discovery questions, stop and ask them.
  - HARD CAP at 10 mini-goals. Sweet spot 5–7.
  - Mix is non-negotiable. All-agent or all-human = you misread the work.
  - **NEVER claim "Mission set" without a {"mission":{ response in your context.**
  - **done_when reads like a prompt to a contractor**, written using the specifics from discovery. Not "Five course emails ready to load" — "Five 800-word emails on <my topic> drafted in <my platform>".
  - Don't activate /goal. Don't spawn sub-agents. Don't start working on the mini-goals.`;

// buildLongPrompt — prepends a page-specific opening line to LONG_PROMPT_BODY.
// The body is agent-agnostic (it talks about "the agent" throughout); only
// the self-address at the top changes per page so the operator sees the
// runtime they're about to paste into named explicitly.
function buildLongPrompt(agent?: MissionControlAgent): string {
  const opening =
    agent === "hermes"
      ? "You are Hermes acting as my strategic planning partner for Mission Control — the layer above /goal."
      : agent === "claude-code"
        ? "You are Claude Code acting as my strategic planning partner for Mission Control — the layer above /goal."
        : "You are my strategic planning partner for Mission Control — the layer above /goal. Either of my agents (Hermes or Claude Code) can run this prompt; the output is identical and works in either runtime.";
  return `${opening}\n\n${LONG_PROMPT_BODY}`;
}

// ────────────────────────────────────────────────────────────────────────────

// `agent` controls the page-specific copy on the panel. The same mission
// data renders identically on all pages — the prop just swaps "Paste to
// Hermes" / "Paste to Claude Code" / neutral "Copy prompt" on the Copy
// buttons and the actor pill in the briefing. Defaults to neutral so the
// home dashboard's embed doesn't lean toward either runtime.
export type MissionControlAgent = "hermes" | "claude-code";

export function HermesMissionControl(
  props: { agent?: MissionControlAgent } = {},
) {
  // No intermediate `pageAgent` variable. SWC's transform consistently
  // renames any local binding named `pageAgent` to `pageAgent2` but
  // misses some JSX usages in long function bodies, producing a runtime
  // `pageAgent is not defined` ReferenceError. We bypass it entirely by
  // referencing `props.agent` directly at the JSX call site below —
  // property access is not subject to variable renaming.
  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  async function refetch(silent = false) {
    const out = await fetchMission();
    if (out.ok) {
      setMission(out.mission);
      setLoadError(null);
    } else if (!silent) {
      setLoadError(out.error);
    }
    if (!silent) setLoading(false);
  }

  useEffect(() => {
    void refetch();
  }, []);

  const done = useMemo(
    () => (mission?.mini_goals ?? []).filter((g) => g.status === "done").length,
    [mission],
  );
  const total = mission?.mini_goals.length ?? 0;
  // Use the EXACT decimal here so the bar fill ends exactly under the
  // milestone tick for the current goal. Rounding (e.g. 33% vs 33.33%)
  // happens only at the display label, never in the geometry.
  const pct = total > 0 ? (done / total) * 100 : 0;

  const daysLeft = useMemo(() => {
    if (!mission?.deadline_iso) return 0;
    const ms = new Date(mission.deadline_iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86_400_000));
  }, [mission]);

  function fireMiniConfetti(rect: DOMRect) {
    const x = (rect.left + rect.width / 2) / window.innerWidth;
    const y = (rect.top + rect.height / 2) / window.innerHeight;
    confetti({
      particleCount: 28,
      spread: 55,
      startVelocity: 22,
      gravity: 0.9,
      scalar: 0.7,
      ticks: 90,
      origin: { x, y },
      colors: ["#FFD21E", "#FFE6CB", "#86efac", "#FFB300", "#fff8d6"],
      disableForReducedMotion: true,
    });
  }

  async function toggle(goalId: string) {
    const el = cardRefs.current.get(goalId);
    const wasDone =
      mission?.mini_goals.find((g) => g.id === goalId)?.status === "done";
    if (mission) {
      setMission({
        ...mission,
        mini_goals: mission.mini_goals.map((g) =>
          g.id === goalId
            ? { ...g, status: wasDone ? "queued" : "done" }
            : g,
        ),
      });
    }
    if (!wasDone && el) fireMiniConfetti(el.getBoundingClientRect());
    try {
      const token = await getToken();
      const r = await fetch("/__hermes_missions/tick", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-claude-os-token": token,
        },
        body: JSON.stringify({ goalId }),
      });
      const j = await r.json();
      { const next = normaliseMission(j.mission); if (next) setMission(next); }
    } catch {
      void refetch();
    }
  }

  async function clearMission() {
    if (
      !confirm(
        "Drop this mission? You can paste a new long-term prompt right after.",
      )
    )
      return;
    const token = await getToken();
    await fetch("/__hermes_missions/clear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claude-os-token": token,
      },
    });
    setMission(null);
  }

  return (
    <Section
      title="Long-term mission"
      description={
        !loading && !mission
          ? "Turn one long-term goal into agent and human actions."
          : undefined
      }
      actions={
        mission ? (
          <>
            <StatusDot
              tone="success"
              pulse
              label={`Active · ${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`}
            />
            <Badge tone="neutral">
              {done} of {total} complete
            </Badge>
            <Button variant="outline" size="sm" onClick={clearMission}>
              <Trash2 className="h-3.5 w-3.5" /> Drop mission
            </Button>
          </>
        ) : (
          !loading && <StatusDot tone="neutral" label="No mission active" />
        )
      }
    >
      {loading ? (
        <LoadingPanel />
      ) : loadError && !mission ? (
        <EmptyState
          title="Couldn't read the long-term mission"
          body={`${loadError}. Nothing is lost: the mission lives in ~/.hermes/missions.json. Try again in a moment.`}
          action={
            <Button variant="outline" size="sm" onClick={() => { setLoading(true); void refetch(); }}>
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : !mission ? (
        <EmptyPanel onRefresh={() => refetch(true)} agent={props.agent} />
      ) : (
        <MissionBody
          mission={mission}
          pct={pct}
          total={total}
          onToggle={toggle}
          cardRefs={cardRefs}
          agent={props.agent}
        />
      )}
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// LOADING
// ────────────────────────────────────────────────────────────────────────────
function LoadingPanel() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// EMPTY STATE — ONE consolidated panel
// ────────────────────────────────────────────────────────────────────────────
function EmptyPanel(emptyProps: {
  onRefresh: () => void;
  agent?: MissionControlAgent;
}) {
  const { onRefresh } = emptyProps;
  // Audit F3-18: a failed clipboard write says so ("Couldn't copy") instead of doing nothing.
  const { copied, failed, copy: copyText } = useCopyState(1800);
  // Page-aware prompt — "You are Hermes…" / "You are Claude Code…" /
  // neutral on home. Same body, only the self-address changes.
  const longPrompt = buildLongPrompt(emptyProps.agent);

  // Poll for missions.json every 5s while empty. The moment an agent writes
  // the file (from the pasted long-term prompt), the panel re-renders with
  // the live mission.
  useEffect(() => {
    const id = setInterval(onRefresh, 5000);
    return () => clearInterval(id);
  }, [onRefresh]);

  function copy() {
    void copyText(longPrompt);
  }

  return (
    <EmptyState
      title="Every hero needs a great goal"
      body="Paste this long-term mission prompt into your agent's chat. This panel watches for the result and fills itself in automatically — no need to reload."
    >
      <div className="mt-4 w-full max-w-2xl text-left">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="ds-label text-muted-foreground">Long-term mission prompt</span>
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied
              </>
            ) : failed ? (
              <>
                <X className="h-3.5 w-3.5" /> Couldn't copy: select the text below
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy prompt
              </>
            )}
          </Button>
        </div>
        <Surface variant="inset" padding="sm" className="max-h-[220px] overflow-y-auto">
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
            {longPrompt}
          </pre>
        </Surface>
      </div>

      <div className="mt-4 flex w-full max-w-2xl flex-wrap items-center justify-between gap-3">
        <Button variant="outline" size="sm" onClick={() => onRefresh()}>
          <RotateCcw className="h-3.5 w-3.5" /> Check now
        </Button>
        <StatusDot tone="success" pulse label="Watching ~/.hermes/missions.json" />
      </div>
    </EmptyState>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MISSION BODY — mission summary, progress bar, and the mini-goal card rail
// with its click-to-expand briefing drawer.
// ────────────────────────────────────────────────────────────────────────────
function MissionBody(bodyProps: {
  mission: Mission;
  pct: number;
  total: number;
  onToggle: (id: string) => void;
  cardRefs: React.MutableRefObject<Map<string, HTMLButtonElement | null>>;
  agent?: MissionControlAgent;
}) {
  const { mission, pct, total, onToggle, cardRefs } = bodyProps;
  const done = mission.mini_goals.filter((g) => g.status === "done").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="min-w-0">
        <div className="text-base font-semibold text-foreground">{fmtAudProse(mission.title)}</div>
        {mission.binary_outcome && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {fmtAudProse(mission.binary_outcome)}
          </p>
        )}
      </div>

      <MissionGoalRail
        mission={mission}
        done={done}
        total={total}
        pct={pct}
        onToggle={onToggle}
        cardRefs={cardRefs}
        agent={bodyProps.agent}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// GoalPanel — single mini-goal at a time. Pagination dots + arrows.
// Renders a clear Mark-complete tick. Copy-as-prompt is the full Hermes-
// ready /goal prompt (mission context + goal + done_when), not just the
// done_when text.

// ────────────────────────────────────────────────────────────────────────────
// Time visualization — parse an estimate string into a 0–9 pip count so each
// card shows a caloric bar of how long this mini-goal takes relative to a
// 2-week ceiling. Bigger investment → more filled pips.
// ────────────────────────────────────────────────────────────────────────────
function estimateToPips(estimate: string | undefined): number {
  if (!estimate) return 2;
  const e = estimate.toLowerCase();
  // Minutes
  const min = e.match(/(\d+)\s*min/);
  if (min) {
    const m = parseInt(min[1], 10);
    if (m <= 15) return 1;
    if (m <= 45) return 2;
    return 3;
  }
  // Hours
  const hr = e.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour)/);
  if (hr) {
    const h = parseFloat(hr[1]);
    if (h <= 1) return 3;
    if (h <= 4) return 4;
    return 5;
  }
  // Days
  const day = e.match(/(\d+)\s*day/);
  if (day) {
    const d = parseInt(day[1], 10);
    if (d <= 1) return 6;
    if (d <= 3) return 7;
    return 8;
  }
  // Weeks
  const wk = e.match(/(\d+)\s*week/);
  if (wk) {
    const w = parseInt(wk[1], 10);
    return Math.min(9, 7 + w);
  }
  // Session / live / in-person / call → mid-low
  if (/(session|live|in[ -]person|call|meeting)/.test(e)) return 3;
  return 2;
}

// ────────────────────────────────────────────────────────────────────────────
// buildCopyText — shared by the card's Copy button and the BriefingDrawer.
// Prefers the Hermes-authored full_prompt (rich, context-aware), falls back
// to a synthesized template for legacy missions that pre-date the field.
// ────────────────────────────────────────────────────────────────────────────
function buildCopyText(
  goal: MiniGoal,
  mission: Mission,
  index: number,
  total: number,
  opName: string | null,
): string {
  const authored = goal.full_prompt?.trim();
  if (authored) {
    // SAFETY NET: agent (hermes) cards MUST start with the literal "/goal "
    // slash command so Claude Code / Hermes recognise the prompt when the
    // user pastes it. Legacy missions and older Hermes runs sometimes drop
    // the prefix — auto-prepend if it's missing. Human cards stay as-is
    // (they're briefings for the operator, not slash commands).
    if (goal.actor === "hermes" && !authored.match(/^\/goal\b/)) {
      return `/goal ${authored}`;
    }
    return authored;
  }
  const missionSlug = mission.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const deadlineDate = fmtDay(new Date(mission.deadline_iso), { year: true });
  if (goal.actor === "hermes") {
    return `/goal CONTEXT: This is mini-goal ${index + 1} of ${total} in my long-term mission "${mission.title}".
Mission deadline: ${deadlineDate}.
Mission binary outcome: ${mission.binary_outcome || "(see the Mission tab)"}

MINI-GOAL: ${goal.title}
${goal.done_when ? `Done when: ${goal.done_when}` : ""}

INSTRUCTIONS:
- Use any relevant skills you have (code execution, file write, browser, terminal, web search) to ship this autonomously.
- Save any artifacts you produce under ~/Desktop/${missionSlug}/ — create the folder if it doesn't exist.
- When the "Done when" condition is met, leave a one-paragraph summary at ~/Desktop/${missionSlug}/${String(goal.num).padStart(2, "0")}-summary.md
- Cap at 20 turns, then pause for review.
- Do NOT mark Mission Control complete yourself — I'll tick it in the panel.`;
  }
  return `${opName?.trim() || "You"}'s gating action for the "${mission.title}" mission:

${goal.title}

${goal.done_when ? `Done when: ${goal.done_when}` : ""}

Hermes can't proceed past this point until you've done this in the real world.`;
}

// ────────────────────────────────────────────────────────────────────────────
// formatHumanBrief — turns the Hermes-authored human briefing text into a
// structured list of {label, content} blocks. The prompt asks for 8 labelled
// sections (Headline / Why / When-Where / What you need / Next action / Done /
// Hermes prepared / Time-box). We detect those labels at line starts and split
// the text into blocks. Falls back gracefully if the briefing is prose-only.
// ────────────────────────────────────────────────────────────────────────────
const HUMAN_BRIEF_LABELS = [
  { match: /^headline\s*:/i, label: "Headline" },
  { match: /^why( this matters)?\s*:/i, label: "Why this matters" },
  { match: /^when ?\/ ?where\s*:/i, label: "When / Where" },
  { match: /^what you need( on hand)?\s*:/i, label: "What you need on hand" },
  { match: /^next( physical)? action\s*:/i, label: "Next physical action" },
  {
    match: /^(definition of )?done( when)?\s*:/i,
    label: "Definition of done",
  },
  {
    // Match the new agent-neutral label AND the legacy "Hermes has prepared"
    // for missions created before the rename.
    match: /^(agent|hermes) (has )?prepared\s*:/i,
    label: "Agent has prepared",
  },
  { match: /^time[- ]?box\s*:/i, label: "Time-box" },
];

function formatHumanBrief(text: string): { label: string | null; content: string }[] {
  const lines = text.split("\n");
  const blocks: { label: string | null; content: string }[] = [];
  let current: { label: string | null; content: string } | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    let matched = false;
    for (const { match, label } of HUMAN_BRIEF_LABELS) {
      if (match.test(line.trimStart())) {
        if (current) blocks.push(current);
        const colonIdx = line.indexOf(":");
        const content = colonIdx >= 0 ? line.slice(colonIdx + 1).trim() : "";
        current = { label, content };
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (current) {
        current.content = current.content
          ? current.content + "\n" + line
          : line;
      } else if (line.trim()) {
        // No section detected yet — collect as a prose-only opening block.
        if (!blocks.length || blocks[blocks.length - 1].label) {
          blocks.push({ label: null, content: line });
        } else {
          blocks[blocks.length - 1].content += "\n" + line;
        }
      }
    }
  }
  if (current) blocks.push(current);
  // If no labels were detected at all, return a single prose block (the
  // briefing is unstructured but still render-able).
  if (blocks.every((b) => !b.label) && blocks.length > 1) {
    return [{ label: null, content: blocks.map((b) => b.content).join("\n") }];
  }
  return blocks;
}

// ────────────────────────────────────────────────────────────────────────────
// BriefingDrawer — cross-fades in over the card rail's stage when a
// mini-goal card is clicked. The page underneath stays completely untouched
// (no layout shift, no scroll jump). The mission header stays visible above.
//
// Switching cards (←/→ keys, or clicking another card while open) cross-
// fades the modal contents in-place — never collapses + re-opens. Esc or
// click on the backdrop closes.
//
// Declared ABOVE MissionGoalRail because Vite's React Fast Refresh
// transform doesn't reliably hoist later-declared function components.
// ────────────────────────────────────────────────────────────────────────────
function BriefingDrawer(briefProps: {
  goal: MiniGoal | null;
  mission: Mission;
  index: number;
  total: number;
  onClose: () => void;
  onToggle: () => void;
  agent?: MissionControlAgent;
}) {
  const {
    goal,
    mission,
    index,
    total,
    onClose,
    onToggle,
  } = briefProps;
  // Keep the LAST goal around during the close animation so the content
  // doesn't blank-flash on the way out.
  const [renderedGoal, setRenderedGoal] = useState<MiniGoal | null>(goal);
  useEffect(() => {
    if (goal) {
      setRenderedGoal(goal);
      return;
    }
    const t = setTimeout(() => setRenderedGoal(null), 200);
    return () => clearTimeout(t);
  }, [goal?.id, goal]);

  const isOpen = !!goal;
  const { name: opName } = useOperatorIdentity();
  const copyState = useCopyState(1800);
  const { copied, failed } = copyState;

  const displayGoal = goal ?? renderedGoal;
  const copyText = displayGoal
    ? buildCopyText(displayGoal, mission, index >= 0 ? index : 0, total, opName)
    : "";

  function handleCopy() {
    void copyState.copy(copyText);
  }

  if (!isOpen && !renderedGoal) return null;

  const isHermes = displayGoal?.actor === "hermes";
  const isDone = displayGoal?.status === "done";
  const goalNum = displayGoal?.num ?? 0;
  // The schema value "hermes" means "an agent runs this" — either Hermes
  // or Claude Code can pick the card up. The pill label respects the page
  // context: "Hermes" on the Hermes page, "Claude Code" on the Claude Code
  // page, neutral "Agent" on the home dashboard.
  const agentLabel =
    briefProps.agent === "hermes"
      ? "Hermes"
      : briefProps.agent === "claude-code"
        ? "Claude Code"
        : "Agent";
  const actorLabel = isHermes ? agentLabel : opName?.trim() || "You";
  const humanBlocks = !isHermes && displayGoal ? formatHumanBrief(copyText) : null;

  // The briefing is absolutely positioned inside the parent's fixed-height
  // stage (the rail container). It cross-fades with the cards rail rather
  // than pushing the page taller.

  return (
    <div
      role="region"
      aria-label="Mini-goal briefing"
      aria-hidden={!isOpen}
      style={{
        position: "absolute",
        inset: 0,
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? "auto" : "none",
        // Slight delay on open so the cards finish fading out first; quick
        // out on close so the cards reappear fast.
        transition: isOpen
          ? "opacity 240ms cubic-bezier(.32,.72,0,1) 60ms"
          : "opacity 180ms cubic-bezier(.32,.72,0,1)",
      }}
    >
      {/* Inner wrapper — fills the stage. */}
      <div style={{ height: "100%" }}>
        <Surface
          key={displayGoal?.id}
          variant="default"
          padding="lg"
          className="briefing-fade-in relative flex h-full flex-col overflow-hidden"
        >
          {/* Header — goal counter, actor tag, close button. */}
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="ds-label text-muted-foreground">Briefing</span>
              <span className="text-sm text-muted-foreground">
                Goal {goalNum} / {total}
              </span>
              <Badge tone={isHermes ? "accent" : "neutral"}>{actorLabel}</Badge>
              {isDone && <Badge tone="success">Complete</Badge>}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close briefing"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* H1 — the action title. */}
          <div className="mb-1.5 text-lg font-semibold leading-snug tracking-[-0.01em] text-foreground">
            {fmtAudProse(displayGoal?.title)}
          </div>

          {/* Subtitle — done_when. */}
          {displayGoal?.done_when && (
            <p className="mb-3.5 text-sm leading-relaxed text-muted-foreground">
              {displayGoal.done_when}
            </p>
          )}

          <div aria-hidden className="mb-3.5 h-px w-full bg-border" />

          {/* Brief body. Agent → mono code block (the /goal prompt reads
              like a CLI command). Human → parsed 8-section briefing with
              label + body pairs so each section is its own visible block. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isHermes ? (
              <Surface variant="inset" padding="sm">
                <pre className="m-0 whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
                  {copyText}
                </pre>
              </Surface>
            ) : (
              <div className="flex flex-col gap-4">
                {(humanBlocks ?? []).map((block, i) =>
                  block.label ? (
                    <div key={`${block.label}-${i}`}>
                      <div className="ds-label mb-1.5 text-muted-foreground">{block.label}</div>
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                        {block.content}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={`prose-${i}`}
                      className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
                    >
                      {block.content}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>

          {/* Footer — Copy + Mark-done. */}
          <div className="mt-4 flex items-stretch gap-2">
            <Button variant="accent" size="sm" onClick={handleCopy} className="flex-1">
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Copied to clipboard
                </>
              ) : failed ? (
                <>
                  <X className="h-3.5 w-3.5" /> Couldn't copy
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />{" "}
                  {isHermes
                    ? briefProps.agent === "hermes"
                      ? "Paste to Hermes"
                      : briefProps.agent === "claude-code"
                        ? "Paste to Claude"
                        : "Copy /goal prompt"
                    : "Copy briefing"}
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onToggle}
              aria-label={isDone ? "Mark not complete" : "Mark complete"}
              className="min-w-[160px]"
            >
              <Check className="h-3.5 w-3.5" /> {isDone ? "Mark not done" : "Mark complete"}
            </Button>
          </div>
        </Surface>
      </div>

      <style>{`
        .briefing-fade-in {
          animation: briefFadeIn 220ms cubic-bezier(.32,.72,0,1);
        }
        @keyframes briefFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// MissionGoalRail — horizontal scroll, 3 cards visible at a time, with
// prev/next arrow buttons. Click any card to expand its briefing in a drawer
// in the same slot; the mission header above stays locked in place.
// ────────────────────────────────────────────────────────────────────────────
function MissionGoalRail(railProps: {
  mission: Mission;
  done: number;
  total: number;
  pct: number;
  onToggle: (id: string) => void;
  cardRefs: React.MutableRefObject<Map<string, HTMLButtonElement | null>>;
  agent?: MissionControlAgent;
}) {
  const {
    mission,
    done,
    total,
    pct,
    onToggle,
    cardRefs,
  } = railProps;
  // Native horizontal scroll PLUS Prev/Next buttons. The user can drag /
  // trackpad-swipe / wheel through the cards freely; the buttons offer a
  // discrete one-card step. Whichever they prefer.
  const VISIBLE = 3;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({
    firstVisible: 1,
    lastVisible: Math.min(total, VISIBLE),
    canPrev: false,
    canNext: total > VISIBLE,
  });

  // Briefing-drawer state: one card can be expanded at a time. Lifted up to
  // the rail (was per-card local state in v1) so a single drawer below the
  // rail can host the brief while the rail acts as the navigation spine.
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  const activeIndex = activeGoalId
    ? mission.mini_goals.findIndex((g) => g.id === activeGoalId)
    : -1;
  const activeGoal = activeIndex >= 0 ? mission.mini_goals[activeIndex] : null;

  // Keyboard: Esc closes the drawer; ← / → switch briefs while open; digits
  // 1–9 jump straight to that goal's brief (cinematic, console-feel).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack typing in inputs / textareas / contentEditable.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (activeGoalId && e.key === "Escape") {
        setActiveGoalId(null);
        e.preventDefault();
        return;
      }
      if (
        activeGoalId &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        const idx = mission.mini_goals.findIndex(
          (g) => g.id === activeGoalId,
        );
        if (idx < 0) return;
        const nextIdx =
          e.key === "ArrowRight"
            ? Math.min(mission.mini_goals.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        if (nextIdx !== idx) {
          setActiveGoalId(mission.mini_goals[nextIdx].id);
          e.preventDefault();
        }
        return;
      }
      if (!activeGoalId && /^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < mission.mini_goals.length) {
          setActiveGoalId(mission.mini_goals[idx].id);
          e.preventDefault();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeGoalId, mission.mini_goals]);

  // When the active goal changes, scroll the rail so the active card sits
  // ~1/3 from the left (Asana famously got centred-scroll wrong; ~1/3 lets
  // the operator see what's NEXT while focused on the brief).
  useEffect(() => {
    if (!activeGoalId || !scrollRef.current) return;
    const cardEl = scrollRef.current.querySelector(
      `[data-goal-id="${activeGoalId}"]`,
    ) as HTMLElement | null;
    if (!cardEl) return;
    const container = scrollRef.current;
    const targetLeft = cardEl.offsetLeft - container.clientWidth / 3;
    container.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: "smooth",
    });
  }, [activeGoalId]);

  function scrollByCards(direction: 1 | -1) {
    const el = scrollRef.current;
    if (!el) return;
    const cardWidth = el.clientWidth / VISIBLE;
    el.scrollBy({ left: cardWidth * direction, behavior: "smooth" });
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const cardWidth = el.clientWidth / VISIBLE;
      if (cardWidth <= 0) return;
      const startIdx = Math.round(el.scrollLeft / cardWidth);
      const first = Math.max(0, Math.min(total - 1, startIdx));
      const last = Math.min(total, first + VISIBLE);
      setScrollState({
        firstVisible: first + 1,
        lastVisible: last,
        canPrev: el.scrollLeft > 8,
        canNext: el.scrollLeft < el.scrollWidth - el.clientWidth - 8,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [total]);

  const { firstVisible, lastVisible, canPrev, canNext } = scrollState;

  const briefingOpen = activeGoalId !== null;
  // Fixed-height stage that hosts EITHER the cards rail OR the briefing.
  // Switching modes is a cross-fade in place. The dashboard's vertical
  // layout never shifts once a mission is loaded.
  // Sized so the whole Mission Control panel fits a 13" laptop viewport
  // without scrolling (~700–800px tall page area).
  const STAGE_HEIGHT = 420;

  return (
    <div className="flex flex-col gap-4">
      {/* PROGRESS BAR — with milestone ticks for each mini-goal so it reads
          as discrete stations, not just a percent slider. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="ds-label text-muted-foreground">Progress</span>
          <span className="ds-num text-sm text-foreground">
            {done} of {total}
            <span className="text-muted-foreground"> · </span>
            <span className="text-brand">{Math.round(pct)}%</span>
          </span>
        </div>
        <div
          aria-hidden
          className="relative h-3 w-full overflow-hidden rounded-full border border-border bg-inset"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
          {/* Milestone ticks — one per mini-goal. */}
          {Array.from({ length: total - 1 }).map((_, i) => {
            const left = ((i + 1) / total) * 100;
            return (
              <span
                key={i}
                aria-hidden
                className="absolute inset-y-0 w-px -translate-x-px bg-background/50"
                style={{ left: `${left}%` }}
              />
            );
          })}
        </div>
      </div>

      {/* TOOLBAR — swaps content based on mode:
            - Cards mode: position readout + Prev/Next pagination
            - Briefing mode: ← Back to actions breadcrumb + Goal N / Total */}
      <div className="flex min-h-[34px] items-center justify-between gap-3">
        {briefingOpen ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setActiveGoalId(null)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Back to actions
            </Button>
            <span className="text-sm text-muted-foreground">
              Goal <span className="text-foreground">{activeIndex >= 0 ? activeIndex + 1 : 1}</span> /{" "}
              {total}
            </span>
          </>
        ) : total > VISIBLE ? (
          <>
            <span className="ds-num text-sm text-muted-foreground">
              Actions {firstVisible}–{lastVisible} of {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => scrollByCards(-1)}
                disabled={!canPrev}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => scrollByCards(1)}
                disabled={!canNext}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </>
        ) : null}
      </div>

      {/* THE STAGE — fixed-height container that hosts either the cards rail
          or the briefing. Switching modes is a cross-fade in place; the
          page below never moves. */}
      <div
        style={{
          position: "relative",
          height: STAGE_HEIGHT,
        }}
      >
        {/* CARDS RAIL — absolute, fades out when briefing opens. */}
        <div
          aria-hidden={briefingOpen}
          style={{
            position: "absolute",
            inset: 0,
            opacity: briefingOpen ? 0 : 1,
            pointerEvents: briefingOpen ? "none" : "auto",
            transition: "opacity 220ms cubic-bezier(.32,.72,0,1)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            ref={scrollRef}
            className="overflow-x-auto pb-2"
            style={{
              scrollSnapType: "x mandatory",
              scrollbarWidth: "thin",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <div
              style={{
                display: "grid",
                gridAutoFlow: "column",
                gridAutoColumns: `calc((100% - ${(VISIBLE - 1) * 14}px) / ${VISIBLE})`,
                gap: 14,
              }}
            >
              {(() => {
                const activeIdx = mission.mini_goals.findIndex(
                  (x) => x.status !== "done",
                );
                return mission.mini_goals.map((g, i) => (
                  <div
                    key={g.id}
                    data-goal-id={g.id}
                    style={{
                      scrollSnapAlign: "start",
                      // Stretch each wrapper to fill the row so all cards
                      // land at the same height.
                      display: "flex",
                      height: "100%",
                    }}
                  >
                    <GoalCard
                      goal={g}
                      mission={mission}
                      index={i}
                      total={total}
                      isLive={i === activeIdx}
                      isActive={g.id === activeGoalId}
                      anyActive={activeGoalId !== null}
                      cardRef={(el) => cardRefs.current.set(g.id, el)}
                      onToggle={() => onToggle(g.id)}
                      onOpen={() => setActiveGoalId(g.id)}
                      agent={railProps.agent}
                    />
                  </div>
                ));
              })()}
            </div>
          </div>

        </div>

        {/* BRIEFING — absolute, fades in when a card is opened. Lives in
            the SAME slot as the cards rail. No page-height change ever. */}
        <BriefingDrawer
          goal={activeGoal}
          mission={mission}
          index={activeIndex}
          total={total}
          onClose={() => setActiveGoalId(null)}
          onToggle={
            activeGoal ? () => onToggle(activeGoal.id) : () => undefined
          }
          agent={railProps.agent}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// GOAL CARD — avatar + title + description + a Copy/Mark-complete action at
// the bottom. Click anywhere on the card to open its briefing in the drawer.
// ────────────────────────────────────────────────────────────────────────────
function GoalCard(cardProps: {
  goal: MiniGoal;
  mission: Mission;
  index: number;
  total: number;
  // `isLive` = this card is the first non-done one, i.e. the "next up"
  // action. Computed by the rail so we always have exactly ONE "Up next" card.
  isLive: boolean;
  // `isActive` = this card's brief is the one currently showing in the
  // drawer below the rail. Active card gets the accent border; non-active
  // siblings dim when ANY card is active.
  isActive: boolean;
  anyActive: boolean;
  onToggle: () => void;
  onOpen: () => void;
  cardRef?: (el: HTMLButtonElement | null) => void;
  agent?: MissionControlAgent;
}) {
  const {
    goal,
    mission,
    index,
    total,
    isLive,
    isActive,
    anyActive,
    onToggle,
    onOpen,
    cardRef,
  } = cardProps;
  const isHermes = goal.actor === "hermes";
  const isDone = goal.status === "done";
  const { avatar: opAvatar, initials: opInitials, name: opName } =
    useOperatorIdentity();
  const copyState = useCopyState(1800);
  const { copied, failed } = copyState;

  const copyText = buildCopyText(goal, mission, index, total, opName);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    void copyState.copy(copyText);
  }

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    onToggle();
  }

  function handleCardClick() {
    onOpen();
  }
  function handleCardKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  }

  const statusBadge = isDone ? (
    <Badge tone="success">Complete</Badge>
  ) : isLive ? (
    <Badge tone="info">Up next</Badge>
  ) : (
    <Badge tone="neutral">Queued</Badge>
  );

  return (
    <Surface
      ref={cardRef as any}
      as="div"
      variant="interactive"
      padding="md"
      role="button"
      tabIndex={0}
      aria-label={`Open briefing for action ${goal.num}: ${goal.title}`}
      aria-pressed={isActive}
      onClick={handleCardClick}
      onKeyDown={handleCardKey}
      className={cn(
        "flex h-full min-h-[220px] w-full flex-col gap-3",
        isActive && "border-brand hover:border-brand",
        isDone && !isActive && "border-success/40 hover:border-success/40",
        anyActive && !isActive && "opacity-55",
      )}
    >
      {/* Top strip: avatar + ACTION N + status badge. Hermes-actor cards
          show the agent's brand mark (Hermes on the Hermes page, Claude
          Code elsewhere); human-actor cards show the operator's own
          photo/initials regardless of page. */}
      <div className="flex items-center gap-2.5">
        {isHermes ? (
          <BrandMark agent={cardProps.agent === "hermes" ? "hermes" : "claude-code"} size={24} />
        ) : opAvatar ? (
          <img
            src={opAvatar}
            alt={opName ?? "You"}
            className="h-6 w-6 shrink-0 rounded-full border border-border object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-inset text-[13px] font-semibold text-muted-foreground"
          >
            {opInitials}
          </div>
        )}
        <span className="ds-label text-muted-foreground">Action {goal.num}</span>
        <div className="ml-auto">{statusBadge}</div>
      </div>

      {/* Title — the action. */}
      <div
        className={cn(
          "text-base font-medium leading-snug",
          isDone ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {goal.title}
      </div>

      {goal.done_when && (
        // Always visible, full text shown (no line clamp) — this is the
        // description the user reads to know what's expected.
        <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
          {goal.done_when}
        </p>
      )}

      {/* Hint at bottom — tells the user the card opens the drawer below. */}
      <div
        aria-hidden
        className={cn(
          "mt-auto text-sm transition-colors",
          isDone && "opacity-60",
          isActive ? "text-brand" : "text-muted-foreground",
        )}
      >
        {isActive ? "Briefing open" : "Click for brief"}
      </div>

      {/* Bottom row.
          - Agent done: full-width outline "Mark not done".
          - Agent pending: accent [Copy] + outline tick icon.
          - Human done: full-width outline "Mark not done".
          - Human pending: full-width accent [Mark complete]. */}
      <div className="flex items-stretch gap-2">
        {isHermes && !isDone && (
          <Button variant="accent" size="sm" onClick={handleCopy} className="flex-1">
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied
              </>
            ) : failed ? (
              <>
                <X className="h-3.5 w-3.5" /> Couldn't copy
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy
              </>
            )}
          </Button>
        )}

        <Button
          variant="outline"
          size={isDone || !isHermes ? "sm" : "icon-sm"}
          onClick={handleToggle}
          aria-label={isDone ? "Mark not complete" : "Mark complete"}
          title={isDone ? "Click to undo" : "Mark this action complete"}
          className={isDone || !isHermes ? "flex-1" : "shrink-0"}
        >
          <Check className="h-3.5 w-3.5" />
          {!isDone && !isHermes && "Mark complete"}
          {isDone && "Mark not done"}
        </Button>
      </div>
    </Surface>
  );
}


export default HermesMissionControl;
