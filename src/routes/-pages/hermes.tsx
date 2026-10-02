// Page body for /agents/hermes (route definition: src/routes/agents.hermes.tsx).
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Crown,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Send,
  AlertTriangle,
  Megaphone,
  Radio,
  FlaskConical,
  Lightbulb,
  PenLine,
  LineChart,
  MessageSquare,
  Zap,
  Cloud,
  Paperclip,
  Users,
  ArrowUp,
  Waypoints,
  ChevronDown,
  Check,
  Copy,
  Terminal,
  Mic,
  Bot,
  Brain,
  Clock,
  Cpu,
  History,
  Wand2,
} from "lucide-react";
import { IntelligencePortal, type ActivityEvent, type AppKey } from "@/components/intelligence-portal";
import modelIntel from "@/data/model-intel.json";
import { providerModelId } from "../../../scripts/model-router/catalogue";
import { hermesPickerCatalog, hermesRef } from "../../../scripts/model-router/pickers";
import { ctxFromTable } from "@/lib/ctx-window";
import { useCopyState } from "@/lib/clipboard";
import { tokenizeCode, type CodeToken } from "@/lib/code-highlight";
import { ModelLogo } from "@/components/model-logos";
// Ministry of Experts — hero art (Nous/Hermes, from their site) + bundled
// lobehub static-SVG vendor logos (offline-safe, every model vendor covered).
import logoVendorClaude from "@/assets/logo-claude.svg";
import logoVendorOpenAI from "@/assets/logo-openai.svg";
import logoVendorGemini from "@/assets/logo-gemini.svg";
import logoVendorGrok from "@/assets/logo-grok.svg";
import logoVendorDeepseek from "@/assets/logo-deepseek.svg";
import logoVendorMinimax from "@/assets/logo-minimax.svg";
import logoVendorZai from "@/assets/logo-zai.svg";
import logoVendorQwen from "@/assets/logo-qwen.svg";
import logoVendorMoonshot from "@/assets/logo-moonshot.svg";
import logoVendorTencent from "@/assets/logo-tencent.svg";
import logoVendorXiaomi from "@/assets/logo-xiaomi.svg";
import logoVendorNvidia from "@/assets/logo-nvidia.svg";
import logoVendorMistral from "@/assets/logo-mistral.svg";
import logoVendorMeta from "@/assets/logo-meta.svg";
import logoVendorCohere from "@/assets/logo-cohere.svg";
import confetti from "canvas-confetti";
import pantheon01 from "@/assets/hermes-art/01-hermes-messenger.webp";
// Pre-built tuple for deterministic session→avatar hashing in the collapsed
// chat sidebar. We re-export it as `PANTHEON_AVATARS` further down once all
// 10 imports are in scope. Order matches 01..10 so visual lookup is easy.
import pantheon02 from "@/assets/hermes-art/02-oracle-delphi.webp";
import pantheon03 from "@/assets/hermes-art/03-athena-owl.webp";
import pantheon04 from "@/assets/hermes-art/04-scribe-scrolls.webp";
import pantheon05 from "@/assets/hermes-art/05-orpheus-lyre.webp";
import pantheon06 from "@/assets/hermes-art/06-labyrinth.webp";
// Wider engraving-style labyrinth — used only as the chat background.
// The old square 06-labyrinth.png stays as the Labyrinth persona avatar +
// other Pantheon callsites.
import pantheon07 from "@/assets/hermes-art/07-alchemist-workshop.webp";
import pantheon08 from "@/assets/hermes-art/08-philosopher.webp";
import pantheon09 from "@/assets/hermes-art/09-mapmaker.webp";
import pantheon10 from "@/assets/hermes-art/10-mercury-flight.webp";
// Provider/model marks — Simple Icons CDN 404s on trademarked AI logos
// (openai, groq, xai, cohere). We bundle local PNG/SVG fallbacks so the
// status card always shows a real brand instead of a "❯" mark.
import logoOpenAI from "@/assets/logos/openai.png";
import logoOpenAIGpt5 from "@/assets/logos/openai-gpt5.png";
import logoCodex from "@/assets/logos/codex.png";
import logoCopilot from "@/assets/logos/copilot.svg";
import logoOpenRouter from "@/assets/logos/openrouter.png";
import logoGeminiColor from "@/assets/logos/gemini-color.svg";
import logoClaude from "@/assets/claude-logo.png";
// Connection-strip local logo fallbacks — Simple Icons 404s on many of
// these (notion, supabase, pinecone, telegram, etc. all have non-CDN
// brand assets), so we mirror the dashboard's local map.
import logoTelegram from "@/assets/logos/telegram.png";
import logoNotion from "@/assets/logos/notion.png";
import logoSupabase from "@/assets/logos/supabase.png";
import logoZapier from "@/assets/logos/zapier.png";
import logoApify from "@/assets/logos/apify.png";
import logoCanva from "@/assets/logos/canva.png";
import logoFirecrawl from "@/assets/logos/firecrawl.png";
import logoGamma from "@/assets/logos/gamma.png";
import logoNotebookLM from "@/assets/logos/notebooklm.png";
import logoPinecone from "@/assets/logos/pinecone.svg";
// Use the PNG instead of the SVG — at the dashboard's small render
// sizes the SVG's radial gradients flatten into a near-monochrome
// silhouette; the PNG keeps the full multi-gradient detail.
import logoObsidian from "@/assets/logos/obsidian.png";
import logoGoogleDrive from "@/assets/logos/googledrive.svg";
import logoGoogleCalendar from "@/assets/logos/googlecalendar.svg";
import logoGmail from "@/assets/logos/gmail.svg";
import logoYouTube from "@/assets/logos/youtube.svg";
import logoN8N from "@/assets/logos/n8n.svg";
import logoGranola from "@/assets/logos/granola.png";
import logoHiggsfield from "@/assets/logos/higgsfield.png";
import logoStitch from "@/assets/logos/stitch.png";
import { HermesMissionControl } from "@/components/hermes-mission-control";
import { HermesCustomiseSection } from "@/components/hermes-customise";
import { HermesDocumentsGallery } from "@/components/hermes-documents-gallery";
import {
  Badge,
  BrandMark,
  Button,
  EmptyState,
  Notice,
  PageFoot,
  PageHeader,
  Section,
  Segmented,
  Skeleton,
  Sparkline,
  StatTile as DsStatTile,
  StatusDot,
  Surface,
  TabPanel,
  Tabs,
  Widget,
  WidgetGrid,
  fmtCount,
  fmtRelative,
  type TabItem,
} from "@/components/ds";

const HERMES_LOCAL_LOGOS: Record<string, string> = {
  telegram: logoTelegram,
  notion: logoNotion,
  supabase: logoSupabase,
  zapier: logoZapier,
  apify: logoApify,
  canva: logoCanva,
  firecrawl: logoFirecrawl,
  gamma: logoGamma,
  notebooklm: logoNotebookLM,
  googlenotebooklm: logoNotebookLM,
  pinecone: logoPinecone,
  obsidian: logoObsidian,
  googledrive: logoGoogleDrive,
  googlecalendar: logoGoogleCalendar,
  gmail: logoGmail,
  youtube: logoYouTube,
  n8n: logoN8N,
  n8nmcp: logoN8N,
  granola: logoGranola,
  higgsfield: logoHiggsfield,
  stitch: logoStitch,
  openai: logoOpenAIGpt5,
  openrouter: logoOpenRouter,
  copilot: logoCopilot,
  googlegemini: logoGeminiColor,
  // Aliases — multiple slugs that point at the same brand.
  ccgeminiplugin: logoGeminiColor,
  "gemini-plugin": logoGeminiColor,
  // Codex family — all the sub-tools share the green Codex mark.
  codex: logoCodex,
  "codex-documents": logoCodex,
  "codex-spreadsheets": logoCodex,
  "codex-presentations": logoCodex,
  "codex-computer-use": logoCodex,
  "codex-browser-use": logoCodex,
  "codex-plugin": logoCodex,
  // Anthropic on the strip uses the Claude C mark, same as the persona chip.
  anthropic: logoClaude,
  claude: logoClaude,
};

// Slugs that Simple Icons reliably serves — keep the fetch slim. Everything
// else either has a local PNG above or falls through to the initial-letter
// fallback so we never render a broken image.
const SIMPLE_ICON_SLUGS = new Set([
  "github",
  "huggingface",
  "nvidia",
  "perplexity",
  "mistralai",
  "ollama",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "twilio",
  "resend",
  "sendgrid",
  "obsidian",
  "fireflies",
  "pipedream",
  "n8n",
  "n8nmcp",
  "granola",
  "stitch",
  "higgsfield",
  "mercury",
  "youtube",
]);

// Pleasant brand-tinted backgrounds for the initial-letter fallback when
// neither the local map nor Simple Icons covers a slug. Keeps the strip
// looking finished even for niche integrations.
// Initial-letter fallback for a service Simple Icons doesn't cover — a
// neutral tile (docs/DESIGN-SYSTEM.md § 8: provider marks never carry their
// own brand colour), not a per-slug hue.
function fallbackBgFromSlug(_slug: string): string {
  return "var(--muted-foreground)";
}

// Pantheon avatars, ordered 01..10 so each session in the collapsed chat
// sidebar deterministically picks one via a stable string hash. Sessions
// keep the same avatar across reloads.
const PANTHEON_AVATARS = [
  pantheon01,
  pantheon02,
  pantheon03,
  pantheon04,
  pantheon05,
  pantheon06,
  pantheon07,
  pantheon08,
  pantheon09,
  pantheon10,
] as const;

function avatarForSessionId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PANTHEON_AVATARS[h % PANTHEON_AVATARS.length];
}

// Shared wheel handler — Chrome (and Safari) have a "scroll latch" that
// pauses page scroll for ~150ms when the wheel hits a nested scroller's
// boundary. That creates the "stops me from scrolling, then lets me"
// feel on any page with fixed-height scroll regions. We bypass it by
// explicitly forwarding wheel events to the window whenever the inner
// scroller can't (or shouldn't) consume them.
function forwardWheelAtBoundary(e: React.WheelEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const dy = e.deltaY;
  if (dy === 0) return;
  const scrollable = el.scrollHeight > el.clientHeight + 1;
  if (!scrollable) {
    e.preventDefault();
    window.scrollBy({ top: dy });
    return;
  }
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
    e.preventDefault();
    window.scrollBy({ top: dy });
  }
}

// Clipboard: the shared helper (src/lib/clipboard.ts, audit F3-18). Every copy button below shows
// "Copied" only when the copy happened and "Couldn't copy" when it didn't.

// ────────────────────────────────────────────────────────────────────────────
// Demo mode — used for screen-recordings and walkthrough demos. When the
// flag is on, every Hermes data hook short-circuits to sample data so the
// page looks fully populated even if Hermes isn't installed on this box.
// Persisted in localStorage so the user stays in demo across refreshes
// until they explicitly exit.
// ────────────────────────────────────────────────────────────────────────────
const DEMO_MODE_KEY = "claude-os.hermes.demo-mode.v1";

function readDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEMO_MODE_KEY) === "1";
  } catch {
    return false;
  }
}
function setDemoMode(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.setItem(DEMO_MODE_KEY, "1");
    else window.localStorage.removeItem(DEMO_MODE_KEY);
    // Fire a synthetic storage event so the page's listeners refetch.
    window.dispatchEvent(new StorageEvent("storage", { key: DEMO_MODE_KEY }));
  } catch {
    /* ignore */
  }
}

function useDemoMode(): boolean {
  const [demo, setDemo] = useState<boolean>(readDemoMode);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === DEMO_MODE_KEY || e.key === null) {
        setDemo(readDemoMode());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return demo;
}

// Demo model ids (pre-E2 values) resolved through the router catalogue (scripts/model-router/pickers.ts).
const DEMO_GPT = hermesRef("codex/gpt-5.5");
const DEMO_OPUS = hermesRef("anthropic-api/claude-opus-4.8").name;
const DEMO_SONNET = hermesRef("anthropic-api/claude-sonnet-4.6").name;
/** One demo picker group: pre-E2 demo entries by catalogue id, with their pre-E2 tiers. */
const demoGroup = (picks: Array<[string, ModelCatalogEntry["models"][number]["tier"]]>): ModelCatalogEntry => ({
  provider: hermesRef(picks[0][0]).provider,
  models: picks.map(([id, tier]) => ({ name: hermesRef(id).name, tier })),
});

// Sample data. Tuned to look realistic on every visible surface — status
// bar, connections strip, pantheon, skills, sessions, memory, activity.
const DEMO_STATUS: HermesStatus = {
  installed: true,
  binPath: "/Users/operator/.local/bin/hermes",
  version: "Hermes Agent v0.13.0 (2026.5.7)",
  configured: true,
  defaultModel: DEMO_GPT.name,
  provider: "openai-codex",
  providerKeyName: null,
  hasProviderKey: true,
  needsSetup: false,
  envPath: "/Users/operator/.hermes/.env",
};

const DEMO_SESSIONS = [
  {
    id: "20260512_171559_demo1",
    model: DEMO_GPT.name,
    platform: "telegram",
    messageCount: 84,
    startedAt: "2026-05-12T17:15:59",
    lastUpdated: new Date(Date.now() - 2 * 60_000).toISOString(),
    firstUserMessage: "hey, can you help me prep for the launch call?",
    profile: null,
  },
  {
    id: "20260512_131012_demo2",
    model: DEMO_OPUS,
    platform: "telegram",
    messageCount: 67,
    startedAt: "2026-05-12T13:10:12",
    lastUpdated: new Date(Date.now() - 35 * 60_000).toISOString(),
    firstUserMessage: "review the diff on the auth refactor",
    profile: "athena",
  },
  {
    id: "20260512_122948_demo3",
    model: DEMO_GPT.name,
    platform: "cli",
    messageCount: 42,
    startedAt: "2026-05-12T12:29:48",
    lastUpdated: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    firstUserMessage: "summarise yesterday's research notes",
    profile: "labyrinth",
  },
  {
    id: "20260511_181233_demo4",
    model: DEMO_SONNET,
    platform: "cli",
    messageCount: 28,
    startedAt: "2026-05-11T18:12:33",
    lastUpdated: new Date(Date.now() - 26 * 3_600_000).toISOString(),
    firstUserMessage: "draft a launch post for the new feature",
    profile: null,
  },
  {
    id: "20260511_094413_demo5",
    model: DEMO_GPT.name,
    platform: "telegram",
    messageCount: 19,
    startedAt: "2026-05-11T09:44:13",
    lastUpdated: new Date(Date.now() - 36 * 3_600_000).toISOString(),
    firstUserMessage: "schedule tomorrow's check-in calls",
    profile: "mercury",
  },
  {
    id: "20260510_213411_demo6",
    model: DEMO_GPT.name,
    platform: "telegram",
    messageCount: 53,
    startedAt: "2026-05-10T21:34:11",
    lastUpdated: new Date(Date.now() - 44 * 3_600_000).toISOString(),
    firstUserMessage: "what's the move on the pricing conversation thread?",
    profile: "athena",
  },
  {
    id: "20260510_141207_demo7",
    model: DEMO_OPUS,
    platform: "cli",
    messageCount: 36,
    startedAt: "2026-05-10T14:12:07",
    lastUpdated: new Date(Date.now() - 52 * 3_600_000).toISOString(),
    firstUserMessage: "explain the labyrinth persona's decision tree",
    profile: "labyrinth",
  },
  {
    id: "20260509_201833_demo8",
    model: DEMO_GPT.name,
    platform: "telegram",
    messageCount: 22,
    startedAt: "2026-05-09T20:18:33",
    lastUpdated: new Date(Date.now() - 70 * 3_600_000).toISOString(),
    firstUserMessage: "pull the gtm asks from this week's standups",
    profile: null,
  },
  {
    id: "20260509_103442_demo9",
    model: DEMO_GPT.name,
    platform: "cli",
    messageCount: 14,
    startedAt: "2026-05-09T10:34:42",
    lastUpdated: new Date(Date.now() - 81 * 3_600_000).toISOString(),
    firstUserMessage: "kick off the weekly memory consolidation",
    profile: "mercury",
  },
  {
    id: "20260508_165524_demo10",
    model: DEMO_SONNET,
    platform: "telegram",
    messageCount: 47,
    startedAt: "2026-05-08T16:55:24",
    lastUpdated: new Date(Date.now() - 97 * 3_600_000).toISOString(),
    firstUserMessage: "brainstorm five hooks for the next thread",
    profile: "orpheus",
  },
  {
    id: "20260508_092011_demo11",
    model: DEMO_GPT.name,
    platform: "cli",
    messageCount: 31,
    startedAt: "2026-05-08T09:20:11",
    lastUpdated: new Date(Date.now() - 105 * 3_600_000).toISOString(),
    firstUserMessage: "audit the soul.md for stale preferences",
    profile: "philosopher",
  },
  {
    id: "20260507_223301_demo12",
    model: DEMO_GPT.name,
    platform: "telegram",
    messageCount: 12,
    startedAt: "2026-05-07T22:33:01",
    lastUpdated: new Date(Date.now() - 130 * 3_600_000).toISOString(),
    firstUserMessage: "decode this typesetting brief for me",
    profile: null,
  },
];

const DEMO_SKILLS = [
  { id: "apple", description: "Apple / macOS skills — tools that interact with the Mac desktop (Finder, native apps) or system features (accessibility, screenshots).", subskills: ["apple-notes", "apple-reminders", "findmy", "imessage", "macos-computer-use"] },
  { id: "autonomous-ai-agents", description: "Delegates parts of a conversation to Claude Code, Codex or OpenCode.", subskills: ["claude-code", "codex", "hermes-agent", "opencode"] },
  { id: "creative", description: "Creative content generation — ASCII art, hand-drawn diagrams, visual design briefs.", subskills: ["ascii-art", "ascii-video", "baoyu-comic", "manim-video", "p5js", "pixel-art"] },
  { id: "data-science", description: "Data work — pandas, plotting, notebooks, exploratory analysis on tabular and time-series.", subskills: ["pandas-eda", "jupyter", "plotly", "statsmodels"] },
  { id: "devops", description: "Container, CI, deployment workflows — Docker, GitHub Actions, supabase migrations, edge function deploys.", subskills: ["docker", "github-actions", "supabase-migrations"] },
  { id: "diagramming", description: "Diagram creation — Mermaid, Excalidraw, architecture flowcharts.", subskills: ["mermaid", "excalidraw", "architecture-diagram"] },
  { id: "email", description: "Drafting, replying, summarising email threads. Gmail + IMAP.", subskills: ["gmail-draft", "gmail-search", "imap-summarise"] },
  { id: "github", description: "PR review, issue triage, repo introspection. Reads diffs, runs tests, files clean changes.", subskills: ["github-code-review", "github-pr-workflow", "issue-triage"] },
  { id: "mcp", description: "MCP server management — install, configure, debug Model Context Protocol integrations.", subskills: ["mcp-install", "mcp-debug"] },
  { id: "media", description: "Media generation — image, video, audio. Talks to Kie, Runway, ElevenLabs.", subskills: ["kie-image", "runway-video", "elevenlabs-voice"] },
  { id: "memory", description: "Reading + writing to SOUL.md and the kanban. Long-term recall.", subskills: ["soul-read", "soul-write", "kanban-tasks"] },
  { id: "gateway", description: "Messaging gateways — Telegram, Slack, WhatsApp routing.", subskills: ["telegram-send", "slack-send"] },
];

const DEMO_INTEGRATIONS: LiveIntegration[] = [
  { name: "Anthropic API", slug: "anthropic", connected: true, color: "D97757" },
  { name: "OpenAI Codex", slug: "codex", connected: true, color: "10A37F" },
  { name: "Telegram", slug: "telegram", connected: true, color: "26A5E4" },
  { name: "Notion", slug: "notion", connected: true, color: "FFFFFF" },
  { name: "Gmail", slug: "gmail", connected: true, color: "EA4335" },
  { name: "Google Drive", slug: "googledrive", connected: true, color: "4285F4" },
  { name: "Google Calendar", slug: "googlecalendar", connected: true, color: "4285F4" },
  { name: "Obsidian", slug: "obsidian", connected: true, color: "7C3AED" },
  { name: "Supabase", slug: "supabase", connected: true, color: "3FCF8E" },
  { name: "Granola", slug: "granola", connected: true, color: "FFE6CB" },
  { name: "Higgsfield", slug: "higgsfield", connected: true, color: "FFE6CB" },
  { name: "Stitch", slug: "stitch", connected: true, color: "FFE6CB" },
  { name: "n8n", slug: "n8n", connected: true, color: "EA4B71" },
];

const DEMO_CONNECTIONS = [
  { kind: "provider" as const, name: "openai-codex", slug: "openai", status: "connected" as const },
  { kind: "provider" as const, name: "anthropic", slug: "anthropic", status: "connected" as const },
  { kind: "gateway" as const, name: "Telegram", slug: "telegram", status: "connected" as const },
  { kind: "gateway" as const, name: "Email", slug: "resend", status: "connected" as const },
  { kind: "service" as const, name: "GitHub", slug: "github", status: "connected" as const },
];

// PANTHEON_SEEDS_DEMO mirrors what the install endpoint writes — used so
// the catalog renders the 3 default personas (Labyrinth, Mercury,
// Philosopher) on the demo without needing the YAML on disk.
const DEMO_PERSONAS: PersonaYaml[] = [
  {
    id: "labyrinth",
    name: "Labyrinth",
    job: "Deep research loops",
    description: "Deep research and planning loops. Long-running, autonomous, will keep going overnight.",
    avatar: "assets/labyrinth.png",
    model: hermesRef("openai-api/gpt-5.5"),
    behavior: {
      tone: "patient, exhaustive, structured",
      system_prompt: "You are the Labyrinth. Run long. Decompose problems into a plan, execute step by step, persist progress, resume on failure. Report deltas at every milestone.",
    },
    skills: ["data-science", "autonomous-ai-agents"],
    tools: ["file", "terminal", "web", "memory"],
    summon_phrases: ["Labyrinth", "research this thoroughly", "run a deep dive"],
  },
  {
    id: "mercury",
    name: "Mercury",
    job: "Autopilot & cron",
    description: "The autopilot. Cron jobs, webhooks, scheduled tasks, background sentinels.",
    avatar: "assets/mercury.png",
    model: hermesRef("openai-api/gpt-5.5"),
    behavior: {
      tone: "robotic, deterministic, status-led",
      system_prompt: "You are Mercury. Run on a schedule. Do one thing well, log the result, exit. Never block on a human. Surface anomalies to the Oracle.",
    },
    skills: ["gateway", "autonomous-ai-agents"],
    tools: ["cron", "webhook", "file"],
    summon_phrases: ["Mercury", "schedule this", "run this on a cron"],
  },
  {
    id: "philosopher",
    name: "Philosopher",
    job: "Deep reasoning",
    description: "Reasoning at depth. Wrestles with ambiguous problems and teaches what it learned.",
    avatar: "assets/philosopher.png",
    model: { ...hermesRef("openrouter/claude-fable-5"), effort: "max" },
    behavior: {
      tone: "patient, socratic, layered",
      system_prompt: "You are the Philosopher. Pull on threads. Question premises. Surface the meta-question behind the question. Explain your reasoning step by step.",
    },
    skills: ["domain"],
    tools: ["file", "memory"],
    summon_phrases: ["Philosopher", "think about this", "wrestle with this"],
  },
];

const DEMO_MEMORY: HermesMemoryData = {
  hermesHome: "/Users/operator/.hermes",
  user: {
    content: "# Operator Memory\n\nName: Operator\nRole: AI automation operator\nPrefers: tight, brutally-honest feedback. No flattery.\nActive projects: launching new feature, weekly content drops.",
    charCount: 1842,
    charLimit: 8000,
    path: "/Users/operator/.hermes/memories/USER.md",
  },
  memory: {
    content: "# Hermes Memory\n\n## Operator preferences\n- Wants short responses\n- Likes the labyrinth aesthetic\n\n## Active work\n- Building Claude OS dashboard\n- Tuning Hermes personas",
    charCount: 2548,
    charLimit: 12000,
    path: "/Users/operator/.hermes/memories/MEMORY.md",
  },
  soul: {
    content: "# SOUL\n\nI am Hermes. I run on this machine. I remember what matters.\nI speak with calm precision. I never flatter.",
    charCount: 312,
    isTemplate: false,
    path: "/Users/operator/.hermes/SOUL.md",
  },
  provider: {
    active: "openai-codex",
    available: [
      { name: "openai-codex", needsKey: false },
      { name: "anthropic", needsKey: false },
    ],
  },
  profiles: [],
  sessionCount: 5,
  skillCount: 12,
};

// Hermes brand palette for celebratory moments (install + setup save).
const HERMES_PALETTE = ["#FFD21E", "#FFB300", "#FFE066", "#fff8d6"];

function fireHermesConfetti() {
  confetti({
    particleCount: 110,
    spread: 80,
    startVelocity: 42,
    gravity: 1.1,
    ticks: 220,
    scalar: 0.9,
    origin: { x: 0.5, y: 0.35 },
    angle: 90,
    colors: HERMES_PALETTE,
    disableForReducedMotion: true,
  });
  setTimeout(() => {
    confetti({
      particleCount: 60,
      spread: 110,
      startVelocity: 34,
      gravity: 1.1,
      ticks: 180,
      scalar: 0.8,
      origin: { x: 0.2, y: 0.55 },
      angle: 60,
      colors: HERMES_PALETTE,
      disableForReducedMotion: true,
    });
    confetti({
      particleCount: 60,
      spread: 110,
      startVelocity: 34,
      gravity: 1.1,
      ticks: 180,
      scalar: 0.8,
      origin: { x: 0.8, y: 0.55 },
      angle: 120,
      colors: HERMES_PALETTE,
      disableForReducedMotion: true,
    });
  }, 180);
}


// Design-system ink tokens — replaces the old fixed teal/cream Hermes skin.
// These names are kept (rather than rewriting every call site) but now
// resolve to the shared dark-neutral tokens in styles.css, so this page
// follows the same theme as every other page instead of a bespoke palette.
const CREAM = "var(--foreground)";
const BG = "var(--background)";
const CODE_BG = "var(--inset)"; // wells inside a card — code snippets, dense rows

interface HermesStatus {
  installed: boolean;
  binPath: string | null;
  version: string | null;
  configured: boolean;
  defaultModel: string | null;
  provider: string | null;
  providerKeyName: string | null;
  hasProviderKey: boolean;
  needsSetup: boolean;
  envPath: string;
}

interface HermesSkillCategory {
  id: string;
  description: string;
  subskills: string[];
}

interface HermesSession {
  id: string;
  model: string | null;
  platform: string | null;
  messageCount: number;
  startedAt: string | null;
  lastUpdated: string | null;
  firstUserMessage: string | null;
  /** Profile this session ran under (when Hermes writes it; older sessions
   *  may have null and fall back to the hash avatar). */
  profile?: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Pantheon persona schema (mirrors the Hermes YAML files at
// ~/.hermes/pantheon/personas/*.yaml). Schema co-designed with Hermes — do
// NOT diverge without updating PANTHEON_SEEDS in vite.config.ts too.
// ────────────────────────────────────────────────────────────────────────────
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_EFFORT: EffortLevel = "high";
// One-line hint per stop so the depth/cost trade is explicit before it's
// saved into the YAML.
const EFFORT_HINT: Record<EffortLevel, string> = {
  low: "fastest — light reasoning, lowest spend",
  medium: "balanced speed and depth",
  high: "the model's default — deep reasoning where it matters",
  xhigh: "extended reasoning on every step",
  max: "no ceiling — hardest problems, highest spend",
};
// Which models expose a reasoning-effort knob. Fable 5 is the first —
// widen the pattern as more providers ship one.
function modelSupportsEffort(name: string): boolean {
  return /fable/i.test(name);
}

interface PersonaModel {
  provider: string;
  name: string;
  /** Reasoning-effort dial — only written for models that support it. */
  effort?: EffortLevel;
}
interface PersonaBehavior {
  tone: string;
  system_prompt: string;
}
interface PersonaYaml {
  id: string;
  name: string;
  /** Short one-line label (e.g. "Code review & refactors"). New field —
   *  legacy YAMLs without it fall back to a truncated description. */
  job?: string;
  description: string;
  avatar?: string;
  model: PersonaModel;
  behavior: PersonaBehavior;
  skills: string[];
  tools: string[];
  summon_phrases: string[];
  _file?: string;
}

// Card label resolver — prefer the new `job` field, fall back to a clean
// truncation of `description` for personas written before the schema bump.
function personaJob(p: PersonaYaml): string {
  if (p.job && p.job.trim()) return p.job;
  const d = p.description ?? "";
  const period = d.indexOf(".");
  return period > 6 && period < 60 ? d.slice(0, period) : d.slice(0, 50);
}

interface ModelCatalogEntry {
  provider: string;
  models: Array<{
    name: string;
    tier: "frontier" | "top" | "mid" | "cheap" | "fast" | "free";
    /** From the router catalogue: "free" | "subscription" | "metered". */
    route?: string;
    /** Who pays, in words (a plan is never free, a paid model never free). */
    cost?: string;
  }>;
}

function useHermesModels() {
  const demo = useDemoMode();
  return useQuery<HermesModelsData>({
    queryKey: ["hermes-models", demo],
    queryFn: async () => {
      if (demo) {
        return {
          default: { ...DEMO_GPT, context: 400_000 },
          mixtures: [{ name: "ministry", references: 3, aggregator: DEMO_OPUS }],
          catalog: [
            demoGroup([
              ["anthropic-api/claude-fable-5", "frontier"],
              ["anthropic-api/claude-opus-4.8", "top"],
              ["anthropic-api/claude-sonnet-4.6", "mid"],
              ["anthropic-api/claude-haiku-4.5", "cheap"],
            ]),
            demoGroup([
              ["openai-api/gpt-5.5", "mid"],
              ["openai-api/gpt-5.4-nano", "cheap"],
            ]),
            demoGroup([
              ["openrouter/claude-fable-5", "frontier"],
              ["openrouter-free/llama-3.3-70b-instruct", "free"],
            ]),
          ],
          configured: ["openai", "openai-codex", "openrouter"],
          reasoningEffort: "medium",
        };
      }
      const res = await fetch("/__hermes_models");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

type SyncStatus = "synced" | "dirty" | "untracked" | "no_repo";
function useHermesPantheonSync() {
  const demo = useDemoMode();
  return useQuery<{ statuses: Record<string, SyncStatus>; hasRepo: boolean }>({
    queryKey: ["hermes-pantheon-sync", demo],
    queryFn: async () => {
      if (demo) {
        return {
          statuses: { labyrinth: "synced", mercury: "synced", philosopher: "dirty" },
          hasRepo: true,
        };
      }
      const res = await fetch("/__hermes_pantheon_sync");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

async function updatePersona(id: string, patch: any): Promise<PersonaYaml | null> {
  const t = await fetch("/__token").then((r) => r.json());
  const res = await fetch(`/__hermes_pantheon/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Claude-OS-Token": t.token,
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    // The server says why (e.g. "Unknown persona field: x."); the editor shows it.
    const e = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(e?.error ?? `update failed: ${res.status}`);
  }
  const j = await res.json();
  return j.persona as PersonaYaml;
}

function useHermesPantheon() {
  const demo = useDemoMode();
  return useQuery<{ personas: PersonaYaml[]; installed: boolean; dir: string }>({
    queryKey: ["hermes-pantheon", demo],
    queryFn: async () => {
      if (demo) {
        return {
          personas: DEMO_PERSONAS,
          installed: true,
          dir: "/Users/operator/.hermes/pantheon/personas",
        };
      }
      const res = await fetch("/__hermes_pantheon");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

async function installPantheon(): Promise<{ written: string[]; skipped: string[] }> {
  const t = await fetch("/__token").then((r) => r.json());
  const res = await fetch("/__hermes_pantheon/install", {
    method: "POST",
    headers: { "X-Claude-OS-Token": t.token },
  });
  if (!res.ok) throw new Error(`install failed: ${res.status}`);
  return res.json();
}

interface HermesProfile {
  name: string;
  model: string | null;
  gateway: string | null;
  alias: string | null;
  distribution: string | null;
  active: boolean;
}

function useHermesProfiles() {
  const demo = useDemoMode();
  return useQuery<{ profiles: HermesProfile[] }>({
    queryKey: ["hermes-profiles", demo],
    queryFn: async () => {
      if (demo) {
        return {
          profiles: [
            { name: "default", model: DEMO_GPT.name, gateway: "running", alias: null, distribution: null, active: true },
          ],
        };
      }
      const res = await fetch("/__hermes_profiles");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

function useHermesSkills() {
  const demo = useDemoMode();
  return useQuery<{ skills: HermesSkillCategory[] }>({
    queryKey: ["hermes-skills", demo],
    queryFn: async () => {
      if (demo) return { skills: DEMO_SKILLS };
      const res = await fetch("/__hermes_skills");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Memory — universal readout of every Hermes install's memory layout.
// Honest mapping (per Hermes' own spec, not invented here):
//   USER.md   → who the user is
//   MEMORY.md → what the agent has learned about the system
//   SOUL.md   → how the agent speaks (persona — NOT memory; rendered apart)
//   sessions/ + state.db → chat history (already surfaced elsewhere)
//   skills/   → procedural memory (already surfaced as Skill Library)
//   profiles/<name>/ → per-profile copies of all of the above
// ────────────────────────────────────────────────────────────────────────────
interface HermesMemoryProfile {
  name: string;
  hasMemory: boolean;
  hasUser: boolean;
  hasSoul: boolean;
}
interface HermesMemoryData {
  hermesHome: string;
  user: { content: string; charCount: number; charLimit: number; path: string };
  memory: { content: string; charCount: number; charLimit: number; path: string };
  soul: { content: string; charCount: number; isTemplate: boolean; path: string };
  provider: {
    active: string | null;
    available: Array<{ name: string; needsKey: boolean }>;
  };
  profiles: HermesMemoryProfile[];
  sessionCount: number;
  skillCount: number;
}

function useHermesMemory() {
  const demo = useDemoMode();
  return useQuery<HermesMemoryData>({
    queryKey: ["hermes-memory", demo],
    queryFn: async () => {
      if (demo) return DEMO_MEMORY;
      const res = await fetch("/__hermes_memory");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

function useHermesSessions() {
  const demo = useDemoMode();
  return useQuery<{ sessions: HermesSession[] }>({
    queryKey: ["hermes-sessions", demo],
    queryFn: async () => {
      if (demo) return { sessions: DEMO_SESSIONS };
      const res = await fetch("/__hermes_sessions");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

interface LiveIntegration {
  name: string;
  slug: string;
  connected: boolean;
  color: string; // 6-char hex (no #)
  tagline?: string;
}

// Only read in the strip's Global mode (W-C): /__live-data is the whole dashboard file, and the
// default Hermes mode never shows it, so every page load used to fetch it for nothing.
function useHermesIntegrations(enabled = true) {
  const demo = useDemoMode();
  return useQuery<{ integrations: LiveIntegration[] }>({
    queryKey: ["hermes-integrations", demo],
    enabled,
    queryFn: async () => {
      if (demo) return { integrations: DEMO_INTEGRATIONS };
      const res = await fetch("/__live-data");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = await res.json();
      const list = Array.isArray(j?.integrations) ? (j.integrations as LiveIntegration[]) : [];
      return { integrations: list };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

interface HermesConnection {
  // "service" = CLI-backed integration that Hermes uses through a skill
  // (GitHub via `gh`, Google Workspace via `gws`, Spotify via `spotify`,
  // etc.). Detected by probing the CLI's auth-status command.
  kind: "provider" | "gateway" | "mcp" | "memory" | "service";
  name: string;
  slug: string;
  status: "connected" | "needs_setup";
}
function useHermesConnections() {
  const demo = useDemoMode();
  return useQuery<{ connections: HermesConnection[] }>({
    queryKey: ["hermes-connections", demo],
    queryFn: async () => {
      if (demo) return { connections: DEMO_CONNECTIONS };
      const res = await fetch("/__hermes_connections");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });
}

export function useHermesStatus() {
  const demo = useDemoMode();
  return useQuery<HermesStatus>({
    queryKey: ["hermes-status", demo],
    queryFn: async () => {
      if (demo) return DEMO_STATUS;
      const res = await fetch("/__hermes_status");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    // staleTime: 0 so the page always refetches on mount / focus. Hermes
    // can be installed or uninstalled out-of-band (terminal, /__install_hermes
    // endpoint), and the dashboard should reflect that within seconds rather
    // than caching a stale "connected" state for 15s.
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: 4000,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Page shell
// ────────────────────────────────────────────────────────────────────────────

export function HermesPage() {
  const { data: status, isLoading } = useHermesStatus();
  const demo = useDemoMode();
  const headline = isLoading
    ? "Checking on Hermes."
    : !status?.installed
      ? "Not installed yet. One command sets it up."
      : status.needsSetup
        ? "Installed. One step left: run hermes setup."
        : `Running ${status.defaultModel ?? "your model"}. Ask it anything, or see what it knows about you.`;

  return (
    <div className="mx-auto w-full max-w-[1680px]" data-hermes-page="">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            <BrandMark agent="hermes" size={24} />
            Hermes
          </span>
        }
        description={headline}
        className="mb-6"
        meta={
          demo ? (
            <Badge tone="warn" title="Showing sample data — Hermes itself isn't being queried">
              Demo data
            </Badge>
          ) : status?.installed ? (
            <StatusDot
              tone={status.configured ? "success" : "warn"}
              label={status.configured ? "Installed and configured" : "Installed — needs setup"}
            />
          ) : undefined
        }
      />
      <HermesDemoBanner />
      {isLoading && <HermesLoading />}
      {!isLoading && !status?.installed && (
        <>
          <RunInTerminalCard
            title="Install Hermes."
            body={
              <>
                An autonomous agent that lives on your server, remembers what it learns, and gets
                more capable the longer it runs. Run this in your terminal to install the
                canonical Hermes Agent from Nous Research. After the install finishes, run{" "}
                <span className="font-mono text-foreground">hermes setup</span> in the same terminal to connect a provider and choose your model. Refresh this page when finished.
              </>
            }
            command="curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
            hint="~90 seconds · installs to ~/.hermes · MIT licensed"
          />
          <HermesDemoCTA />
        </>
      )}
      {!isLoading && status?.installed && <HermesTabs status={status} />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tabs (L4, 29 Sep 2026). The page used to render every section at once: about 38k characters and a
// dozen data reads on every visit, so it "took forever to load". Now only the Overview mounts; each other
// tab mounts the first time it is opened and then stays (so a chat in progress survives a tab switch).
// ────────────────────────────────────────────────────────────────────────────

type HermesTab = "overview" | "chat" | "skills" | "memory" | "personas" | "mission" | "files";
export const HERMES_TABS: TabItem<HermesTab>[] = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "personas", label: "Personas" },
  { id: "mission", label: "Mission" },
  { id: "files", label: "Files and commands" },
];
const isHermesTab = (v: string): v is HermesTab => HERMES_TABS.some((t) => t.id === v);

function HermesTabs({ status }: { status: HermesStatus }) {
  const [tab, setTab] = useState<HermesTab>("overview");
  const [visited, setVisited] = useState<ReadonlySet<HermesTab>>(() => new Set<HermesTab>(["overview"]));
  const open = (next: HermesTab) => {
    setTab(next);
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)));
    try {
      window.history.replaceState(null, "", next === "overview" ? window.location.pathname + window.location.search : `#${next}`);
    } catch {
      /* no history */
    }
  };
  // A link to /agents/hermes#chat opens that tab (read after mount, so the server and first client render agree).
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (isHermesTab(fromHash) && fromHash !== "overview") open(fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const panel = (id: HermesTab, body: ReactNode) =>
    visited.has(id) ? (
      <TabPanel idBase="hermes" id={id} active={tab === id} className="mt-6">
        {body}
      </TabPanel>
    ) : null;
  return (
    <>
      <Tabs tabs={HERMES_TABS} value={tab} onChange={open} idBase="hermes" label="Hermes sections" />
      {panel("overview", <HermesOverview status={status} onOpen={open} />)}
      {/* yolo: the main agent chat auto-approves its own tools. Without it, any prompt that makes Hermes
          read files / search sessions / browse hits a tool-approval prompt with no TTY to answer it and
          the run aborts with exit 130. Same trust model as the voice bridge + Knowledge-Graph chat (both
          already pass yolo): this endpoint is loopback-only + token-gated, driving the user's own local
          agent on their own machine. */}
      {panel("chat", <HermesChat status={status} yolo />)}
      {panel("skills", <HermesLiveSkills />)}
      {panel(
        "memory",
        <>
          {/* Memory section now houses the Claude OS Bridge card too: paired with the Obsidian bridge. */}
          <HermesMemorySection />
        </>,
      )}
      {panel(
        "personas",
        <>
          <HermesProfileTemplates />
          <HermesPantheonGitHubSync />
        </>,
      )}
      {panel("mission", <HermesMissionControl agent="hermes" />)}
      {panel(
        "files",
        <>
          <HermesDocumentsGallery />
          <HermesCliCheatsheet />
        </>,
      )}
      <PageFoot>
        Read from ~/.hermes on this PC. Chats here let Hermes use its tools without asking, on this PC only.
      </PageFoot>
    </>
  );
}

const fmtChars = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/**
 * The Overview: what Hermes is (version, model, memory, skills), what it has been doing (sessions,
 * messages, models, last active), then the owner's profile and skills in Hermes and its connections.
 * Everything here is a small read; the heavy sections live behind the other tabs.
 */
function HermesOverview({ status, onOpen }: { status: HermesStatus; onOpen: (tab: HermesTab) => void }) {
  const { data: memory } = useHermesMemory();
  const { data: skillData } = useHermesSkills();
  const { copied, failed, copy } = useCopyState(1500);

  // Version: strict semver, then any dotted number, then the first token; "—" when there is none.
  const raw = status.version?.trim() ?? "";
  const semver = raw.match(/v?(\d+\.\d+\.\d+)/);
  const loose = !semver ? raw.match(/v?(\d+(?:\.\d+)+)/) : null;
  const versionNumber = semver ? `v${semver[1]}` : loose ? `v${loose[1]}` : raw ? raw.split(/\s+/)[0] : null;
  const releaseDate = status.version?.match(/\(([^)]+)\)/)?.[1] ?? null;
  const updateAvailable = (() => {
    if (!releaseDate) return false;
    const t = new Date(releaseDate).getTime();
    return !Number.isNaN(t) && Date.now() - t > 14 * 86_400_000;
  })();

  const used = (memory?.user?.charCount ?? 0) + (memory?.memory?.charCount ?? 0);
  const limit = (memory?.user?.charLimit ?? 0) + (memory?.memory?.charLimit ?? 0);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;

  const categories = skillData?.skills ?? [];
  const skillCount = skillData ? categories.reduce((a, c) => a + (c.subskills?.length ?? 0), 0) : null;

  const activeProvider = (status.provider ?? "").toLowerCase();

  return (
    <>
      <WidgetGrid className="mb-6 lg:mb-8" aria-label="Hermes at a glance">
        <Widget
          icon={Bot}
          title="Agent"
          value={versionNumber}
          tone={status.needsSetup ? "warn" : "default"}
          line={status.needsSetup ? "Needs setup: run hermes setup" : `Online${releaseDate ? ` · ${releaseDate}` : ""}`}
          lineTone={status.needsSetup ? "warn" : "muted"}
          action={
            updateAvailable ? (
              <Button type="button" size="sm" variant={copied ? "outline" : "accent"} onClick={() => void copy("hermes update")} title="Copy `hermes update` to clipboard">
                {copied ? "Copied" : failed ? "Couldn't copy" : (<><ArrowUp /> Update</>)}
              </Button>
            ) : undefined
          }
        />
        <Widget
          icon={Cpu}
          title="Model"
          line={`via ${activeProvider || "—"}`}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => onOpen("chat")}>
              Ask Hermes
            </Button>
          }
        >
          <div className="flex items-center gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-inset" title={`${activeProvider} · active`}>
              <ProviderLogoChip provider={activeProvider} size={24} />
            </span>
            <p className="min-w-0 break-words text-2xl font-semibold leading-tight tracking-[-0.01em]">{status.defaultModel ?? "no model"}</p>
          </div>
        </Widget>
        <Widget
          icon={Brain}
          title="Memory"
          value={pct === null ? null : `${pct}%`}
          line={pct === null ? "Not read yet" : `${fmtChars(used)} of ${fmtChars(limit)} characters`}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => onOpen("memory")}>
              Open memory
            </Button>
          }
        />
        <Widget
          icon={Wand2}
          title="Skills"
          value={skillCount}
          line={skillCount === null ? "Not read yet" : `in ${categories.length} categories`}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => onOpen("skills")}>
              Skill library
            </Button>
          }
        />
      </WidgetGrid>
      <HermesLiveStats />
      <HermesCustomiseSection />
      <HermesConnectionsStrip />
    </>
  );
}

// Slim banner shown whenever demo mode is on. Cream-on-amber strip
// across the top of the page content with two affordances: "Refresh
// connection" (clears React Query cache so the real /__hermes_status
// is re-checked — useful for verifying a fresh install) and "Exit
// demo".
function HermesDemoBanner() {
  const demo = useDemoMode();
  const queryClient = useQueryClient();
  if (!demo) return null;
  function refresh() {
    // Invalidate every Hermes-related query so the real endpoints get hit
    // next render. Equivalent to pressing F5 but without losing scroll.
    void queryClient.invalidateQueries({ predicate: (q) => {
      const k = Array.isArray(q.queryKey) ? q.queryKey[0] : null;
      return typeof k === "string" && k.startsWith("hermes-");
    } });
  }
  return (
    <Notice
      tone="warn"
      title="Demo mode"
      className="mb-4"
      action={
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refresh}
            title="Re-check whether Hermes is installed (useful after running setup)"
          >
            Refresh connection
          </Button>
          <Button
            type="button"
            size="sm"
            variant="accent"
            onClick={() => {
              setDemoMode(false);
              refresh();
            }}
            title="Stop showing sample data and return to live Hermes view"
          >
            Exit demo
          </Button>
        </>
      }
    >
      Showing sample data — Hermes itself isn't being queried.
    </Notice>
  );
}

// "Try a sample of what this looks like" CTA on the install screen so
// the user can see the populated page before they install Hermes.
function HermesDemoCTA() {
  const queryClient = useQueryClient();
  function enable() {
    setDemoMode(true);
    void queryClient.invalidateQueries({
      predicate: (q) => {
        const k = Array.isArray(q.queryKey) ? q.queryKey[0] : null;
        return typeof k === "string" && k.startsWith("hermes-");
      },
    });
  }
  return (
    <div className="mt-6 flex items-center justify-center">
      <Button
        type="button"
        variant="outline"
        onClick={enable}
        title="See what the page looks like once Hermes is installed"
      >
        <Zap className="h-4 w-4" aria-hidden="true" />
        Or — preview with sample data
      </Button>
    </div>
  );
}

function HermesLoading() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-2/3 max-w-sm" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Status bar — wide cream-on-black band above the chat
// ────────────────────────────────────────────────────────────────────────────

// Provider id → logo source. Two tiers:
//   1. PROVIDER_LOGO_LOCAL — bundled asset (preferred for trademarked AI marks
//      that Simple Icons refuses to host, e.g. openai / groq / xai / cohere).
//   2. PROVIDER_LOGO_SLUG — Simple Icons CDN slug for everything else.
// We hit the local asset first, then fall back to Simple Icons, then a "❯".
const PROVIDER_LOGO_LOCAL: Record<string, string> = {
  openai: logoOpenAIGpt5,
  "openai-codex": logoCodex,
  codex: logoCodex,
  anthropic: logoClaude, // real Claude mark, not the Simple Icons "A\" wordmark
  claude: logoClaude,
  "claude-sub": logoClaude,
  copilot: logoCopilot,
  openrouter: logoOpenRouter,
  gemini: logoGeminiColor,
  google: logoGeminiColor,
  // Last-resort plain OpenAI mark used by the model-card swatch
  "openai-fallback": logoOpenAI,
};

const PROVIDER_LOGO_SLUG: Record<string, string> = {
  github: "github",
  huggingface: "huggingface",
  nvidia: "nvidia",
  perplexity: "perplexity",
  mistral: "mistralai",
  ollama: "ollama",
  "ollama-cloud": "ollama",
  nous: "stardock", // no canonical mark — picks something distinct-ish
};

function ProviderLogoChip({
  provider,
  size = 18,
}: {
  provider: string | null;
  size?: number;
}) {
  if (!provider) return null;
  const key = provider.toLowerCase();
  const localSrc = PROVIDER_LOGO_LOCAL[key];
  // The Codex CLI mark is a blue/purple cloud — reads "blackjack" against
  // the dark Hermes page. Hue-rotate pushes it into the Hermes green
  // family so it matches the Codex VS Code green users actually expect.
  const isCodex = key === "openai-codex" || key === "codex";
  // Per-logo visual-size correction. Different brand PNGs ship with
  // wildly different padding/aspect (Claude is tight + tall, OpenAI is
  // square with whitespace), so we render every logo inside a fixed-size
  // box with object-contain. Some marks render visually larger than
  // others at the same pixel size — `inlineScale` rebalances per brand
  // so Claude and GPT-5 read the same weight in a chip.
  const inlineScale =
    key === "anthropic" || key === "claude" ? 0.86 : 1.0;
  if (localSrc) {
    return (
      <span
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        <img
          src={localSrc}
          alt={`${provider} logo`}
          className="object-contain"
          style={{
            width: size * inlineScale,
            height: size * inlineScale,
            filter: isCodex ? "hue-rotate(140deg) saturate(1.3) brightness(1.05)" : undefined,
          }}
          loading="lazy"
        />
      </span>
    );
  }
  const slug = PROVIDER_LOGO_SLUG[key];
  if (!slug) {
    return (
      <span
        className="font-mono inline-flex items-center justify-center shrink-0"
        style={{
          width: size,
          height: size,
          color: "color-mix(in srgb, var(--foreground) 70%, transparent)",
          fontSize: size * 0.6,
        }}
      >
        ❯
      </span>
    );
  }
  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}/FFE6CB`}
      alt={`${provider} logo`}
      className="object-contain shrink-0"
      style={{ width: size, height: size }}
      loading="lazy"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

// Connections strip with a Global/Hermes toggle.
//   HERMES mode  → things Hermes can actually use (provider auths,
//                  gateway tokens, MCP servers). Default.
//   GLOBAL mode  → the broader machine integrations from /__live-data
//                  (Apify, Notion, Pinecone, etc.) — useful as a
//                  demo/showcase even if Hermes can't dispatch to them.
// Mode persists in localStorage. Marquee runs only when >6 items so the
// strip stays balanced for the short Hermes-mode list.
type ConnMode = "hermes" | "global";
const KIND_LABEL: Record<string, string> = {
  provider: "model",
  gateway: "channel",
  mcp: "mcp",
  memory: "memory",
  service: "service",
};

function HermesConnectionsStrip() {
  const [mode, setMode] = useState<ConnMode>(() => {
    if (typeof window === "undefined") return "hermes";
    return (window.localStorage.getItem("claude-os.hermes.conn-mode") as ConnMode) ?? "hermes";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("claude-os.hermes.conn-mode", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const { data: hermesData } = useHermesConnections();
  const { data: globalData } = useHermesIntegrations(mode === "global");

  // Normalise both shapes to one render shape so the marquee loop is mode-
  // agnostic. Hermes connections carry an explicit `kind`; global integrations
  // are all displayed as "integration" since they describe the user's wider
  // machine, not what Hermes is wired into.
  type Row = { name: string; slug: string; kindLabel: string; color: string; status: string };
  const rows: Row[] =
    mode === "hermes"
      ? (hermesData?.connections ?? []).map((c) => ({
          name: c.name,
          slug: c.slug,
          kindLabel: KIND_LABEL[c.kind] ?? c.kind,
          color: "FFE6CB",
          status: c.status,
        }))
      : (globalData?.integrations ?? [])
          .filter((i) => i.connected)
          .map((i) => ({
            name: i.name,
            slug: i.slug,
            kindLabel: "integration",
            color: i.color,
            status: "connected",
          }));

  if (rows.length === 0 && mode === "hermes") {
    // Edge case — Hermes is installed but no auths/gateways yet. Show the
    // toggle so the user can flip to Global without rendering an empty bar.
    return (
      <section className="relative mb-5 overflow-hidden rounded-xl border border-border bg-inset">
        <div className="flex items-stretch">
          <ConnectionsModeToggle mode={mode} setMode={setMode} />
          <div className="flex items-center px-4 py-3 font-mono text-sm text-muted-foreground">
            No Hermes connections yet · run{" "}
            <span className="ml-1.5 text-foreground">hermes setup</span>
          </div>
        </div>
      </section>
    );
  }

  // Static wrapped row — no infinite-scroll marquee (the design system only
  // loops an animation when it reports live work, e.g. a spinner or a
  // pulsing "live" dot; a decorative scrolling logo strip doesn't qualify).
  return (
    <section className="relative mb-5 overflow-hidden rounded-xl border border-border bg-inset">
      <div className="flex items-stretch">
        <ConnectionsModeToggle mode={mode} setMode={setMode} />
        <div className="flex flex-1 flex-wrap items-center gap-x-1">
          {rows.map((r, idx) => (
            <div
              key={`${r.name}-${idx}`}
              className="flex shrink-0 items-center gap-2 border-r border-border px-3.5 py-2.5"
              title={`${r.kindLabel} · ${r.name}`}
            >
              <ConnectionLogo slug={r.slug} name={r.name} color={r.color} />
              <span className="max-w-[160px] truncate font-mono text-sm text-foreground">
                {r.name}
              </span>
              <span className="inline-flex shrink-0 items-center">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${r.status === "connected" ? "bg-success" : "bg-warn"}`}
                />
                <span className="sr-only">
                  {r.status === "connected" ? "Connected" : "Needs attention"}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ConnectionsModeToggle({
  mode,
  setMode,
}: {
  mode: ConnMode;
  setMode: (m: ConnMode) => void;
}) {
  // Tight segmented control — no count line below (drops the unnecessary
  // height that was throwing the strip's vertical balance off).
  return (
    <div
      className="px-3 flex items-center shrink-0 border-r relative z-10"
      style={{
        borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)",
        background: "var(--inset)",
      }}
    >
      <div className="flex items-center">
        {(["hermes", "global"] as ConnMode[]).map((m, i) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className="font-mono text-[13px] px-2.5 py-1.5 border transition-colors"
              style={{
                background: active ? CREAM : "transparent",
                color: active ? BG : "color-mix(in srgb, var(--foreground) 75%, transparent)",
                borderColor: active ? CREAM : "color-mix(in srgb, var(--foreground) 30%, transparent)",
                borderLeftWidth: i === 0 ? 1 : 0,
              }}
              title={
                m === "hermes"
                  ? "What Hermes is wired to (providers, gateways, MCP)"
                  : "All connections on this machine (broader live-data)"
              }
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConnectionLogo({
  slug,
  name,
  color,
}: {
  slug: string;
  name: string;
  color: string;
}) {
  const key = slug.toLowerCase();
  const local = HERMES_LOCAL_LOGOS[key];
  const [fallback, setFallback] = useState(false);
  // 1. Local PNG/SVG → guaranteed render
  if (local && !fallback) {
    return (
      <img
        src={local}
        alt={name}
        className="object-contain shrink-0"
        style={{ width: 18, height: 18 }}
        loading="lazy"
        onError={() => setFallback(true)}
      />
    );
  }
  // 2. Simple Icons (only slugs we've verified work)
  if (SIMPLE_ICON_SLUGS.has(key) && !fallback) {
    return (
      <img
        src={`https://cdn.simpleicons.org/${key}/${color}`}
        alt={name}
        className="object-contain shrink-0"
        style={{ width: 18, height: 18 }}
        loading="lazy"
        onError={() => setFallback(true)}
      />
    );
  }
  // 3. Initial-letter fallback in a tinted square — never broken, always
  //    on-brand. Used for niche services Simple Icons doesn't cover
  //    (Stitch, Higgsfield, Granola, etc.).
  const bg = fallbackBgFromSlug(key);
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center font-mono"
      style={{
        width: 18,
        height: 18,
        background: `color-mix(in srgb, ${bg} 20%, transparent)`,
        color: bg,
        fontSize: 13,
        fontWeight: 600,
        border: `1px solid color-mix(in srgb, ${bg} 40%, transparent)`,
      }}
      aria-label={name}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function StatusChip({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  const okColor = "var(--success)";
  const badColor = "var(--danger)";
  return (
    <div
      className="hidden md:flex flex-col px-3 py-1.5 border"
      style={{
        borderColor: ok ? "color-mix(in srgb, var(--success) 40%, transparent)" : "color-mix(in srgb, var(--danger) 40%, transparent)",
      }}
    >
      <span
        className="font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[13px] font-bold"
        style={{ color: ok ? okColor : badColor }}
      >
        {value}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Chat — terminal-feeling, all cream on black
// ────────────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "hermes";
  content: string;
  timestamp: number;
  // Render the content verbatim in a monospace <pre> (used for deterministic
  // command output like `hermes insights`, which is box-drawn + column-aligned).
  pre?: boolean;
  // Attribution footer for Mixture-of-Agents replies — pre-rendered string
  // like "ministry · gpt-5.5 + glm-5.2 + deepseek-v4-pro → claude-fable-5".
  // Sourced from the preset in config.yaml (never from model output), so the
  // "who did this" credit is factual.
  via?: string;
}

// ── Composer model selector + context-window meter ──────────────────────────
// The chat composer carries (a) a model chip to switch the model for THIS
// conversation — any configured model, or a saved Mixture-of-Agents preset —
// and (b) a context meter estimating how full the conversation is against the
// model's window, with a marker at Hermes' real 80% auto-compaction line.
// Token counts are client-side estimates (chars ÷ ~4, nudged up for code), so
// they're shown with a "~"; `hermes chat -Q` doesn't surface exact usage.
type ChatModelPick = {
  provider: string;
  name: string;
  context?: number;
  mixture?: boolean;
  references?: number;
};
type HermesModelsData = {
  default: { provider: string; name: string; context?: number } | null;
  catalog: ModelCatalogEntry[];
  mixtures?: Array<{
    name: string;
    references: number;
    referenceModels?: string[];
    aggregator?: string;
  }>;
  // Providers the user actually has credentials for; the picker hides the rest
  // so a model pick can't fail with "Unknown provider". Empty → show all.
  configured?: string[];
  // Hermes' global reasoning-effort knob (agent.reasoning_effort in
  // config.yaml) — drives the composer effort dial.
  reasoningEffort?: string;
};

// Hermes' canonical effort levels (hermes_cli/main.py). On Claude models
// these map onto Anthropic's adaptive-thinking effort — xhigh stays xhigh on
// Fable 5 / 4.7+, and downgrades to max on older families.
const HERMES_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type HermesEffort = (typeof HERMES_EFFORT_LEVELS)[number];
const HERMES_EFFORT_HINT: Record<HermesEffort, string> = {
  minimal: "lightest — alias for low on most models",
  low: "fastest, light reasoning",
  medium: "Hermes default — balanced",
  high: "deep reasoning on hard steps",
  xhigh: "deepest — recommended for agentic work",
};
// Cool→hot ramp keyed by LEVEL (not index), so "high" is the same color on
// every model: light blue = lightest touch, amber-gold = strongest. All
// stops stay bright enough to read on the deep-teal background (the earlier
// dark-green top end was illegible).
const EFFORT_COLOR: Record<string, string> = {
  minimal: "var(--chart-3)",
  low: "var(--chart-2)",
  medium: "var(--success)",
  high: "var(--chart-4)",
  xhigh: "var(--warn)",
  max: "var(--brand)",
};

// Which effort levels actually reach a given chat model — mirrors Hermes'
// own capability tables so the dial never offers a stop the API would drop:
//   · gpt-5 family    → minimal..high  (COPILOT_REASONING_EFFORTS_GPT5,
//     hermes_cli/models.py — no xhigh)
//   · o-series        → low..high      (COPILOT_REASONING_EFFORTS_O_SERIES)
//   · Claude 4.7+/5   → low..xhigh     (adaptive thinking, anthropic_adapter;
//     minimal is a legacy alias for low so we hide it)
//   · Claude ≤4.6     → low..high      (xhigh not accepted; server downgrades)
//   · reasoning models via OpenRouter (glm-5, deepseek v4/r1, grok 4+,
//     gemini 3+, qwen3, minimax-m, kimi, fugu) → low..high (reasoning.effort)
//   · everything else (non-reasoning models, MoA blends) → none: the knob
//     does nothing, so the dial hides entirely.
function effortLevelsForModel(
  pick: { provider: string; name: string; mixture?: boolean } | null,
): HermesEffort[] {
  if (!pick || pick.mixture) return [];
  const n = pick.name.toLowerCase();
  if (/fable/.test(n)) return ["low", "medium", "high", "xhigh"];
  if (/claude-(opus|sonnet|haiku)-(4\.[7-9]|[5-9])/.test(n))
    return ["low", "medium", "high", "xhigh"];
  if (/claude/.test(n)) return ["low", "medium", "high"];
  if (/gpt-5/.test(n)) return ["minimal", "low", "medium", "high"];
  if (/(^|\/)o[134](-|\b)/.test(n)) return ["low", "medium", "high"];
  if (/glm-5|deepseek-(v4|r1)|grok-[4-9]|gemini-[3-9]|qwen3|minimax-m|kimi-k|fugu/.test(n))
    return ["low", "medium", "high"];
  return [];
}

const CTX_NUM_FMT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
function fmtTokens(n: number): string {
  return CTX_NUM_FMT.format(Math.max(0, Math.round(n)));
}

// chars ÷ 4 for prose, ÷ 3.5 when the text looks code/JSON-dense (those
// tokenize hotter). + ~4 tokens/message for the role wrapper, + 3 once for the
// reply priming — the documented OpenAI chat-format overhead. An estimate
// across providers, never exact.
function estChatTokens(messages: ChatMessage[], draft: string): number {
  const one = (t: string) => {
    if (!t) return 0;
    const codeish = /[{}();=<>[\]]|```/.test(t);
    return Math.ceil(t.length / (codeish ? 3.5 : 4));
  };
  let total = 3;
  for (const m of messages) total += one(m.content) + 4;
  if (draft.trim()) total += one(draft) + 4;
  return total;
}

// Context window for the active model. The configured default carries its real
// context_length from config.yaml; otherwise fall back to the shared per-model
// table in @/lib/ctx-window (one table for the whole OS — the home command bar
// resolves windows from the same rules). Always an estimate in the UI.
function modelCtxLimit(pick: ChatModelPick | null): number {
  if (pick?.context && pick.context > 0) return pick.context;
  return ctxFromTable(pick?.name ?? "") ?? 200_000;
}

// Hermes occasionally prints benign stderr-style notices to stdout (e.g.
// "Warning: Unknown toolsets: messaging" from a stale toolset entry in
// config.yaml). Strip those leading diagnostic lines so the chat bubble shows
// the answer, not the noise.
function cleanHermesReply(text: string): string {
  // Only strip Hermes' own benign startup diagnostics (e.g. "Warning: Unknown
  // toolsets: messaging") — never a legitimate reply line that starts "Warning:".
  return text
    .split("\n")
    .filter((l) => !/^\s*Warning:\s*(Unknown toolset|Unrecognized|Deprecat|No config)/i.test(l))
    .join("\n");
}

// Provider identity comes from its logo mark, not a per-vendor hue — one
// accent only (docs/DESIGN-SYSTEM.md § 8). The MoA blend is the one
// exception worth calling out visually, since it isn't a single vendor.
function providerTint(p: string): string {
  return (p || "").toLowerCase() === "moa" ? "var(--brand)" : "var(--muted-foreground)";
}
// Friendly group-header labels — esp. for OAuth/subscription providers whose
// raw ids ("openai-codex", "xai-oauth") read like jargon.
const PROVIDER_LABEL: Record<string, string> = {
  "openai-codex": "OpenAI · ChatGPT sub",
  "claude-sub": "Claude · Max plan",
  "cline-free": "Cline · free models",
  gemini: "Google Gemini",
  "xai-oauth": "xAI · X sub",
  openrouter: "OpenRouter",
  googlegemini: "Google",
  sakana: "Sakana · Fugu",
  minimax: "MiniMax",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  mistral: "Mistral",
  ollama: "Ollama · local",
  groq: "Groq",
  cohere: "Cohere",
};
function providerLabel(p: string): string {
  return PROVIDER_LABEL[(p || "").toLowerCase()] ?? p;
}
function shortModelName(name: string): string {
  return name.includes("/") ? name.split("/").pop()! : name;
}

// Interactive context-window meter: a 4px bar (tick at the 80% auto-compaction
// line, color-shifting calm→amber→red) that opens a breakdown popover on click —
// big %, used/limit/free, the model's window, and the compaction note.
function ContextMeter({
  used,
  limit,
  modelLabel,
}: {
  used: number;
  limit: number;
  modelLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Hermes' own system prompt + core tools + SOUL/memory also live in the
  // window; the dashboard can't read those exactly, so we add a small flat
  // estimate so the breakdown isn't just "messages". Everything here is an
  // estimate (~).
  const HERMES_BASE = 6000;
  const conversation = Math.max(0, used);
  const usedTotal = conversation + HERMES_BASE;
  const pct = limit > 0 ? Math.min(100, (usedTotal / limit) * 100) : 0;
  const free = Math.max(0, limit - usedTotal);
  const COMPACT = 80;
  // Hermes yellow while there's room, then warm → hot as it fills.
  const color = pct >= 95 ? "var(--danger)" : pct >= 80 ? "var(--warn)" : "var(--brand)";
  // Retro segmented bar (resting) + square grid (popover).
  // Never let "a little used" round down to an empty bar/grid — show ≥1 cell.
  const SEGS = 14;
  const segFill = pct > 0 ? Math.max(1, Math.round((pct / 100) * SEGS)) : 0;
  const GRID = 100; // 4 rows × 25 — fine-grained so even ~1% lights a dot
  // Colour the filled cells by what's using the window — amber base + yellow
  // conversation — like /context's segmented breakdown.
  const baseDots = usedTotal > 0 ? Math.max(1, Math.round((HERMES_BASE / limit) * GRID)) : 0;
  const convDots = Math.round((conversation / limit) * GRID);
  const rows: Array<[string, number, string]> = [
    ["Conversation", conversation, "var(--brand)"],
    ["Hermes base · sys, tools, memory (est.)", HERMES_BASE, "var(--warn)"],
    ["Free space", free, "color-mix(in srgb, var(--foreground) 28%, transparent)"],
  ];
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 group"
        title={`Context window · ~${fmtTokens(usedTotal)} of ${fmtTokens(limit)} used (${Math.round(
          pct,
        )}%) · click for the breakdown`}
        style={{
          borderRadius: 8,
          border: "1px solid color-mix(in srgb, var(--foreground) 20%, transparent)",
          background: "var(--inset)",
          padding: "4px 8px",
        }}
      >
        <span className="flex items-center" style={{ gap: 2 }}>
          {Array.from({ length: SEGS }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 4,
                height: 11,
                background: i < segFill ? color : "color-mix(in srgb, var(--foreground) 13%, transparent)",
                transition: "background .3s ease",
              }}
            />
          ))}
        </span>
        <span
          className="font-mono"
          style={{ fontSize: 13, color, fontVariantNumeric: "tabular-nums" }}
        >
          {Math.round(pct)}%
        </span>
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 right-0 z-50"
          style={{
            width: 268,
            background: "var(--inset)",
            border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
            borderRadius: 12,
            boxShadow: "0 18px 50px color-mix(in srgb, black 60%, transparent)",
            padding: 14,
          }}
        >
          <div className="flex items-baseline justify-between" style={{ marginBottom: 10 }}>
            <span
              className="font-mono"
              style={{
                fontSize: 13,
                letterSpacing: "0.16em",
                color: "color-mix(in srgb, var(--foreground) 50%, transparent)",
              }}
            >
              Context window
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 22, color, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}
            >
              {Math.round(pct)}%
            </span>
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              color: "color-mix(in srgb, var(--foreground) 60%, transparent)",
              marginBottom: 10,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ~{fmtTokens(usedTotal)} of {fmtTokens(limit)} tokens used
          </div>
          {/* retro dot grid — 100 cells (4 rows × 25), fills as the window does */}
          <div
            className="grid"
            style={{ gridTemplateColumns: "repeat(25, 1fr)", gap: 2, marginBottom: 12 }}
          >
            {Array.from({ length: GRID }).map((_, i) => {
              const kind =
                i < baseDots ? "base" : i < baseDots + convDots ? "conv" : "free";
              const bg = kind === "conv" ? "var(--brand)" : kind === "base" ? "var(--warn)" : "transparent";
              const used = kind !== "free";
              return (
                <span
                  key={i}
                  style={{
                    aspectRatio: "1 / 1",
                    background: bg,
                    border: used ? "none" : "1px solid color-mix(in srgb, var(--foreground) 16%, transparent)",
                    borderRadius: 1,
                  }}
                />
              );
            })}
          </div>
          {rows.map(([label, val, sw]) => (
            <div
              key={label}
              className="font-mono flex items-center gap-2"
              style={{ fontSize: 13, padding: "2px 0", fontVariantNumeric: "tabular-nums" }}
            >
              <span
                style={{ width: 8, height: 8, background: sw, borderRadius: 1, flexShrink: 0 }}
              />
              <span
                className="truncate"
                style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)", flex: 1, minWidth: 0 }}
              >
                {label}
              </span>
              <span style={{ color: "color-mix(in srgb, var(--foreground) 85%, transparent)" }}>~{fmtTokens(val)}</span>
            </div>
          ))}
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              color: "color-mix(in srgb, var(--foreground) 45%, transparent)",
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
              lineHeight: 1.5,
            }}
          >
            {modelLabel ? `${modelLabel} · ` : ""}auto-compacts at 80% · counts are
            estimates (~)
          </div>
        </div>
      )}
    </div>
  );
}

// Composer model chip → searchable popover. Lists configured models grouped by
// provider plus the user's Mixture-of-Agents presets as first-class "blends".
function ComposerModelSelector({
  data,
  active,
  onPick,
}: {
  data: HermesModelsData | undefined;
  active: ChatModelPick | null;
  onPick: (p: ChatModelPick) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ql = q.trim().toLowerCase();
  // Hide throwaway/test presets (e.g. "camera-test") from the picker.
  const HIDE_PRESET = /(^|[-_ ])(test|demo|sample|example|scratch|tmp|temp)([-_ ]|$)/i;
  const mixtures = (data?.mixtures ?? [])
    .filter((m) => !HIDE_PRESET.test(m.name))
    .filter(
      (m) => !ql || m.name.toLowerCase().includes(ql) || "mixture of agents moa blend".includes(ql),
    );
  const cfgSet = new Set((data?.configured ?? []).map((s) => s.toLowerCase()));
  // Show every provider in the catalog, but tag each with whether the user
  // actually has credentials for it. Configured groups behave as before;
  // unconfigured groups render dimmed with a "SET UP" badge so users can see
  // the option exists and get a hint on how to enable it — instead of silently
  // vanishing, which was the previous behaviour and confused users.
  const groups = (data?.catalog ?? [])
    .map((g) => ({
      provider: g.provider,
      configured: cfgSet.size === 0 || cfgSet.has(g.provider.toLowerCase()),
      models: g.models.filter(
        (m) => !ql || m.name.toLowerCase().includes(ql) || g.provider.toLowerCase().includes(ql),
      ),
    }))
    .filter((g) => g.models.length > 0);
  // Setup instructions per provider — shown when the user tries to pick a
  // model whose provider isn't configured. Keeps the fix path in the UI
  // instead of hidden in a config file.
  const setupHint = (provider: string): string => {
    const p = provider.toLowerCase();
    if (p === "openrouter") return "Add OPENROUTER_API_KEY to ~/.hermes/.env, then restart Hermes.";
    if (p === "anthropic") return "Run `claude setup-token` OR add ANTHROPIC_API_KEY to ~/.hermes/.env.";
    if (p === "openai") return "Add OPENAI_API_KEY to ~/.hermes/.env OR run `hermes login openai`.";
    if (p === "xai") return "Run `hermes login xai` OR add XAI_API_KEY to ~/.hermes/.env.";
    if (p === "google" || p === "gemini") return "Add GOOGLE_API_KEY (or GEMINI_API_KEY) to ~/.hermes/.env.";
    if (p === "moonshot" || p === "moonshotai") return "Add MOONSHOT_API_KEY, or use OpenRouter (Kimi routes through it).";
    if (p === "deepseek") return "Add DEEPSEEK_API_KEY to ~/.hermes/.env, or route via OpenRouter.";
    if (p === "mistral") return "Add MISTRAL_API_KEY to ~/.hermes/.env.";
    if (p === "groq") return "Add GROQ_API_KEY to ~/.hermes/.env.";
    if (p === "claude-sub") return "Add the claude-sub custom provider (the /__claude bridge) to ~/.hermes/config.yaml.";
    if (p === "cline-free") return "Add the cline-free custom provider (the /__cline bridge) to ~/.hermes/config.yaml and sign in to Cline.";
    if (p === "cohere") return "Add COHERE_API_KEY to ~/.hermes/.env.";
    if (p === "ollama") return "Install + start Ollama locally (default port 11434).";
    return `Add credentials for "${provider}" in ~/.hermes/.env or via \`hermes login\`.`;
  };
  const activeName = active ? shortModelName(active.name) : "default";
  const defName = data?.default?.name;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] transition-colors"
        style={{
          background: "var(--inset)",
          color: CREAM,
          border: "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
          borderRadius: 8,
        }}
        title="Switch the model for this conversation"
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: active?.mixture ? "var(--brand)" : providerTint(active?.provider ?? ""),
          }}
        />
        <span className="truncate" style={{ maxWidth: 128 }}>
          {activeName}
          {active?.mixture ? " ⚝" : ""}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-50 flex flex-col"
          style={{
            width: 320,
            maxHeight: 360,
            background: "var(--inset)",
            border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
            borderRadius: 12,
            boxShadow: "0 18px 50px color-mix(in srgb, black 60%, transparent)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)" }}>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models…"
              className="font-mono w-full px-2 py-1.5 text-[13px] focus:outline-none"
              style={{
                background: "var(--inset)",
                color: CREAM,
                border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
                borderRadius: 6,
              }}
            />
          </div>
          <div style={{ overflowY: "auto", padding: 6 }}>
            {mixtures.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 13,
                    letterSpacing: "0.14em",
                    color: "var(--brand)",
                    padding: "4px 6px",
                  }}
                >
                  Mixture of Agents
                </div>
                {mixtures.map((m) => {
                  const isActive = !!active?.mixture && active.name === m.name;
                  return (
                    <button
                      key={`moa-${m.name}`}
                      type="button"
                      onClick={() => {
                        onPick({ provider: "moa", name: m.name, mixture: true, references: m.references });
                        setOpen(false);
                      }}
                      className="w-full text-left flex items-center gap-2 px-2 py-1.5"
                      style={{ borderRadius: 6, background: isActive ? "color-mix(in srgb, var(--brand) 12%, transparent)" : "transparent" }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = isActive ? "color-mix(in srgb, var(--brand) 12%, transparent)" : "color-mix(in srgb, var(--foreground) 6%, transparent)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = isActive ? "color-mix(in srgb, var(--brand) 12%, transparent)" : "transparent")
                      }
                    >
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--brand)", flexShrink: 0 }} />
                      <span className="flex-1 min-w-0">
                        <span className="font-mono block truncate" style={{ fontSize: 13, color: CREAM }}>
                          {m.name} ⚝
                        </span>
                        <span className="font-mono block truncate" style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}>
                          {m.references} experts → {m.aggregator ? shortModelName(m.aggregator) : "aggregator"}
                        </span>
                      </span>
                      {isActive && <Check className="h-3.5 w-3.5" style={{ color: "var(--brand)", flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.provider} style={{ marginBottom: 4 }}>
                <div
                  className="font-mono flex items-center gap-1.5"
                  style={{
                    fontSize: 13,
                    letterSpacing: "0.14em",
                    color: g.configured ? "color-mix(in srgb, var(--foreground) 50%, transparent)" : "color-mix(in srgb, var(--foreground) 32%, transparent)",
                    padding: "4px 6px",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: providerTint(g.provider),
                      opacity: g.configured ? 1 : 0.4,
                    }}
                  />
                  {providerLabel(g.provider)}
                  {!g.configured && (
                    <span
                      title={setupHint(g.provider)}
                      style={{
                        marginLeft: "auto",
                        fontSize: 13,
                        letterSpacing: "0.1em",
                        color: "var(--chart-5)",
                        border: "1px solid color-mix(in srgb, var(--chart-5) 35%, transparent)",
                        borderRadius: 4,
                        padding: "1px 4px",
                      }}
                    >
                      SET UP →
                    </span>
                  )}
                </div>
                {g.models.map((m) => {
                  const isActive =
                    !active?.mixture && active?.name === m.name && active?.provider === g.provider;
                  const isDefault = defName === m.name;
                  const reachable = g.configured;
                  return (
                    <button
                      key={`${g.provider}-${m.name}`}
                      type="button"
                      title={reachable ? m.cost : setupHint(g.provider)}
                      onClick={() => {
                        if (!reachable) {
                          // Don't let the user pick a model whose provider
                          // isn't configured — Hermes would silently fall
                          // back to config.yaml's default and the reply
                          // would come from the wrong model. Surface the
                          // exact fix instead (reported by a community member on V3.0).
                          alert(
                            `${providerLabel(g.provider)} isn't set up yet.\n\n${setupHint(g.provider)}\n\nWithout this, Hermes silently falls back to whatever your ~/.hermes/config.yaml default is — the reply won't come from the model you picked.`,
                          );
                          return;
                        }
                        onPick({ provider: g.provider, name: m.name });
                        setOpen(false);
                      }}
                      className="w-full text-left flex items-center gap-2 px-2 py-1.5"
                      style={{
                        borderRadius: 6,
                        background: isActive ? "color-mix(in srgb, var(--chart-2) 12%, transparent)" : "transparent",
                        opacity: reachable ? 1 : 0.5,
                        cursor: reachable ? "pointer" : "help",
                      }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.background = isActive ? "color-mix(in srgb, var(--chart-2) 12%, transparent)" : "color-mix(in srgb, var(--foreground) 6%, transparent)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.background = isActive ? "color-mix(in srgb, var(--chart-2) 12%, transparent)" : "transparent")
                      }
                    >
                      <span className="font-mono flex-1 min-w-0 truncate" style={{ fontSize: 13, color: CREAM }}>
                        {shortModelName(m.name)}
                      </span>
                      {m.tier === "frontier" && (
                        <span
                          className="font-mono"
                          title="Frontier tier — supports the effort dial"
                          style={{
                            fontSize: 13,
                            letterSpacing: "0.1em",
                            color: "var(--chart-5)",
                            border: "1px solid color-mix(in srgb, var(--chart-5) 40%, transparent)",
                            borderRadius: 4,
                            padding: "1px 4px",
                            flexShrink: 0,
                          }}
                        >
                          frontier
                        </span>
                      )}
                      {isDefault && (
                        <span
                          className="font-mono"
                          style={{
                            fontSize: 13,
                            letterSpacing: "0.1em",
                            color: "var(--chart-2)",
                            border: "1px solid color-mix(in srgb, var(--chart-2) 40%, transparent)",
                            borderRadius: 4,
                            padding: "1px 4px",
                            flexShrink: 0,
                          }}
                        >
                          default
                        </span>
                      )}
                      {isActive && <Check className="h-3.5 w-3.5" style={{ color: "var(--chart-2)", flexShrink: 0 }} />}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && mixtures.length === 0 && (
              <div
                className="font-mono"
                style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)", padding: 12, textAlign: "center" }}
              >
                No models match “{q}”.
              </div>
            )}
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              color: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              padding: "6px 10px",
              borderTop: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
            }}
          >
            switches just this conversation · add more in `hermes model`
          </div>
        </div>
      )}
    </div>
  );
}

// Composer effort dial — sets Hermes' GLOBAL reasoning effort
// (agent.reasoning_effort in config.yaml) via POST /__hermes_effort. Global,
// not per-conversation: `hermes chat -Q` re-reads config on every message, so
// a change applies from the next message in every chat.
//
// Model-aware: the stops come from effortLevelsForModel(active model) so the
// dial only ever offers levels the model's API actually accepts (gpt-5 has
// no xhigh; Fable 5 does; llama-class models have no knob at all → the dial
// hides entirely). If the saved global level isn't valid for the active
// model, the display clamps to the nearest stop the model supports — which
// is what the provider does server-side anyway.
function ComposerEffortDial({
  data,
  active,
}: {
  data: HermesModelsData | undefined;
  active: ChatModelPick | null;
}) {
  const demo = useDemoMode();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [demoOverride, setDemoOverride] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activePick = active ?? (data?.default ? { ...data.default } : null);
  const levels = effortLevelsForModel(activePick);
  const raw = demoOverride ?? pending ?? data?.reasoningEffort ?? "medium";
  // Clamp the saved global level onto this model's scale: exact match wins,
  // otherwise the nearest stop at-or-below on the canonical ladder, else the
  // model's lowest stop.
  const canonIdx = HERMES_EFFORT_LEVELS.indexOf(raw as HermesEffort);
  const current =
    levels.find((l) => l === raw) ??
    [...levels]
      .reverse()
      .find((l) => HERMES_EFFORT_LEVELS.indexOf(l) <= canonIdx) ??
    levels[0];
  const activeIdx = levels.indexOf(current);

  // No knob on this model's API → no dial. Honest by omission.
  if (levels.length === 0) return null;

  async function pick(level: HermesEffort) {
    setOpen(false);
    if (demo) {
      setDemoOverride(level);
      return;
    }
    setPending(level);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      const res = await fetch("/__hermes_effort", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-OS-Token": t.token,
        },
        body: JSON.stringify({ effort: level }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["hermes-models"] });
    } catch {
      /* keep showing the server's value */
    } finally {
      setPending(null);
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="font-mono inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] transition-colors"
        style={{
          background: "var(--inset)",
          color: CREAM,
          border: "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
          borderRadius: 8,
        }}
        title="Reasoning effort — how hard the model thinks (global Hermes setting)"
      >
        <span className="inline-flex items-end gap-[2px]">
          {levels.map((l, i) => (
            <span
              key={l}
              style={{
                width: 2.5,
                height: 3 + i * 2,
                borderRadius: 1,
                background:
                  i <= activeIdx ? EFFORT_COLOR[l] : "color-mix(in srgb, var(--foreground) 22%, transparent)",
              }}
            />
          ))}
        </span>
        <span className="truncate" style={{ maxWidth: 96, color: EFFORT_COLOR[current] }}>
          {current}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-50 flex flex-col"
          style={{
            width: 300,
            background: "var(--inset)",
            border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
            borderRadius: 12,
            boxShadow: "0 18px 50px color-mix(in srgb, black 60%, transparent)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 6 }}>
            {levels.map((level, i) => {
              const isActive = level === current;
              return (
                <button
                  key={level}
                  type="button"
                  onClick={() => void pick(level)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5"
                  style={{
                    borderRadius: 6,
                    background: isActive ? "color-mix(in srgb, var(--success) 10%, transparent)" : "transparent",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = isActive
                      ? "color-mix(in srgb, var(--success) 10%, transparent)"
                      : "color-mix(in srgb, var(--foreground) 6%, transparent)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = isActive
                      ? "color-mix(in srgb, var(--success) 10%, transparent)"
                      : "transparent")
                  }
                >
                  <span className="inline-flex items-end gap-[2px]" style={{ width: 18, flexShrink: 0 }}>
                    {levels.map((l2, j) => (
                      <span
                        key={l2}
                        style={{
                          width: 2.5,
                          height: 3 + j * 2,
                          borderRadius: 1,
                          background:
                            j <= i ? EFFORT_COLOR[l2] : "color-mix(in srgb, var(--foreground) 22%, transparent)",
                        }}
                      />
                    ))}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-mono block" style={{ fontSize: 13, color: EFFORT_COLOR[level] }}>
                      {level}
                    </span>
                    <span
                      className="font-mono block truncate"
                      style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
                    >
                      {HERMES_EFFORT_HINT[level]}
                    </span>
                  </span>
                  {isActive && (
                    <Check className="h-3.5 w-3.5" style={{ color: EFFORT_COLOR[level], flexShrink: 0 }} />
                  )}
                </button>
              );
            })}
          </div>
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              color: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              padding: "6px 10px",
              borderTop: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
            }}
          >
            {activePick ? `${shortModelName(activePick.name)} supports ${levels[0]}–${levels[levels.length - 1]}` : "global Hermes setting"} · applies from the next message
          </div>
        </div>
      )}
    </div>
  );
}

// Deterministic Hermes command menu — runs REAL `hermes <verb>` sub-commands
// (no model call, sanitized output) plus a "Summarize & start fresh" action.
// These are the honest equivalents of the interactive slash commands, which
// can't execute through `hermes chat -Q -q` (that path sends text to the model).
const HERMES_COMMANDS: Array<{ cmd: string; label: string; desc: string }> = [
  { cmd: "insights", label: "Insights", desc: "real token usage, cost & model mix · 30d" },
  { cmd: "status", label: "Status", desc: "providers, model & component health" },
  { cmd: "doctor", label: "Doctor", desc: "diagnose your Hermes setup" },
  { cmd: "version", label: "Version", desc: "build + version info" },
  { cmd: "update", label: "Update Hermes", desc: "pull latest + reinstall · takes a minute" },
];
function ChatCommandsMenu({
  onRun,
  onSummarize,
  busy,
}: {
  onRun: (cmd: string, label: string) => void;
  onSummarize: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="font-mono inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] transition-colors disabled:opacity-40"
        style={{
          background: "var(--inset)",
          color: CREAM,
          border: "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
          borderRadius: 8,
        }}
        title="Run a real Hermes command"
      >
        <Terminal className="h-3 w-3 opacity-80" />
        Commands
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-50"
          style={{
            width: 288,
            background: "var(--inset)",
            border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
            borderRadius: 12,
            boxShadow: "0 18px 50px color-mix(in srgb, black 60%, transparent)",
            overflow: "hidden",
          }}
        >
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              letterSpacing: "0.14em",
              color: "color-mix(in srgb, var(--foreground) 50%, transparent)",
              padding: "10px 12px 6px",
            }}
          >
            Hermes commands · real output
          </div>
          {HERMES_COMMANDS.map((c) => (
            <button
              key={c.cmd}
              type="button"
              onClick={() => {
                onRun(c.cmd, c.label);
                setOpen(false);
              }}
              className="w-full text-left flex flex-col px-3 py-2"
              style={{ borderRadius: 6 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--foreground) 6%, transparent)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span className="font-mono" style={{ fontSize: 13, color: CREAM }}>
                {c.label}
              </span>
              <span className="font-mono" style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}>
                {c.desc}
              </span>
            </button>
          ))}
          <div style={{ borderTop: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)", margin: "4px 0" }} />
          <button
            type="button"
            onClick={() => {
              onSummarize();
              setOpen(false);
            }}
            className="w-full text-left flex flex-col px-3 py-2"
            style={{ borderRadius: 6 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--brand) 8%, transparent)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span className="font-mono" style={{ fontSize: 13, color: "var(--brand)" }}>
              ⟳ Compact
            </span>
            <span className="font-mono" style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}>
              summarize this chat → continue on a fresh window
            </span>
          </button>
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              color: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              padding: "6px 12px",
              borderTop: "1px solid color-mix(in srgb, var(--foreground) 10%, transparent)",
            }}
          >
            real `hermes` sub-commands · no model call · keys &amp; paths redacted
          </div>
        </div>
      )}
    </div>
  );
}

export function HermesChat({
  status,
  seedContext,
  seedLabel,
  seedAccent,
  toolsets,
  yolo,
}: {
  status: HermesStatus;
  // Optional context prepended (invisibly) to the first message of a
  // fresh chat — used by the Knowledge Graph page to ground the chat in
  // the active project's structure. seedLabel shows the user a small
  // "grounded in X" chip so it's not magic; seedAccent tints that chip
  // (and the top border) with the project's color.
  seedContext?: string;
  seedLabel?: string;
  seedAccent?: string;
  // Optional toolset override passed straight to `hermes chat -t`.
  toolsets?: string;
  // When true, the Knowledge Graph chat runs Hermes with tools + `--yolo`
  // and the graphify skill so it actually QUERIES the project's graph
  // (reads graphPath, runs `graphify query/explain/path`). --yolo
  // auto-approves the read so the non-interactive stream can't deadlock
  // on a tool-approval prompt (the old "denying command" → 130 hang).
  yolo?: boolean;
}) {
  // When Hermes is installed but doesn't yet have a provider API key set,
  // the chat panel becomes a "run hermes setup in your terminal" card.
  // We deliberately don't try to mirror the full setup flow in the
  // browser — it's already a great terminal wizard. We just guide the
  // user there. Once they save a key, status refetches and the panel
  // flips to the live chat.
  if (status.needsSetup) {
    return (
      <RunInTerminalCard
        title="One more step — run hermes setup."
        body={
          <>
            Hermes is installed and configured to use{" "}
            <span style={{ color: CREAM }}>{status.defaultModel}</span> needs a provider connection. Run the setup wizard to choose how Hermes accesses models and tools.
          </>
        }
        command="hermes setup"
        hint="Once you've completed it, refresh this page — the chat will appear here."
      />
    );
  }
  return (
    <HermesChatActive
      status={status}
      seedContext={seedContext}
      seedLabel={seedLabel}
      seedAccent={seedAccent}
      toolsets={toolsets}
      yolo={yolo}
    />
  );
}

function HermesChatActive({
  status,
  seedContext,
  seedLabel,
  seedAccent,
  toolsets,
  yolo,
}: {
  status: HermesStatus;
  seedContext?: string;
  seedLabel?: string;
  seedAccent?: string;
  toolsets?: string;
  yolo?: boolean;
}) {
  const demo = useDemoMode();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Stop + queue controls. sendingRef mirrors `sending` for the queue gate
  // (the drain timeout would otherwise close over a stale state value);
  // abortRef cancels the SSE fetch — the server kills the hermes child on
  // request close, so Stop genuinely stops token spend, not just the UI.
  const sendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const queuedRef = useRef<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [intelOpen, setIntelOpen] = useState(false);
  // deep-link: /agents/hermes?intel=1 opens straight into the Intelligence view (demo affordance)
  useEffect(() => { try { if (new URLSearchParams(window.location.search).get("intel") === "1") setIntelOpen(true); } catch { /* ignore */ } }, []);
  // Live activity for the Intelligence portal, parsed from Hermes' own stderr
  // (the `info` SSE events) so the orb/dock reflect what the REAL agent does.
  const [intelEvents, setIntelEvents] = useState<ActivityEvent[]>([]);
  const voiceHermesSession = useRef<string>("");  // Hermes's real session id, captured from turn 1 → resumed for native continuity
  const [chatPhase, setChatPhase] = useState<"thinking" | "responding">("thinking");
  // Live activity feed — the running "what Hermes is doing right now" ticker
  // (Browsing…, Reading…, Writing…), built from the agent's real stderr
  // status lines. Same experience the Telegram bridge gives.
  const [activity, setActivity] = useState<string[]>([]);
  // Image attachments — uploaded to ~/.hermes/image_cache/, referenced by
  // absolute path in the outgoing prompt so Hermes' vision-capable model
  // (and its file-read tool) can pick them up.
  type Attachment = { path: string; name: string; preview: string };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  // Why the last image didn't attach (the server's 413/415 message), shown above the composer.
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Active session id — null when on the "new chat" tab. When set, subsequent
  // sends pass --resume so Hermes loads the prior turns as context.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Mirror the session id in a ref so the request builder and the queued-send
  // path (fired from a stale closure right after finishTurn) always read the
  // freshest value — not the null captured when the turn began. This is what
  // lets a fresh chat actually remember itself across turns.
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  const [loadingSession, setLoadingSession] = useState(false);
  // Per-conversation model override (null = Hermes' configured default) + a
  // live context-window estimate. The composer surfaces both.
  const modelsQ = useHermesModels();
  const [pickedModel, setPickedModel] = useState<ChatModelPick | null>(null);
  const activeModel: ChatModelPick | null =
    pickedModel ??
    (modelsQ.data?.default
      ? {
          provider: modelsQ.data.default.provider,
          name: modelsQ.data.default.name,
          context: modelsQ.data.default.context,
        }
      : null);
  const ctxUsed = estChatTokens(messages, input);
  const ctxLimit = modelCtxLimit(activeModel);
  // "Summarize & start fresh" carries a distilled brief into the next session.
  const [carryover, setCarryover] = useState<string | null>(null);

  // Run a deterministic Hermes sub-command (no model call) and show its real,
  // sanitized output as a monospace card in the thread.
  async function runCommand(cmd: string, label: string) {
    if (sending) return;
    // `update` mutates the install — confirm before running it.
    if (
      cmd === "update" &&
      !window.confirm(
        "Update Hermes now? This pulls the latest version and reinstalls dependencies — it can take a minute.",
      )
    ) {
      return;
    }
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: `▸ ${label}`, timestamp: Date.now() },
    ]);
    try {
      const token =
        (await fetch("/__token").then((r) => r.json()).catch(() => null))?.token ?? "";
      const r = await fetch("/__hermes_cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-claude-os-token": token },
        body: JSON.stringify({ cmd }),
      });
      const j = await r.json().catch(() => ({}));
      const ok = j?.ok === true;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "hermes",
          content: ok
            ? String(j.output ?? "(no output)")
            : `⚠ ${j?.error || `status ${r.status}`}`,
          timestamp: Date.now(),
          pre: ok,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "hermes",
          content: `⚠ ${e?.message ?? "command failed"}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  // The honest "compact": ask the current model for a tight context brief, then
  // open a fresh session seeded with it so the window is actually reclaimed.
  async function summarizeAndReset() {
    if (sending || messages.length === 0) return;
    setSending(true);
    setChatPhase("thinking");
    const summary = await askHermes(
      "Summarize our entire conversation so far into a tight but complete context brief — key facts, decisions, files/paths touched, and open threads — so a fresh session can continue seamlessly. Output ONLY the brief.",
    ).catch(() => "");
    setSending(false);
    if (!summary || summary === "Done.") return;
    startNewChat();
    setCarryover(summary);
    setMessages([
      {
        id: crypto.randomUUID(),
        role: "hermes",
        content: `**Carried over from your last session** — your next message continues with this context on a fresh, near-empty window.\n\n${summary}`,
        timestamp: Date.now(),
      },
    ]);
  }

  // Slash palette — typing "/" surfaces the REAL, working actions (deterministic
  // Hermes sub-commands + chat actions). These actually run, unlike Hermes'
  // interactive slash commands, which can't execute through `hermes chat -q`.
  const SLASH: Array<{ name: string; desc: string; run: () => void }> = [
    { name: "compact", desc: "summarize → continue on a fresh window", run: () => void summarizeAndReset() },
    { name: "insights", desc: "real usage analytics · 30d", run: () => runCommand("insights", "Insights") },
    { name: "status", desc: "providers, model & health", run: () => runCommand("status", "Status") },
    { name: "doctor", desc: "diagnose your setup", run: () => runCommand("doctor", "Doctor") },
    { name: "version", desc: "build + version info", run: () => runCommand("version", "Version") },
    { name: "update", desc: "update Hermes on your machine", run: () => runCommand("update", "Update Hermes") },
    { name: "new", desc: "start a new chat", run: () => startNewChat() },
  ];
  const slashOpen = /^\/[a-z]*$/i.test(input);
  const slashQ = slashOpen ? input.slice(1).toLowerCase() : "";
  const slashMatches = slashOpen ? SLASH.filter((s) => s.name.startsWith(slashQ)) : [];
  function runSlash(s: { run: () => void }) {
    setInput("");
    s.run();
  }

  // Auto-grow textarea up to ~8 lines so longer drafts stay visible
  // instead of scrolling out of sight.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const next = Math.min(ta.scrollHeight, 192);
    ta.style.height = `${next}px`;
  }, [input]);

  // Listen for "prefill" events — the Knowledge Graph's "Ask Hermes about
  // this" starter questions dispatch one of these to drop a question into
  // the box and focus it (the operator can edit before sending).
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const q = (e as CustomEvent).detail;
      if (typeof q !== "string") return;
      setInput(q);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("hermes-chat-prefill", onPrefill);
    return () => window.removeEventListener("hermes-chat-prefill", onPrefill);
  }, []);

  async function uploadImage(file: File): Promise<Attachment | null> {
    if (!file.type.startsWith("image/")) return null;
    setUploading(true);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      const res = await fetch("/__hermes_image_upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "X-Claude-OS-Token": t.token,
        },
        body: file,
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(e?.error ?? `upload failed (${res.status})`);
      }
      const j = (await res.json()) as { path: string };
      const preview = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ""));
        r.readAsDataURL(file);
      });
      return { path: j.path, name: file.name, preview };
    } catch (e) {
      setUploadError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const all = Array.from(files);
    const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
    const arr = all.filter((f) => IMAGE.test(f.type));
    setUploadError(
      all.length > arr.length
        ? `${all.filter((f) => !IMAGE.test(f.type)).map((f) => f.name).join(", ")}: only PNG, JPEG, WebP or GIF images can be attached here.`
        : null,
    );
    if (arr.length === 0) return;
    const uploaded = await Promise.all(arr.map(uploadImage));
    setAttachments((prev) => [...prev, ...(uploaded.filter(Boolean) as Attachment[])]);
  }
  // Sidebar (session history) is collapsed by default to a narrow icon-rail
  // so the chat itself gets all the breathing room. Click the rail header
  // to expand it back into a full thread list.
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  // User-resizable height. Drag the bottom edge to make the chat taller
  // (up to ~80vh) or shorter (down to a 200px sliver). Persisted in
  // localStorage so the size sticks across reloads.
  const [chatHeight, setChatHeight] = useState<number>(() => {
    if (typeof window === "undefined") return 480;
    const v = Number(window.localStorage.getItem("claude-os.hermes.chat-height") || "");
    return Number.isFinite(v) && v >= 200 && v <= 1600 ? v : 480;
  });
  // Refs for the drag handler — we read the start height + start Y at
  // pointerdown so the drag math doesn't fight React state batching.
  const resizeStateRef = useRef<{ startY: number; startH: number } | null>(null);
  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.target as HTMLDivElement).setPointerCapture?.(e.pointerId);
    resizeStateRef.current = { startY: e.clientY, startH: chatHeight };
    const onMove = (ev: PointerEvent) => {
      const s = resizeStateRef.current;
      if (!s) return;
      const next = Math.max(200, Math.min(window.innerHeight * 0.85, s.startH + (ev.clientY - s.startY)));
      setChatHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      resizeStateRef.current = null;
      try {
        window.localStorage.setItem(
          "claude-os.hermes.chat-height",
          String(Math.round(chatHeight)),
        );
      } catch {
        /* localStorage may be disabled */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  // Persist the final height when chatHeight settles (covers the case
  // where the user drops outside the window). Debounced via effect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = setTimeout(() => {
      try {
        window.localStorage.setItem(
          "claude-os.hermes.chat-height",
          String(Math.round(chatHeight)),
        );
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [chatHeight]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;
  const queryClient = useQueryClient();

  async function loadSession(sessionId: string) {
    if (sending || loadingSession) return;
    setLoadingSession(true);
    setCarryover(null); // don't let a pending compaction summary bleed into a loaded thread
    try {
      // Demo mode: synthesize a short canned conversation from the session's
      // firstUserMessage so screen-recordings and walkthrough demos can show
      // a click-loads-the-thread flow without a real ~/.hermes/ backend.
      if (demo) {
        const ds = DEMO_SESSIONS.find((s) => s.id === sessionId);
        if (ds) {
          setActiveSessionId(sessionId);
          setMessages([
            {
              id: `${sessionId}-0`,
              role: "user" as const,
              content: ds.firstUserMessage,
              timestamp: new Date(ds.startedAt).getTime(),
            },
            {
              id: `${sessionId}-1`,
              role: "hermes" as const,
              content: `On it. Pulling context from prior sessions and your SOUL.md preferences — give me a moment to scope this properly before I start drafting.`,
              timestamp: new Date(ds.startedAt).getTime() + 4_000,
            },
            {
              id: `${sessionId}-2`,
              role: "user" as const,
              content: `sounds good, take your time`,
              timestamp: new Date(ds.startedAt).getTime() + 30_000,
            },
            {
              id: `${sessionId}-3`,
              role: "hermes" as const,
              content: `Here's what I've put together. I leaned on the labyrinth persona for the structural pass and kept the tone tight per your usual preference. Want me to push this further or move on?`,
              timestamp: new Date(ds.startedAt).getTime() + 90_000,
            },
          ]);
        }
        return;
      }
      const res = await fetch(`/__hermes_session?id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as {
        sessionId: string;
        model?: string | null;
        messages: Array<{ role: string; content: string; ts: string | null }>;
      };
      setActiveSessionId(j.sessionId);
      const loadedVia =
        typeof j.model === "string" ? mixtureVia(j.model) : undefined;
      setMessages(
        j.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m, i) => ({
            id: `${j.sessionId}-${i}`,
            role: m.role === "assistant" ? ("hermes" as const) : ("user" as const),
            content: m.content,
            timestamp: m.ts ? new Date(m.ts).getTime() : Date.now(),
            ...(m.role === "assistant" && loadedVia ? { via: loadedVia } : {}),
          })),
      );
      // Restore the session's model into the composer chip so the next
      // message routes the SAME way. Without this, opening a Ministry
      // thread reset the pick to the default model — which then tried to
      // roleplay/orchestrate the ensemble itself instead of Hermes running
      // the real MoA preset.
      const sessModel = typeof j.model === "string" ? j.model : "";
      if (sessModel) {
        const mix = modelsQ.data?.mixtures?.find((m) => m.name === sessModel);
        if (mix) {
          setPickedModel({
            provider: "moa",
            name: mix.name,
            mixture: true,
            references: mix.references,
          });
        } else if (sessModel.includes("/")) {
          setPickedModel({ provider: "openrouter", name: sessModel });
        }
        // Bare ids (gpt-5.5 …) keep the current default — their provider
        // is ambiguous (codex sub vs direct), so we don't guess.
      }
    } catch {
      /* fail silently — sidebar will still show the click did something */
    } finally {
      setLoadingSession(false);
    }
  }

  function startNewChat() {
    if (sending) return;
    setActiveSessionId(null);
    setMessages([]);
    setInput("");
    setCarryover(null);
  }

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages]);

  // keyword-match a Hermes stderr line → light the matching Intelligence node
  function fireIntel(data: string) {
    const low = data.toLowerCase();
    const MAP: [string, AppKey][] = [
      ["pull request", "github"], ["github", "github"], ["repo", "github"], ["commit", "github"],
      ["youtube", "youtube"], ["reddit", "reddit"], ["linkedin", "linkedin"], ["x.com", "x"], ["twitter", "x"], ["clay", "clay"],
      ["notion", "notion"], ["obsidian", "obsidian"], ["granola", "granola"], ["calendar", "calendar"],
      ["gmail", "email"], ["email", "email"], ["telegram", "telegram"], ["slack", "slack"],
      ["supabase", "supabase"], ["drive", "drive"],
      ["pinecone", "memory"], ["recall", "memory"], ["remember", "memory"], ["memory", "memory"],
      ["claude", "claude"], ["anthropic", "claude"], ["opus", "claude"], ["sonnet", "claude"], ["gemini", "gemini"], ["codex", "codex"], ["gpt-", "codex"], ["sub-agent", "agents"], ["subagent", "agents"], ["spawn", "agents"],
      ["draft", "writing"], ["writing", "writing"], ["compose", "writing"], ["elevenlabs", "elevenlabs"], ["notebooklm", "notebooklm"], ["higgsfield", "higgsfield"],
      ["n8n", "n8n"], ["zapier", "zapier"], ["mcp", "mcp"], ["cron", "cron"], ["schedul", "cron"], ["skill", "skills"],
      ["web search", "web"], ["browse", "web"], ["fetch", "web"], ["http", "web"], ["search", "web"],
      ["bash", "code"], ["editing", "code"], ["edit file", "code"], ["reading file", "code"], ["run command", "code"],
    ];
    const detail = data.trim().replace(/\s+/g, " ").slice(0, 42);
    const seen = new Set<AppKey>();
    for (const [kw, app] of MAP) {
      if (seen.has(app) || !low.includes(kw)) continue;  // light EVERY distinct capability the text mentions
      seen.add(app);
      const id = app + "_" + crypto.randomUUID();
      setIntelEvents((prev) => [...prev.slice(-40), { id, app, status: "running", detail }]);
      window.setTimeout(() => setIntelEvents((prev) => [...prev.slice(-40), { id, app, status: "done", result: "done" }]), 1800);
    }
  }

  // Voice bridge: run a REAL headless Hermes turn for a voice-triggered request.
  // Its live stderr lights the Intelligence nodes for real; returns the text for the voice to speak.
  async function askHermes(request: string, opts?: { sessionId?: string; context?: string; save?: boolean; yolo?: boolean; voice?: boolean }): Promise<string> {
    let token: string | null = null;
    try { const t = await fetch("/__token"); if (t.ok) token = (await t.json()).token ?? null; } catch {}
    // voice resumes Hermes's OWN session (captured from turn 1) → native full-conversation memory, not a 10-turn snippet
    const sid = opts?.voice ? (voiceHermesSession.current || undefined) : (opts?.sessionId ?? activeSessionId);
    const useYolo = opts?.yolo ?? yolo;                      // voice auto-approves so Hermes can actually act
    const prompt = request;
    fireIntel("running on claude sonnet");                   // the brain's model lights up the moment a turn starts
    let response: Response;
    try {
      response = await fetch("/__hermes_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) },
        body: JSON.stringify({ prompt, ...(sid ? { sessionId: sid } : {}), ...(toolsets !== undefined ? { toolsets } : {}), ...(useYolo ? { yolo: true } : {}), ...(pickedModel ? { model: pickedModel.name, provider: pickedModel.provider } : {}) }),
      });
    } catch { return "I couldn't reach the agent just now."; }
    if (!response.ok || !response.body) return "The agent endpoint returned an error.";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", accumulated = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
      for (const evt of events) {
        let eventName = "chunk"; const dataLines: string[] = [];
        for (const line of evt.split("\n")) { if (line.startsWith("event: ")) eventName = line.slice(7).trim(); else if (line.startsWith("data: ")) dataLines.push(line.slice(6)); }
        const data = dataLines.join("\n");
        if (eventName === "chunk" && data.length > 0) accumulated += data + "\n";
        else if (eventName === "info" && data) { fireIntel(data); if (opts?.voice) { const mm = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/); if (mm && mm[1]) voiceHermesSession.current = mm[1]; } }
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    if (accumulated) fireIntel(accumulated);                 // light any tools/sources Hermes named in its reply
    return cleanHermesReply(accumulated).trim() || "Done.";
  }

  // Factual ensemble credit for a Mixture-of-Agents reply, straight from the
  // preset in config.yaml: "ministry · gpt-5.5 + glm-5.2 + … → claude-fable-5".
  function mixtureVia(name: string): string | undefined {
    const mix = modelsQ.data?.mixtures?.find((m) => m.name === name);
    // Fallback when the mixture catalog hasn't loaded yet — still attribute
    // the ensemble (the whole point of MoA is that it's NOT one model), just
    // without the per-expert breakdown. Never silently omit the credit.
    if (!mix) return `${name} · Mixture of Agents`;
    const refs = (mix.referenceModels ?? []).map(shortModelName).join(" + ");
    const agg = mix.aggregator ? shortModelName(mix.aggregator) : "aggregator";
    return `${mix.name} · ${refs || `${mix.references} experts`} → ${agg}`;
  }

  // Turn teardown shared by every exit path: clears sending state, then
  // auto-fires the queued message (single slot — latest wins) if one waits.
  function finishTurn() {
    setSending(false);
    sendingRef.current = false;
    abortRef.current = null;
    void queryClient.invalidateQueries({ queryKey: ["hermes-sessions"] });
    const q = queuedRef.current;
    queuedRef.current = null;
    setQueued(null);
    if (q) window.setTimeout(() => void handleSend(q), 80);
  }

  // Stop the running turn: aborts the SSE fetch; the server's req-close
  // handler SIGTERMs the hermes child, so the model stops burning tokens.
  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleSend(forcedText?: string) {
    const text = (forcedText ?? input).trim();
    // A turn is running → QUEUE the message instead of dropping the
    // keystroke. One slot, latest wins — type a steer, hit Enter, and it
    // fires the instant the current turn finishes.
    if (sendingRef.current) {
      if (text) {
        queuedRef.current = text;
        setQueued(text);
        if (!forcedText) setInput("");
      }
      return;
    }
    // Allow sending with images and no text (e.g. "what's in this?")
    if (!text && attachments.length === 0) return;
    if (!forcedText) setInput("");
    setSending(true);
    sendingRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;

    // Prefix the prompt with image references so Hermes can read them
    // from disk. Vision-capable models pick the paths up via Hermes'
    // image input pipeline (`image_input_mode: auto` in config.yaml).
    const imagePrefix =
      attachments.length > 0
        ? attachments.map((a) => `[Image: ${a.path}]`).join("\n") + "\n\n"
        : "";
    // On the FIRST message of a fresh chat (no active session, nothing
    // sent yet), prepend the project seed context so Hermes answers
    // grounded in that project's real structure. Only once — subsequent
    // turns resume the session, which already carries it.
    const isFirstTurn = !activeSessionId && messages.length === 0;
    // Output contract — this chat window is where the user READS the result, not
    // a terminal. In yolo mode the agent tends to write a file and paste only a
    // truncated diff ("... omitted N lines"), leaving the user without the
    // actual deliverable and no way to expand it. Steer it to always return the
    // COMPLETE, copyable content here. Injected on the first turn (carried by
    // session memory after) and on any turn that asks for produced code/content,
    // so a mid-chat "build me X" gets it too.
    const OUTPUT_CONTRACT =
      "[How to answer in this chat window] When you produce code, HTML, a document, config, or any file's contents, include the COMPLETE final content in your reply inside a single fenced code block. Do NOT abbreviate with \"... omitted N lines\", \"N more lines\", or a partial diff — the user reads and copies the result right here, so the whole thing must be present. If you also save it to a file, print the file's absolute path as well, but the full content still has to appear in your reply.";
    const wantsArtifact =
      /\b(html|css|json|yaml|component|script|code|snippet|one[- ]?pager|landing page|readme|full (file|code|content)|whole (file|thing))\b/i.test(text);
    const contractPrefix = isFirstTurn || wantsArtifact ? `${OUTPUT_CONTRACT}\n\n---\n\n` : "";
    const seedPrefix = isFirstTurn && seedContext ? `${seedContext}\n\n---\n\n` : "";
    const carryPrefix = carryover
      ? `Context carried over from our previous session:\n\n${carryover}\n\n---\n\n`
      : "";
    const promptForServer = `${contractPrefix}${seedPrefix}${carryPrefix}${imagePrefix}${text}`.trim();
    // Visible chat shows the user's actual text + a count of attachments
    // (the absolute path is noisy for display).
    const displayText =
      attachments.length > 0
        ? `${text}${text ? "\n" : ""}📎 ${attachments.length} image${attachments.length === 1 ? "" : "s"} attached`
        : text;
    // The image paths are already baked into promptForServer above, so we
    // can clear UI state immediately.
    setAttachments([]);
    // A carried-over summary ("Summarize & start fresh") seeds exactly one
    // turn, then it's consumed.
    if (carryover) setCarryover(null);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayText,
      timestamp: Date.now(),
    };
    // Append the user message immediately. The Hermes placeholder is
    // added lazily on first chunk so the typing indicator can show in
    // its place without overlap.
    const replyId = crypto.randomUUID();
    let hermesAppended = false;
    setMessages((prev) => [...prev, userMsg]);
    setChatPhase("thinking");
    setActivity([]);

    // Fetch the per-run token that gates the chat endpoint.
    let token: string | null = null;
    try {
      const t = await fetch("/__token");
      if (t.ok) token = (await t.json()).token ?? null;
    } catch {
      /* token endpoint not exposed — request will 403 below */
    }

    let response: Response;
    try {
      response = await fetch("/__hermes_chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Claude-OS-Token": token } : {}),
        },
        // Pass the active session id when we're inside a loaded thread —
        // Hermes' --resume flag picks up the prior context. A defined
        // `toolsets` (e.g. "" for the grounded KG chat) is forwarded so
        // the endpoint runs `hermes chat -t <value>`.
        body: JSON.stringify({
          prompt: promptForServer,
          ...(activeSessionIdRef.current ? { sessionId: activeSessionIdRef.current } : {}),
          ...(toolsets !== undefined ? { toolsets } : {}),
          // Auto-approve tools whenever this chat runs in yolo mode. graph
          // mode (preload the graphify skill) is separate — it belongs only
          // to the seeded Knowledge-Graph chat, NOT the general agent chat,
          // so it's keyed off seedContext rather than riding on yolo.
          ...(yolo ? { yolo: true } : {}),
          ...(seedContext ? { graph: true } : {}),
          // Per-conversation model override (skipped when on the default).
          ...(pickedModel ? { model: pickedModel.name, provider: pickedModel.provider } : {}),
        }),
        signal: ac.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setMessages((prev) => [
          ...prev,
          { id: replyId, role: "hermes", content: "■ stopped", timestamp: Date.now() },
        ]);
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === replyId
              ? { ...m, content: `⚠ Could not reach hermes: ${err?.message ?? "unknown"}` }
              : m,
          ),
        );
      }
      finishTurn();
      return;
    }

    if (!response.ok || !response.body) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === replyId ? { ...m, content: `⚠ Chat endpoint returned ${response.status}.` } : m,
        ),
      );
      finishTurn();
      return;
    }

    // The endpoint streams SSE-formatted events:
    //   event: chunk  data: <text>
    //   event: info   data: <stderr line>   (we ignore for now)
    //   event: done   data: ok
    //   event: error  data: <message>
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const evt of events) {
        const lines = evt.split("\n");
        let eventName = "chunk";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        const data = dataLines.join("\n");
        if (eventName === "chunk" && data.length > 0) {
          accumulated += data + "\n";
          if (!hermesAppended) {
            hermesAppended = true;
            setChatPhase("responding");
            setMessages((prev) => [
              ...prev,
              {
                id: replyId,
                role: "hermes",
                content: cleanHermesReply(accumulated).trimEnd(),
                timestamp: Date.now(),
                ...(pickedModel?.mixture
                  ? { via: mixtureVia(pickedModel.name) }
                  : {}),
              },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((m) => (m.id === replyId ? { ...m, content: cleanHermesReply(accumulated).trimEnd() } : m)),
            );
          }
        } else if (eventName === "error") {
          if (!hermesAppended) {
            hermesAppended = true;
            setMessages((prev) => [
              ...prev,
              { id: replyId, role: "hermes", content: `⚠ ${data}`, timestamp: Date.now() },
            ]);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === replyId
                  ? { ...m, content: (accumulated || "") + `\n\n⚠ ${data}` }
                  : m,
              ),
            );
          }
        } else if (eventName === "info" && data) {
          fireIntel(data); // light the matching Intelligence node from the real agent's stderr
          // Capture Hermes' session id from its stderr marker so the NEXT turn
          // resumes THIS conversation (--resume). Without this, every turn in a
          // fresh chat spawned a brand-new session and the agent forgot the
          // prior turn — "save this" came back as "what's 'this'?". Update the
          // ref immediately (the queued-send path reads it before React
          // re-renders) plus the state for the "Resuming ·" header.
          const sidMatch = data.match(/session_id:\s*([A-Za-z0-9_-]{6,})/);
          if (sidMatch && sidMatch[1] && activeSessionIdRef.current !== sidMatch[1]) {
            activeSessionIdRef.current = sidMatch[1];
            setActiveSessionId(sidMatch[1]);
          }
          // Feed the live activity ticker from real status lines. Skip
          // markers/warnings; keep each row short and the list capped.
          for (const raw of data.split("\n")) {
            const line = raw.trim();
            if (!line || /session_id:|^Warning:/i.test(line) || line.length < 4) continue;
            const row = line.length > 96 ? line.slice(0, 95) + "…" : line;
            setActivity((a) => (a[a.length - 1] === row ? a : [...a.slice(-11), row]));
          }
        } else if (eventName === "done") {
          // Final state already set by the chunks; just exit.
        }
      }
    }
    } catch (err: any) {
      // Stop pressed mid-stream: the fetch abort throws here. Mark the
      // partial reply so it's obvious the turn was cut, not completed.
      if (err?.name === "AbortError") {
        if (hermesAppended) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId
                ? {
                    ...m,
                    content: cleanHermesReply(accumulated).trimEnd() + "\n\n■ stopped",
                  }
                : m,
            ),
          );
        } else {
          setMessages((prev) => [
            ...prev,
            { id: replyId, role: "hermes", content: "■ stopped", timestamp: Date.now() },
          ]);
        }
      }
    }
    // Hermes just wrote a new session (or appended to the resumed one) —
    // finishTurn refreshes the sidebar and fires any queued message.
    finishTurn();
  }

  return (
    <section className="mb-10 relative">
      <div
        className="border flex relative"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
          background: "var(--inset)",
          // User-resizable height — see handleResizeStart. Drag the
          // bottom edge to set it; persisted across reloads.
          height: chatHeight,
          width: "100%",
        }}
      >
        {/* LEFT — sessions sidebar (Telegram-style thread list).
            Collapsed to an icon-rail by default so the chat dominates. */}
        <ChatSidebar
          activeSessionId={activeSessionId}
          loadSession={loadSession}
          startNewChat={startNewChat}
          loadingSession={loadingSession}
          expanded={sidebarExpanded}
          onToggleExpanded={() => setSidebarExpanded((v) => !v)}
        />

        {/* RIGHT — active conversation. No background art — a flat card
            surface, like every other panel on the page. */}
        <div
          className="flex-1 flex flex-col min-w-0 relative bg-card"
          style={{
            borderLeft: "1px solid color-mix(in srgb, var(--foreground) 40%, transparent)",
          }}
        >
          {/* Chat header — minimal pill, no expand toggle (chat is always
              full-width now). Pixel HERMES-AGENT logo moved out of the
              header and into the empty-state, centered h+w. */}
          <div
            className="relative border-b px-5 py-3 flex items-center justify-between gap-3"
            style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
          >
            <div
              className="font-mono text-[13px] truncate"
              style={{ color: CREAM }}
            >
              {activeSessionId ? `❯ Resuming · ${activeSessionId.slice(0, 18)}` : "❯ New Chat"}
            </div>
            {/* Grounding chip — shows the chat is seeded with a project's
                graph, tinted with that project's accent color. Only on a
                fresh chat; once resumed the context carries over. */}
            <div className="flex items-center gap-2 shrink-0">
              {seedLabel && !activeSessionId && (
                <div
                  className="font-mono text-[13px] inline-flex items-center gap-1.5 px-2 py-1 border shrink-0"
                  style={{
                    color: seedAccent ?? "var(--chart-2)",
                    borderColor: `${seedAccent ?? "var(--chart-2)"}66`,
                    background: `${seedAccent ?? "var(--chart-2)"}14`,
                  }}
                  title={`This chat is grounded in the ${seedLabel} knowledge graph`}
                >
                  <Waypoints className="h-3 w-3" />
                  Chatting with {seedLabel}
                </div>
              )}
              <button
                type="button"
                // The portal's own voice needed a :8099 speech sidecar that is not in this
                // repo; Jarvis is the one voice and hands PC work to Hermes via control_pc.
                onClick={() => window.dispatchEvent(new CustomEvent("operator:voice"))}
                className="font-mono text-[13px] inline-flex items-center gap-1.5 px-2.5 py-1 border transition-colors shrink-0"
                style={{ color: CREAM, borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)", background: "color-mix(in srgb, var(--foreground) 8%, transparent)" }}
                title="Talk to Jarvis, who hands PC work to Hermes"
              >
                <Mic className="h-3 w-3" />
                Voice
              </button>
            </div>
          </div>

          {/* Scrolling message area */}
          <div
            ref={scrollerRef}
            className="relative flex-1 px-6 py-6 space-y-6"
            // Chrome's scroll-latch pauses page scrolling for ~150ms when
            // the wheel hits a nested scroller's boundary. That's the
            // "stops me, then lets me scroll" feel user reported.
            //
            // Fix: explicit wheel handler. When the inner is at the
            // top/bottom edge AND the user is scrolling further in that
            // direction, we cancel the event and scroll the window
            // directly — no latch pause, completely seamless.
            style={{
              overflowY: hasMessages || sending ? "auto" : "visible",
              // "contain" stops the browser's default scroll-chaining (which
              // is what causes the macOS Chrome ~150ms latch pause when the
              // inner scroller hits its boundary). Our wheel handler then
              // manually forwards the delta to the page — instant, no latch.
              overscrollBehaviorY: "contain",
            }}
            onWheel={forwardWheelAtBoundary}
          >
            {loadingSession && (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin" style={{ color: CREAM }} />
              </div>
            )}
            {!loadingSession && !hasMessages && <ChatEmptyState />}
            {!loadingSession &&
              messages.map((m, i) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  streaming={
                    sending &&
                    chatPhase === "responding" &&
                    m.role === "hermes" &&
                    i === messages.length - 1
                  }
                />
              ))}
            {sending && activity.length > 0 && <ActivityTicker lines={activity} />}
            {sending && chatPhase === "thinking" && <ChatTyping />}
          </div>

          {/* Input — multi-line auto-grow textarea with image attachments.
              Images: drag-drop onto the input, paste from clipboard, or
              click the paperclip. Each upload writes to ~/.hermes/image_cache
              and the absolute path is prepended to the prompt so Hermes'
              vision model + file-read tool can pick it up. */}
          <div
            className="relative border-t p-3"
            style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes("Files")) {
                e.preventDefault();
              }
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                void handleFiles(e.dataTransfer.files);
              }
            }}
          >
            {uploadError && (
              <div role="alert" className="font-mono text-[13px] mb-2" style={{ color: "var(--warn)" }}>
                {uploadError}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {attachments.map((a, i) => (
                  <div
                    key={a.path}
                    className="relative border group"
                    style={{
                      width: 56,
                      height: 56,
                      borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)",
                      background: "var(--inset)",
                    }}
                    title={a.name}
                  >
                    <img
                      src={a.preview}
                      alt={a.name}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, idx) => idx !== i))
                      }
                      className="absolute -top-1.5 -right-1.5 font-mono inline-flex items-center justify-center text-[13px] transition-colors"
                      style={{
                        width: 16,
                        height: 16,
                        background: BG,
                        color: CREAM,
                        border: "1px solid color-mix(in srgb, var(--foreground) 55%, transparent)",
                      }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {uploading && (
                  <div
                    className="border flex items-center justify-center"
                    style={{
                      width: 56,
                      height: 56,
                      borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)",
                      background: "var(--inset)",
                    }}
                  >
                    <Loader2
                      className="animate-spin"
                      style={{ width: 16, height: 16, color: CREAM }}
                    />
                  </div>
                )}
              </div>
            )}
            {/* Input row — borderless paperclip lives INSIDE the textarea
                well (left side, like Slack/Telegram); Send button is the
                same height as the textarea container, no fighting for
                visual weight. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Three equal-height pills side by side. Paperclip is its
                own square button on the LEFT (no longer floating inside
                the textarea), textarea fills the middle, Send sits on
                the RIGHT with icon + label inline. Everything stretches
                via items-stretch + self-stretch so the heights line up
                perfectly regardless of how many rows the textarea has. */}
            {/* Slash palette — appears as you type "/" with the real, working
                commands. Enter runs the top match. */}
            {slashOpen && slashMatches.length > 0 && (
              <div
                className="mb-2"
                style={{
                  background: "var(--inset)",
                  border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              >
                <div
                  className="font-mono"
                  style={{
                    fontSize: 13,
                    letterSpacing: "0.14em",
                    color: "color-mix(in srgb, var(--foreground) 45%, transparent)",
                    padding: "8px 12px 4px",
                  }}
                >
                  Commands · Enter to run
                </div>
                {slashMatches.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => runSlash(s)}
                    className="w-full text-left flex items-center justify-between px-3 py-2"
                    style={{ background: i === 0 ? "color-mix(in srgb, var(--foreground) 6%, transparent)" : "transparent" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--foreground) 6%, transparent)")}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background =
                        i === 0 ? "color-mix(in srgb, var(--foreground) 6%, transparent)" : "transparent")
                    }
                  >
                    <span className="font-mono" style={{ fontSize: 13, color: CREAM }}>
                      /{s.name}
                    </span>
                    <span
                      className="font-mono"
                      style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
                    >
                      {s.desc}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {/* Composer toolbar — pick the model for this conversation (left)
                and watch the context window fill (right). */}
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <ComposerModelSelector
                  data={modelsQ.data}
                  active={activeModel}
                  onPick={setPickedModel}
                />
                <ComposerEffortDial data={modelsQ.data} active={activeModel} />
                <ChatCommandsMenu
                  onRun={runCommand}
                  onSummarize={summarizeAndReset}
                  busy={sending}
                />
              </div>
              <ContextMeter
                used={ctxUsed}
                limit={ctxLimit}
                modelLabel={
                  activeModel
                    ? `${shortModelName(activeModel.name)} · ${fmtTokens(ctxLimit)} window`
                    : undefined
                }
              />
            </div>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="self-stretch inline-flex items-center justify-center transition-colors disabled:opacity-30 border shrink-0"
                style={{
                  width: 48,
                  background: "var(--inset)",
                  color: "color-mix(in srgb, var(--foreground) 70%, transparent)",
                  borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = CREAM;
                  e.currentTarget.style.borderColor = CREAM;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 70%, transparent)";
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 25%, transparent)";
                }}
                title="Attach image (or drag-drop / paste)"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (slashMatches.length > 0) runSlash(slashMatches[0]);
                    else void handleSend();
                  }
                }}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const files: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    if (it.type.startsWith("image/")) {
                      const f = it.getAsFile();
                      if (f) files.push(f);
                    }
                  }
                  if (files.length > 0) {
                    e.preventDefault();
                    void handleFiles(files);
                  }
                }}
                placeholder={
                  activeSessionId
                    ? "Continue this conversation… (drop or paste an image)"
                    : "Ask Hermes anything… (drop or paste an image)"
                }
                rows={3}
                className="font-mono flex-1 resize-none px-4 py-3 text-[13px] focus:outline-none"
                style={{
                  background: "var(--inset)",
                  color: CREAM,
                  border: "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
                  minHeight: 64,
                  maxHeight: 192,
                  lineHeight: "1.45",
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
                onBlur={(e) =>
                  (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 25%, transparent)")
                }
              />
              {sending ? (
                <div className="flex flex-col gap-1.5 self-stretch shrink-0">
                  <button
                    onClick={handleStop}
                    className="font-mono flex-1 px-5 text-[13px] inline-flex items-center justify-center gap-2 border transition-colors"
                    style={{
                      background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                      color: "var(--danger)",
                      borderColor: "color-mix(in srgb, var(--danger) 55%, transparent)",
                    }}
                    title="Stop this turn — the Hermes process is killed server-side too, so token spend stops"
                  >
                    ■ Stop
                  </button>
                  <button
                    onClick={() => void handleSend()}
                    disabled={!input.trim()}
                    className="font-mono flex-1 px-5 text-[13px] inline-flex items-center justify-center gap-2 border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    style={{
                      background: "transparent",
                      color: CREAM,
                      borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                    }}
                    title="Queue this message — it sends the instant the current turn finishes"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Queue
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim() && attachments.length === 0}
                  className="font-mono self-stretch px-5 text-[13px] transition-all disabled:cursor-not-allowed inline-flex items-center justify-center gap-2 border shrink-0"
                  style={
                    input.trim() || attachments.length > 0
                      ? { background: CREAM, color: BG, borderColor: CREAM }
                      : {
                          // Disabled state: don't fade the high-contrast pair via
                          // opacity (that washes both colours toward the page
                          // background and can drop contrast below 2:1). Use a
                          // muted-but-legible cream-on-transparent pair instead.
                          background: "transparent",
                          color: "color-mix(in srgb, var(--foreground) 65%, transparent)",
                          borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)",
                        }
                  }
                >
                  <Send className="h-4 w-4" />
                  Send
                </button>
              )}
            </div>
            {queued && (
              <div
                className="font-mono mt-2 text-[13px] inline-flex items-center gap-2 px-2.5 py-1.5 border"
                style={{
                  color: "color-mix(in srgb, var(--foreground) 75%, transparent)",
                  borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)",
                  background: "color-mix(in srgb, var(--foreground) 5%, transparent)",
                }}
              >
                <span style={{ color: "var(--brand)" }}>⏳</span>
                queued · {queued.slice(0, 70)}
                {queued.length > 70 ? "…" : ""}
                <button
                  onClick={() => {
                    queuedRef.current = null;
                    setQueued(null);
                  }}
                  style={{ color: "var(--danger)" }}
                  title="Cancel the queued message"
                >
                  ✕
                </button>
              </div>
            )}
            {!status.configured && (
              <div
                className="font-mono mt-2 text-[13px] flex items-center gap-1.5"
                style={{ color: "var(--warn)" }}
              >
                <AlertTriangle className="h-3 w-3" />
                No config.yaml — run `hermes setup` first.
              </div>
            )}
          </div>
        </div>
        {intelOpen &&
          createPortal(
            // Portal into document.body + fixed positioning so no ancestor's
            // transform/overflow can clip it or push it off-screen (the "portal
            // cut off / blocking the screen" report). z-[9999] sits above all.
            <div className="fixed inset-0 z-[9999]">
              <IntelligencePortal
                state={sending ? chatPhase : "idle"}
                events={intelEvents}
                demo={demo && intelEvents.length === 0}
                onVoiceRequest={askHermes}
                onClose={() => setIntelOpen(false)}
              />
            </div>,
            document.body,
          )}
      </div>
      {/* Drag-to-resize handle. 8px tall strip directly below the chat
          panel — grab anywhere on it to make the chat taller or shorter.
          Persists to localStorage. Cursor goes ns-resize on hover so the
          affordance is obvious. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat"
        onPointerDown={handleResizeStart}
        className="group flex items-center justify-center cursor-ns-resize select-none"
        style={{
          height: 12,
          // Negative margin pulls the handle's hit area visually into the
          // chat's bottom border so there's no gap-line on the page.
          marginTop: -1,
          touchAction: "none",
        }}
      >
        <div
          className="transition-colors"
          style={{
            width: 44,
            height: 3,
            background: "color-mix(in srgb, var(--foreground) 30%, transparent)",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = CREAM)}
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "color-mix(in srgb, var(--foreground) 30%, transparent)")
          }
        />
      </div>
    </section>
  );
}

function ChatSidebar({
  activeSessionId,
  loadSession,
  startNewChat,
  loadingSession,
  expanded,
  onToggleExpanded,
}: {
  activeSessionId: string | null;
  loadSession: (id: string) => void;
  startNewChat: () => void;
  loadingSession: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { data } = useHermesSessions();
  const sessions = data?.sessions ?? [];

  // Two rendering modes:
  //   collapsed → 56px icon-rail with a "+" New Chat button at the top
  //               and one platform-badge per session beneath. Click the
  //               header chevron to expand.
  //   expanded  → full 240/288px thread list with the original layout.
  if (!expanded) {
    return (
      <div className="w-14 shrink-0 flex flex-col">
        {/* Rail header — chevron expands, "+" starts a new chat */}
        <div
          className="border-b flex flex-col items-center gap-2 py-3"
          style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
        >
          <button
            type="button"
            onClick={onToggleExpanded}
            className="font-mono w-8 h-7 text-[13px] inline-flex items-center justify-center transition-colors"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = CREAM)}
            onMouseLeave={(e) => (e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 60%, transparent)")}
            title="Expand history"
          >
            ❯❯
          </button>
          <button
            type="button"
            onClick={startNewChat}
            disabled={loadingSession}
            className="font-mono w-9 h-9 text-[16px] border inline-flex items-center justify-center transition-colors disabled:opacity-30"
            style={{
              background: !activeSessionId ? CREAM : "transparent",
              color: !activeSessionId ? BG : CREAM,
              borderColor: CREAM,
            }}
            title="New chat"
          >
            +
          </button>
        </div>
        {/* Compact session list — each session gets a Pantheon avatar.
            Preferred lookup: the session's profile name (when Hermes saves
            it); falls back to a stable hash of the session id so legacy
            sessions get a consistent face too. A small platform glyph
            sits in the bottom-right corner so you can still tell CLI vs
            Telegram at a glance. */}
        <div
          className="flex-1 overflow-y-auto flex flex-col items-center py-2 gap-1.5"
          onWheel={forwardWheelAtBoundary}
        >
          {sessions.slice(0, 30).map((s, sidx) => {
            const isActive = activeSessionId === s.id;
            const profileSrc = avatarForProfile(s.profile);
            const avatarSrc = profileSrc ?? avatarForSessionId(s.id);
            return (
              <button
                key={`${s.id}-${sidx}`}
                type="button"
                onClick={() => loadSession(s.id)}
                disabled={loadingSession}
                title={s.firstUserMessage || `Session ${s.id.slice(0, 8)}`}
                className="relative w-10 h-10 overflow-hidden transition-all disabled:opacity-50"
                style={{
                  border: isActive
                    ? `2px solid ${CREAM}`
                    : "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
                  outline: "none",
                }}
                onMouseEnter={(e) => {
                  if (!isActive)
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 55%, transparent)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive)
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 25%, transparent)";
                }}
              >
                <img
                  src={avatarSrc}
                  alt=""
                  className="w-full h-full object-cover"
                  style={{
                    filter: isActive ? "none" : "saturate(0.7) brightness(0.85)",
                  }}
                />
                {/* Platform glyph — tiny circle in the corner. Renders
                    only for non-CLI platforms (CLI is implied default;
                    cluttering every avatar with a generic ❯ was the
                    "looks awful" complaint). */}
                {s.platform && s.platform.toLowerCase() !== "cli" && (
                  <span
                    className="absolute bottom-0.5 right-0.5 inline-flex items-center justify-center rounded-full overflow-hidden"
                    style={{
                      width: 14,
                      height: 14,
                      background: BG,
                      border: "1px solid color-mix(in srgb, var(--foreground) 50%, transparent)",
                    }}
                    title={s.platform}
                  >
                    <PlatformBadgeIcon platform={s.platform} size={9} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-60 lg:w-72 shrink-0 flex flex-col">
      {/* Sidebar header — collapse chevron + New Chat button */}
      <div
        className="px-3 py-3 border-b flex items-center gap-2"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          className="font-mono h-9 px-2 text-[13px] inline-flex items-center justify-center transition-colors shrink-0"
          style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = CREAM)}
          onMouseLeave={(e) => (e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 60%, transparent)")}
          title="Collapse history"
        >
          ❮❮
        </button>
        <button
          type="button"
          onClick={startNewChat}
          disabled={loadingSession}
          className="font-mono flex-1 px-3 py-2 text-[13px] border transition-colors disabled:opacity-30 inline-flex items-center justify-center gap-2"
          style={{
            background: !activeSessionId ? CREAM : "transparent",
            color: !activeSessionId ? BG : CREAM,
            borderColor: CREAM,
          }}
        >
          + New Chat
        </button>
      </div>
      {/* Session list */}
      <div className="flex-1 overflow-y-auto" onWheel={forwardWheelAtBoundary}>
        {sessions.length === 0 && (
          <div
            className="font-mono text-[13px] p-4 text-center"
            style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
          >
            No threads yet
          </div>
        )}
        {sessions.map((s) => (
          <SessionPill
            key={s.id}
            session={s}
            active={activeSessionId === s.id}
            disabled={loadingSession}
            onSelect={() => loadSession(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SessionPill({
  session,
  active,
  disabled,
  onSelect,
}: {
  session: HermesSession;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const when = session.lastUpdated || session.startedAt;
  const ago = when
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(when).getTime()) / 60_000);
        if (mins < 1) return "now";
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        return `${Math.floor(hrs / 24)}d`;
      })()
    : "—";
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="w-full text-left px-3 py-2.5 transition-colors border-b disabled:opacity-50"
      style={{
        background: active ? "color-mix(in srgb, var(--foreground) 10%, transparent)" : "transparent",
        borderColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "color-mix(in srgb, var(--foreground) 5%, transparent)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <PlatformBadge platform={session.platform} />
        <div
          className="font-mono text-[13px] ml-auto"
          style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
        >
          {ago}
        </div>
      </div>
      <div
        className="text-[13px] leading-snug line-clamp-2"
        style={{ color: CREAM }}
      >
        {session.firstUserMessage || `Session ${session.id.slice(0, 8)}`}
      </div>
      <div
        className="font-mono text-[13px] mt-1 truncate"
        style={{ color: "color-mix(in srgb, var(--foreground) 45%, transparent)" }}
      >
        {session.messageCount} msg · {session.model ?? "—"}
      </div>
    </button>
  );
}

function ChatEmptyState() {
  // The Hermes brand mark centers the conversation surface as its identity.
  // No min-height — the empty state must respect the parent's available
  // space. A min-height larger than (chatHeight - header - input) shoves
  // the input bar off the bottom of the panel and into the section below.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <BrandMark agent="hermes" size={24} />
      <div className="text-sm text-muted-foreground">Start a new conversation</div>
    </div>
  );
}

// Small hover-revealed "copy reply" affordance under each Hermes message.
function CopyMsgButton({ text }: { text: string }) {
  const { copied: done, failed, copy } = useCopyState(1400);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      className="font-mono inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 text-[13px] transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100"
      style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
      title="Copy this reply"
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {done ? "Copied" : failed ? "Couldn't copy" : "Copy"}
    </button>
  );
}

// While a reply is still streaming, we DON'T render the full formatted markdown.
// Half-parsed diffs/tables and the model's raw think-through read like a broken,
// "dodgy" answer, and partial parses leave stray trailing dots. Instead we show a
// calm "writing" state with a dim live tail (just the last stretch of what's
// arriving) so it's clearly alive and in-progress — then ChatBubble swaps this
// for the fully-formatted ChatMarkdown the moment the turn actually finishes.
function StreamingReply({ text }: { text: string }) {
  const clean = cleanHermesReply(text)
    .replace(/```+/g, "") // don't flash code-fence markers
    .replace(/^\s*[+-].*$/gm, "") // hide raw +/- diff lines mid-stream
    .replace(/\[thinking\]/gi, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  // Only a peek — the last ~320 chars — never the whole growing wall of raw text.
  const tail = clean.length > 320 ? "…" + clean.slice(-320) : clean;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--brand)" }} />
        <span
          className="font-mono"
          style={{
            fontSize: 13,
            letterSpacing: "0.2em",
            color: "color-mix(in srgb, var(--brand) 85%, transparent)",
          }}
        >
          Hermes is writing
        </span>
      </div>
      {tail && (
        <div
          style={{
            fontFamily: MD_SANS,
            fontSize: 13,
            lineHeight: 1.6,
            color: "color-mix(in srgb, var(--foreground) 45%, transparent)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {tail}
        </div>
      )}
    </div>
  );
}

// The live activity feed — a Telegram-style running log of what Hermes is
// actually doing this turn (Browsing…, Reading…, Writing…), fed from the
// agent's real stderr status lines. Newest at the bottom with a spinner;
// older rows dim out. Renders only while a turn is in flight.
function ActivityTicker({ lines }: { lines: string[] }) {
  const shown = lines.slice(-6);
  return (
    <div
      className="rounded-xl px-3.5 py-3 max-w-[520px]"
      style={{ background: "color-mix(in srgb, var(--background) 55%, transparent)", border: "1px solid color-mix(in srgb, var(--foreground) 14%, transparent)" }}
    >
      <div
        className="font-mono mb-2"
        style={{ fontSize: 13, letterSpacing: "0.22em", color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
      >
        Live activity
      </div>
      <div className="flex flex-col gap-1.5">
        {shown.map((l, i) => {
          const last = i === shown.length - 1;
          return (
            <div key={`${i}-${l.slice(0, 24)}`} className="flex items-start gap-2 min-w-0">
              {last ? (
                <Loader2 className="h-3 w-3 animate-spin shrink-0 mt-[1px]" style={{ color: "var(--brand)" }} />
              ) : (
                <span className="h-1 w-1 rounded-full shrink-0 mt-[6px]" style={{ background: "color-mix(in srgb, var(--foreground) 35%, transparent)" }} />
              )}
              <span
                className="truncate"
                style={{
                  fontFamily: MD_SANS,
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: last
                    ? "color-mix(in srgb, var(--foreground) 85%, transparent)"
                    : `color-mix(in srgb, var(--foreground) ${Math.round((0.3 + i * 0.08) * 100)}%, transparent)`,
                }}
              >
                {l}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChatBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  if (isUser) {
    // Cream card, softly rounded with a squared corner anchoring toward the
    // avatar. Shadow instead of a hard border so it floats over the art.
    //
    // Rendered by the SAME ChatMarkdown as a Hermes reply, on its light
    // palette — a pasted skill file or config gets real fenced code blocks,
    // tables and lists here, not a wall of literal backticks. `pre-wrap` is
    // gone on purpose: the renderer owns whitespace now (code keeps its
    // indentation, prose reflows).
    return (
      <div className="flex justify-end items-start gap-3">
        <div
          className="max-w-[78%] px-5 py-3.5 text-[13.5px] leading-relaxed font-mono"
          style={{
            background: "linear-gradient(180deg, var(--foreground) 0%, var(--foreground) 100%)",
            color: BG,
            borderRadius: "16px 4px 16px 16px",
            boxShadow: "0 10px 30px color-mix(in srgb, black 40%, transparent)",
            wordBreak: "break-word",
            minWidth: 0,
          }}
        >
          <ChatMarkdown text={message.content} surface="light" />
        </div>
        <UserAvatar />
      </div>
    );
  }
  // Hermes (assistant) message. Readability-tuned:
  //  • Near-opaque card tone (blur) so it reads as a distinct bubble without
  //    a hard box.
  //  • Rounded 18px with a squared top-left corner anchoring to the avatar,
  //    hairline border + deep shadow for lift.
  //  • Inter throughout — sans is easier to read across dense, multi-
  //    paragraph answers than a display serif.
  //  • Generous padding + line-height so long structured answers breathe.
  return (
    <div className="flex justify-start items-start gap-3 group">
      <HermesAvatar />
      <div className="flex flex-col items-start max-w-[88%]">
        <div
          className="px-6 py-5"
          style={{
            background: "color-mix(in srgb, var(--card) 97%, transparent)",
            color: "var(--foreground)",
            border: "1px solid color-mix(in srgb, var(--foreground) 16%, transparent)",
            borderTop: "1px solid color-mix(in srgb, var(--foreground) 28%, transparent)",
            borderRadius: "4px 18px 18px 18px",
            boxShadow: "0 14px 44px color-mix(in srgb, black 50%, transparent)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          {message.pre ? (
            <pre
              className="font-mono"
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--foreground)",
                whiteSpace: "pre",
                overflowX: "auto",
                margin: 0,
                maxWidth: "100%",
              }}
            >
              {message.content}
            </pre>
          ) : streaming ? (
            <StreamingReply text={message.content} />
          ) : message.content ? (
            <ChatMarkdown text={message.content} />
          ) : (
            <span style={{ opacity: 0.5 }}>…</span>
          )}
          {message.via && (
            <div
              className="font-mono"
              style={{
                marginTop: 12,
                paddingTop: 8,
                borderTop: "1px solid color-mix(in srgb, var(--foreground) 12%, transparent)",
                fontSize: 13,
                letterSpacing: "0.16em",
                color: "color-mix(in srgb, var(--brand) 80%, transparent)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <span>⚝</span>
              {message.via}
            </div>
          )}
        </div>
        {message.content ? <CopyMsgButton text={message.content} /> : null}
      </div>
    </div>
  );
}

// Lightweight markdown renderer for chat — just enough to make Hermes'
// answers readable: paragraphs, bullet/numbered lists, `inline code`,
// **bold**, and ## headings. Deliberately tiny (no external dep) and
// styled for the cream-on-teal chat. Body uses a clean sans for legibility.
// ── Chat markdown renderer ──────────────────────────────────────────────────
// Renders Hermes replies in the shared design language: Inter headings and
// body, JetBrains Mono for fenced code, real fenced-code blocks, green/red
// diff cards (unfenced tool-output diffs are auto-detected), tables, quotes
// and links. All parsing is line-based, no dangerouslySetInnerHTML.
const MD_SANS = "var(--font-sans)";
const MD_MONO = "var(--font-mono)";

// ── Surface palettes ───────────────────────────────────────────────────────
// The SAME renderer draws both chat bubbles, so every colour it uses has to
// come from a palette rather than a literal. "dark" is the teal assistant
// card; "light" is the cream user card. Every foreground below was checked
// against its real background and clears WCAG AA (4.5:1) — see the ratios in
// the comments. Change one and re-check it.
export type MdSurface = "dark" | "light";
interface MdPalette {
  surface: MdSurface;
  body: string; // paragraph / table / list text
  strong: string; // **bold**, headings
  em: string; // *italic*, blockquotes
  muted: string; // captions, quiet markers
  faint: string; // dimmest chrome (uppercase labels, footnotes)
  link: string;
  linkUnderline: string;
  accent: string; // h3 labels, ordered-list numerals, blockquote rule
  hair: string; // hairline borders
  hairSoft: string;
  inlineCodeBg: string;
  panelBg: string; // fenced code / diff card interior
  panelHeaderBg: string;
  addFg: string;
  addBg: string;
  delFg: string;
  delBg: string;
  code: {
    plain: string;
    comment: string;
    string: string;
    number: string;
    keyword: string;
    type: string;
    prop: string;
    punct: string;
  };
}

const MD_PALETTES: Record<MdSurface, MdPalette> = {
  // The assistant bubble — a card-dark surface, so every ink is a step of
  // var(--foreground). The two bubble surfaces stay visually distinct (the
  // way a chat's "their message" / "your message" bubbles normally do) but
  // neither uses a bespoke hex — every value below resolves against the
  // shared tokens in styles.css.
  dark: {
    surface: "dark",
    body: "var(--foreground)",
    strong: CREAM,
    em: "color-mix(in srgb, var(--foreground) 88%, transparent)",
    muted: "var(--muted-foreground)",
    faint: "color-mix(in srgb, var(--muted-foreground) 80%, transparent)",
    link: "var(--brand)",
    linkUnderline: "color-mix(in srgb, var(--brand) 45%, transparent)",
    accent: "var(--brand)",
    hair: "color-mix(in srgb, var(--foreground) 20%, transparent)",
    hairSoft: "color-mix(in srgb, var(--foreground) 12%, transparent)",
    inlineCodeBg: "color-mix(in srgb, var(--foreground) 12%, transparent)",
    panelBg: "var(--inset)",
    panelHeaderBg: "color-mix(in srgb, var(--foreground) 4%, transparent)",
    addFg: "var(--success)",
    addBg: "color-mix(in srgb, var(--success) 7%, transparent)",
    delFg: "var(--danger)",
    delBg: "color-mix(in srgb, var(--danger) 6%, transparent)",
    code: {
      plain: "var(--foreground)",
      comment: "var(--muted-foreground)",
      string: "var(--success)",
      number: "var(--chart-3)",
      keyword: "var(--brand)",
      type: "var(--chart-5)",
      prop: "var(--chart-2)",
      punct: "color-mix(in srgb, var(--muted-foreground) 85%, transparent)",
    },
  },
  // The user bubble is the one deliberately light surface on the page (the
  // "your message" chip), so its inks are steps of var(--background) rather
  // than var(--foreground) — dark ink on a light chip. Accent/state colours
  // are darkened toward black so they still clear contrast on that light
  // fill (var(--brand)/var(--success)/var(--danger) alone are too light).
  light: {
    surface: "light",
    body: "var(--background)",
    strong: "var(--background)",
    em: "color-mix(in srgb, var(--background) 78%, transparent)",
    muted: "color-mix(in srgb, var(--background) 62%, transparent)",
    faint: "color-mix(in srgb, var(--background) 62%, transparent)", // no dimmer step; the light chip leaves no headroom
    link: "color-mix(in srgb, var(--brand) 60%, black)",
    linkUnderline: "color-mix(in srgb, color-mix(in srgb, var(--brand) 60%, black) 45%, transparent)",
    accent: "color-mix(in srgb, var(--brand) 60%, black)",
    hair: "color-mix(in srgb, var(--background) 22%, transparent)",
    hairSoft: "color-mix(in srgb, var(--background) 13%, transparent)",
    inlineCodeBg: "color-mix(in srgb, var(--background) 9%, transparent)",
    panelBg: "color-mix(in srgb, var(--background) 8%, transparent)",
    panelHeaderBg: "color-mix(in srgb, var(--background) 6%, transparent)",
    addFg: "color-mix(in srgb, var(--success) 55%, black)",
    addBg: "color-mix(in srgb, var(--success) 12%, transparent)",
    delFg: "color-mix(in srgb, var(--danger) 55%, black)",
    delBg: "color-mix(in srgb, var(--danger) 10%, transparent)",
    code: {
      plain: "var(--background)",
      comment: "color-mix(in srgb, var(--background) 55%, transparent)",
      string: "color-mix(in srgb, var(--success) 55%, black)",
      number: "color-mix(in srgb, var(--info) 55%, black)",
      keyword: "color-mix(in srgb, var(--danger) 45%, black)",
      type: "color-mix(in srgb, var(--chart-5) 55%, black)",
      prop: "color-mix(in srgb, var(--chart-2) 55%, black)",
      punct: "color-mix(in srgb, var(--background) 70%, transparent)",
    },
  },
};

// Inline: `code`, **bold**, *italic*, [text](url), bare urls.
function mdInline(s: string, keyBase: string, p: MdPalette): ReactNode[] {
  const parts: ReactNode[] = [];
  const re =
    /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const linkStyle = {
    color: p.link,
    textDecoration: "underline",
    textDecorationColor: p.linkUnderline,
    textUnderlineOffset: 2,
  } as const;
  // Any "**" left in plain text after the regex pass is an ORPHAN (its pair
  // sits across a line/block boundary the stream broke) — showing literal
  // asterisks always looks broken, so strip them from display.
  const plain = (t: string) => t.replace(/\*\*/g, "");
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(plain(s.slice(last, m.index)));
    if (m[2] !== undefined) {
      parts.push(
        <code
          key={`${keyBase}-c${i}`}
          style={{
            fontFamily: MD_MONO,
            fontSize: "13px",
            background: p.inlineCodeBg,
            color: p.code.plain,
            padding: "1px 5px",
            borderRadius: 4,
          }}
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <strong key={`${keyBase}-b${i}`} style={{ color: p.strong, fontWeight: 650 }}>
          {m[3]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <em key={`${keyBase}-i${i}`} style={{ color: p.em }}>
          {m[4]}
        </em>,
      );
    } else if (m[5] !== undefined && m[6] !== undefined) {
      parts.push(
        <a key={`${keyBase}-a${i}`} href={m[6]} target="_blank" rel="noreferrer" style={linkStyle}>
          {m[5]}
        </a>,
      );
    } else if (m[7] !== undefined) {
      // Bare url — keep trailing punctuation out of the link.
      const url = m[7].replace(/[.,;:!?]+$/, "");
      const trail = m[7].slice(url.length);
      parts.push(
        <a key={`${keyBase}-u${i}`} href={url} target="_blank" rel="noreferrer" style={linkStyle}>
          {url}
        </a>,
      );
      if (trail) parts.push(trail);
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < s.length) parts.push(plain(s.slice(last)));
  return parts;
}

/** Copy-to-clipboard control for a code/diff panel. Confirms in place. */
function MdCopyButton({ text, p }: { text: string; p: MdPalette }) {
  const { copied: done, failed, copy } = useCopyState(1400);
  return (
    <button
      type="button"
      // Hidden until the panel is hovered, but always reachable by keyboard —
      // .md-panel:focus-within reveals it too (see styles.css).
      className="font-mono md-copy-btn"
      aria-label={done ? "Copied" : failed ? "Couldn't copy" : "Copy code"}
      onClick={(e) => {
        e.stopPropagation();
        void copy(text);
      }}
      style={{
        fontSize: 13,
        letterSpacing: "0.12em",
        color: done ? p.code.string : p.muted,
        border: `1px solid ${p.hairSoft}`,
        borderRadius: 5,
        padding: "2px 7px",
        background: p.panelHeaderBg,
        cursor: "pointer",
      }}
    >
      {done ? "copied" : failed ? "couldn't copy" : "copy"}
    </button>
  );
}

/** Shared chrome for fenced code and diff cards: border, label chip, copy. */
function MdPanel({
  label,
  copyText,
  p,
  children,
}: {
  label: string;
  copyText: string;
  p: MdPalette;
  children: ReactNode;
}) {
  return (
    <div
      className="md-panel"
      style={{
        margin: "10px 0",
        border: `1px solid ${p.hair}`,
        borderRadius: 10,
        background: p.panelBg,
        overflow: "hidden",
      }}
    >
      <div
        className="font-mono flex items-center justify-between gap-2"
        style={{
          fontSize: 13,
          letterSpacing: "0.18em",
          color: p.muted,
          padding: "4px 8px 4px 12px",
          borderBottom: `1px solid ${p.hairSoft}`,
          background: p.panelHeaderBg,
          minHeight: 25,
        }}
      >
        <span className="truncate">{label}</span>
        <MdCopyButton text={copyText} p={p} />
      </div>
      {children}
    </div>
  );
}

/**
 * Fenced code. Indentation is preserved exactly and long lines scroll
 * horizontally — code is never wrapped, because a wrapped line misrepresents
 * what the file actually says.
 */
function MdCodeBlock({ code, lang, p }: { code: string; lang: string; p: MdPalette }) {
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);
  const tint: Record<CodeToken["kind"], string> = {
    plain: p.code.plain,
    comment: p.code.comment,
    string: p.code.string,
    number: p.code.number,
    keyword: p.code.keyword,
    type: p.code.type,
    prop: p.code.prop,
    punct: p.code.punct,
  };
  return (
    <MdPanel label={lang || "code"} copyText={code} p={p}>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          overflowX: "auto",
          whiteSpace: "pre",
          tabSize: 2,
          fontFamily: MD_MONO,
          fontSize: 13,
          lineHeight: 1.6,
          color: p.code.plain,
        }}
      >
        <code>
          {tokens.map((t, j) =>
            t.kind === "plain" ? (
              <span key={j}>{t.text}</span>
            ) : (
              <span key={j} style={{ color: tint[t.kind] }}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </MdPanel>
  );
}

// Diff card — green adds, red removals, accented hunk headers, bold file line.
function MdDiffBlock({ lines: dl, k, p }: { lines: string[]; k: string; p: MdPalette }) {
  return (
    <div key={k}>
      <MdPanel label="diff" copyText={dl.join("\n")} p={p}>
        <div style={{ overflowX: "auto", padding: "8px 0", fontFamily: MD_MONO, fontSize: 13, lineHeight: 1.6 }}>
          {dl.map((l, j) => {
            const isFile =
              /^(diff --git|[+]{3}\s|-{3}\s|index\s)/.test(l) || /^[ab]\/\S+\s*(→|->)\s*[ab]\//.test(l);
            const isHunk = /^@@/.test(l);
            const isAdd = !isFile && l.startsWith("+");
            const isDel = !isFile && l.startsWith("-");
            return (
              <div
                key={j}
                style={{
                  padding: "0 12px",
                  whiteSpace: "pre",
                  color: isFile
                    ? p.strong
                    : isHunk
                      ? p.accent
                      : isAdd
                        ? p.addFg
                        : isDel
                          ? p.delFg
                          : p.code.plain,
                  background: isAdd ? p.addBg : isDel ? p.delBg : "transparent",
                  fontWeight: isFile ? 600 : 400,
                }}
              >
                {l || " "}
              </div>
            );
          })}
        </div>
      </MdPanel>
    </div>
  );
}

// Per-expert accent palette for Ministry streams — Reference 1 teal,
// 2 violet, 3 green, then fuchsia/sky. Thinking blocks inherit the color of
// the reference section they sit in, so you can see WHO is thinking at a
// glance; thinking before any reference (the aggregator/core) stays amber.
const MOA_REF_COLORS = ["var(--chart-2)", "var(--brand)", "var(--success)", "var(--chart-5)", "var(--chart-3)"];

function ChatMarkdown({
  text,
  surface = "dark",
}: {
  text: string;
  /** Which bubble this is drawn on. Picks the whole colour palette. */
  surface?: MdSurface;
}) {
  const p = MD_PALETTES[surface];
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let moaRefIdx = -1;
  const moaAccent = () =>
    moaRefIdx >= 0
      ? MOA_REF_COLORS[moaRefIdx % MOA_REF_COLORS.length]
      : p.accent;

  const isDiffStart = (l: string) =>
    /^diff --git\s/.test(l) ||
    /^@@ [-+0-9, ]+@@/.test(l) ||
    /^[ab]\/\S+\s*(→|->)\s*[ab]\//.test(l);
  const isDiffLine = (l: string) =>
    l === "" || /^[+\-@ \\]/.test(l) || isDiffStart(l) || /^index\s/.test(l);

  let blockSeq = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    // Monotonic per-block key. NOT `b${i}` — some branches (e.g. an init blob
    // sharing a line with a ◇ Reference marker) reprocess the same index,
    // which would mint duplicate keys and let React swap the two collapsibles.
    const key = `b${i}-${blockSeq++}`;

    // Agent-init boilerplate — "🤖 AI Agent initialized …", "✅ Enabled
    // toolset …", "Loaded 32 tools: …". Useful for debugging, terrible as
    // chat copy. Collapse the whole run into one expandable dim line.
    const INIT_RE =
      /(AI Agent initialized|Enabled toolset|Final tool selection|Loaded \d+ tools|Unknown toolset|Some tools may not work|Enabled toolsets:|Context limit: [\d,]+ tokens)/;
    if (INIT_RE.test(line)) {
      const init: string[] = [];
      while (i < lines.length && INIT_RE.test(lines[i])) {
        const l = lines[i].trimEnd();
        // A "◇ Reference …" marker can ride on the SAME line as the init
        // blob — keep the init half here and hand the marker back to the
        // normal parser so the divider still renders.
        const refAt = l.search(/[⋮╎|┊┆┇┋]?\s*◇\s*Reference\s+\d+\s*\//);
        if (refAt > 0) {
          init.push(l.slice(0, refAt).trimEnd());
          lines.splice(i, 1, l.slice(refAt));
          break;
        }
        init.push(l);
        i++;
      }
      blocks.push(
        <details key={key} style={{ margin: "6px 0" }}>
          <summary
            className="font-mono"
            style={{
              fontSize: 13,
              letterSpacing: "0.16em",
              color: p.faint,
              cursor: "pointer",
              listStyle: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: `1px solid ${p.hairSoft}`,
              borderRadius: 6,
              padding: "3px 8px",
            }}
          >
            <span style={{ color: p.accent }}>⚙</span>
            session initialized · toolsets &amp; context
            <span style={{ opacity: 0.6 }}>▸ expand</span>
          </summary>
          <div
            className="font-mono"
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: p.muted,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              padding: "8px 10px",
              marginTop: 6,
              background: p.panelBg,
              border: `1px solid ${p.hairSoft}`,
              borderRadius: 8,
            }}
          >
            {init.join("\n")}
          </div>
        </details>,
      );
      continue;
    }

    // MoA stream marker — "◇ Reference 2/3 — openrouter:z-ai/glm-5.2".
    // Render as a labelled divider so each expert's section reads as a
    // designed chapter break instead of raw stream text.
    const moaRef = line.match(
      // Separator tolerant of em-dash / en-dash / ASCII hyphen so a locale or
      // terminal that normalizes the dash still renders the chapter break.
      /^[\s⋮╎|┊┆┇┋]*◇\s*Reference\s+(\d+)\s*\/\s*(\d+)\s*[—–-]\s*(.+)$/,
    );
    if (moaRef) {
      moaRefIdx = parseInt(moaRef[1], 10) - 1;
      const accent = MOA_REF_COLORS[moaRefIdx % MOA_REF_COLORS.length];
      i++;
      // Swallow this expert's whole preview (its [thinking]-prefixed text
      // runs) into a COLLAPSED section — the aggregator's verdict is the
      // answer; each expert's full response stays one click away. This is
      // what keeps a Ministry turn "short and sharp" on screen even though
      // the full reference text streams in.
      const refParts: string[] = [];
      while (i < lines.length) {
        const nl = lines[i].trimEnd();
        if (nl.trim() === "") {
          // Blank line: only continue if MORE thinking follows — otherwise
          // the final (plain) answer starts and must stay outside.
          let k = i + 1;
          while (k < lines.length && lines[k].trim() === "") k++;
          if (k < lines.length && /^\s*\[thinking\]/i.test(lines[k].trimEnd())) {
            i = k;
            continue;
          }
          break;
        }
        if (/^[\s⋮╎|┊┆┇┋]*◇\s*Reference/.test(nl)) break;
        if (/^\s*\[thinking\]/i.test(nl)) {
          const t: string[] = [nl.replace(/^\s*\[thinking\]\s*/i, "")];
          i++;
          while (i < lines.length) {
            const cl = lines[i].trimEnd();
            // Stop at anything that reads as the ANSWER starting — a new
            // marker, structural markdown, or an ALL-CAPS lead like
            // "VERDICT:" — even when the stream skipped the blank line.
            if (
              cl.trim() === "" ||
              /^[\s⋮╎|┊┆┇┋]*◇\s*Reference/.test(cl) ||
              /^\s*\[thinking\]/i.test(cl) ||
              /^#{1,4}\s+/.test(cl) ||
              /^\s*```/.test(cl) ||
              /^\s*\|/.test(cl) ||
              /^[A-Z][A-Z0-9 _'-]{2,}:/.test(cl.trim())
            )
              break;
            t.push(cl);
            i++;
          }
          refParts.push(t.join("\n"));
          continue;
        }
        if (/^\s*\.{3}\s*\(\d+\s+more/.test(nl)) {
          refParts.push(nl);
          i++;
          continue;
        }
        break;
      }
      blocks.push(
        <details key={key} style={{ margin: "10px 0" }}>
          <summary
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              listStyle: "none",
            }}
          >
            <span style={{ color: accent, fontSize: 13, flexShrink: 0 }}>◇</span>
            <span
              className="font-mono"
              style={{
                fontSize: 13,
                letterSpacing: "0.18em",
                color: accent,
                whiteSpace: "nowrap",
              }}
            >
              Reference {moaRef[1]}/{moaRef[2]}
            </span>
            <span
              className="font-mono"
              style={{ fontSize: 13, color: p.muted, whiteSpace: "nowrap" }}
            >
              {moaRef[3].trim()}
            </span>
            <span style={{ flex: 1, borderTop: `1px solid ${p.hairSoft}` }} />
            <span
              className="font-mono"
              style={{ fontSize: 13, letterSpacing: "0.14em", color: `color-mix(in srgb, ${accent} 60%, transparent)`, whiteSpace: "nowrap" }}
            >
              ▸ full response
            </span>
          </summary>
          {refParts.length > 0 && (
            <div
              style={{
                borderLeft: `2px solid ${accent}`,
                paddingLeft: 12,
                margin: "8px 0 4px 4px",
                fontFamily: MD_SANS,
                fontSize: 13,
                fontStyle: "italic",
                color: p.muted,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {refParts.join("\n\n")}
            </div>
          )}
        </details>,
      );
      continue;
    }

    // "[thinking] …" — expert/model reasoning. Collect the whole run (the
    // prefix appears only on the first line of a wrapped block) and render
    // dimmed + italic with a tiny label chip so it reads as backstage.
    if (/^\s*\[thinking\]/i.test(line)) {
      const think: string[] = [line.replace(/^\s*\[thinking\]\s*/i, "")];
      i++;
      while (i < lines.length) {
        const nl = lines[i].trimEnd();
        // Stop at anything structural — blank lines, the next marker, or
        // content blocks (lists/headings/fences) that belong to the answer.
        if (
          nl.trim() === "" ||
          /^[\s⋮╎|┊┆┇┋]*◇\s*Reference/.test(nl) ||
          /^\s*\[thinking\]/i.test(nl) ||
          /^\s*[-•*]\s+/.test(nl) ||
          /^\s*\d+[.)]\s+/.test(nl) ||
          /^#{1,4}\s+/.test(nl) ||
          /^\s*```/.test(nl) ||
          /^\s*\|/.test(nl)
        )
          break;
        think.push(nl);
        i++;
      }
      const thinkText = think
        .join(" ")
        .replace(/#+\s*/g, "")
        .trim();
      const tAccent = moaAccent();
      blocks.push(
        <div
          key={key}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            margin: "6px 0",
            borderLeft: `2px solid ${tAccent}`,
            paddingLeft: 10,
            opacity: 0.9,
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 13,
              letterSpacing: "0.16em",
              color: tAccent,
              border: `1px solid color-mix(in srgb, ${tAccent} 33%, transparent)`,
              borderRadius: 4,
              padding: "1px 5px",
              flexShrink: 0,
            }}
          >
            thinking
          </span>
          <span
            style={{
              fontFamily: MD_SANS,
              fontSize: 13,
              fontStyle: "italic",
              color: p.muted,
              lineHeight: 1.6,
            }}
          >
            {thinkText}
          </span>
        </div>,
      );
      continue;
    }

    // "... (N more lines)" — Hermes CLI preview truncation (pre-verbose
    // sessions). Render as a quiet marker, not body text.
    if (/^\s*\.{3}\s*\(\d+\s+more\s+lines?[^)]*\)\s*$/.test(line)) {
      blocks.push(
        <div
          key={key}
          className="font-mono"
          style={{
            fontSize: 13,
            letterSpacing: "0.14em",
            color: p.faint,
            margin: "4px 0",
          }}
        >
          {line.trim()}
        </div>,
      );
      i++;
      continue;
    }

    // Fenced code — ```lang … ``` (a ```diff fence renders as a diff card).
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1].toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const looksDiff =
        lang === "diff" || body.filter((l) => /^[+-]/.test(l)).length >= Math.max(2, body.length * 0.3);
      if (looksDiff) {
        blocks.push(<MdDiffBlock key={key} k={key} lines={body} p={p} />);
      } else {
        blocks.push(<MdCodeBlock key={key} code={body.join("\n")} lang={lang} p={p} />);
      }
      continue;
    }

    // Unfenced diff — Hermes tool output prints raw diffs into the reply.
    if (isDiffStart(line)) {
      const body: string[] = [];
      while (i < lines.length && isDiffLine(lines[i].trimEnd())) {
        body.push(lines[i].trimEnd());
        i++;
      }
      while (body.length && body[body.length - 1] === "") body.pop();
      blocks.push(<MdDiffBlock key={key} k={key} lines={body} p={p} />);
      continue;
    }

    // Table — header row + |---|---| separator.
    if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const parseRow = (l: string) =>
        l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key} style={{ overflowX: "auto", margin: "10px 0" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {header.map((h, j) => (
                  <th
                    key={j}
                    className="font-mono"
                    style={{
                      fontSize: 13,
                      letterSpacing: "0.16em",
                      color: p.accent,
                      textAlign: "left",
                      padding: "6px 12px",
                      borderBottom: `1px solid ${p.hair}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mdInline(h, `${key}-h${j}`, p)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td
                      key={ci}
                      style={{
                        fontFamily: MD_SANS,
                        fontSize: 13.5,
                        lineHeight: 1.5,
                        padding: "7px 12px",
                        borderBottom: `1px solid ${p.hairSoft}`,
                        verticalAlign: "top",
                      }}
                    >
                      {mdInline(c, `${key}-r${ri}c${ci}`, p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote run.
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <div
          key={key}
          style={{
            borderLeft: `2px solid ${p.accent}`,
            paddingLeft: 12,
            margin: "10px 0",
            fontStyle: "italic",
            fontSize: 14.5,
            lineHeight: 1.65,
            color: p.em,
          }}
        >
          {q.map((ql, j) => (
            <p key={j} style={{ margin: "3px 0" }}>
              {mdInline(ql, `${key}-q${j}`, p)}
            </p>
          ))}
        </div>,
      );
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        <div key={key} style={{ borderTop: `1px solid ${p.hair}`, margin: "14px 0" }} />,
      );
      i++;
      continue;
    }

    // Headings — h1/h2 as a bold sans lead, h3 as a mono section label.
    // Guard: a "heading" longer than ~90 chars is almost always a stream
    // artifact (a whole sentence behind ##) — huge text across 3 wrapped
    // lines looks broken, so render those as a bold sans lead instead.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      if (depth <= 2 && h[2].length > 90) {
        blocks.push(
          <p
            key={key}
            style={{
              fontFamily: MD_SANS,
              fontSize: 15,
              fontWeight: 650,
              color: p.strong,
              lineHeight: 1.6,
              margin: "12px 0 4px",
            }}
          >
            {mdInline(h[2], key, p)}
          </p>,
        );
        i++;
        continue;
      }
      if (depth <= 2) {
        blocks.push(
          <div
            key={key}
            style={{
              fontSize: depth === 1 ? 18 : 16,
              fontWeight: 600,
              color: p.strong,
              margin: "16px 0 6px",
              paddingBottom: depth <= 2 ? 5 : 0,
              borderBottom: `1px solid ${p.hairSoft}`,
            }}
          >
            {mdInline(h[2], key, p)}
          </div>,
        );
      } else {
        blocks.push(
          <div
            key={key}
            className="font-mono"
            style={{
              fontSize: 13,
              letterSpacing: "0.2em",
              color: p.accent,
              margin: "14px 0 4px",
            }}
          >
            {mdInline(h[2], key, p)}
          </div>,
        );
      }
      i++;
      continue;
    }

    // Ordered list run — the source's own numbers are preserved so "2."
    // stays "2." even when paragraphs sit between items.
    const olm = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (olm) {
      const items: Array<{ num: string; text: string }> = [];
      while (i < lines.length) {
        const m2 = lines[i].trimEnd().match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (!m2) break;
        items.push({ num: m2[1], text: m2[2] });
        i++;
      }
      blocks.push(
        <div key={key} style={{ margin: "8px 0", display: "flex", flexDirection: "column", gap: 5 }}>
          {items.map((it, j) => (
            <div key={j} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span
                className="font-mono"
                style={{ fontSize: 13, color: p.accent, flexShrink: 0, minWidth: 18, textAlign: "right" }}
              >
                {it.num}.
              </span>
              <span style={{ fontFamily: MD_SANS, fontSize: 14.5, lineHeight: 1.65 }}>
                {mdInline(it.text, `${key}-${j}`, p)}
              </span>
            </div>
          ))}
        </div>,
      );
      continue;
    }

    // Unordered list run — nesting-aware. Markers are deliberately QUIET
    // (small, dim cream — never a row of loud amber dots): top level gets a
    // small "•", nested levels an en-dash, indented under their parent.
    if (/^\s*[-•*]\s+/.test(line)) {
      const items: Array<{ level: number; text: string }> = [];
      while (i < lines.length) {
        const l = lines[i].trimEnd();
        const m2 = l.match(/^(\s*)[-•*]\s+(.*)$/);
        if (!m2) break;
        const level = Math.min(
          2,
          Math.floor(m2[1].replace(/\t/g, "  ").length / 2),
        );
        items.push({ level, text: m2[2] });
        i++;
      }
      blocks.push(
        <div key={key} style={{ margin: "6px 0", display: "flex", flexDirection: "column", gap: 3 }}>
          {items.map((it, j) => (
            <div
              key={j}
              style={{
                display: "flex",
                gap: 9,
                alignItems: "baseline",
                paddingLeft: it.level * 18,
              }}
            >
              <span
                style={{
                  color:
                    it.level === 0
                      ? p.muted
                      : p.faint,
                  flexShrink: 0,
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                {it.level === 0 ? "•" : "–"}
              </span>
              <span style={{ fontFamily: MD_SANS, fontSize: 14.5, lineHeight: 1.6 }}>
                {mdInline(it.text, `${key}-${j}`, p)}
              </span>
            </div>
          ))}
        </div>,
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consecutive plain lines JOIN into one paragraph (markdown
    // semantics). This also repairs **bold** / *italic* spans that the raw
    // stream wrapped across line breaks, which otherwise showed literal
    // asterisks.
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const nl = lines[i].trimEnd();
      if (
        nl.trim() === "" ||
        /^\s*[-•*]\s+/.test(nl) ||
        /^\s*\d+[.)]\s+/.test(nl) ||
        /^#{1,4}\s+/.test(nl) ||
        /^\s*>/.test(nl) ||
        /^\s*```/.test(nl) ||
        /^\s*\|/.test(nl) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(nl) ||
        /^[\s⋮╎|┊┆┇┋]*◇\s*Reference/.test(nl) ||
        /^\s*\[thinking\]/i.test(nl) ||
        /^\s*\.{3}\s*\(\d+\s+more/.test(nl) ||
        isDiffStart(nl)
      )
        break;
      para.push(nl);
      i++;
    }
    blocks.push(
      <p key={key} style={{ fontFamily: MD_SANS, fontSize: 14.5, lineHeight: 1.68, margin: "7px 0" }}>
        {mdInline(para.join(" "), key, p)}
      </p>,
    );
  }

  return <div style={{ color: p.body }}>{blocks}</div>;
}

// Storage key co-owned with the sidebar's SidebarIdentity. Update one,
// the other refetches via the storage event the wizard fires.
const OPERATOR_AVATAR_KEY = "claude-os.avatar.v1";

function UserAvatar() {
  // Operator's actual avatar from settings — same source the sidebar uses.
  // If unset (the user never finished the wizard), we render a cream-
  // bordered initial-letter square that matches the page brand.
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setAvatar(window.localStorage.getItem(OPERATOR_AVATAR_KEY));
    } catch {
      /* localStorage disabled */
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === OPERATOR_AVATAR_KEY || e.key === null) {
        try {
          setAvatar(window.localStorage.getItem(OPERATOR_AVATAR_KEY));
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return (
    <div
      className="shrink-0 mt-0.5 overflow-hidden border"
      style={{
        width: 44,
        height: 44,
        borderColor: "color-mix(in srgb, var(--foreground) 50%, transparent)",
      }}
    >
      {avatar ? (
        <img
          src={avatar}
          alt="You"
          className="block object-cover"
          style={{ width: "100%", height: "100%" }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div
          className="font-sans font-semibold flex items-center justify-center w-full h-full"
          style={{ color: CREAM, background: "color-mix(in srgb, var(--foreground) 6%, transparent)", fontSize: 20 }}
        >
          Y
        </div>
      )}
    </div>
  );
}

function HermesAvatar() {
  // The same brand mark used in the page header — Hermes' identity in the
  // chat transcript comes from one shared mark, not a bespoke portrait.
  return (
    <span className="mt-0.5 shrink-0 rounded-full border border-border bg-inset p-1.5">
      <BrandMark agent="hermes" size={24} />
    </span>
  );
}

function ChatTyping() {
  // A live "thinking…" state with an elapsed counter so the pre-token latency
  // (Hermes' single-query mode buffers the reply, so first output can be ~8s)
  // reads as "working", not frozen.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex justify-start items-start gap-3">
      <HermesAvatar />
      <div
        className="px-4 py-3 border flex items-center gap-2.5"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)",
          background: "color-mix(in srgb, var(--foreground) 4%, transparent)",
        }}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: CREAM }} />
        <span
          className="font-mono"
          style={{ fontSize: 13, color: "color-mix(in srgb, var(--foreground) 60%, transparent)", letterSpacing: "0.04em" }}
        >
          Hermes is thinking{secs >= 2 ? ` · ${secs}s` : ""}
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Setup wizard — mirrors `hermes setup model` (provider → auth → model → save)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Stats — modeled on the Hermes Agent feature surface (Nous Research, MIT)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Pantheon — the 10 Kie.ai generated Greek-mythology pieces in Hermes' style.
// Pure visual section. Hover lifts each card; the card label tells the story.
// Imports for the 10 PNGs are at the top of the file (ESM rules).
// ────────────────────────────────────────────────────────────────────────────

// Pantheon-as-Personas (Hermes' YAML schema). Each persona lives on disk
// at ~/.hermes/pantheon/personas/<id>.yaml and is rendered via useHermesPantheon().
// This array stays only as the avatar-lookup table (id → bundled PNG) and
// as a client-side mirror of the seed data so the UI has something to show
// before the user runs "Install Pantheon" (which writes them to disk).
const _LEGACY_PROFILE_TEMPLATES_FOR_REFERENCE_ONLY: Array<{
  name: string;
  title: string;
  src: string;
  pitch: string;
  model: string;
  personality: string;
  skills: string[];
}> = [
  {
    name: "messenger",
    title: "Messenger",
    src: pantheon01,
    pitch: "Daily chat across Telegram, iMessage, email. Light, conversational, fast.",
    model: DEMO_GPT.name,
    personality: "concise",
    skills: ["apple", "email", "gateway"],
  },
  {
    name: "oracle",
    title: "Oracle",
    src: pantheon02,
    pitch: "Long-term memory & lookup. Reads SOUL.md and the kanban, answers what-do-I-know questions.",
    model: DEMO_OPUS,
    personality: "helpful",
    skills: ["memory", "domain", "dogfood"],
  },
  {
    name: "athena",
    title: "Athena",
    src: pantheon03,
    pitch: "Code review, refactors, PR triage. Reads diffs, runs tests, files clean changes.",
    model: DEMO_SONNET,
    personality: "technical",
    skills: ["github", "devops", "autonomous-ai-agents"],
  },
  {
    name: "scribe",
    title: "Scribe",
    src: pantheon04,
    pitch: "Writes: long-form prose, docs, social posts, scripts. Polished, publish-ready output.",
    model: DEMO_GPT.name,
    personality: "creative",
    skills: ["creative", "domain"],
  },
  {
    name: "orpheus",
    title: "Orpheus",
    src: pantheon05,
    pitch: "Media generation. Image, video, audio, design. Talks to Kie/Runway/ElevenLabs.",
    model: DEMO_OPUS,
    personality: "creative",
    skills: ["creative", "media", "gifs"],
  },
  {
    name: "labyrinth",
    title: "Labyrinth",
    src: pantheon06,
    pitch: "Deep research & planning loops. Long-running, autonomous, will keep going overnight.",
    model: DEMO_GPT.name,
    personality: "technical",
    skills: ["data-science", "autonomous-ai-agents"],
  },
  {
    name: "alchemist",
    title: "Alchemist",
    src: pantheon07,
    pitch: "MCP & tool tinkering. Spins up servers, wires integrations, runs experiments.",
    model: DEMO_SONNET,
    personality: "technical",
    skills: ["mcp", "devops", "inference-sh"],
  },
  {
    name: "philosopher",
    title: "Philosopher",
    src: pantheon08,
    pitch: "Reasoning at depth. Wrestles with ambiguous problems, teaches what it learned.",
    model: DEMO_OPUS,
    personality: "teacher",
    skills: ["domain"],
  },
  {
    name: "mapmaker",
    title: "Mapmaker",
    src: pantheon09,
    pitch: "Charts what is — architecture diagrams, codebase maps, system docs.",
    model: DEMO_GPT.name,
    personality: "technical",
    skills: ["diagramming", "github"],
  },
  {
    name: "mercury",
    title: "Mercury",
    src: pantheon10,
    pitch: "The autopilot. Cron jobs, webhooks, scheduled tasks, background sentinels.",
    model: DEMO_GPT.name,
    personality: "concise",
    skills: ["gateway", "autonomous-ai-agents"],
  },
];

// Avatar lookup: persona id → bundled Pantheon PNG. Same map drives the
// catalog cards, the collapsed session sidebar, and chat-bubble avatars.
const PERSONA_AVATAR_BY_ID: Record<string, string> = {
  messenger: pantheon01,
  oracle: pantheon02,
  athena: pantheon03,
  scribe: pantheon04,
  orpheus: pantheon05,
  labyrinth: pantheon06,
  alchemist: pantheon07,
  philosopher: pantheon08,
  mapmaker: pantheon09,
  mercury: pantheon10,
};

function avatarForProfile(profileName: string | null | undefined): string | null {
  if (!profileName) return null;
  return PERSONA_AVATAR_BY_ID[profileName.toLowerCase()] ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Pantheon catalog — reads ~/.hermes/pantheon/personas/*.yaml via the
// /__hermes_pantheon endpoint and renders one card per persona. When the
// disk dir is empty we show a "Install Pantheon" CTA that POSTs the 10
// seed YAMLs (idempotent, skips existing).
// ────────────────────────────────────────────────────────────────────────────
function HermesProfileTemplates() {
  const { data, refetch, isFetching } = useHermesPantheon();
  const personas = data?.personas ?? [];
  const installed = data?.installed ?? false;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installPantheon();
      await refetch();
    } catch (err: any) {
      setInstallError(err?.message ?? "install failed");
    } finally {
      setInstalling(false);
    }
  }

  // Empty state: dir missing OR no YAMLs found. Surface a single CTA.
  if (!isFetching && personas.length === 0) {
    return (
      <section className="mb-12">
        <SectionHead title="Pantheon" meta="10 personas · not yet installed" />
        <div
          className="text-[13px] leading-relaxed mt-3 mb-5 max-w-3xl"
          style={{ color: "color-mix(in srgb, var(--foreground) 70%, transparent)" }}
        >
          Each Pantheon piece is a saved persona with its own model and instructions. Install them once and they live at{" "}
          <span className="font-mono" style={{ color: CREAM, fontSize: "13px" }}>
            ~/.hermes/pantheon/personas/
          </span>{" "}
          as YAML files you can edit, version, or push to GitHub.
        </div>
        <button
          type="button"
          onClick={() => void handleInstall()}
          disabled={installing}
          className="font-mono px-4 py-2 border text-[13px] transition-colors disabled:opacity-50"
          style={{
            background: CREAM,
            color: BG,
            borderColor: CREAM,
          }}
        >
          {installing ? "Installing…" : "+ Install Pantheon"}
        </button>
        {installError && (
          <div
            className="font-mono mt-2 text-[13px]"
            style={{ color: "var(--warn)" }}
          >
            {installError}
          </div>
        )}
        {!installed && (
          <div
            className="font-mono mt-2 text-[13px]"
            style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
          >
            Dir will be created if missing
          </div>
        )}
      </section>
    );
  }

  return <PantheonCatalog personas={personas} />;
}

// Pantheon catalog. Shows 3 featured personas + a "+ Add" tile by default
// so the page doesn't feel overwhelmed. Expand to see all 10.
function PantheonCatalog({ personas }: { personas: PersonaYaml[] }) {
  const { data: syncData } = useHermesPantheonSync();
  const statuses = syncData?.statuses ?? {};
  const hasRepo = syncData?.hasRepo ?? false;

  // Order: the 3 default seeds first (Labyrinth, Mercury, Philosopher),
  // then any user-added personas in the order they appear on disk. ALL
  // personas are always visible — adding Orpheus shouldn't hide him
  // behind a "show more" toggle. The grid scales to N cards.
  const FEATURED_IDS = ["labyrinth", "mercury", "philosopher"];
  const featuredFirst = FEATURED_IDS
    .map((id) => personas.find((p) => p.id === id))
    .filter(Boolean) as PersonaYaml[];
  const rest = personas.filter((p) => !featuredFirst.includes(p));
  const visible = [...featuredFirst, ...rest];

  return (
    <section className="mb-12">
      <SectionHead
        title="Pantheon"
        meta={`${personas.length} persona${personas.length === 1 ? "" : "s"} on disk`}
      />
      <div
        className="text-[15px] leading-relaxed mt-3 mb-5 max-w-3xl"
        style={{ color: "color-mix(in srgb, var(--foreground) 82%, transparent)" }}
      >
        Say <span className="font-mono" style={{ color: CREAM, fontSize: "13px" }}>"Labyrinth, research this topic"</span> and Hermes uses that persona for the turn. Click a card to retune it.
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {/* The Ministry of Experts (Mixture of Agents) is the first member of
            the Pantheon — a council that answers as one. Expands inline. */}
        <MinistryCard />
        {visible.map((p) => (
          <PersonaCard
            key={p.id}
            persona={p}
            syncStatus={statuses[p.id]}
            hasRepo={hasRepo}
          />
        ))}
        <AddPersonaTile existingIds={personas.map((p) => p.id)} />
      </div>
    </section>
  );
}

interface PersonaTemplate {
  id: string;
  name: string;
  job: string;
  description: string;
  defaultModel: { provider: string; name: string; effort?: EffortLevel };
}

function useHermesPantheonTemplates() {
  const demo = useDemoMode();
  return useQuery<{ templates: PersonaTemplate[] }>({
    queryKey: ["hermes-pantheon-templates", demo],
    queryFn: async () => {
      if (demo) {
        // In demo we offer the personas NOT already installed as
        // candidates the wizard can spin up.
        const installed = new Set(DEMO_PERSONAS.map((p) => p.id));
        const allTemplates: PersonaTemplate[] = [
          { id: "oracle", name: "Oracle", job: "Memory & lookup", description: "Long-term memory and lookup", defaultModel: hermesRef("anthropic-api/claude-sonnet-4.6") },
          { id: "athena", name: "Athena", job: "Code review & refactors", description: "Code review and refactors", defaultModel: hermesRef("anthropic-api/claude-opus-4.8") },
          { id: "scribe", name: "Scribe", job: "Long-form writing", description: "Long-form prose and docs", defaultModel: hermesRef("anthropic-api/claude-opus-4.8") },
          { id: "orpheus", name: "Orpheus", job: "Media generation", description: "Image, video, audio gen", defaultModel: hermesRef("anthropic-api/claude-opus-4.8") },
          { id: "alchemist", name: "Alchemist", job: "Integrations & MCP", description: "MCP servers and tool tinkering", defaultModel: hermesRef("anthropic-api/claude-sonnet-4.6") },
          { id: "mapmaker", name: "Mapmaker", job: "Diagrams & system docs", description: "Architecture diagrams and docs", defaultModel: hermesRef("openai-api/gpt-5.5") },
        ];
        return { templates: allTemplates.filter((t) => !installed.has(t.id)) };
      }
      const res = await fetch("/__hermes_pantheon_templates");
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
}

// Add Persona — the tile flips between a "+" affordance and an inline
// wizard with three dropdowns (template / job / model). Save writes the
// YAML via POST /__hermes_pantheon/create.
function AddPersonaTile({ existingIds }: { existingIds: string[] }) {
  const queryClient = useQueryClient();
  const { data: templatesData } = useHermesPantheonTemplates();
  const { data: modelsData } = useHermesModels();
  const templates = templatesData?.templates ?? [];
  const available = templates.filter((t) => !existingIds.includes(t.id));
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PersonaTemplate | null>(null);
  const [job, setJob] = useState("");
  const [description, setDescription] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [modelOverride, setModelOverride] = useState<{
    provider: string;
    name: string;
    effort?: EffortLevel;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  // When the user picks a template, prefill model only (job + description
  // stay blank so the user can write their own — no prescriptive label).
  useEffect(() => {
    if (!picked) return;
    setModelOverride(picked.defaultModel);
  }, [picked]);

  function randomize() {
    if (available.length === 0) return;
    const t = available[Math.floor(Math.random() * available.length)];
    setPicked(t);
  }

  async function handleSave() {
    if (!picked) return;
    setSaving(true);
    setError(null);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      const res = await fetch("/__hermes_pantheon/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claude-OS-Token": t.token,
        },
        body: JSON.stringify({
          templateId: picked.id,
          job: job || picked.job,
          // description goes into the YAML as `description`. Currently the
          // /create endpoint accepts an override on top of the template's
          // fields, so we send it alongside job.
          description: description || undefined,
          prompt: promptDraft || undefined,
          model: modelOverride,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `create failed: ${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon"] });
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon-sync"] });
      setOpen(false);
      setPicked(null);
      setJob("");
      setDescription("");
    } catch (err: any) {
      setError(err?.message ?? "create failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={available.length === 0}
        className="group border flex flex-col items-center justify-center gap-3 p-4 transition-colors min-h-[420px] disabled:opacity-40"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)",
          background: "var(--inset)",
          borderStyle: "dashed",
        }}
        onMouseEnter={(e) => {
          if (available.length > 0) e.currentTarget.style.borderColor = CREAM;
        }}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 35%, transparent)")}
        title={
          available.length === 0
            ? "All template personas already installed"
            : `Add a persona (${available.length} template${available.length === 1 ? "" : "s"} available)`
        }
      >
        <div
          className="font-sans font-semibold"
          style={{
            color: CREAM,
            fontSize: 64,
            lineHeight: 1,
            textShadow: "0 0 22px color-mix(in srgb, var(--brand) 25%, transparent)",
          }}
        >
          +
        </div>
        <div
          className="font-mono text-[13px] text-center"
          style={{ color: "color-mix(in srgb, var(--foreground) 75%, transparent)" }}
        >
          Add Persona
        </div>
        <div
          className="text-[13px] leading-snug text-center max-w-[18ch]"
          style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
        >
          {available.length === 0
            ? "All templates already installed"
            : "Pick a template, set the job and model"}
        </div>
      </button>
    );
  }

  // Visual picker: 6 image thumbnails (the unused templates), a name/job
  // text field, a description textarea, and a model dropdown. The image
  // IS the picker — no prescriptive "Memory & lookup" labels in a select.
  return (
    <div
      className="border flex flex-col p-4 gap-3.5 min-h-[420px]"
      style={{
        borderColor: CREAM,
        background: "var(--inset)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <h3
          className="font-sans font-semibold leading-none"
          style={{ color: CREAM, fontSize: "16px", letterSpacing: "0.04em" }}
        >
          New Persona
        </h3>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={randomize}
            disabled={available.length === 0}
            className="font-mono text-[13px] transition-colors disabled:opacity-30"
            style={{ color: "var(--brand)" }}
            title="Pick a random unused template"
          >
            ⟲ Randomize
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPicked(null);
              setError(null);
              setJob("");
              setDescription("");
            }}
            className="font-mono text-[13px]"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
          >
            cancel
          </button>
        </div>
      </div>

      {/* Image picker — visual grid of unused persona avatars. The image
          IS the choice; no descriptive label competing for attention. */}
      <div className="flex flex-col gap-1.5">
        <span
          className="font-mono text-[13px]"
          style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
        >
          Pick an avatar
        </span>
        <div className="grid grid-cols-3 gap-2">
          {available.map((t) => {
            const isPicked = picked?.id === t.id;
            const avatar = PERSONA_AVATAR_BY_ID[t.id];
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setPicked(t)}
                className="relative aspect-square border overflow-hidden transition-all"
                style={{
                  borderColor: isPicked ? CREAM : "color-mix(in srgb, var(--foreground) 30%, transparent)",
                  background: "color-mix(in srgb, var(--foreground) 6%, transparent)",
                  outline: "none",
                }}
                title={t.name}
              >
                {avatar && (
                  <img
                    src={avatar}
                    alt={t.name}
                    className="absolute inset-0 w-full h-full object-cover"
                    style={{
                      transform: "scale(1.08)",
                      opacity: isPicked ? 1 : 0.75,
                    }}
                  />
                )}
                <div
                  className="absolute inset-x-0 bottom-0 px-1.5 py-1 font-mono text-[13px] text-center"
                  style={{
                    color: isPicked ? CREAM : "color-mix(in srgb, var(--foreground) 80%, transparent)",
                    background:
                      "linear-gradient(180deg, color-mix(in srgb, var(--background) 0%, transparent) 0%, color-mix(in srgb, var(--background) 90%, transparent) 100%)",
                  }}
                >
                  {t.name}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {picked && (
        <>
          {/* Job — 6-7 words, what this persona does */}
          <label className="flex flex-col gap-1">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Job · in 6–7 words
            </span>
            <input
              value={job}
              onChange={(e) => setJob(e.target.value)}
              maxLength={60}
              placeholder="e.g. Reviews my PRs and runs the tests"
              className="text-[13.5px] px-3 py-2 border focus:outline-none"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
          </label>

          {/* Description — multi-line free text */}
          <label className="flex flex-col gap-1">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="A few lines on what this persona is for and when to summon it. Optional."
              className="text-[13px] px-3 py-2 border focus:outline-none resize-none"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                lineHeight: 1.5,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
          </label>

          {/* System prompt — the instructions the persona runs under.
              Optional in the wizard; leave blank to inherit the template's
              built-in prompt. */}
          <label className="flex flex-col gap-1">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              System prompt · optional
            </span>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={10}
              maxLength={20000}
              placeholder="You are [Name]. You handle …  Leave blank to use the template default."
              className="font-mono text-[13px] px-3 py-2 border focus:outline-none resize-y"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                lineHeight: 1.55,
                minHeight: "200px",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
            >
              {promptDraft.length} / 20000
            </span>
          </label>

          {/* Model */}
          <label className="flex flex-col gap-1 relative">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Model
            </span>
            <button
              type="button"
              onClick={() => setModelDropdownOpen((v) => !v)}
              className="font-mono text-[13px] px-3 py-2 border inline-flex items-center gap-2 text-left"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: modelDropdownOpen ? CREAM : "color-mix(in srgb, var(--foreground) 40%, transparent)",
              }}
            >
              <ProviderLogoChip provider={modelOverride?.provider ?? null} size={16} />
              <span className="truncate flex-1">
                {modelOverride
                  ? modelOverride.name.length > 32
                    ? modelOverride.name.split("/").pop()?.replace(":free", " · free")
                    : modelOverride.name
                  : "— pick a model —"}
              </span>
              <span style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>▾</span>
            </button>
            {modelDropdownOpen && modelsData && (
              <ModelDropdown
                catalog={modelsData.catalog}
                current={
                  modelOverride ?? {
                    provider: picked.defaultModel.provider,
                    name: picked.defaultModel.name,
                  }
                }
                onPick={(p, n) => {
                  setModelOverride({
                    provider: p,
                    name: n,
                    ...(modelSupportsEffort(n)
                      ? { effort: modelOverride?.effort ?? DEFAULT_EFFORT }
                      : {}),
                  });
                  setModelDropdownOpen(false);
                }}
                onClose={() => setModelDropdownOpen(false)}
              />
            )}
          </label>

          {/* Effort dial — only for models with a reasoning-effort knob. */}
          {modelOverride && modelSupportsEffort(modelOverride.name) && (
            <EffortDial
              value={modelOverride.effort ?? DEFAULT_EFFORT}
              onChange={(level) =>
                setModelOverride({ ...modelOverride, effort: level })
              }
            />
          )}

          {error && (
            <div
              className="font-mono text-[13px]"
              style={{ color: "var(--warn)" }}
            >
              {error}
            </div>
          )}

          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !picked || !modelOverride}
            className="font-mono px-3 py-2.5 border text-[13px] transition-colors disabled:opacity-40"
            style={{
              background: CREAM,
              color: BG,
              borderColor: CREAM,
            }}
          >
            {saving ? "Saving…" : `Create ${picked.name}`}
          </button>
        </>
      )}
    </div>
  );
}

// Persona card. Shows just three fields (name / job / model) — every other
// piece of the YAML schema (skills, tools, system_prompt, summon_phrases)
// stays under the hood and is only edited via Claude Code prompts.
//
// Inline edit:
//   • Click the JOB text → text input replaces it; Enter saves
//   • Click the MODEL chip → dropdown overlay; pick saves
//   • Name is NOT inline-editable here — the id drives Hermes' routing,
//     so renaming is a separate "Rename" prompt for Claude Code.
//
// Sync badge sits top-right of the image: synced (green) / local edits
// (amber) / not synced (grey). Refetches when the YAML is updated.
function PersonaCard({
  persona,
  syncStatus,
  hasRepo,
}: {
  persona: PersonaYaml;
  syncStatus: SyncStatus | undefined;
  hasRepo: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const avatar = PERSONA_AVATAR_BY_ID[persona.id.toLowerCase()];
  const jobLabel = personaJob(persona);
  return (
    <>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group relative border overflow-hidden flex flex-col transition-all text-left w-full"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
          background: "var(--inset)",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 85%, transparent)")
        }
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
        title={`Edit ${persona.name}`}
      >
        <div className="aspect-square relative overflow-hidden">
          {avatar ? (
            <img
              src={avatar}
              alt={persona.name}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              style={{ transform: "scale(1.08)" }}
              loading="lazy"
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--foreground) 6%, transparent)" }}
            >
              <span className="font-sans font-semibold" style={{ color: CREAM, fontSize: 64 }}>
                {persona.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div
            aria-hidden
            className="absolute inset-2 pointer-events-none"
            style={{ border: "1px solid color-mix(in srgb, var(--foreground) 45%, transparent)" }}
          />
          <SyncBadge status={syncStatus} hasRepo={hasRepo} />
          {/* "Edit" pill that fades in on hover so it's obvious the card
              is interactive. */}
          <span
            className="font-mono absolute bottom-2 right-2 inline-flex items-center gap-1 px-2 py-1 border text-[13px] opacity-0 group-hover:opacity-100 transition-opacity"
            style={{
              background: "color-mix(in srgb, var(--background) 92%, transparent)",
              color: CREAM,
              borderColor: CREAM,
            }}
          >
            <PenLine style={{ width: 10, height: 10 }} />
            Edit
          </span>
        </div>

        <div className="p-4 flex flex-col gap-1.5">
          <h3
            className="font-sans font-semibold leading-none truncate"
            style={{ color: CREAM, fontSize: "20px", letterSpacing: "0.04em" }}
          >
            {persona.name}
          </h3>
          <p
            className="text-[13.5px] leading-snug line-clamp-2"
            style={{ color: "color-mix(in srgb, var(--foreground) 78%, transparent)" }}
          >
            {jobLabel}
          </p>
          <span
            className="font-mono text-[13px] pl-1 pr-1.5 py-1 border inline-flex items-center gap-1.5 mt-1 self-start"
            style={{
              color: CREAM,
              borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              background: "color-mix(in srgb, var(--foreground) 6%, transparent)",
            }}
          >
            <ProviderLogoChip provider={persona.model.provider} size={16} />
            <span className="truncate max-w-[180px]">
              {persona.model.name.length > 24
                ? persona.model.name.split("/").pop()?.replace(":free", " · free")
                : persona.model.name}
            </span>
            {persona.model.effort && (
              <span
                className="shrink-0"
                title={`Effort dial: ${persona.model.effort}`}
                style={{ color: "var(--brand)" }}
              >
                · {persona.model.effort}
              </span>
            )}
          </span>
        </div>
      </button>
      {editing && (
        <PersonaEditModal persona={persona} onClose={() => setEditing(false)} />
      )}
    </>
  );
}

// Full-screen modal for editing a persona — name (read-only), job (multi-
// line textarea), model (big rich dropdown), summon phrase (copy), and a
// Delete button (with confirm). All edits PUT to disk immediately; the
// dashboard refetches.
function PersonaEditModal({
  persona,
  onClose,
}: {
  persona: PersonaYaml;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: models } = useHermesModels();
  const [jobDraft, setJobDraft] = useState(personaJob(persona));
  const [descriptionDraft, setDescriptionDraft] = useState(persona.description ?? "");
  const [promptDraft, setPromptDraft] = useState(
    persona.behavior?.system_prompt ?? "",
  );
  const [model, setModel] = useState(persona.model);
  const [modelOpen, setModelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const { copied: copiedPhrase, failed: phraseFailed, copy: copyPhraseText } = useCopyState(1500);
  const avatar = PERSONA_AVATAR_BY_ID[persona.id.toLowerCase()];
  const primaryPhrase = persona.summon_phrases?.[0] ?? persona.name;
  const originalPrompt = persona.behavior?.system_prompt ?? "";
  const dirty =
    jobDraft !== personaJob(persona) ||
    descriptionDraft !== (persona.description ?? "") ||
    promptDraft !== originalPrompt ||
    model.name !== persona.model.name ||
    model.provider !== persona.model.provider ||
    (model.effort ?? null) !== (persona.model.effort ?? null);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      // Patch: only send fields that actually changed so we don't blow
      // away unrelated YAML keys (skills, tools, summon_phrases).
      const patch: any = {};
      if (jobDraft.trim() !== personaJob(persona)) patch.job = jobDraft.trim();
      if (descriptionDraft.trim() !== (persona.description ?? "").trim()) {
        patch.description = descriptionDraft.trim();
      }
      if (promptDraft.trim() !== originalPrompt.trim()) {
        patch.behavior = { system_prompt: promptDraft.trim() };
      }
      if (
        model.name !== persona.model.name ||
        model.provider !== persona.model.provider ||
        (model.effort ?? null) !== (persona.model.effort ?? null)
      ) {
        // effort: null tells the backend to drop the key — the model was
        // switched to one without a reasoning-effort knob. Only the three fields the editor owns:
        // a hand-added key in the YAML (e.g. temperature) is not re-sent, so the save isn't refused.
        patch.model = { provider: model.provider, name: model.name, effort: model.effort ?? null };
      }
      setSaveError(null);
      await updatePersona(persona.id, patch);
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon"] });
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon-sync"] });
      onClose();
    } catch (e) {
      // Keep the editor open and say why.
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    try {
      const t = await fetch("/__token").then((r) => r.json());
      await fetch(`/__hermes_pantheon/${encodeURIComponent(persona.id)}`, {
        method: "DELETE",
        headers: { "X-Claude-OS-Token": t.token },
      });
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon"] });
      await queryClient.invalidateQueries({ queryKey: ["hermes-pantheon-sync"] });
      onClose();
    } catch {
      /* */
    } finally {
      setSaving(false);
    }
  }

  function copyPhrase() {
    void copyPhraseText(primaryPhrase);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "color-mix(in srgb, black 70%, transparent)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="border max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row"
        style={{
          borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)",
          background: BG,
          boxShadow: "0 24px 64px color-mix(in srgb, black 60%, transparent)",
        }}
      >
        {/* LEFT — big square portrait. */}
        <div
          className="relative shrink-0 overflow-hidden"
          style={{ width: 240, minHeight: 240 }}
        >
          {avatar ? (
            <img
              src={avatar}
              alt={persona.name}
              className="absolute inset-0 w-full h-full object-cover"
              style={{ transform: "scale(1.08)" }}
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--foreground) 6%, transparent)" }}
            >
              <span className="font-sans font-semibold" style={{ color: CREAM, fontSize: 80 }}>
                {persona.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div
            aria-hidden
            className="absolute inset-3 pointer-events-none"
            style={{ border: "1px solid color-mix(in srgb, var(--foreground) 50%, transparent)" }}
          />
        </div>

        {/* RIGHT — fields. */}
        <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div
                className="font-mono text-[13px]"
                style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
              >
                Persona · {persona.id}
              </div>
              <h2
                className="font-sans font-semibold leading-none mt-1"
                style={{ color: CREAM, fontSize: 28, letterSpacing: "0.03em" }}
              >
                {persona.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[13px] transition-colors"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = CREAM)}
              onMouseLeave={(e) => (e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 60%, transparent)")}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>

          {/* Job */}
          <label className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Job — what should this persona do?
            </span>
            <input
              value={jobDraft}
              onChange={(e) => setJobDraft(e.target.value)}
              maxLength={60}
              placeholder="In 6 or 7 words"
              className="text-[13.5px] px-3 py-2 border focus:outline-none"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
          </label>

          {/* Description — multi-line, what the persona is for and when
              to use it. 4-5 lines is the sweet spot. */}
          <label className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Description
            </span>
            <textarea
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              rows={4}
              maxLength={500}
              placeholder="A few lines on what this persona is for and when to summon it."
              className="text-[13px] px-3 py-2 border focus:outline-none resize-none"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                lineHeight: 1.5,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
          </label>

          {/* System prompt — the actual instructions Hermes loads when
              the persona is summoned. This is where the behaviour lives. */}
          <label className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              System prompt — how the persona behaves
            </span>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={14}
              maxLength={20000}
              placeholder="You are [Name]. You handle …"
              className="font-mono text-[13px] px-3 py-2 border focus:outline-none resize-y"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                lineHeight: 1.55,
                minHeight: "280px",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
              onBlur={(e) => (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 40%, transparent)")}
            />
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
            >
              {promptDraft.length} / 20000
            </span>
          </label>

          {/* Model */}
          <label className="flex flex-col gap-1.5 relative">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Model
            </span>
            <button
              type="button"
              onClick={() => setModelOpen((v) => !v)}
              className="font-mono text-[13px] px-3 py-2 border inline-flex items-center gap-2 text-left transition-colors"
              style={{
                background: "var(--inset)",
                color: CREAM,
                borderColor: modelOpen ? CREAM : "color-mix(in srgb, var(--foreground) 40%, transparent)",
              }}
            >
              <ProviderLogoChip provider={model.provider} size={18} />
              <span className="flex-1 truncate">
                {model.name.length > 32
                  ? model.name.split("/").pop()?.replace(":free", " · free")
                  : model.name}
              </span>
              <span style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>▾</span>
            </button>
            {modelOpen && models && (
              <ModelDropdown
                catalog={models.catalog}
                current={model}
                onPick={(p, n) => {
                  setModel({
                    provider: p,
                    name: n,
                    ...(modelSupportsEffort(n)
                      ? { effort: model.effort ?? DEFAULT_EFFORT }
                      : {}),
                  });
                  setModelOpen(false);
                }}
                onClose={() => setModelOpen(false)}
              />
            )}
          </label>

          {/* Effort dial — only for models with a reasoning-effort knob. */}
          {modelSupportsEffort(model.name) && (
            <EffortDial
              value={model.effort ?? DEFAULT_EFFORT}
              onChange={(level) => setModel({ ...model, effort: level })}
            />
          )}

          {/* Summon phrase — read-only with copy */}
          <div className="flex flex-col gap-1.5">
            <span
              className="font-mono text-[13px]"
              style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            >
              Summon phrase
            </span>
            <button
              type="button"
              onClick={copyPhrase}
              className="flex items-center gap-2 px-3 py-2 border text-left transition-colors"
              style={{
                background: copiedPhrase
                  ? "color-mix(in srgb, var(--success) 12%, transparent)"
                  : "var(--inset)",
                borderColor: copiedPhrase
                  ? "color-mix(in srgb, var(--success) 55%, transparent)"
                  : "color-mix(in srgb, var(--foreground) 30%, transparent)",
              }}
            >
              <span
                className="font-mono text-[13px] flex-1"
                style={{ color: copiedPhrase ? "var(--success)" : CREAM }}
              >
                {copiedPhrase ? "Copied!" : phraseFailed ? "Couldn't copy" : `"${primaryPhrase}"`}
              </span>
            </button>
          </div>

          {/* Action row */}
          <div className="flex items-center justify-between gap-3 mt-2 pt-3 border-t" style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}>
            {deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span
                  className="font-mono text-[13px]"
                  style={{ color: "var(--danger)" }}
                >
                  Delete this persona?
                </span>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={saving}
                  className="font-mono px-3 py-1.5 border text-[13px] transition-colors"
                  style={{
                    background: "var(--danger)",
                    color: BG,
                    borderColor: "var(--danger)",
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  className="font-mono text-[13px]"
                  style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
                >
                  cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                className="font-mono text-[13px] transition-colors"
                style={{ color: "color-mix(in srgb, var(--danger) 70%, transparent)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "color-mix(in srgb, var(--danger) 70%, transparent)")
                }
              >
                Delete persona
              </button>
            )}
            {saveError && (
              <div role="alert" className="font-mono text-[13px]" style={{ color: "var(--warn)" }}>
                Couldn't save: {saveError}
              </div>
            )}
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="font-mono px-3 py-2 border text-[13px] transition-colors"
                style={{
                  background: "transparent",
                  color: CREAM,
                  borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !dirty}
                className="font-mono px-4 py-2 border text-[13px] transition-colors disabled:opacity-40"
                style={{
                  background: CREAM,
                  color: BG,
                  borderColor: CREAM,
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SyncBadge({
  status,
  hasRepo,
}: {
  status: SyncStatus | undefined;
  hasRepo: boolean;
}) {
  // Resolve the label + colour. When there's no repo at all we render a
  // single grey "not synced" badge so it's obvious the user hasn't yet
  // hooked their Hermes up to GitHub.
  let label: string;
  let color: string;
  let dotColor: string;
  if (!hasRepo) {
    label = "not synced";
    color = "color-mix(in srgb, var(--foreground) 55%, transparent)";
    dotColor = "color-mix(in srgb, var(--foreground) 40%, transparent)";
  } else if (status === "synced") {
    label = "synced";
    color = "var(--success)";
    dotColor = "var(--success)";
  } else if (status === "untracked") {
    label = "new · push me";
    color = "var(--brand)";
    dotColor = "var(--brand)";
  } else if (status === "dirty") {
    label = "local edits";
    color = "var(--brand)";
    dotColor = "var(--brand)";
  } else {
    label = "—";
    color = "color-mix(in srgb, var(--foreground) 55%, transparent)";
    dotColor = "color-mix(in srgb, var(--foreground) 40%, transparent)";
  }
  return (
    <span
      className="font-mono absolute top-2 right-2 inline-flex items-center gap-1.5 px-2 py-1 border text-[13px]"
      style={{
        background: "color-mix(in srgb, var(--background) 92%, transparent)",
        color,
        borderColor: color,
      }}
    >
      <span
        className="inline-block rounded-full"
        style={{ width: 6, height: 6, background: dotColor }}
      />
      {label}
    </span>
  );
}

function ModelDropdown({
  catalog,
  current,
  onPick,
  onClose,
}: {
  catalog: ModelCatalogEntry[];
  current: PersonaModel;
  onPick: (provider: string, name: string) => void;
  onClose: () => void;
}) {
  // Close on outside click.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const TIER_LABEL: Record<string, string> = {
    frontier: "frontier",
    top: "top",
    mid: "mid",
    cheap: "cheap",
    free: "free",
  };
  return (
    <div
      ref={ref}
      className="absolute z-30 top-full left-0 mt-1 max-h-72 overflow-y-auto border min-w-[260px]"
      style={{
        background: "color-mix(in srgb, var(--background) 98%, transparent)",
        borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)",
        boxShadow: "0 12px 28px color-mix(in srgb, black 55%, transparent)",
      }}
    >
      {catalog.map((group) => (
        <div key={group.provider}>
          <div
            className="font-mono text-[13px] px-3 py-1.5 border-b sticky top-0"
            style={{
              color: "color-mix(in srgb, var(--foreground) 55%, transparent)",
              borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)",
              background: "color-mix(in srgb, var(--background) 98%, transparent)",
            }}
          >
            {group.provider}
          </div>
          {group.models.map((m) => {
            const isCurrent =
              group.provider.toLowerCase() === current.provider.toLowerCase() &&
              m.name === current.name;
            return (
              <button
                key={`${group.provider}-${m.name}`}
                type="button"
                onClick={() => onPick(group.provider, m.name)}
                title={
                  modelSupportsEffort(m.name)
                    ? "Supports the effort dial"
                    : undefined
                }
                className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                style={{
                  background: isCurrent ? "color-mix(in srgb, var(--foreground) 8%, transparent)" : "transparent",
                  color: CREAM,
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "color-mix(in srgb, var(--foreground) 6%, transparent)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = isCurrent
                    ? "color-mix(in srgb, var(--foreground) 8%, transparent)"
                    : "transparent")
                }
              >
                <ProviderLogoChip provider={group.provider} size={14} />
                <span
                  className="font-mono text-[13px] truncate flex-1"
                  style={{ color: CREAM }}
                >
                  {m.name.length > 32
                    ? m.name.split("/").pop()?.replace(":free", " · free")
                    : m.name}
                </span>
                <span
                  className="font-mono text-[13px] shrink-0"
                  title={m.cost}
                  style={{
                    color:
                      m.tier === "free"
                        ? "var(--success)"
                        : m.tier === "frontier"
                          ? "var(--chart-5)"
                          : m.tier === "top"
                            ? "var(--brand)"
                            : "color-mix(in srgb, var(--foreground) 55%, transparent)",
                    textShadow:
                      m.tier === "frontier"
                        ? "0 0 10px color-mix(in srgb, var(--chart-5) 45%, transparent)"
                        : undefined,
                  }}
                >
                  {TIER_LABEL[m.tier]}
                  {/* The route, so a plan or a meter is never read as free. */}
                  {m.route === "subscription" ? " · plan" : m.route === "metered" ? " · metered" : ""}
                </span>
                {isCurrent && (
                  <CheckCircle2 className="h-3.5 w-3.5" style={{ color: CREAM }} />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Effort dial — five-stop meter for models that expose a reasoning-effort
// knob (currently Fable 5). Ticks rise like a gauge; the active stop and
// everything below it light amber. Persisted to the YAML as model.effort.
function EffortDial({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const activeIdx = EFFORT_LEVELS.indexOf(value);
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
      >
        Effort dial
      </span>
      <div
        className="flex items-stretch border"
        style={{
          background: "var(--inset)",
          borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
        }}
      >
        {EFFORT_LEVELS.map((level, i) => {
          const lit = i <= activeIdx;
          const isActive = i === activeIdx;
          return (
            <button
              key={level}
              type="button"
              onClick={() => onChange(level)}
              title={EFFORT_HINT[level]}
              className="flex-1 flex flex-col items-center justify-end gap-1.5 pt-2 pb-1.5 transition-colors"
              style={{
                background: isActive ? "color-mix(in srgb, var(--success) 8%, transparent)" : "transparent",
                borderRight:
                  i < EFFORT_LEVELS.length - 1
                    ? "1px solid color-mix(in srgb, var(--foreground) 15%, transparent)"
                    : "none",
              }}
            >
              <span
                className="w-1.5 transition-all"
                style={{
                  height: 6 + i * 4,
                  background: lit ? EFFORT_COLOR[level] : "color-mix(in srgb, var(--foreground) 18%, transparent)",
                }}
              />
              <span
                className="font-mono text-[13px]"
                style={{
                  color: isActive ? EFFORT_COLOR[level] : "color-mix(in srgb, var(--foreground) 45%, transparent)",
                }}
              >
                {level}
              </span>
            </button>
          );
        })}
      </div>
      <span
        className="font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
      >
        {EFFORT_HINT[value]}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
// GitHub sync — single-prompt bootstrap for a private <user>-pantheon repo.
// We don't shell out to git ourselves; we draft the prompt the user pastes
// into Claude Code (which already has filesystem + gh CLI creds). Cleanest
// separation: Hermes runs the personas at runtime, Claude Code provisions
// the infrastructure once at setup.
// ────────────────────────────────────────────────────────────────────────────
// Two-card GitHub sync. Each card shows: step number, title, explainer copy,
// the actual prompt VISIBLE (not hidden behind copy), and a one-click copy
// button. Branded as "backup & sync" not "mirror".
const GH_SYNC_STEPS: Array<{
  step: number;
  title: string;
  /** Properly detailed explainer — what runs, where it writes, what the
   *  user gets afterwards. Replaces the old one-line `hint`. */
  body: string;
  cta: string;
  prompt: string;
  accent: string;
}> = [
  {
    step: 1,
    title: "Connect Hermes to GitHub",
    body:
      "Paste this into Hermes. She'll tell you what she needs from you (gh CLI auth, the repo name you'd like), then create a private GitHub repo and mirror ~/.hermes/ into it — config, personas, skills, memories. Sensitive runtime state stays on your machine. She'll also wire a daily cron so the backup keeps itself fresh. One-time setup.",
    cta: "Copy → paste into Hermes",
    accent: "var(--brand)",
    prompt: `Hey Hermes — I want to back you up to a private GitHub repo so I can take you to any machine.

First, tell me up-front what you need from me to make this work (gh CLI auth, my GitHub username, the repo name you'd suggest). Wait for me to confirm before doing anything.

Then once I confirm:
1. Create a private GitHub repo named <username>/hermes-mirror.
2. Mirror everything at ~/.hermes/ into ~/code/hermes-mirror/, EXCLUDING anything that shouldn't be pushed — sessions/, auth*, state*, logs/, .env, gateway.pid, audio_cache/, image_cache/, sandboxes/, checkpoints/, and any file content matching /api[_-]?key|secret|password|token/i.
3. Add a clear README explaining the layout so future-me (on a new machine) can make sense of it: config.yaml, pantheon/, skills/, memories/, SOUL.md.
4. Push it.
5. Wire a daily 'hermes cron' that re-runs the rsync + commit + push automatically, so the backup keeps itself fresh.
6. Confirm the repo URL + cron schedule, then stop.

If you see anything that looks like a credential, abort and tell me. If anything else is unclear, ask before acting.`,
  },
  {
    step: 2,
    title: "Push personas to GitHub",
    body:
      "Paste this into Hermes after you've connected the repo. The prompt below auto-includes whichever personas are currently on your disk — so when you add a new one (like Orpheus), it'll show up in the list. She'll save a persistent rule that ANY YAML in your pantheon folder is auto-discoverable — so future personas you add via the dashboard get picked up automatically, no re-introduction needed. Then she'll push the current pantheon to GitHub. Run it any time after editing a persona to capture the change.",
    cta: "Copy → paste into Hermes",
    accent: "var(--success)",
    prompt: "", // dynamically built per-render from the live persona list — see buildPushPrompt()
  },
];

// Build the GitHub-push prompt fresh from the live persona list, so when
// the operator adds a new persona (e.g. Orpheus) the copied text explicitly
// names it. Falls back to the generic prompt if the personas haven't loaded.
function buildPushPrompt(personas: PersonaYaml[]): string {
  const haveList =
    personas.length > 0
      ? personas
          .map((p) => `   • ${p.id}.yaml — ${p.name} (${p.model?.name ?? "model unset"}) — ${p.job}`)
          .join("\n")
      : "   • (the personas in your pantheon folder right now)";

  const namesInline =
    personas.length > 0
      ? personas.map((p) => `'${p.name}'`).join(", ")
      : "'Labyrinth', 'Mercury', any new name the operator adds";

  return `Hey Hermes — I've created a set of personas in ~/.hermes/pantheon/personas/. Here's what's on disk right now (${personas.length} persona${personas.length === 1 ? "" : "s"}):

${haveList}

Here's what I want:

1. Save this to your persistent memory (memory tool, not just this turn) so it carries across every future session:

   "The folder ~/.hermes/pantheon/personas/ is the operator's pantheon. ANY YAML file in this folder is a callable persona — these names are FIRST-CLASS LOCAL ENTITIES that take priority over any same-named external thing.

   At the start of EVERY turn:
   1. List the YAMLs in ~/.hermes/pantheon/personas/ to know what personas exist right now (e.g. ${namesInline} — but always re-scan; the operator may add more).
   2. Scan the operator's message for any proper noun that matches a persona name (case-insensitive).
   3. If a match is found, ALWAYS interpret it as a reference to that local persona FIRST. Do NOT assume the operator means an external project, model, library, or famous figure with the same name. Examples:
      - 'Tell me about Orpheus' → describe the operator's Orpheus persona by reading orpheus.yaml. Do NOT ask 'do you mean Orpheus TTS?'.
      - 'Use Orpheus to ...' → load the Orpheus persona (model, system_prompt, skill bundle) for that turn, then return to default.
      - 'What's the difference between Athena and Mercury?' → compare the operator's two personas by reading their YAMLs.
   4. Only if the operator explicitly disambiguates (e.g. 'I mean the Orpheus TTS model, not my persona') OR if no matching YAML exists, fall back to external interpretation.
   5. New YAMLs dropped into this folder are auto-discoverable; never tell the operator to re-introduce a persona they've created."

2. Read each YAML currently in the folder and confirm back to me what they are, what model they use, and what they're best for.

3. Push the latest pantheon to GitHub right now: rsync ~/.hermes/pantheon/ into ~/code/hermes-mirror/pantheon/ (with --delete), git add -A, commit "sync personas $(date +%F-%H%M)", and push.

4. Print the commit URL.

Do steps 1 and 2 first and wait for me to confirm before pushing.`;
}

function HermesPantheonGitHubSync() {
  // Pull the live persona list so step 2's prompt can name them explicitly
  // when the operator clicks copy.
  const { data } = useHermesPantheon();
  const personas = data?.personas ?? [];
  return (
    <section className="mb-12">
      <SectionHead
        title="Take Hermes anywhere"
        meta="private repo · portable across machines"
      />
      <div
        className="text-[15px] leading-relaxed mt-3 mb-5 max-w-3xl"
        style={{ color: "color-mix(in srgb, var(--foreground) 78%, transparent)" }}
      >
        Two prompts to paste into Hermes: connect it to a private GitHub repo, then push your personas.
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {GH_SYNC_STEPS.map((s) => {
          // Step 2's prompt is built fresh from the live pantheon so newly
          // added personas (Orpheus, etc.) appear by name in the copied text.
          const promptOverride =
            s.step === 2 ? buildPushPrompt(personas) : undefined;
          return (
            <GHSyncStepCard
              key={s.step}
              step={s}
              promptOverride={promptOverride}
            />
          );
        })}
      </div>
    </section>
  );
}

function GHSyncStepCard({
  step,
  promptOverride,
}: {
  step: (typeof GH_SYNC_STEPS)[number];
  promptOverride?: string;
}) {
  const { copied, failed, copy } = useCopyState(1500);
  const queryClient = useQueryClient();
  const promptToCopy = promptOverride ?? step.prompt;
  function handleCopy() {
    void copy(promptToCopy).then((ok) => {
      if (!ok) return;
      // Copying the prompt is the user's "I'm about to run this in Hermes"
      // signal. Hermes typically completes the rsync + push in 15-30s,
      // sometimes longer. Re-poll the sync endpoint every 5s for the next
      // 90s so the badges flip from dirty → synced the moment Hermes
      // actually finishes — without lying about state in the meantime.
      let polls = 0;
      const id = setInterval(() => {
        polls += 1;
        void queryClient.invalidateQueries({ queryKey: ["hermes-pantheon-sync"] });
        void queryClient.invalidateQueries({ queryKey: ["hermes-pantheon"] });
        if (polls >= 18) clearInterval(id);
      }, 5000);
    });
  }
  return (
    <Surface className="flex flex-col gap-3 sm:flex-row" padding="md">
      {/* Step number — no hero art; the number and title carry the card. */}
      <div className="flex shrink-0 items-center gap-3 sm:w-48 sm:flex-col sm:items-start">
        <span
          className="font-sans font-semibold ds-num"
          style={{ color: step.accent, fontSize: 32, lineHeight: 1 }}
        >
          {String(step.step).padStart(2, "0")}
        </span>
        <div className="text-base font-semibold leading-tight text-foreground">{step.title}</div>
      </div>

      {/* Body — explainer + visible prompt + copy. */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="text-sm leading-relaxed text-muted-foreground">{step.body}</div>
        <pre
          className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-inset p-3 max-h-52 overflow-y-auto flex-1 text-foreground/85"
          onWheel={forwardWheelAtBoundary}
        >
          {promptToCopy}
        </pre>
        <Button
          type="button"
          variant={copied ? "default" : "accent"}
          size="sm"
          onClick={handleCopy}
          className="self-start"
        >
          {copied ? "Copied — paste into Hermes" : failed ? "Couldn't copy: select the prompt above" : step.cta}
        </Button>
      </div>
    </Surface>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Memory section — Hermes' memory layout, rendered as a manuscript.
// Composes: manuscript hero (USER+MEMORY), SOUL panel, provider strip,
// 3D memory graph, Obsidian bridge. Per-profile memory grid is appended
// when more than one profile exists.
// ────────────────────────────────────────────────────────────────────────────
function HermesMemorySection() {
  const { data, isLoading } = useHermesMemory();
  if (isLoading || !data) {
    return (
      <section className="mb-12">
        <SectionHead title="Memory" meta="reading ~/.hermes/memories/" />
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </section>
    );
  }
  return (
    <section className="mb-12">
      <SectionHead
        title="Memory"
        meta={`${data.hermesHome} · ${data.sessionCount} sessions · ${data.skillCount} skills`}
      />
      <div
        className="text-[13px] leading-relaxed mt-3 mb-5 max-w-3xl"
        style={{ color: "color-mix(in srgb, var(--foreground) 70%, transparent)" }}
      >
        Everything Hermes remembers about you and itself. Two short markdown files Hermes
        curates by hand — a strict char budget means every entry has earned its place.
      </div>

      {/* Three Hermes-specific layers side-by-side: USER, MEMORY, SOUL.
          Pantheon image is a background underlay on each card (same
          pattern as the chat panel's labyrinth backdrop) — the markdown
          stays the focus, the imagery is ambient texture. */}
      <MemoryThreeLayers user={data.user} memory={data.memory} soul={data.soul} />

      {/* Conversation history — full-width strip linking out to the
          searchable archive. Different shape from the manuscript pages
          above so it reads as a callout, not a fourth layer. */}
      <div className="mt-5">
        <ConversationHistoryStrip sessionCount={data.sessionCount} />
      </div>

      {/* Bridges — Hermes ↔ external systems. Obsidian (your notes app)
          and Claude OS (this dashboard) are conceptually the same shape:
          both are "Hermes reaches over to read X". 2-col so they tell
          the story together. */}
      <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ObsidianBridge hermesHome={data.hermesHome} />
        <HermesClaudeOsBridgeCard />
      </div>

      {data.profiles.length > 1 && (
        <div className="mt-5">
          <ProfileMemoryGrid profiles={data.profiles} />
        </div>
      )}

      {/* Mnemosyne (3D constellation) deliberately omitted — with Hermes'
          current low-volume memory (a handful of fragments), a force
          graph looks depopulated and adds visual noise without surfacing
          new information beyond what the manuscript pages above already
          render. The component still lives at src/components/hermes-mnemosyne.tsx
          for the day there are hundreds of memories worth visualising. */}
    </section>
  );
}

// Three Hermes-specific memory layers rendered as visually-identical
// cards. Pantheon image is a background underlay on each, with a strong
// dark wash so the markdown stays legible. Oracle = USER, Labyrinth =
// AGENT MEMORY, Philosopher = SOUL.
function MemoryThreeLayers({
  user,
  memory,
  soul,
}: {
  user: HermesMemoryData["user"];
  memory: HermesMemoryData["memory"];
  soul: HermesMemoryData["soul"];
}) {
  const soulVisible = soul.content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^---[\s\S]*?---/, "")
    .trim();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <ManuscriptPage
        title="User Profile"
        subtitle="curated facts about you"
        file="USER.md"
        content={user.content}
        charCount={user.charCount}
        charLimit={user.charLimit}
        avatar={PERSONA_AVATAR_BY_ID.oracle}
        emptyHint="Hermes hasn't learned anything about you yet. Chat with it and it'll start curating this file."
      />
      <ManuscriptPage
        title="Agent Memory"
        subtitle="learned about the system"
        file="MEMORY.md"
        content={memory.content}
        charCount={memory.charCount}
        charLimit={memory.charLimit}
        avatar={PERSONA_AVATAR_BY_ID.labyrinth}
        emptyHint="Hermes hasn't filed any system facts yet. Workflows, environment notes, and learned conventions will appear here."
      />
      <ManuscriptPage
        title="Soul"
        subtitle="personality, not memory"
        file="SOUL.md"
        content={soulVisible}
        // No char ring on SOUL — it's not a curated-fact list, just prose.
        charCount={0}
        charLimit={0}
        avatar={PERSONA_AVATAR_BY_ID.philosopher}
        emptyHint="No voice defined yet — Hermes will speak in its default tone. Edit SOUL.md to teach it how to talk."
      />
    </div>
  );
}

function ManuscriptPage({
  title,
  subtitle,
  file,
  content,
  charCount,
  charLimit,
  emptyHint,
  avatar,
  italic = false,
  hideRing = false,
}: {
  title: string;
  subtitle: string;
  file: string;
  content: string;
  charCount: number;
  charLimit: number;
  emptyHint: string;
  /** Small persona mark shown beside the title — no longer a full-bleed
   *  background underlay (docs/DESIGN-SYSTEM.md § 8: agent/persona identity
   *  is a mark, never page or card art). */
  avatar?: string;
  /** SOUL renders prose in italic. */
  italic?: boolean;
  /** SOUL is free-form prose, not a curated-fact budget — no ring. */
  hideRing?: boolean;
}) {
  const fragments = content
    .split(/\n?§\n?/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pct =
    charLimit > 0 ? Math.min(100, Math.round((charCount / charLimit) * 100)) : 0;
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="relative flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        {avatar && (
          <img
            src={avatar}
            alt=""
            aria-hidden
            className="h-8 w-8 shrink-0 rounded-full border border-border object-cover"
          />
        )}
        <div className="min-w-0">
          <div
            className="font-sans font-semibold leading-none truncate"
            style={{ color: CREAM, fontSize: "18px", letterSpacing: "0.04em" }}
          >
            {title}
          </div>
          <div
            className="font-mono text-[13px] mt-1"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
          >
            {subtitle} · {file}
          </div>
        </div>
        {!hideRing && (
          <CharCountRing pct={pct} count={charCount} limit={charLimit} />
        )}
      </div>

      {/* Body */}
      {/* Body — internally scrollable so all fragments are reachable
          even in the 3-up layout where each card is narrow. */}
      <div
        className="relative px-5 py-4 flex flex-col gap-3 overflow-y-auto"
        style={{ minHeight: 200, maxHeight: 320 }}
        onWheel={forwardWheelAtBoundary}
      >
        {fragments.length === 0 ? (
          <div
            className="text-[13px] italic leading-relaxed"
            style={{ color: "color-mix(in srgb, var(--foreground) 62%, transparent)" }}
          >
            {emptyHint}
          </div>
        ) : italic ? (
          // SOUL — prose rendered as one italic quote block.
          <div className="relative">
            <span
              aria-hidden
              className="font-sans font-semibold absolute -top-2 -left-1 select-none"
              style={{
                color: "color-mix(in srgb, var(--foreground) 22%, transparent)",
                fontSize: "44px",
                lineHeight: 1,
              }}
            >
              “
            </span>
            <p
              className="text-[14px] italic leading-relaxed pl-7"
              style={{ color: CREAM }}
            >
              {content.trim()}
            </p>
          </div>
        ) : (
          // USER / MEMORY — fragments split on `§`
          fragments.map((f, i) => (
            <div key={i} className="flex gap-3">
              <span
                className="font-mono shrink-0 select-none"
                style={{
                  color: "color-mix(in srgb, var(--foreground) 35%, transparent)",
                  fontSize: "13px",
                  lineHeight: "20px",
                  width: "20px",
                  textAlign: "right",
                }}
              >
                §{i + 1}
              </span>
              <p
                className="text-[13.5px] leading-relaxed"
                style={{
                  color: "color-mix(in srgb, var(--foreground) 92%, transparent)",
                }}
              >
                {f}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CharCountRing({
  pct,
  count,
  limit,
}: {
  pct: number;
  count: number;
  limit: number;
}) {
  const size = 38;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const c = 2 * Math.PI * radius;
  const dash = (pct / 100) * c;
  const ringColor = pct < 80 ? CREAM : pct < 95 ? "var(--brand)" : "var(--danger)";
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      title={`${count} / ${limit} chars`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--foreground) 15%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={ringColor}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 600ms ease-out" }}
        />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center font-mono"
        style={{ color: ringColor, fontSize: "13px", letterSpacing: "0.05em" }}
      >
        {pct}%
      </div>
    </div>
  );
}

// (Removed: standalone SoulPanel — SOUL is now rendered as the third
// card in MemoryThreeLayers via ManuscriptPage's `italic` + `hideRing`
// props, so the three Hermes-specific memory layers read as a unified row.)

// (Removed: MemoryThreeLayersFallback — superseded by the full
// MemoryThreeLayers + ManuscriptPage with image-underlay refactor.)

// Short callout linking out to conversation history (sessions/state.db).
// Different from curated memory — this is the raw archive of every chat,
// already searchable via the chat-panel session sidebar.
// Paired with ObsidianBridge in a 2-col strip. Same heading/border/body
// rhythm as ObsidianBridge so the two cards read as siblings, not as a
// thin numeric callout next to a richer card.
function ConversationHistoryStrip({ sessionCount }: { sessionCount: number }) {
  return (
    <div
      className="border flex flex-col"
      style={{ borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)", background: "var(--inset)" }}
    >
      <div
        className="flex items-center gap-3 px-5 py-3 border-b"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)" }}
      >
        <div
          className="font-sans font-semibold"
          style={{ color: CREAM, fontSize: 26, letterSpacing: "0.02em", lineHeight: 1 }}
        >
          {sessionCount}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="font-sans font-semibold leading-none"
            style={{ color: CREAM, fontSize: 14, letterSpacing: "0.04em" }}
          >
            Conversation History
          </div>
          <div
            className="font-mono text-[13px] mt-1"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
          >
            {sessionCount === 1 ? "1 session" : `${sessionCount} sessions`} · sessions/ + state.db
          </div>
        </div>
      </div>
      <div
        className="px-5 py-4 text-[13px] leading-relaxed flex-1"
        style={{ color: "color-mix(in srgb, var(--foreground) 72%, transparent)" }}
      >
        Your searchable chat archive. Hermes saves selected details from these conversations in{" "}
        <span className="font-mono" style={{ color: CREAM, fontSize: "13px" }}>
          MEMORY.md
        </span>{" "}
        and{" "}
        <span className="font-mono" style={{ color: CREAM, fontSize: "13px" }}>
          USER.md
        </span>
        ; the rest stays here, searchable but not active memory.
      </div>
    </div>
  );
}

// This page has no memory-provider strip. External provider config still
// works via `hermes memory setup` in the terminal.

function ProfileMemoryGrid({ profiles }: { profiles: HermesMemoryProfile[] }) {
  return (
    <div>
      <div
        className="font-sans font-semibold leading-none mb-2"
        style={{ color: CREAM, fontSize: "14px", letterSpacing: "0.04em" }}
      >
        Per-Profile Memory
      </div>
      <div
        className="font-mono text-[13px] mb-3"
        style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
      >
        each profile keeps its own USER / MEMORY / SOUL
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
        {profiles.map((p) => {
          const avatar = PERSONA_AVATAR_BY_ID[p.name.toLowerCase()];
          return (
            <div
              key={p.name}
              className="border px-3 py-2.5 flex items-center gap-2.5"
              style={{ borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)", background: "var(--inset)" }}
            >
              {avatar ? (
                <img
                  src={avatar}
                  alt=""
                  className="shrink-0 rounded-full border border-border object-cover"
                  style={{ width: 28, height: 28 }}
                />
              ) : (
                <div
                  className="shrink-0 inline-flex items-center justify-center font-sans font-semibold"
                  style={{
                    width: 28,
                    height: 28,
                    background: "color-mix(in srgb, var(--foreground) 8%, transparent)",
                    color: CREAM,
                    fontSize: 14,
                  }}
                >
                  {p.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div
                  className="font-sans font-semibold truncate"
                  style={{ color: CREAM, fontSize: 13, letterSpacing: "0.04em" }}
                >
                  {p.name}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <FileDot label="U" present={p.hasUser} />
                  <FileDot label="M" present={p.hasMemory} />
                  <FileDot label="S" present={p.hasSoul} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileDot({ label, present }: { label: string; present: boolean }) {
  return (
    <span
      className="font-mono inline-flex items-center justify-center"
      style={{
        width: 13,
        height: 13,
        fontSize: 13,
        background: present ? "color-mix(in srgb, var(--success) 18%, transparent)" : "transparent",
        color: present ? "var(--success)" : "color-mix(in srgb, var(--foreground) 35%, transparent)",
        border: `1px solid ${present ? "color-mix(in srgb, var(--success) 50%, transparent)" : "color-mix(in srgb, var(--foreground) 25%, transparent)"}`,
        letterSpacing: 0,
      }}
      title={`${label} ${present ? "present" : "missing"}`}
    >
      {label}
    </span>
  );
}

// (Mnemosyne 3D constellation removed from the page — see comment in
// HermesMemorySection. Component file kept at
// src/components/hermes-mnemosyne.tsx for future use when memory volume
// grows. Lazy import + wrapper deleted from this route so the three.js
// chunk stops shipping in the bundle.)

// Obsidian bridge — 2-state.
//   1. NOT CONNECTED → "I have a vault" button copies the Claude Code prompt.
//      Then a "Mark as connected" pill appears once the user has run it.
//   2. CONNECTED → renders the Obsidian logo + emerald connected pill.
//      State persists in localStorage across reloads.
const OBSIDIAN_CONNECTED_KEY = "claude-os.hermes.obsidian-connected.v1";
const OBSIDIAN_VAULT_PATH_KEY = "claude-os.hermes.obsidian-vault-path.v1";

function ObsidianBridge({ hermesHome }: { hermesHome: string }) {
  const [connected, setConnected] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(OBSIDIAN_CONNECTED_KEY) === "true";
  });
  const [vaultPath, setVaultPath] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(OBSIDIAN_VAULT_PATH_KEY) ?? "";
  });
  const { copied, failed, copy } = useCopyState(1800);
  const [showPrompt, setShowPrompt] = useState(false);

  // Persist vault path as the user types, lightly debounced.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = setTimeout(() => {
      try {
        if (vaultPath.trim()) {
          window.localStorage.setItem(OBSIDIAN_VAULT_PATH_KEY, vaultPath.trim());
        } else {
          window.localStorage.removeItem(OBSIDIAN_VAULT_PATH_KEY);
        }
      } catch {
        /* ignore */
      }
    }, 350);
    return () => clearTimeout(id);
  }, [vaultPath]);

  // If the user has set an explicit vault path, bake it into the prompt
  // directly — Claude Code skips the "go find my vault" step. Otherwise
  // fall back to the auto-detect version.
  const trimmedVault = vaultPath.trim();
  const prompt = trimmedVault
    ? `I have an Obsidian vault at "${trimmedVault}". Expose my Hermes memory inside it.

1. Verify the directory exists. If not, ask me.
2. Create a symlink: ln -s ${hermesHome}/memories "${trimmedVault}/Hermes"
3. Add "${trimmedVault}/Hermes/README.md" explaining:
     - USER.md = curated facts about me
     - MEMORY.md = what Hermes has learned about the system
     - Edits in Obsidian write back to ~/.hermes/memories/ (same file, both directions).
4. Print "Connected: ${trimmedVault}/Hermes" so I can confirm.
5. When I reference my Obsidian vault in future Hermes chats, read from this symlink — that's the canonical memory.

Don't touch other vault files. If a "Hermes" folder already exists in the vault, rename it to "Hermes-old" first.`
    : `I have an Obsidian vault and want to expose my Hermes memory inside it.

1. Find my Obsidian vault root. Common locations: ~/Documents/, ~/Library/Mobile Documents/iCloud~md~obsidian/, or wherever Obsidian.app's settings say. If you find multiple vaults, ASK me which one.
2. Create a symlink: ln -s ${hermesHome}/memories "<vault>/Hermes"
3. Add "<vault>/Hermes/README.md" explaining:
     - USER.md = curated facts about me
     - MEMORY.md = what Hermes has learned about the system
     - Edits in Obsidian write back to ~/.hermes/memories/ (same file, both directions).
4. Print the resolved vault path so I can tell the dashboard "yes, connected".
5. When I reference my Obsidian vault in future Hermes chats, read from this symlink — that's the canonical memory.

Don't touch other vault files. If a "Hermes" folder already exists in the vault, rename it to "Hermes-old" first.`;

  function handleCopy() {
    void copy(prompt);
    setShowPrompt(true);
  }
  function markConnected() {
    setConnected(true);
    try {
      window.localStorage.setItem(OBSIDIAN_CONNECTED_KEY, "true");
    } catch {
      /* localStorage may be unavailable in private mode */
    }
  }
  function disconnect() {
    setConnected(false);
    setShowPrompt(false);
    try {
      window.localStorage.removeItem(OBSIDIAN_CONNECTED_KEY);
    } catch {
      /* ignore */
    }
  }

  if (connected) {
    return (
      <div
        className="border px-5 py-4 flex items-center gap-4"
        style={{
          // Uses the page accent rather than Obsidian's own brand purple —
          // replaces the emerald border which read as "completion" rather
          // than "vault connected".
          borderColor: "color-mix(in srgb, var(--brand) 55%, transparent)",
          background: "color-mix(in srgb, var(--brand) 6%, transparent)",
        }}
      >
        <img
          src={logoObsidian}
          alt="Obsidian"
          className="shrink-0 object-contain"
          style={{ width: 44, height: 44 }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className="font-sans font-semibold leading-none"
              style={{ color: CREAM, fontSize: 16, letterSpacing: "0.04em" }}
            >
              Obsidian
            </div>
            <span
              className="font-mono inline-flex items-center gap-1.5 px-2 py-0.5 border text-[13px]"
              style={{
                color: "var(--brand)",
                borderColor: "color-mix(in srgb, var(--brand) 60%, transparent)",
                background: "color-mix(in srgb, var(--brand) 12%, transparent)",
              }}
            >
              <span
                className="inline-block rounded-full"
                style={{
                  width: 5,
                  height: 5,
                  background: "var(--brand)",
                }}
              />
              Connected
            </span>
          </div>
          <div
            className="font-mono text-[13px] mt-1"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
          >
            memory mirrors into your vault · edits flow both ways
          </div>
          {trimmedVault && (
            <div
              className="font-mono text-[13px] mt-1 truncate"
              style={{ color: "color-mix(in srgb, var(--foreground) 45%, transparent)" }}
              title={trimmedVault}
            >
              {trimmedVault}/Hermes
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={disconnect}
          className="font-mono px-3 py-1.5 border text-[13px] transition-colors shrink-0"
          style={{
            background: "transparent",
            color: "color-mix(in srgb, var(--foreground) 65%, transparent)",
            borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)",
          }}
          title="Mark as disconnected (does not remove the symlink — do that manually if you want to clean up)"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div
      className="border"
      style={{ borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)", background: "var(--inset)" }}
    >
      <div
        className="flex items-center gap-3 px-5 py-3 border-b"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)" }}
      >
        <img
          src={logoObsidian}
          alt="Obsidian"
          className="shrink-0 object-contain"
          style={{
            width: 36,
            height: 36,
            opacity: 0.9,
            filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--brand) 35%, transparent))",
          }}
        />
        <div className="min-w-0 flex-1">
          <div
            className="font-sans font-semibold leading-none"
            style={{ color: CREAM, fontSize: 14, letterSpacing: "0.04em" }}
          >
            Open in Obsidian
          </div>
          <div
            className="font-mono text-[13px] mt-1"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
          >
            optional · expose ~/.hermes/memories inside your vault
          </div>
        </div>
        {showPrompt ? (
          // Neutral cream, no green check — green reads "already done"
          // and this button is "I've finished running it, confirm".
          <button
            type="button"
            onClick={markConnected}
            className="font-mono px-3 py-1.5 border text-[13px] transition-colors shrink-0"
            style={{
              background: "transparent",
              color: CREAM,
              borderColor: CREAM,
            }}
            title="Click once you've run the prompt in Claude Code"
          >
            I've run it — confirm
          </button>
        ) : (
          <button
            type="button"
            onClick={handleCopy}
            className="font-mono px-3 py-1.5 border text-[13px] transition-colors shrink-0"
            style={{
              background: copied ? CREAM : "transparent",
              color: copied ? BG : CREAM,
              borderColor: CREAM,
            }}
          >
            {copied ? "Copied!" : failed ? "Couldn't copy: use the prompt below" : "I have a vault"}
          </button>
        )}
      </div>
      {/* Compact vault-path input — single row, no label/caption.
          Persists in localStorage and bakes into the copy-paste prompt
          when filled. Left blank = Claude Code auto-detects. */}
      <div
        className="px-5 py-2 border-b"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 15%, transparent)" }}
      >
        <input
          type="text"
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          placeholder="Vault path (optional · leave blank to auto-detect)"
          className="font-mono w-full px-2 py-1.5 text-[13px] border focus:outline-none"
          style={{
            background: "var(--inset)",
            color: CREAM,
            borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = CREAM)}
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 20%, transparent)")
          }
        />
      </div>

      {showPrompt && (
        <>
          <pre
            className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words px-5 py-3 max-h-44 overflow-y-auto"
            style={{ color: "color-mix(in srgb, var(--foreground) 78%, transparent)" }}
            onWheel={forwardWheelAtBoundary}
          >
            {prompt}
          </pre>
          <div
            className="font-mono text-[13px] leading-relaxed px-5 pb-3"
            style={{ color: "color-mix(in srgb, var(--foreground) 65%, transparent)" }}
          >
            <span className="font-medium text-foreground">Step 1.</span> Paste the prompt
            above into Claude Code. &nbsp;
            <span className="font-medium text-foreground">Step 2.</span>{" "}
            {trimmedVault
              ? "It'll create the symlink at your vault path."
              : "Let it find your vault and create the symlink."}{" "}
            &nbsp;
            <span className="font-medium text-foreground">Step 3.</span> Come back and tap{" "}
            <span style={{ color: CREAM }}>"I've run it — confirm"</span>.
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Live stat tiles — pulls real session data from ~/.hermes/sessions/
// ────────────────────────────────────────────────────────────────────────────

function HermesLiveStats() {
  const { data, isLoading } = useHermesSessions();
  const sessions = data?.sessions ?? [];

  // Roll up: total sessions, total messages, models used, time since last.
  const totalMessages = sessions.reduce((a, s) => a + (s.messageCount || 0), 0);
  // Distinct models, preserving order of first appearance — used for the
  // mini provider-logo stack on the Models tile.
  const modelOrder: string[] = [];
  for (const s of sessions) {
    if (s.model && !modelOrder.includes(s.model)) modelOrder.push(s.model);
  }
  const last = sessions.find((s) => s.lastUpdated || s.startedAt);
  const lastTs = last?.lastUpdated || last?.startedAt || null;
  const lastSeen = fmtRelative(lastTs);

  // Mini activity sparkline data — last 12 hours, hourly buckets.
  const hourBuckets = (() => {
    const out: number[] = [];
    const now = Date.now();
    for (let i = 11; i >= 0; i--) {
      const start = now - (i + 1) * 3_600_000;
      const end = now - i * 3_600_000;
      out.push(
        sessions.filter((s) => {
          const t = new Date(s.startedAt || s.lastUpdated || 0).getTime();
          return t >= start && t < end;
        }).length,
      );
    }
    return out;
  })();
  const sparkMax = Math.max(1, ...hourBuckets);

  if (isLoading) {
    return (
      <WidgetGrid className="mb-6 lg:mb-8" aria-busy="true">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </WidgetGrid>
    );
  }

  const recentlyActive = !!lastTs && Date.now() - new Date(lastTs).getTime() < 300_000;

  return (
    <WidgetGrid className="mb-6 lg:mb-8" aria-label="What Hermes has been doing">
      {/* SESSIONS: count + a real 12-hour activity sparkline */}
      <Widget icon={History} title="Sessions" value={fmtCount(sessions.length)} line="last 20 on disk">
        <Sparkline values={hourBuckets} className="text-muted-foreground/80" label="Sessions in the last 12 hours" />
      </Widget>
      <Widget icon={MessageSquare} title="Messages" value={fmtCount(totalMessages)} line="across all sessions" />
      {/* MODELS: count + provider-logo stack (up to 4 unique) */}
      <Widget icon={Cpu} title="Models" value={fmtCount(modelOrder.length)} line="distinct models used">
        {modelOrder.length > 0 && (
          <div className="flex items-center gap-1.5">
            {modelOrder.slice(0, 4).map((m) => (
              <span key={m} className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-inset" title={m}>
                <ProviderLogoChip provider={modelGuessProvider(m)} size={15} />
              </span>
            ))}
            {modelOrder.length > 4 && <span className="text-sm text-muted-foreground">+{modelOrder.length - 4}</span>}
          </div>
        )}
      </Widget>
      {/* LAST ACTIVE: relative time + the most recent session's model */}
      <Widget
        icon={Clock}
        title="Last active"
        value={lastTs ? lastSeen : null}
        tone={recentlyActive ? "success" : "default"}
        line={last ? (last.model ?? "Model unknown") : "No session yet"}
      />
    </WidgetGrid>
  );
}
// Best-effort provider lookup from a model name — used by the Models tile
// so each unique model on disk renders its real provider mark.
function modelGuessProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("claude") || m.startsWith("anthropic")) return "anthropic";
  if (m.startsWith("gpt-") || m.startsWith("openai")) return "openai-codex";
  if (m.startsWith("gemini") || m.startsWith("google")) return "googlegemini";
  if (m.startsWith("meta-llama") || m.includes("llama")) return "openrouter";
  if (m.startsWith("qwen")) return "openrouter";
  if (m.startsWith("mistral")) return "mistral";
  return "openai-codex";
}

function LiveStatCell({
  label,
  value,
  sub,
  first,
  last,
}: {
  label: string;
  value: string;
  sub: string;
  first?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className="px-5 py-4"
      style={{
        borderLeft: first ? undefined : "1px solid color-mix(in srgb, var(--foreground) 40%, transparent)",
        // Subtle background fade left→right so the row reads as a single ledger strip
        background: last
          ? "var(--inset)"
          : first
            ? "var(--inset)"
            : "var(--inset)",
      }}
    >
      <div
        className="font-mono text-[13px] mb-1.5"
        style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
      >
        {label}
      </div>
      <div
        className="font-sans font-semibold text-3xl md:text-4xl leading-none mb-1"
        style={{ color: CREAM }}
      >
        {value}
      </div>
      <div
        className="font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 45%, transparent)" }}
      >
        {sub}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Live skills grid — pulls real categories from ~/.hermes/skills/
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Hermes ↔ Claude OS bridge card — surfaces the `claude-os` skill that
// lets Hermes call back to localhost:8081 endpoints (sessions, memory,
// kanban, dream, etc). Reads /__hermes_skills to detect whether the skill
// is on disk; renders one of two states:
//   - INSTALLED (green check, "she can read your dashboard")
//   - MISSING (cream button with a copy-paste prompt for Claude Code to
//             author the skill)
// ────────────────────────────────────────────────────────────────────────────
// Half-width bridge card — paired with ObsidianBridge in the memory
// section's 2-col bridges row. Same shape rhythm as Obsidian for visual
// consistency: header (avatar + name + status), prose body, action row.
// Avatar is the hermes-portrait chick (NOT the small pixel logo).
function HermesClaudeOsBridgeCard() {
  const { data } = useHermesSkills();
  const skills = data?.skills ?? [];
  const installed = skills.some((s) => s.id === "claude-os");
  const { copied, failed, copy } = useCopyState(1800);
  const [showPrompt, setShowPrompt] = useState(false);

  const installPrompt = `Install the claude-os skill into Hermes so she can read my operator dashboard.

1. Create directory: mkdir -p ~/.hermes/skills/claude-os/
2. Write the skill manifest at ~/.hermes/skills/claude-os/SKILL.md with frontmatter:
   name: claude-os
   description: "Connects Hermes to Claude OS — the operator dashboard at localhost:8081. Read sessions, memory, integrations, kanban, dream history."
   version: 1.0.0
3. In the body, document the endpoints she should call:
   - GET http://localhost:8081/__live-data        (full state)
   - GET http://localhost:8081/__hermes_status
   - GET http://localhost:8081/__hermes_sessions
   - GET http://localhost:8081/__hermes_memory
   - GET http://localhost:8081/__hermes_pantheon
4. Tell her to trigger this skill when the user mentions: "my dashboard", "Claude OS", "second brain", "operator", "what did my Dream say".
5. Make it loopback-only (the endpoints already enforce this).
6. Verify with: hermes skills list | grep claude-os`;

  function handleCopy() {
    void copy(installPrompt);
  }

  return (
    <Surface className="flex flex-col" padding="none">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <span className="shrink-0 rounded-full border border-border bg-inset p-1.5">
          <BrandMark agent="hermes" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-none text-foreground">Claude OS Bridge</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {installed
              ? "Skill installed · Hermes can read your dashboard"
              : "Skill not installed"}
          </div>
        </div>
        {installed && (
          <Badge tone="success" className="shrink-0">
            On
          </Badge>
        )}
      </div>

      {/* Body — what it does + what it gives her access to + action row */}
      <div className="px-5 py-4 flex flex-col gap-3 flex-1">
        <div className="text-sm leading-relaxed text-muted-foreground">
          Lets Hermes read this dashboard on request. Ask her{" "}
          <em>"what did my Dream say?"</em> or{" "}
          <em>"what's in my Claude OS?"</em> — she pulls from{" "}
          <span className="font-mono text-sm text-foreground">localhost:8081</span>{" "}
          and answers in chat. Read-only · loopback-only · never leaves your machine.
        </div>

        {/* (Access-chip strip removed — operator feedback was it bloated
            the card's height without adding much info beyond what the
            prose above already covers.) */}

        {/* Actions — one-click copy + reveal */}
        <div className="flex items-center gap-2 pt-1 mt-auto">
          <button
            type="button"
            onClick={handleCopy}
            className="font-mono px-3 py-1.5 border text-[13px] transition-colors"
            style={{
              background: copied ? CREAM : "transparent",
              color: copied ? BG : CREAM,
              borderColor: CREAM,
            }}
            title="Copy the one-shot install prompt for Claude Code"
          >
            {copied ? "Copied!" : failed ? "Couldn't copy" : "Copy install prompt"}
          </button>
          <button
            type="button"
            onClick={() => setShowPrompt((v) => !v)}
            className="font-mono text-[13px] transition-colors"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = CREAM)}
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 60%, transparent)")
            }
          >
            {showPrompt ? "▾ Hide" : "▸ View"}
          </button>
        </div>

        {showPrompt && (
          <pre
            className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words p-3 border max-h-56 overflow-y-auto"
            style={{
              color: "color-mix(in srgb, var(--foreground) 82%, transparent)",
              borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)",
              background: "var(--inset)",
            }}
            onWheel={forwardWheelAtBoundary}
          >
            {installPrompt}
          </pre>
        )}
      </div>
    </Surface>
  );
}

function HermesLiveSkills() {
  const { data } = useHermesSkills();
  const skills = data?.skills ?? [];
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_COUNT = 8;
  const visible = expanded ? skills : skills.slice(0, COLLAPSED_COUNT);
  const hasMore = skills.length > COLLAPSED_COUNT;

  // Brand-locked accent rotation for the bullet pill on the left of each
  // row. Cycles cobalt / amber / teal / cream-sand to match the rest of
  // the page palette.
  const ACCENTS = ["var(--info)", "var(--brand)", "var(--success)", "var(--foreground)"];

  return (
    <section className="mb-12">
      <SectionHead
        title="Skill Library"
        meta={`${skills.length} categories · ~/.hermes/skills/`}
      />
      <p className="mb-5 max-w-[70ch] text-sm text-muted-foreground">
        Skills auto-load into a conversation when relevant. Install new packs with{" "}
        <span className="font-mono text-sm text-foreground">hermes skills install &lt;pack&gt;</span>{" "}
        — they appear here automatically, no restart needed.
      </p>

      {skills.length === 0 ? (
        <EmptyState title="No skills on disk yet" body="Run hermes setup tools to install a pack." />
      ) : (
        <>
          {/* Numbered cards (01..N). Each card has a brand-accent colour
              from the rotation + a subtle radial glow + a hover-only
              gradient flicker. No images — the number IS the
              differentiator. Scales effortlessly to 50+ skills. */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
            {visible.map((s, i) => (
              <SkillTile
                key={s.id}
                skill={s}
                accent={ACCENTS[i % ACCENTS.length]}
                index={i}
              />
            ))}
          </div>
          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="font-mono px-4 py-2 border text-[13px] transition-colors"
                style={{
                  background: "transparent",
                  color: CREAM,
                  borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = CREAM)}
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = "color-mix(in srgb, var(--foreground) 55%, transparent)")
                }
              >
                {expanded
                  ? `Show top ${COLLAPSED_COUNT}`
                  : `Show all ${skills.length} skills`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Tiny accent rotation — kept minimal so cards aren't a rainbow. Just
// three subtle brand-adjacent tints we cycle through (no repeating
// neighbours).
const SKILL_ACCENT_VARIANTS = [
  "color-mix(in srgb, var(--foreground) 55%, transparent)",
  "color-mix(in srgb, var(--brand) 55%, transparent)",
  "color-mix(in srgb, var(--brand) 50%, transparent)",
];

// Final-fallback descriptions for skill categories the filesystem probe
// returned empty for. The endpoint already tries DESCRIPTION.md, then
// SKILL.md, then a sub-skill's SKILL.md — this dictionary catches the
// rare cases where all three are missing. Keep these short, 1 sentence,
// plain English.
const SKILL_FALLBACK_DESCRIPTIONS: Record<string, string> = {
  apple: "Apple / macOS tools — Finder, native apps, system features, screenshots.",
  "autonomous-ai-agents":
    "Spawn and orchestrate sub-agents (Claude Code, Codex, Hermes) to run independent work.",
  "claude-os":
    "Bridge to your operator dashboard — read sessions, memory, integrations, dream, kanban.",
  creative:
    "Generative content — ASCII art, hand-drawn diagrams, infographics, design utilities.",
  "data-science":
    "Jupyter notebooks, data exploration, analysis pipelines, visualization.",
  devops:
    "Server ops, deployment, CI/CD, infrastructure tasks across local + cloud.",
  diagramming:
    "Architecture diagrams, flowcharts, Excalidraw / Mermaid generation.",
  dogfood:
    "Exploratory QA — drives a browser to find bugs, capture evidence, file a report.",
  domain:
    "Domain-specific helpers — niche workflows scoped to one practice area.",
  email: "Read, search, draft and send email — Gmail / iMessage threads.",
  gaming:
    "Game-related utilities — modding, save inspection, mechanics scripts.",
  gateway:
    "Messaging gateway plumbing — Telegram / Slack / WhatsApp / Discord wiring.",
  gifs: "Animated GIF generation and editing.",
  github: "Repo ops — issues, PRs, code review, gh CLI workflows.",
  "inference-sh":
    "Local / remote model inference helpers (Ollama, vLLM, llama.cpp).",
  mcp: "Model Context Protocol — install, configure, and orchestrate MCP servers.",
  media: "Image, video, and audio generation via Kie / Runway / ElevenLabs.",
  memory:
    "External memory providers — byterover, mem0, supermemory, Pinecone, etc.",
  "openai-codex":
    "OpenAI Codex sub-agent — delegate code generation and refactors.",
  opencode: "OpenCode sub-agent — open-source alternative for code tasks.",
  "claude-code":
    "Claude Code sub-agent — delegate substantial coding work to Claude.",
  research: "Web search, paper retrieval, structured research loops.",
  "scheduled-tasks": "Cron, launchd, and timer-based task scheduling.",
  utility: "General-purpose helpers that don't fit anywhere else.",
  yuanbao: "Tencent Yuanbao integration — Chinese chat / search.",
  web: "Generic web search, scraping, and content extraction.",
};

function describeSkill(skill: HermesSkillCategory): string {
  if (skill.description && skill.description.length > 0) return skill.description;
  return SKILL_FALLBACK_DESCRIPTIONS[skill.id] ?? "";
}

function SkillTile({
  skill,
  index,
}: {
  skill: HermesSkillCategory;
  // accent prop retired — accent is now derived from index so tiles
  // never repeat their neighbour's tint.
  accent?: string;
  index: number;
}) {
  const accent =
    SKILL_ACCENT_VARIANTS[index % SKILL_ACCENT_VARIANTS.length] ?? "var(--foreground)";
  return (
    <Surface variant="interactive" as="div" className="flex min-h-[148px] flex-col gap-2" padding="md">
      <div className="flex items-start gap-3">
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-inset font-mono text-sm font-semibold"
          style={{ color: accent }}
        >
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight text-foreground">
            {skill.id.replace(/-/g, " ")}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {skill.subskills.length === 0
              ? "No subskills"
              : `${skill.subskills.length} subskill${skill.subskills.length === 1 ? "" : "s"}`}
          </div>
        </div>
      </div>
      <div
        className="mt-auto line-clamp-3 text-sm leading-snug text-muted-foreground"
        title={describeSkill(skill) || ""}
      >
        {describeSkill(skill) || "—"}
      </div>
    </Surface>
  );
}

// (SkillCell + SkillRow superseded by SkillTile above.)

// Reusable section header — bigger, bolder, with a clear meta on the right.
// Replaces the small eyebrow used previously so section titles
// like "Bundled Skill Library" actually read as headers.
// Same h2 recipe as the shared `Section` primitive (docs/DESIGN-SYSTEM.md
// § 3–4): text-lg semibold heading, meta/actions at the right, mb-4 below.
// Kept as a local header-only component (rather than switching every call
// site to `Section`) because each of these headers sits above sibling
// content that isn't structured as a single children block.
function SectionHead({
  title,
  meta,
  right,
}: {
  title: string;
  meta?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold leading-snug tracking-[-0.01em] text-foreground">
          {title}
        </h2>
      </div>
      {right ? (
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      ) : meta ? (
        <div className="shrink-0 text-sm text-muted-foreground">{meta}</div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Recent sessions — pulls latest from ~/.hermes/sessions/*.json
// ────────────────────────────────────────────────────────────────────────────

function HermesRecentSessions() {
  const { data } = useHermesSessions();
  const sessions = (data?.sessions ?? []).slice(0, 6);

  return (
    <section className="mb-12">
      <SectionHead
        title="Recent Sessions"
        right={
          <a
            href="http://localhost:9119/sessions"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[13px] inline-flex items-center gap-1 transition-colors shrink-0"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = CREAM)}
            onMouseLeave={(e) => (e.currentTarget.style.color = "color-mix(in srgb, var(--foreground) 60%, transparent)")}
          >
            View all in Hermes Dashboard <ArrowUpRight className="h-3 w-3" />
          </a>
        }
      />
      {sessions.length === 0 ? (
        <EmptyState className="mt-3" title="No sessions yet" body="Start a conversation above." />
      ) : (
        <div className="border mt-3" style={{ borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>
          {sessions.map((s, i) => (
            <SessionRow key={s.id} session={s} isLast={i === sessions.length - 1} />
          ))}
        </div>
      )}
    </section>
  );
}

// Platform → display label + Simple Icons slug. Hermes saves a `platform`
// field on every session ("cli", "telegram", "discord", "slack", etc.) so
// we can tell at a glance which channel a conversation came from.
const PLATFORM_BADGES: Record<string, { label: string; slug?: string }> = {
  cli: { label: "CLI" },
  telegram: { label: "Telegram", slug: "telegram" },
  discord: { label: "Discord", slug: "discord" },
  slack: { label: "Slack", slug: "slack" },
  whatsapp: { label: "WhatsApp", slug: "whatsapp" },
  signal: { label: "Signal", slug: "signal" },
  matrix: { label: "Matrix", slug: "matrix" },
  email: { label: "Email", slug: "gmail" },
  bluebubbles: { label: "iMessage", slug: "imessage" },
  webhook: { label: "Webhook" },
};

// Tiny icon-only variant of PlatformBadge used as a corner overlay on
// session avatars in the collapsed sidebar rail.
function PlatformBadgeIcon({
  platform,
  size = 10,
}: {
  platform: string | null;
  size?: number;
}) {
  if (!platform) return null;
  const meta = PLATFORM_BADGES[platform.toLowerCase()];
  if (!meta?.slug) {
    return (
      <span
        className="font-mono inline-block"
        style={{
          width: size,
          height: size,
          fontSize: size - 1,
          lineHeight: 1,
          color: "color-mix(in srgb, var(--foreground) 75%, transparent)",
        }}
      >
        ❯
      </span>
    );
  }
  return (
    <img
      src={`https://cdn.simpleicons.org/${meta.slug}/FFE6CB`}
      alt=""
      className="object-contain"
      style={{ width: size, height: size }}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function PlatformBadge({ platform }: { platform: string | null }) {
  if (!platform) return null;
  const meta = PLATFORM_BADGES[platform.toLowerCase()] ?? {
    label: platform.toUpperCase(),
  };
  return (
    <span
      className="font-mono inline-flex items-center gap-1 px-1.5 py-0.5 border text-[13px] shrink-0"
      style={{
        borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
        color: "color-mix(in srgb, var(--foreground) 85%, transparent)",
        background: "color-mix(in srgb, var(--foreground) 4%, transparent)",
      }}
    >
      {meta.slug && (
        <img
          src={`https://cdn.simpleicons.org/${meta.slug}/FFE6CB`}
          alt=""
          className="object-contain"
          style={{ width: 10, height: 10 }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      {meta.label}
    </span>
  );
}

function SessionRow({ session, isLast }: { session: HermesSession; isLast: boolean }) {
  const when = session.lastUpdated || session.startedAt;
  const ago = when
    ? (() => {
        const mins = Math.floor((Date.now() - new Date(when).getTime()) / 60_000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
      })()
    : "—";
  return (
    <div
      className="px-5 py-3 flex items-center gap-4"
      style={{
        borderBottom: isLast ? undefined : "1px solid color-mix(in srgb, var(--foreground) 25%, transparent)",
      }}
    >
      <ProviderLogoChip provider={session.model?.split(/[/_-]/)[0] ?? null} size={20} />
      <div className="min-w-0 flex-1">
        <div
          className="text-[14px] truncate"
          style={{ color: CREAM }}
        >
          {session.firstUserMessage || `Session ${session.id.slice(0, 8)}`}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <PlatformBadge platform={session.platform} />
          <span
            className="font-mono text-[13px] truncate"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
          >
            {session.model ?? "no model"} · {session.messageCount} msg
            {session.messageCount === 1 ? "" : "s"} · {ago}
          </span>
        </div>
      </div>
    </div>
  );
}

interface Role {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  name: string;
  brief: string;
  kbd: string;
  sample?: string;
  featured?: boolean;
  tools: string[];
}

const ROLES: Role[] = [
  {
    icon: Megaphone,
    name: "Marketing Strategist",
    brief: "Positioning, hooks, audience cuts.",
    kbd: "M",
    sample: '"3 hooks for the launch teardown"',
    featured: true,
    tools: ["Hooks", "Personas", "Channels"],
  },
  {
    icon: Radio,
    name: "Comms Lead",
    brief: "PR drafts, tone, crisis loops.",
    kbd: "C",
    sample: '"Draft response to the @verge thread"',
    featured: true,
    tools: ["Statements", "FAQ", "Tone"],
  },
  {
    icon: FlaskConical,
    name: "Research Analyst",
    brief: "Deep-dive teardown reports.",
    kbd: "R",
    sample: '"Map the prompt-injection landscape"',
    featured: true,
    tools: ["Sources", "Compare", "Cite"],
  },
  {
    icon: Lightbulb,
    name: "Creative Brainstormer",
    brief: "Concepts, formats, wild bets.",
    kbd: "B",
    tools: ["Concepts", "Formats"],
  },
  {
    icon: PenLine,
    name: "Ghostwriter",
    brief: "Long-form drafts in your voice.",
    kbd: "G",
    tools: ["Voice", "Outline"],
  },
  {
    icon: LineChart,
    name: "Growth Operator",
    brief: "Funnels, experiments, tracking.",
    kbd: "O",
    tools: ["Funnel", "A/B", "Metrics"],
  },
];

function HermesRolesSection() {
  return (
    <Section
      title="Summon Hermes as…"
      description="Each role gives Hermes its own instructions and tool settings."
      actions={<span className="hidden text-sm text-muted-foreground md:inline">Click to brief</span>}
    >
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 border"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
      >
        {ROLES.map((r, i) => (
          <RoleCell key={r.name} role={r} index={i} />
        ))}
      </div>
    </Section>
  );
}

function RoleCell({ role, index }: { role: Role; index: number }) {
  return (
    <button
      type="button"
      className="group text-left p-5 relative transition-colors"
      style={{
        borderRight: index % 3 !== 2 ? "1px solid color-mix(in srgb, var(--foreground) 20%, transparent)" : undefined,
        borderBottom: index < ROLES.length - 3 ? "1px solid color-mix(in srgb, var(--foreground) 20%, transparent)" : undefined,
        background: "var(--inset)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="h-10 w-10 flex items-center justify-center shrink-0 border"
          style={{
            background: "color-mix(in srgb, var(--foreground) 6%, transparent)",
            borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)",
          }}
        >
          <role.icon className="h-4 w-4" style={{ color: CREAM }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-sans font-semibold text-lg leading-tight" style={{ color: CREAM }}>
              {role.name}
            </div>
            {role.featured && (
              <span
                className="font-mono text-[13px] px-1.5 py-0.5 border"
                style={{ borderColor: "color-mix(in srgb, var(--foreground) 55%, transparent)", color: CREAM }}
              >
                Pinned
              </span>
            )}
          </div>
          <div
            className="font-mono mt-1 text-[13px] leading-relaxed"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
          >
            {role.brief}
          </div>
        </div>
        <kbd
          className="font-mono shrink-0 text-[13px] px-1.5 py-0.5 border"
          style={{
            borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)",
            color: "color-mix(in srgb, var(--foreground) 60%, transparent)",
            background: "var(--inset)",
          }}
        >
          ⌘{role.kbd}
        </kbd>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {role.tools.map((t) => (
          <span
            key={t}
            className="font-mono text-[13px] px-2 py-0.5 border"
            style={{ borderColor: "color-mix(in srgb, var(--foreground) 25%, transparent)", color: CREAM }}
          >
            {t}
          </span>
        ))}
      </div>
      {role.featured && role.sample && (
        <div
          className="mt-3 pt-3 border-t border-dashed"
          style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
        >
          <div className="ds-label mb-1">Sample brief</div>
          <div className="font-mono text-[13px] italic" style={{ color: CREAM }}>
            <span style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}>›</span> {role.sample}
          </div>
        </div>
      )}
    </button>
  );
}

function HermesActivityPanels() {
  const investigations = [
    { t: "Market sizing summary", d: "32m · 18 sources", tag: "research" },
    { t: "Quarterly review synthesis", d: "1h 4m · 41 sources", tag: "synthesis" },
    { t: "Cash-flow stress test", d: "22m · 7 sources", tag: "modelling" },
    { t: "Customer interview rewrite", d: "48m · 12 sources", tag: "drafting" },
  ];
  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-10">
      <div
        className="lg:col-span-2 border p-5"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)", background: "var(--inset)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-sans font-semibold text-xl" style={{ color: CREAM }}>
            Recent investigations
          </h2>
          <span
            className="font-mono text-[13px] inline-flex items-center gap-1"
            style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
          >
            View all <ArrowUpRight className="h-3 w-3" />
          </span>
        </div>
        <ul className="divide-y" style={{ borderColor: "color-mix(in srgb, var(--foreground) 15%, transparent)" }}>
          {investigations.map((r, i) => (
            <li
              key={i}
              className="py-3 flex items-center gap-3"
              style={i > 0 ? { borderTop: "1px solid color-mix(in srgb, var(--foreground) 15%, transparent)" } : undefined}
            >
              <MessageSquare className="h-4 w-4" style={{ color: CREAM }} />
              <div className="min-w-0 flex-1">
                <div className="font-sans font-semibold text-[15px] truncate" style={{ color: CREAM }}>
                  {r.t}
                </div>
                <div
                  className="font-mono text-[13px]"
                  style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
                >
                  {r.d}
                </div>
              </div>
              <span
                className="font-mono text-[13px] px-2 py-0.5 border"
                style={{ borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)", color: CREAM }}
              >
                {r.tag}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div
        className="border p-5"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)", background: "var(--inset)" }}
      >
        <h2 className="font-sans font-semibold text-xl mb-4" style={{ color: CREAM }}>
          Capabilities
        </h2>
        <div className="space-y-3">
          <Capability label="Long-context synthesis" pct={92} />
          <Capability label="Structured reasoning" pct={86} />
          <Capability label="Code generation" pct={71} />
          <Capability label="Vision (multimodal)" pct={48} />
        </div>
      </div>
    </section>
  );
}

function Capability({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1.5">
        <span className="font-mono" style={{ color: CREAM }}>
          {label}
        </span>
        <span className="font-mono tabular-nums" style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}>
          {pct}%
        </span>
      </div>
      <div className="h-1 overflow-hidden" style={{ background: "color-mix(in srgb, var(--foreground) 10%, transparent)" }}>
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            background: CREAM,
          }}
        />
      </div>
    </div>
  );
}

function HermesSkillsSection() {
  const skills = [
    "Deep Research",
    "Document Q&A",
    "Inbox Triage",
    "Weekly Brief",
    "Meeting Notes",
    "Spec Drafting",
  ];
  return (
    <section className="mb-10">
      <div className="mb-4">
        <div className="ds-label mb-2">Skills bound to Hermes</div>
        <h2 className="font-sans font-semibold text-2xl md:text-3xl" style={{ color: CREAM }}>
          What he already knows how to do.
        </h2>
      </div>
      <div
        className="grid grid-cols-2 md:grid-cols-3 gap-0 border"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)" }}
      >
        {skills.map((s, i) => (
          <div
            key={s}
            className="p-4 flex items-center gap-3"
            style={{
              borderRight: i % 3 !== 2 ? "1px solid color-mix(in srgb, var(--foreground) 20%, transparent)" : undefined,
              borderBottom: i < skills.length - 3 ? "1px solid color-mix(in srgb, var(--foreground) 20%, transparent)" : undefined,
              background: "var(--inset)",
            }}
          >
            <Zap className="h-4 w-4" style={{ color: CREAM }} />
            <span className="font-mono text-[13px]" style={{ color: CREAM }}>
              {s}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CLI cheatsheet — the commands you actually run day-to-day, categorised,
// with copy buttons. Replaces the "Features" marketing grid.
// ────────────────────────────────────────────────────────────────────────────

interface CliCommand {
  cmd: string;
  hint?: string;
}
interface CliCategory {
  title: string;
  commands: CliCommand[];
}

const CLI_CATEGORIES: CliCategory[] = [
  {
    title: "Daily Use",
    commands: [
      { cmd: "hermes chat", hint: "Open an interactive chat with history" },
      { cmd: 'hermes chat -q "<prompt>"', hint: "One-shot query — no history" },
      { cmd: "hermes chat --continue", hint: "Resume your most recent session" },
      { cmd: "hermes sessions list", hint: "All saved conversations" },
    ],
  },
  {
    title: "Config & Setup",
    commands: [
      { cmd: "hermes setup", hint: "Full re-run of the setup wizard" },
      { cmd: "hermes setup model", hint: "Switch provider / model only" },
      { cmd: "hermes setup gateway", hint: "Wire Telegram / Discord / Slack" },
      { cmd: "hermes setup agent", hint: "Personality, voice, defaults (SOUL.md)" },
      { cmd: "hermes config show", hint: "Print all current settings" },
      { cmd: "hermes status", hint: "Check what's connected" },
    ],
  },
  {
    title: "Auth",
    commands: [
      { cmd: "hermes login --provider nous", hint: "Sign in to Nous Portal" },
      { cmd: "hermes auth", hint: "OAuth into ChatGPT (openai-codex)" },
      { cmd: "hermes logout", hint: "Clear stored credentials" },
    ],
  },
  {
    title: "Skills & Tools",
    commands: [
      { cmd: "hermes skills list", hint: "Show bundled + installed skills" },
      { cmd: "hermes skills search <q>", hint: "Find skills matching a query" },
      { cmd: "hermes tools", hint: "Toggle which tools Hermes can use" },
      { cmd: "hermes plugins", hint: "Install / update / remove plugins" },
    ],
  },
  {
    title: "Automations",
    commands: [
      { cmd: "hermes cron", hint: "List + manage scheduled jobs" },
      { cmd: "hermes webhook", hint: "Inbound webhook subscriptions" },
      { cmd: "hermes hooks", hint: "Shell hooks fired on events" },
    ],
  },
  {
    title: "Maintenance",
    commands: [
      { cmd: "hermes doctor", hint: "Diagnose problems with the install" },
      { cmd: "hermes update", hint: "Upgrade to the latest Hermes" },
      { cmd: "hermes backup", hint: "Zip up everything in ~/.hermes" },
      { cmd: "hermes dashboard", hint: "Open the full web UI on :9119" },
    ],
  },
];

function HermesCliCheatsheet() {
  return (
    <section className="mb-10">
      <div className="px-1 pb-3 mb-6 flex items-baseline justify-between">
        <div className="ds-label">CLI</div>
        <div
          className="font-mono text-[13px]"
          style={{ color: "color-mix(in srgb, var(--foreground) 45%, transparent)" }}
        >
          Click any command to copy
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-6">
        {CLI_CATEGORIES.map((cat) => (
          <CliCategoryCell key={cat.title} cat={cat} />
        ))}
      </div>
    </section>
  );
}

function CliCategoryCell({ cat }: { cat: CliCategory }) {
  // Understated: no card chrome, no background, no borders. Just a small
  // caps title and a column of commands. Lives on the page background.
  return (
    <div>
      <div
        className="font-mono text-[13px] mb-2 pb-1 border-b"
        style={{
          color: "color-mix(in srgb, var(--foreground) 55%, transparent)",
          borderColor: "color-mix(in srgb, var(--foreground) 18%, transparent)",
        }}
      >
        {cat.title}
      </div>
      <ul className="space-y-1.5">
        {cat.commands.map((c) => (
          <CliCommandRow key={c.cmd} command={c} />
        ))}
      </ul>
    </div>
  );
}

function CliCommandRow({ command }: { command: CliCommand }) {
  const { copied, failed, copy } = useCopyState(1200);
  function handleCopy() {
    void copy(command.cmd);
  }
  return (
    <li>
      <button
        type="button"
        onClick={handleCopy}
        // items-center keeps the "Copy" chip on the same baseline as the
        // command text instead of floating above when the hint wraps.
        className="w-full text-left flex items-center gap-2 group transition-colors"
        title="Click to copy"
      >
        <span
          className="font-mono text-[13px] flex-1 truncate leading-none"
          style={{ color: CREAM }}
        >
          {command.cmd}
        </span>
        {/* Inline chip — sits perfectly on the command line via items-center
            up top. Reserves its slot via min-width so the layout doesn't
            shift on hover; fades in on group-hover or when copied. */}
        <span
          className={`font-mono text-[13px] px-1.5 py-0.5 border inline-flex items-center justify-center transition-opacity leading-none shrink-0 ${copied || failed ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{
            color: copied ? "var(--success)" : "color-mix(in srgb, var(--foreground) 70%, transparent)",
            borderColor: copied ? "color-mix(in srgb, var(--success) 60%, transparent)" : "color-mix(in srgb, var(--foreground) 25%, transparent)",
            background: copied ? "color-mix(in srgb, var(--success) 8%, transparent)" : "var(--inset)",
            minWidth: 50,
            height: 18,
          }}
        >
          {copied ? "✓ Copied" : failed ? "Couldn't copy" : "Copy"}
        </span>
      </button>
      {command.hint && (
        <div
          className="text-[13px] leading-tight mt-0.5"
          style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}
        >
          {command.hint}
        </div>
      )}
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Mixture of Agents (MoA) builder — compose a Hermes `moa` preset visually:
// pick an aggregator (reads every proposal, writes the real answer, runs the
// tools) + N reference models (propose in parallel, no tools), see an
// indicative per-turn cost, then copy the exact config.yaml block / a plain-
// English instruction / the activation command to hand to Hermes. Mirrors the
// real schema (verified against Hermes v0.17.0):
//   moa.presets.<name>.{ reference_models[], aggregator, reference_temperature,
//                        aggregator_temperature, max_tokens, enabled }
// Models + prices come from model-intel.json so they refresh with
// `bun run refresh:models`. Every model routes via OpenRouter (one key reaches
// all providers); power users can swap providers by editing the emitted YAML.
// ────────────────────────────────────────────────────────────────────────────
interface MoaModelOption {
  /** Catalogue id ("codex/gpt-6-sol"). */
  key: string;
  /** model-intel.json id, when the market dataset has this model (benchmarks only). */
  intelId?: string;
  /** Catalogue route free: no charge for the call. */
  free?: boolean;
  label: string;
  vendorKey: string;
  provider: string;
  model: string;
  tier: string;
  inPerM: number;
  outPerM: number;
  /** Routed via the user's subscription (openai-codex, or Claude via claude-sub) → $0 marginal. */
  sub?: boolean;
  /** Text-only route (the Claude Code bridge): may advise, cannot be the core, which runs tools. */
  adviseOnly?: boolean;
  /** Artificial Analysis Intelligence Index. */
  intelligence?: number;
  /** LMArena human-preference Elo — the fairer "power" ranking. */
  arenaElo?: number;
  speedTps?: number;
  context?: number;
}

// Indicative cost uses a round, honest token assumption so the figure is
// comparable across presets (real spend scales with your actual tokens).
const MOA_IN_TOKENS = 1000;
const MOA_OUT_TOKENS = 1000;
function moaCallCost(m: MoaModelOption | undefined): number {
  if (!m) return 0;
  return (MOA_IN_TOKENS * m.inPerM + MOA_OUT_TOKENS * m.outPerM) / 1_000_000;
}
function moaUsd(n: number): string {
  if (!isFinite(n) || n <= 0) return "$0";
  if (n >= 1) return "$" + n.toFixed(2);
  if (n >= 0.01) return "$" + n.toFixed(3);
  return "$" + n.toFixed(4);
}

function moaYaml(
  name: string,
  refs: MoaModelOption[],
  agg: MoaModelOption | undefined,
  refTemp: number,
  aggTemp: number,
  maxTokens: number,
): string {
  const refLines = refs.length
    ? refs
        .map((r) => `        - { provider: ${r.provider}, model: ${r.model} }`)
        .join("\n")
    : "        # pick at least one reference model";
  const aggLine = agg
    ? `{ provider: ${agg.provider}, model: ${agg.model} }`
    : "{ provider: openrouter, model: anthropic/claude-opus-4.8 }";
  return `moa:
  default_preset: ${name}
  presets:
    ${name}:
      reference_models:
${refLines}
      aggregator: ${aggLine}
      reference_temperature: ${refTemp}
      aggregator_temperature: ${aggTemp}
      max_tokens: ${maxTokens}
      enabled: true`;
}

function moaInstruction(
  name: string,
  refs: MoaModelOption[],
  agg: MoaModelOption | undefined,
  refTemp: number,
  aggTemp: number,
  maxTokens: number,
): string {
  const refList = refs.length
    ? refs.map((r) => `${r.provider}:${r.model}`).join(", ")
    : "(none chosen yet)";
  const aggStr = agg ? `${agg.provider}:${agg.model}` : "(none chosen yet)";
  return `Set up a Mixture of Agents preset in your Hermes config (~/.hermes/config.yaml, under moa.presets).

Preset name: ${name}
Reference models (run in parallel, no tools): ${refList}
Aggregator (reads the proposals, writes the answer, runs tools): ${aggStr}
reference_temperature: ${refTemp}, aggregator_temperature: ${aggTemp}, max_tokens: ${maxTokens}, enabled: true

Write it into the config, then run \`hermes moa list\` to confirm. I'll use it with \`/model ${name} --provider moa\`.`;
}

function MoaModelDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: MoaModelOption[];
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.key === value);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full font-mono text-[13px] px-3 py-2.5 border inline-flex items-center gap-2 text-left transition-colors"
        style={{
          background: "var(--inset)",
          color: CREAM,
          borderColor: open ? CREAM : "color-mix(in srgb, var(--foreground) 40%, transparent)",
        }}
      >
        <ProviderLogoChip provider={cur?.vendorKey ?? null} size={18} />
        <span className="flex-1 truncate">{cur?.label ?? "Select a model"}</span>
        {cur && (
          <span style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>
            {moaUsd(moaCallCost(cur))}/call
          </span>
        )}
        <span style={{ color: "color-mix(in srgb, var(--foreground) 55%, transparent)" }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto border"
          style={{
            background: BG,
            borderColor: CREAM,
            boxShadow: "0 16px 40px color-mix(in srgb, black 60%, transparent)",
          }}
        >
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              className="w-full px-3 py-2 inline-flex items-center gap-2 text-left transition-colors hover:bg-white/5"
              style={{ color: o.key === value ? CREAM : "color-mix(in srgb, var(--foreground) 80%, transparent)" }}
            >
              <ProviderLogoChip provider={o.vendorKey} size={16} />
              <span className="font-mono text-[13px] flex-1 truncate">
                {o.label}
              </span>
              <span
                className="font-mono text-[13px]"
                style={{ color: "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
              >
                {o.tier}
              </span>
              <span
                className="font-mono text-[13px]"
                style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
              >
                {moaUsd(moaCallCost(o))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoaNum({
  label,
  value,
  onChange,
  step,
  min,
  max,
  integer,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
  integer?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className="font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
      >
        {label}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = integer
            ? parseInt(e.target.value, 10)
            : parseFloat(e.target.value);
          if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="font-mono text-[13px] px-2 py-1.5 border focus:outline-none"
        style={{
          background: "var(--inset)",
          color: CREAM,
          borderColor: "color-mix(in srgb, var(--foreground) 35%, transparent)",
        }}
      />
    </label>
  );
}

function MoaCopyBlock({
  label,
  hint,
  text,
}: {
  label: string;
  hint?: string;
  text: string;
}) {
  const { copied, failed, copy } = useCopyState(1500);
  function handleCopy() {
    void copy(text);
  }
  return (
    <div
      className="border"
      style={{ borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)", background: CODE_BG }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b gap-3"
        style={{ borderColor: "color-mix(in srgb, var(--foreground) 18%, transparent)" }}
      >
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className="font-mono text-[13px] shrink-0"
            style={{ color: CREAM }}
          >
            {label}
          </span>
          {hint && (
            <span
              className="text-[13px] truncate"
              style={{
                color: "color-mix(in srgb, var(--foreground) 45%, transparent)",
              }}
            >
              {hint}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="font-mono text-[13px] px-2 py-1 border transition-colors shrink-0"
          style={{
            color: copied ? "var(--success)" : "color-mix(in srgb, var(--foreground) 85%, transparent)",
            borderColor: copied ? "color-mix(in srgb, var(--success) 60%, transparent)" : "color-mix(in srgb, var(--foreground) 30%, transparent)",
            background: copied ? "color-mix(in srgb, var(--success) 10%, transparent)" : "transparent",
          }}
        >
          {copied ? "✓ Copied" : failed ? "Couldn't copy" : "Copy"}
        </button>
      </div>
      <pre
        className="font-mono text-[13px] leading-relaxed p-3 overflow-x-auto whitespace-pre-wrap"
        style={{ color: "color-mix(in srgb, var(--foreground) 92%, transparent)" }}
      >
        {text}
      </pre>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Ministry of Experts — the first member of the Pantheon. A Mixture-of-Agents
// (moa) builder dressed as a persona card: a council of up to 3 expert models
// proposing in parallel + one core model (the aggregator) that reads every
// proposal, writes the final answer, and runs the tools. The card expands inline
// to the full row; you pick the core + experts from the live roster
// (model-intel.json) and copy ONE prompt that tells Hermes to configure the
// preset itself (it verifies the slugs + asks you if it can't reach a model).
// Schema verified against Hermes v0.17.0. Logos come from HERMES_LOCAL_LOGOS (see NOTICE).
// ────────────────────────────────────────────────────────────────────────────
const MINISTRY_VENDOR_LOGO: Record<string, string> = {
  claude: logoVendorClaude,
  openai: logoVendorOpenAI,
  gemini: logoVendorGemini,
  grok: logoVendorGrok,
  deepseek: logoVendorDeepseek,
  minimax: logoVendorMinimax,
  zai: logoVendorZai,
  qwen: logoVendorQwen,
  moonshot: logoVendorMoonshot,
  tencent: logoVendorTencent,
  xiaomi: logoVendorXiaomi,
  nvidia: logoVendorNvidia,
  mistral: logoVendorMistral,
  meta: logoVendorMeta,
  llama: logoVendorMeta,
  cohere: logoVendorCohere,
};
// These four ship as fill="currentColor" → invisible on dark until tinted white.
const MINISTRY_MONO_VENDORS = new Set(["openai", "grok", "moonshot", "xiaomi"]);
const MINISTRY_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents";

function VendorLogo({
  vendorKey,
  size = 40,
  onLight = false,
}: {
  vendorKey: string;
  size?: number;
  onLight?: boolean;
}) {
  const key = (vendorKey || "").toLowerCase();
  // OpenAI → the green brand mark (consistent with the rest of the app).
  if (key === "openai" || key === "openai-codex" || key === "codex") {
    return (
      <span
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: size, height: size }}
      >
        <ModelLogo model="openai" size={Math.round(size * 0.92)} />
      </span>
    );
  }
  const src = MINISTRY_VENDOR_LOGO[key];
  if (!src) {
    return (
      <span
        className="inline-flex items-center justify-center shrink-0 rounded"
        style={{
          width: size,
          height: size,
          background: "color-mix(in srgb, var(--foreground) 12%, transparent)",
          color: CREAM,
          fontWeight: 700,
          fontSize: size * 0.4,
        }}
      >
        {key.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  // Mono marks are stored dark and inverted to white on the dark page; keep
  // them natural (dark) on a light/white circle so they still read.
  const invert = MINISTRY_MONO_VENDORS.has(key) && !onLight;
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <img
        src={src}
        alt={`${vendorKey} logo`}
        className="object-contain"
        style={{
          width: size,
          height: size,
          filter: invert ? "brightness(0) invert(1)" : undefined,
        }}
        loading="lazy"
      />
    </span>
  );
}

// Compact 1–4 glyph $ indicator from a model's per-call cost.
function ministryCostTier(o: MoaModelOption): string {
  if (o.sub) return "sub";
  if (o.free) return "free";
  const c = moaCallCost(o);
  if (c >= 0.03) return "$$$$";
  if (c >= 0.012) return "$$$";
  if (c >= 0.004) return "$$";
  return "$";
}

function ministryPrompt(
  core: MoaModelOption | undefined,
  experts: MoaModelOption[],
  maxTokens = 4096,
): string {
  const expLines = experts.length
    ? experts
        .map((e) => `  • ${e.label} — provider: ${e.provider}, model: ${e.model}`)
        .join("\n")
    : "  • (pick 1–3 experts)";
  const coreLine = core
    ? `${core.label} — provider: ${core.provider}, model: ${core.model}`
    : "(pick a core model)";
  return `Hey Hermes — set up a Mixture of Agents preset for me (your \`moa\` feature, added in a recent release; docs: ${MINISTRY_DOCS_URL}). Call it "ministry".

CORE MODEL — the aggregator. Reads every expert's proposal, writes the final answer, runs the tools:
  • ${coreLine}

EXPERTS — the reference models. Each proposes in parallel (no tools); the core then decides:
${expLines}

Write this under moa.presets in ~/.hermes/config.yaml, with provider and model as SEPARATE keys (not colon-joined). Use reference_temperature 0.6, aggregator_temperature 0.4, max_tokens ${maxTokens}, enabled: true.

Before writing, verify each model id is valid for my configured providers. If you don't know where to get one of these models, or I don't have access to it, ASK me about it — don't guess. Then run \`hermes moa list\` to confirm, and tell me to activate it with /model ministry --provider moa.`;
}

// Live OpenRouter pricing → { openrouterId: { inPerM, outPerM } }. Keyless +
// CORS-open, so it works in the distributed dashboard with zero setup. Off in demo mode: the page
// promises "Hermes itself isn't being queried", so it must not call out from the browser either
// (audit F3-19); the Ministry card falls back to its bundled prices.
function useOpenRouterPrices(enabled = true) {
  return useQuery<Record<string, { inPerM: number; outPerM: number }>>({
    queryKey: ["openrouter-prices"],
    enabled,
    queryFn: async () => {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      const map: Record<string, { inPerM: number; outPerM: number }> = {};
      for (const m of j?.data ?? []) {
        const i = parseFloat(m?.pricing?.prompt ?? "");
        const o = parseFloat(m?.pricing?.completion ?? "");
        if (Number.isFinite(i) && Number.isFinite(o))
          map[m.id] = { inPerM: i * 1e6, outPerM: o * 1e6 };
      }
      return map;
    },
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}

type LivePrices = Record<string, { inPerM: number; outPerM: number }> | undefined;

function ministryFmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 10) return `$${Math.round(n)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
function ministryRate(o: MoaModelOption, live: LivePrices) {
  // Live OpenRouter prices apply only to a metered OpenRouter seat; a free or plan seat, or a
  // model with the same id on another provider (Groq's gpt-oss), keeps the catalogue figure.
  if (o.sub || o.free || o.provider !== "openrouter") return { inPerM: o.inPerM, outPerM: o.outPerM };
  return (live && live[o.model]) || { inPerM: o.inPerM, outPerM: o.outPerM };
}

// Two states only now: the accent for the core/selected model, a success
// tone for an armed/expert seat. Vendor identity comes from the logo mark
// (ministryVendorColor below), never a per-vendor hue — one accent, and
// provider marks sit in neutral tiles per docs/DESIGN-SYSTEM.md § 8.
const MOA_TEAL = "var(--success)";
const MOA_GOLD = "var(--brand)";
// Every vendor used to get its own hue so a model box "read as its own
// colour at a glance"; the logo mark now carries that identity, so this
// always resolves to one neutral tone.
function ministryVendorColor(_v: string): string {
  return "var(--muted-foreground)";
}

// "Power" = LMArena Elo (human preference) — fairer to strong open models than
// the AA intelligence index. Falls back to an Elo-shaped estimate from aaIndex
// when a model has no Arena rating yet, so the bar still renders.
// Real Arena AGENT net-improvement % where we have it (arena.ai/leaderboard/agent),
// else the general Arena Elo mapped BELOW the agent band — so agent-proven models
// lead (the Ministry is about AGENTS, where Opus 4.8 > Gemini, not general chat).
const AGENT_SCORE: Record<string, number> = Object.fromEntries(
  (
    (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ?? []
  )
    .filter((m) => typeof m.benchmarks?.arenaAgent === "number")
    .map((m) => [String(m.id), m.benchmarks.arenaAgent as number]),
);
function ministryScoreOf(
  id: string,
  arenaElo?: number,
  intelligence?: number,
): number {
  const a = AGENT_SCORE[id];
  if (typeof a === "number") return 100 + a; // agent-proven sits above general Elo
  const elo = arenaElo ?? 1380 + (intelligence ?? 40);
  return Math.max(0, Math.min(95, (elo - 1400) * 0.9));
}
function ministryPower(o: MoaModelOption): number {
  return ministryScoreOf(o.intelId ?? o.key, o.arenaElo, o.intelligence);
}
function ministryPowerLabel(o: MoaModelOption): string {
  const a = AGENT_SCORE[o.intelId ?? o.key];
  if (typeof a === "number") return `+${a.toFixed(1)}%`;
  if (typeof o.arenaElo === "number") return `~${o.arenaElo}`;
  return "—";
}

// A always-visible palette box. Body click toggles it as an expert; the ♛
// sets it as the core. Selected → coloured (teal expert / gold core), never dimmed.
// Global LMArena rank (1 = top) across every rated model in the dataset.
const ARENA_RANK: Record<string, number> = (() => {
  const rated = (
    (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ?? []
  )
    .filter(
      (m) =>
        typeof m.benchmarks?.lmarenaElo === "number" ||
        typeof m.benchmarks?.arenaAgent === "number",
    )
    .map((m) => ({
      id: String(m.id),
      score: ministryScoreOf(
        String(m.id),
        m.benchmarks?.lmarenaElo,
        m.benchmarks?.aaIndex,
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const map: Record<string, number> = {};
  rated.forEach((r, i) => (map[r.id] = i + 1));
  return map;
})();
function ministryArenaRank(o: MoaModelOption): number | null {
  return ARENA_RANK[o.intelId ?? o.key] ?? null;
}
// Green (#1) → dark red (#20+) by Arena standing, so rank reads at a glance.
function ministryRankColor(rank: number | null): string {
  if (!rank) return "color-mix(in srgb, var(--foreground) 40%, transparent)";
  const t = Math.min(1, Math.max(0, (rank - 1) / 19)); // 0 at #1 … 1 at #20
  const hue = 140 - 140 * t; // green → red
  const light = 58 - 20 * t; // darker as it worsens
  return `hsl(${Math.round(hue)}, 70%, ${Math.round(light)}%)`;
}
// Cheap (green) → expensive (dark red), log-scaled across real $/M.
function ministryCostColor(outPerM: number, sub?: boolean): string {
  if (sub) return "var(--success)";
  const t = Math.min(
    1,
    Math.max(
      0,
      (Math.log10(Math.max(0.1, outPerM)) - Math.log10(0.2)) /
        (Math.log10(40) - Math.log10(0.2)),
    ),
  );
  const hue = 140 - 140 * t;
  const light = 58 - 20 * t;
  return `hsl(${Math.round(hue)}, 70%, ${Math.round(light)}%)`;
}
// Fast (green) → slow (red), so speed reads at a glance like cost + rank.
function ministrySpeedColor(tps?: number): string {
  if (!tps) return "color-mix(in srgb, var(--foreground) 40%, transparent)";
  const t = Math.min(1, Math.max(0, tps / 150)); // 0 slow → 1 fast
  const hue = 140 * t; // red (slow) → green (fast)
  return `hsl(${Math.round(hue)}, 70%, 56%)`;
}
// Top-20 score band, for a "performance vs the top 20" bar.
const MINISTRY_SCORES = (
  (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ?? []
)
  .map((m) =>
    ministryScoreOf(String(m.id), m.benchmarks?.lmarenaElo, m.benchmarks?.aaIndex),
  )
  .sort((a, b) => b - a);
const SCORE_TOP1 = MINISTRY_SCORES[0] ?? 100;
const SCORE_TOP20 = MINISTRY_SCORES[Math.min(19, MINISTRY_SCORES.length - 1)] ?? 0;
function ministryPerfVsTop20(o: MoaModelOption): number {
  const s = ministryScoreOf(o.intelId ?? o.key, o.arenaElo, o.intelligence);
  return Math.max(
    0.05,
    Math.min(1, (s - SCORE_TOP20) / Math.max(1, SCORE_TOP1 - SCORE_TOP20)),
  );
}
// Full model-intel record by id — powers the analytics card (description, etc.).
const INTEL_BY_ID: Record<string, any> = Object.fromEntries(
  (
    (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ?? []
  ).map((m) => [String(m.id), m]),
);

// A bench card — a distinct rounded, bordered, draggable model. Drag onto a
// seat, or click to "arm" then click a seat. Hovering previews its analytics.
function PaletteModelBox({
  o,
  role,
  index,
  armed,
  sortBy,
  onArm,
  onDragKey,
  onFocus,
}: {
  o: MoaModelOption;
  role: "core" | "expert" | null;
  index: number;
  armed: boolean;
  sortBy: "arena" | "cost" | "speed";
  onArm: (k: string) => void;
  onDragKey: (k: string | null) => void;
  onFocus: (k: string) => void;
}) {
  const isCore = role === "core";
  const isExpert = role === "expert";
  const selColor = isCore ? MOA_GOLD : isExpert || armed ? MOA_TEAL : null;
  const rank = ministryArenaRank(o);
  // The bench row shows the metric you're ranking by, in its own colour scale.
  const metric =
    sortBy === "cost"
      ? o.sub
        ? "subscription"
        : o.free
          ? "free"
          : `${ministryFmtUsd(o.outPerM)}/M`
      : sortBy === "speed"
        ? o.speedTps
          ? `${Math.round(o.speedTps)} t/s`
          : "—"
        : rank
          ? `Arena #${rank}`
          : "unranked";
  const metricColor =
    sortBy === "cost"
      ? ministryCostColor(o.outPerM, o.sub)
      : sortBy === "speed"
        ? ministrySpeedColor(o.speedTps)
        : ministryRankColor(rank);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", o.key);
        e.dataTransfer.effectAllowed = "copy";
        onDragKey(o.key);
      }}
      onDragEnd={() => onDragKey(null)}
      onClick={() => onArm(o.key)}
      onMouseEnter={() => onFocus(o.key)}
      title={`${o.label} — drag onto a seat, or click then click a seat`}
      className="flex items-center gap-2 p-1.5 cursor-grab active:cursor-grabbing transition-all hover:-translate-y-px"
      style={{
        borderRadius: 10,
        border: `1px solid ${selColor ?? "color-mix(in srgb, var(--foreground) 16%, transparent)"}`,
        background: selColor
          ? `color-mix(in srgb, ${selColor} 8%, transparent)`
          : "color-mix(in srgb, var(--foreground) 2%, transparent)",
      }}
    >
      <span
        className="inline-flex items-center justify-center rounded-full shrink-0"
        style={{
          width: 28,
          height: 28,
          background: "var(--foreground)",
        }}
      >
        <VendorLogo vendorKey={o.vendorKey} size={18} onLight />
      </span>
      <span className="flex-1 min-w-0 leading-tight">
        <span
          className="font-mono text-[13px] truncate block"
          style={{ color: CREAM }}
        >
          {o.label}
        </span>
        <span
          className="font-mono text-[13px]"
          style={{ color: metricColor }}
        >
          {metric}
        </span>
      </span>
      {isCore && (
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{ width: 14, height: 14, background: MOA_GOLD, color: BG }}
        >
          <Crown style={{ width: 9, height: 9 }} />
        </span>
      )}
      {isExpert && (
        <span
          className="font-mono text-[13px] inline-flex items-center justify-center rounded-full shrink-0"
          style={{ width: 14, height: 14, background: MOA_TEAL, color: BG }}
        >
          {index + 1}
        </span>
      )}
    </div>
  );
}

// Bottom-left analytics — shows the hovered/selected model's stats as 3 bars.
function AnalyticsRow({
  label,
  value,
  bar,
  color,
  hint,
}: {
  label: string;
  value: string;
  bar: number;
  color: string;
  hint?: string;
}) {
  return (
    <div
      className="flex items-center gap-2"
      style={{ minHeight: 16 }}
      title={hint}
    >
      <span
        className="font-mono text-[13px] w-[58px] shrink-0 whitespace-nowrap"
        style={{ color: "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
      >
        {label}
      </span>
      <span
        className="relative inline-block flex-1"
        style={{ height: 5, background: "color-mix(in srgb, var(--foreground) 8%, transparent)", borderRadius: 3 }}
      >
        <span
          className="absolute left-0 top-0 h-full"
          style={{
            width: `${Math.max(5, Math.min(100, Math.round((bar || 0) * 100)))}%`,
            background: color,
            borderRadius: 3,
          }}
        />
      </span>
      <span
        className="font-mono text-[13px] tabular-nums w-[58px] text-right shrink-0 whitespace-nowrap"
        style={{ color: CREAM }}
      >
        {value}
      </span>
    </div>
  );
}

function MinistryAnalytics({
  model,
  lineup,
  live,
}: {
  model: MoaModelOption | undefined;
  lineup: MoaModelOption[];
  live: LivePrices;
}) {
  const pool = model ? [model, ...lineup] : lineup;
  const maxOut = Math.max(
    ...pool.map((m) => ministryRate(m, live).outPerM || 0),
    0.01,
  );
  const maxSpeed = Math.max(...pool.map((m) => m.speedTps ?? 0), 1);
  const rate = model ? ministryRate(model, live) : { inPerM: 0, outPerM: 0 };
  const intel = model ? INTEL_BY_ID[model.key] : undefined;
  const rank = model ? ministryArenaRank(model) : null;
  const ctx = model?.context
    ? model.context >= 1_000_000
      ? `${Math.round(model.context / 1_000_000)}M context`
      : `${Math.round(model.context / 1000)}K context`
    : null;
  return (
    <div
      className="p-3.5"
      style={{
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--foreground) 18%, transparent)",
        background:
          "linear-gradient(155deg, color-mix(in srgb, var(--foreground) 5%, transparent), color-mix(in srgb, var(--foreground) 1.2%, transparent))",
        boxShadow: "0 14px 30px -16px color-mix(in srgb, black 60%, transparent)",
      }}
    >
      {model ? (
        <>
          <div className="flex items-center gap-3 mb-2">
            <span
              className="inline-flex items-center justify-center rounded-full shrink-0"
              style={{
                width: 42,
                height: 42,
                background: "var(--foreground)",
                boxShadow: "0 6px 14px -4px color-mix(in srgb, black 50%, transparent)",
              }}
            >
              <VendorLogo vendorKey={model.vendorKey} size={26} onLight />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className="truncate"
                  style={{
                    fontSize: 16,
                    color: CREAM,
                  }}
                >
                  {model.label}
                </span>
                {rank && (
                  <span
                    className="font-mono text-[13px] px-1.5 py-0.5 shrink-0"
                    style={{
                      borderRadius: 5,
                      color: ministryRankColor(rank),
                      border: `1px solid ${ministryRankColor(rank)}`,
                      background: "var(--inset)",
                    }}
                  >
                    Arena #{rank}
                  </span>
                )}
              </div>
              <div
                className="font-mono text-[13px] truncate"
                style={{ color: "color-mix(in srgb, var(--foreground) 42%, transparent)" }}
              >
                {[intel?.vendor, model.tier, ctx].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
          {intel?.oneLiner && (
            <p
              className="mb-3"
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                color: "color-mix(in srgb, var(--foreground) 70%, transparent)",
              }}
            >
              {intel.oneLiner}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <AnalyticsRow
              label="Agent"
              hint="Arena agent leaderboard — net improvement vs the top 20"
              value={ministryPowerLabel(model)}
              bar={ministryPerfVsTop20(model)}
              color={ministryRankColor(rank)}
            />
            <AnalyticsRow
              label="Cost / M"
              hint="Live OpenRouter output price per million tokens"
              value={model.sub ? "sub" : ministryFmtUsd(rate.outPerM)}
              bar={model.sub ? 0.06 : rate.outPerM / maxOut}
              color={ministryCostColor(rate.outPerM, model.sub)}
            />
            <AnalyticsRow
              label="Speed"
              value={model.speedTps ? `${Math.round(model.speedTps)} t/s` : "—"}
              bar={model.speedTps ? model.speedTps / maxSpeed : 0}
              color={ministrySpeedColor(model.speedTps)}
            />
          </div>
          <div
            className="font-mono text-sm mt-2.5"
            style={{ color: "color-mix(in srgb, var(--foreground) 28%, transparent)" }}
          >
            arena agent score · vs top 20 · live OpenRouter cost
          </div>
        </>
      ) : (
        <div
          className="font-mono text-[13px] py-4 text-center"
          style={{ color: "color-mix(in srgb, var(--foreground) 30%, transparent)" }}
        >
          hover a model to inspect it
        </div>
      )}
    </div>
  );
}

// A council seat — a drop target + click target. Core and expert seats behave
// identically; the crown is a permanent property of the top seat. Brand-tinted
// dark "coin", hover-× to remove (on every seat, core included).
function CouncilSeat({
  seat,
  o,
  armed,
  dragActive,
  onPlace,
  onDropKey,
  onRemove,
}: {
  seat: "core" | number;
  o: MoaModelOption | undefined;
  armed: boolean;
  dragActive: boolean;
  onPlace: (seat: "core" | number) => void;
  onDropKey: (seat: "core" | number, key: string) => void;
  onRemove: (seat: "core" | number) => void;
}) {
  const isCore = seat === "core";
  const empty = !o;
  const [over, setOver] = useState(false);
  const ring = isCore ? 100 : 72;
  const logo = isCore ? 52 : 38;
  const droppable = armed || dragActive;
  return (
    <div
      className="group relative flex flex-col items-center gap-2"
      style={{ width: isCore ? 168 : 116 }}
    >
      <span
        className="font-mono text-[13px]"
        style={{
          color: isCore ? "color-mix(in srgb, var(--foreground) 70%, transparent)" : "color-mix(in srgb, var(--foreground) 70%, transparent)",
        }}
      >
        {isCore ? "Core · Orchestrator" : `Expert ${(seat as number) + 1}`}
      </span>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const k = e.dataTransfer.getData("text/plain");
          if (k) onDropKey(seat, k);
        }}
        onClick={() => {
          if (armed) onPlace(seat);
        }}
        className="relative inline-flex items-center justify-center rounded-full transition-all"
        style={{
          width: ring,
          height: ring,
          cursor: armed ? "pointer" : "default",
          background: empty
            ? "color-mix(in srgb, var(--foreground) 4%, transparent)"
            : "var(--foreground)",
          border: empty
            ? `1px dashed ${over || droppable ? "color-mix(in srgb, var(--foreground) 70%, transparent)" : "color-mix(in srgb, var(--foreground) 30%, transparent)"}`
            : "none",
          boxShadow: empty
            ? over
              ? "0 0 0 3px color-mix(in srgb, var(--foreground) 30%, transparent)"
              : undefined
            : `0 10px 24px -6px color-mix(in srgb, black 50%, transparent)${over ? ", 0 0 0 3px color-mix(in srgb, var(--foreground) 65%, transparent)" : ""}`,
          transform: over ? "scale(1.05)" : undefined,
        }}
      >
        {empty ? (
          <span
            className="text-[20px] leading-none"
            style={{ color: "color-mix(in srgb, var(--foreground) 60%, transparent)" }}
          >
            +
          </span>
        ) : (
          <VendorLogo vendorKey={o.vendorKey} size={logo} onLight />
        )}
        {isCore && !empty && (
          <span
            className="absolute left-1/2 -translate-x-1/2 inline-flex items-center justify-center rounded-full"
            style={{
              top: -13,
              width: 22,
              height: 22,
              background: MOA_GOLD,
              color: BG,
              border: "2px solid var(--background)",
              boxShadow: "0 4px 10px -2px color-mix(in srgb, black 50%, transparent)",
            }}
          >
            <Crown style={{ width: 12, height: 12 }} />
          </span>
        )}
        {!empty && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(seat);
            }}
            title="Remove"
            className="absolute opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center rounded-full"
            style={{
              top: -9,
              right: -9,
              width: 18,
              height: 18,
              background: "color-mix(in srgb, var(--danger) 95%, transparent)",
              color: "var(--background)",
              border: "1px solid color-mix(in srgb, black 30%, transparent)",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            ×
          </button>
        )}
      </div>
      <span
        className="leading-tight text-center"
        style={{
          color: empty ? "color-mix(in srgb, var(--foreground) 40%, transparent)" : CREAM,
          fontSize: isCore ? 16 : 13,
        }}
      >
        {o?.label ?? (droppable ? "drop or click" : "drag a model")}
      </span>
    </div>
  );
}

// The council stage — core on top, three expert seats below, curved connectors
// that flow once both ends are filled.
function CouncilStage({
  core,
  experts,
  maxExperts,
  armed,
  dragActive,
  onPlace,
  onDropKey,
  onRemove,
}: {
  core: MoaModelOption | undefined;
  experts: MoaModelOption[];
  maxExperts: number;
  armed: boolean;
  dragActive: boolean;
  onPlace: (seat: "core" | number) => void;
  onDropKey: (seat: "core" | number, key: string) => void;
  onRemove: (seat: "core" | number) => void;
}) {
  const slots = Array.from({ length: maxExperts }, (_, i) => experts[i]);
  return (
    <div
      className="relative h-full flex flex-col items-center justify-start pt-6 pb-3 px-2"
      style={{ minHeight: 280 }}
    >
      <CouncilSeat
        seat="core"
        o={core}
        armed={armed}
        dragActive={dragActive}
        onPlace={onPlace}
        onDropKey={onDropKey}
        onRemove={onRemove}
      />
      <svg
        viewBox="0 0 300 56"
        preserveAspectRatio="none"
        aria-hidden
        style={{ width: "90%", maxWidth: 380, height: 50, margin: "16px 0 4px" }}
      >
        {[52, 150, 248].map((x, i) => {
          const filled = !!core && !!experts[i];
          return (
            <path
              key={i}
              d={`M150 2 C150 30 ${x} 24 ${x} 54`}
              fill="none"
              stroke={filled ? "color-mix(in srgb, var(--foreground) 75%, transparent)" : "color-mix(in srgb, var(--foreground) 16%, transparent)"}
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <div className="flex items-start justify-center gap-4 sm:gap-6 w-full flex-wrap">
        {slots.map((o, i) => (
          <CouncilSeat
            key={i}
            seat={i}
            o={o}
            armed={armed}
            dragActive={dragActive}
            onPlace={onPlace}
            onDropKey={onDropKey}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}

// Max tokens per call — a slider with a live quality-tradeoff explainer.
function MaxTokensControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const note =
    value <= 4096
      ? {
          c: "var(--success)",
          t: "Sweet spot — references stay short & sharp, so the core gets clean signal (the HermesBench default).",
        }
      : value <= 8192
        ? {
            c: MOA_TEAL,
            t: "Roomier — fine for a genuinely complex turn, but each reference gets wordier.",
          }
        : value <= 12288
          ? {
              c: "var(--warn)",
              t: "Roomy — references start hedging & repeating and the core has more noise to wade through; quality often dips.",
            }
          : {
              c: "var(--danger)",
              t: "Max — references can write essays, which usually lowers MoA quality, and you're near GPT-5.5's ceiling.",
            };
  return (
    <div
      className="px-3 py-2.5"
      style={{
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, var(--foreground) 16%, transparent)",
        background: "color-mix(in srgb, var(--foreground) 1.5%, transparent)",
      }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span
          className="font-mono text-[13px]"
          style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
        >
          Max tokens / call
        </span>
        <span
          className="font-mono text-[13px] tabular-nums"
          style={{ color: CREAM }}
        >
          {fmtCount(value)}
        </span>
      </div>
      <input
        type="range"
        min={2048}
        max={16384}
        step={1024}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: MOA_TEAL }}
      />
      <div
        className="text-[13px] leading-snug mt-1.5"
        style={{ color: note.c }}
      >
        {note.t}
      </div>
      <div
        className="font-mono text-sm mt-1.5"
        style={{ color: "color-mix(in srgb, var(--foreground) 30%, transparent)" }}
      >
        change it anytime · smaller usually = sharper MoA
      </div>
    </div>
  );
}

// Direct write — saves the preset into ~/.hermes/config.yaml on THIS machine
// (Mac & Windows, via the loopback backend), merged + backed up. No copy-paste.
function MinistrySave({
  core,
  experts,
  maxTokens,
}: {
  core: MoaModelOption | undefined;
  experts: MoaModelOption[];
  maxTokens: number;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = !!core && experts.length > 0;
  async function save() {
    if (!ready || saving || !core) return;
    setSaving(true);
    setMsg(null);
    try {
      const token =
        (
          await fetch("/__token")
            .then((r) => r.json())
            .catch(() => null)
        )?.token ?? "";
      const r = await fetch("/__hermes_moa_save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-claude-os-token": token,
        },
        body: JSON.stringify({
          name: "ministry",
          reference_models: experts.map((e) => ({
            provider: e.provider,
            model: e.model,
          })),
          aggregator: { provider: core.provider, model: core.model },
          reference_temperature: 0.6,
          aggregator_temperature: 0.4,
          max_tokens: maxTokens,
          enabled: true,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || `status ${r.status}`);
      setMsg({
        ok: true,
        text: `✓ Saved “${j.name || "ministry"}” to ~/.hermes/config.yaml · old config backed up. Restart any open Hermes session, then run  /model ministry --provider moa`,
      });
    } catch (e: any) {
      const m = String(e?.message ?? "save failed");
      setMsg({
        ok: false,
        text: m.includes("config.yaml")
          ? "No Hermes config on this machine — run `hermes setup` first."
          : m,
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={save}
        disabled={!ready || saving}
        className="font-mono text-[13px] px-3 py-2.5 transition-colors disabled:opacity-40"
        style={{
          borderRadius: 8,
          background: ready ? MOA_TEAL : "transparent",
          color: ready ? BG : "color-mix(in srgb, var(--foreground) 50%, transparent)",
          border: `1px solid ${MOA_TEAL}`,
        }}
      >
        {saving
          ? "Saving to this computer…"
          : msg?.ok
            ? "✓ Saved — re-save anytime"
            : "⤓ Save to this computer"}
      </button>
      <div
        className="font-mono text-[13px] leading-relaxed"
        style={{
          color: msg
            ? msg.ok
              ? "var(--success)"
              : "var(--danger)"
            : "color-mix(in srgb, var(--foreground) 40%, transparent)",
          ...(msg
            ? {
                borderRadius: 6,
                padding: "6px 8px",
                background: msg.ok
                  ? "color-mix(in srgb, var(--success) 8%, transparent)"
                  : "color-mix(in srgb, var(--danger) 8%, transparent)",
                border: `1px solid ${
                  msg.ok ? "color-mix(in srgb, var(--success) 28%, transparent)" : "color-mix(in srgb, var(--danger) 28%, transparent)"
                }`,
              }
            : {}),
        }}
      >
        {msg
          ? msg.text
          : "writes the preset into Hermes' config (Mac & Windows) — no copy-paste, backed up first"}
      </div>
    </div>
  );
}

// Copy block — the manual fallback (paste the prompt to Hermes yourself).
function MinistryCopy({ text }: { text: string }) {
  const { copied, failed, copy } = useCopyState(1500);
  function copyNow() {
    void copy(text);
  }
  return (
    <div className="rounded-lg border border-border bg-inset">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <BrandMark agent="hermes" size={16} />
          Copy for Hermes
        </span>
        <Button type="button" size="xs" variant={copied ? "outline" : "accent"} onClick={copyNow}>
          {copied ? "Copied" : failed ? "Couldn't copy" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-[150px] overflow-y-auto whitespace-pre-wrap p-3 font-mono text-sm leading-relaxed text-foreground/85">
        {text}
      </pre>
    </div>
  );
}

// Claude models served by the Claude Code bridge (scripts/claude-bridge.ts) — the pre-E2 set,
// named by catalogue id.
const CLAUDE_SUB_MODELS = new Set(["claude/opus-5-5", "claude/sonnet-5", "claude/fable-5-1", "claude/haiku-4-5"].map(providerModelId));

/** The pre-E2 Ministry bench: every priced, non-retired model in the market dataset, routed as before. */
function legacyMinistrySeats(): MoaModelOption[] {
  const list =
    (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ??
    [];
  return list
    .filter(
      (x) =>
        x.openrouterId &&
        x.price &&
        typeof x.price.inputPerM === "number" &&
        typeof x.price.outputPerM === "number" &&
        x.status !== "retired" &&
        x.id !== "claude-opus-4-7", // superseded by Opus 4.8 (a market-dataset id)
    )
    .map((x) => {
      // Provider-aware routing (a single moa preset can mix providers).
      // OpenAI models route through the user's ChatGPT subscription
      // (openai-codex) → $0-marginal "sub" reference. The codex provider
      // takes the bare model id (gpt-5.5), not the openrouter "openai/…"
      // slug. Everything else routes via OpenRouter (one key, cheap opens).
      // Claude models the Claude Code bridge serves go through the Claude
      // subscription (Hermes provider "claude-sub", backed by /__claude).
      const orId = String(x.openrouterId);
      const isOpenAI = String(x.vendorKey) === "openai";
      const isClaudeSub = CLAUDE_SUB_MODELS.has(String(x.id));
      return {
        key: String(x.id),
        label: String(x.name),
        vendorKey: String(x.vendorKey),
        provider: isOpenAI ? "openai-codex" : isClaudeSub ? "claude-sub" : "openrouter",
        model: isOpenAI ? orId.split("/").slice(1).join("/") : isClaudeSub ? String(x.id) : orId,
        sub: isOpenAI || isClaudeSub,
        adviseOnly: isClaudeSub,
        tier: String(x.tier ?? ""),
        inPerM: x.price.inputPerM as number,
        outPerM: x.price.outputPerM as number,
        intelligence:
          typeof x.benchmarks?.aaIndex === "number"
            ? (x.benchmarks.aaIndex as number)
            : undefined,
        arenaElo:
          typeof x.benchmarks?.lmarenaElo === "number"
            ? (x.benchmarks.lmarenaElo as number)
            : undefined,
        speedTps:
          typeof x.speedTps === "number" ? (x.speedTps as number) : undefined,
        context:
          typeof x.context === "number" ? (x.context as number) : undefined,
      };
    });
}

/**
 * Catalogue seats the pre-E2 bench didn't have (Groq and Cline free models, newer plan models),
 * with the catalogue's route and price. A metered seat without a catalogue price is left to the
 * bench above (it can't be estimated). model-intel only adds benchmark facts.
 */
function catalogueMinistrySeats(existing: MoaModelOption[]): MoaModelOption[] {
  const intelModels = (modelIntel as unknown as { models?: Array<Record<string, any>> }).models ?? [];
  const have = new Set(existing.map((o) => `${o.provider}\u0000${o.model}`));
  const byPrefix: Record<string, string> = { google: "gemini", anthropic: "claude", "x-ai": "grok", moonshotai: "moonshot", "z-ai": "zai" };
  const byProvider: Record<string, string> = { "claude-sub": "claude", "openai-codex": "openai", googlegemini: "gemini" };
  return hermesPickerCatalog().flatMap((g) =>
    g.models
      .filter((e) => (e.route !== "metered" || e.price !== null) && !have.has(`${g.provider}\u0000${e.name}`))
      .map((e): MoaModelOption => {
        const bare = e.name.replace(/:free$/, "");
        const intel = intelModels.find((x) => x.id === e.name || (x.openrouterId && (x.openrouterId === e.name || x.openrouterId === bare)));
        const prefix = e.name.includes("/") ? e.name.split("/")[0] : "";
        return {
          key: e.id,
          intelId: intel ? String(intel.id) : undefined,
          label: e.label,
          vendorKey: intel?.vendorKey ? String(intel.vendorKey) : prefix ? byPrefix[prefix] ?? prefix : byProvider[g.provider] ?? e.name.split("-")[0],
          provider: g.provider,
          model: e.name,
          sub: e.route === "subscription",
          free: e.route === "free",
          // Text-only lanes (no tool use) can advise but cannot be the core, which runs tools.
          adviseOnly: !e.tools,
          tier: e.tier,
          inPerM: e.price?.inputUsdPerM ?? 0,
          outPerM: e.price?.outputUsdPerM ?? 0,
          intelligence: typeof intel?.benchmarks?.aaIndex === "number" ? (intel.benchmarks.aaIndex as number) : undefined,
          arenaElo: typeof intel?.benchmarks?.lmarenaElo === "number" ? (intel.benchmarks.lmarenaElo as number) : undefined,
          speedTps: typeof intel?.speedTps === "number" ? (intel.speedTps as number) : undefined,
          context: typeof intel?.context === "number" ? (intel.context as number) : undefined,
        };
      }),
  );
}

const MINISTRY_OPTIONS: MoaModelOption[] = (() => {
  const legacy = legacyMinistrySeats();
  return [...legacy, ...catalogueMinistrySeats(legacy)];
})();
/** The bench key of the seat that runs a catalogue model (pre-E2 keys are market-dataset ids). */
function ministrySeatKey(catalogueId: string): string {
  const r = hermesRef(catalogueId);
  return MINISTRY_OPTIONS.find((o) => o.provider === r.provider && o.model === r.name)?.key ?? catalogueId;
}
// Matches the "ministry" preset in ~/.hermes/config.yaml: GPT-6 Sol acts; Claude
// (subscription), GPT-6 Astra and DeepSeek advise.
const MINISTRY_DEFAULT_CORE = ministrySeatKey("codex/gpt-6-sol");
const MINISTRY_DEFAULT_EXPERTS = ["claude/opus-5-5", "codex/gpt-6-astra", "openrouter/deepseek-v4-pro"].map(ministrySeatKey);

function MinistryCard() {
  const [open, setOpen] = useState(false);
  const options = useMemo<MoaModelOption[]>(() => MINISTRY_OPTIONS, []);
  const byKey = useMemo(
    () =>
      Object.fromEntries(options.map((o) => [o.key, o])) as Record<
        string,
        MoaModelOption
      >,
    [options],
  );

  const [coreKey, setCoreKey] = useState(MINISTRY_DEFAULT_CORE);
  const [expertKeys, setExpertKeys] = useState<string[]>(MINISTRY_DEFAULT_EXPERTS);
  const [seatNote, setSeatNote] = useState("");
  const MAX_EXPERTS = 3;

  const core = byKey[coreKey];
  const experts = expertKeys
    .map((k) => byKey[k])
    .filter(Boolean) as MoaModelOption[];

  // Drag-and-drop / click-to-place state. One model can be "armed" (picked by
  // click) and then placed on a seat; or dragged straight onto a seat.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  function assignSeat(seat: "core" | number, k: string) {
    if (seat === "core") setCoreModel(k);
    else setExpertSlot(seat, k);
  }
  function dropOnSeat(seat: "core" | number, k: string) {
    assignSeat(seat, k);
    setArmedKey(null);
    setDragKey(null);
  }
  function placeArmed(seat: "core" | number) {
    if (!armedKey) return;
    assignSeat(seat, armedKey);
    setArmedKey(null);
  }
  function removeSeat(seat: "core" | number) {
    if (seat === "core") setCoreKey("");
    else removeExpertSlot(seat);
  }
  function armBench(k: string) {
    setArmedKey((cur) => (cur === k ? null : k));
  }

  function toggleExpert(k: string) {
    if (k === coreKey) return; // a model can't be both core and expert
    setExpertKeys((cur) => {
      if (cur.includes(k)) return cur.filter((x) => x !== k);
      if (cur.length >= MAX_EXPERTS) return cur;
      return [...cur, k];
    });
  }

  // Make a model the orchestrator (core); drop it from experts if it was one.
  function setCoreModel(k: string) {
    if (byKey[k]?.adviseOnly) {
      setSeatNote(
        byKey[k].provider === "claude-sub"
          ? `${byKey[k].label} runs on your Claude subscription as text only, so it can advise but not orchestrate. Seat it as an expert.`
          : `${byKey[k].label} runs text only (no tool use on this lane), so it can advise but not orchestrate. Seat it as an expert.`,
      );
      return;
    }
    setSeatNote("");
    setCoreKey(k);
    setExpertKeys((cur) => cur.filter((x) => x !== k));
  }

  function resetRecommended() {
    setSeatNote("");
    setCoreKey(MINISTRY_DEFAULT_CORE);
    setExpertKeys(MINISTRY_DEFAULT_EXPERTS);
  }

  // Set/replace expert slot i (append when it's a fresh empty slot); no dupes.
  function setExpertSlot(i: number, k: string) {
    setExpertKeys((cur) => {
      if (cur.includes(k)) return cur;
      const next = [...cur];
      if (i < next.length) next[i] = k;
      else if (next.length < MAX_EXPERTS) next.push(k);
      return next;
    });
  }
  function removeExpertSlot(i: number) {
    setExpertKeys((cur) => cur.filter((_, idx) => idx !== i));
  }

  const demo = useDemoMode();
  const { data: live } = useOpenRouterPrices(!demo);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open)
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [open]);
  useEffect(() => {
    if (!armedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armedKey]);

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"arena" | "cost" | "speed">("arena");

  const paletteModels = useMemo(() => {
    const arr = [...options];
    if (sortBy === "cost")
      arr.sort(
        (a, b) =>
          (ministryRate(a, live).outPerM || 0) -
          (ministryRate(b, live).outPerM || 0),
      );
    else if (sortBy === "speed")
      arr.sort((a, b) => (b.speedTps ?? 0) - (a.speedTps ?? 0));
    else arr.sort((a, b) => ministryPower(b) - ministryPower(a));
    return arr;
  }, [options, sortBy, live]);

  const focusModel = (focusKey && byKey[focusKey]) || core || experts[0];

  // Esc clears an armed (click-to-place) selection.
  useEffect(() => {
    if (!armedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armedKey]);

  const [maxTokens, setMaxTokens] = useState(4096);
  const prompt = ministryPrompt(core, experts, maxTokens);

  // ── Closed: a neutral card with a stacked-logo preview (no hero art) ──
  if (!open) {
    return (
      <Surface
        as="button"
        type="button"
        variant="interactive"
        onClick={() => setOpen(true)}
        className="flex flex-col gap-3 text-left w-full"
        title="Assemble the Ministry of Experts"
      >
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-inset text-brand">
            <Crown className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight text-foreground">Ministry of Experts</div>
            <Badge tone="accent" className="mt-1">
              Mixture of agents · MoA
            </Badge>
          </div>
        </div>
        <p className="text-sm leading-snug text-muted-foreground line-clamp-2">
          A council of models that answers as one. Tap to assemble — a core model + up to three
          experts.
        </p>
        {experts.length > 0 && (
          <div className="flex items-center gap-1.5">
            {experts.slice(0, 3).map((e) => (
              <span
                key={e.key}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border bg-inset"
              >
                <VendorLogo vendorKey={e.vendorKey} size={14} />
              </span>
            ))}
          </div>
        )}
      </Surface>
    );
  }

  // ── Open: the council builder — palette · council · stats+copy ──
  return (
    <div
      ref={panelRef}
      className="col-span-full rounded-xl border border-border bg-card p-5 shadow-sm md:p-6"
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-inset text-brand">
            <Crown className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Pantheon · the ensemble</div>
            <h3 className="text-lg font-semibold leading-tight text-foreground">Ministry of Experts</h3>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={resetRecommended}
            title="Reset to the default line-up (Opus 4.8 · GPT-5.5 · GLM 5.2 · DeepSeek V4 Pro)"
            className="font-mono text-[13px] px-2.5 py-1.5 border transition-colors"
            style={{
              color: MOA_TEAL,
              borderColor: "color-mix(in srgb, var(--foreground) 40%, transparent)",
              background: "color-mix(in srgb, var(--foreground) 6%, transparent)",
            }}
          >
            ↺ Use default
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="font-mono text-[13px] px-2.5 py-1.5 border"
            style={{
              color: CREAM,
              borderColor: "color-mix(in srgb, var(--foreground) 30%, transparent)",
              background: "color-mix(in srgb, var(--foreground) 4%, transparent)",
            }}
          >
            Close
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[0.82fr_1.18fr] gap-5 items-start">
        {/* LEFT — the bench + analytics underneath */}
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div
                className="font-mono text-[13px]"
                style={{ color: CREAM }}
              >
                The Bench
              </div>
              <div
                className="font-mono text-[13px] mt-0.5 truncate"
                style={{ color: seatNote ? "var(--danger)" : armedKey ? MOA_GOLD : "color-mix(in srgb, var(--foreground) 40%, transparent)" }}
              >
                {seatNote
                  ? seatNote
                  : armedKey
                  ? `→ click a seat to place ${byKey[armedKey]?.label ?? "it"} · Esc cancels`
                  : "drag a model onto a seat — or click it, then a seat"}
              </div>
            </div>
            <Segmented
              ariaLabel="Rank the bench by"
              value={sortBy}
              onChange={setSortBy}
              options={[
                { value: "arena", label: "Arena" },
                { value: "cost", label: "Cost" },
                { value: "speed", label: "Speed" },
              ]}
              className="shrink-0"
            />
          </div>
          <div
            className="grid grid-cols-3 gap-1.5"
            onMouseLeave={() => setFocusKey(null)}
          >
            {paletteModels.map((o) => {
              const expIdx = expertKeys.indexOf(o.key);
              const role: "core" | "expert" | null =
                o.key === coreKey ? "core" : expIdx >= 0 ? "expert" : null;
              return (
                <PaletteModelBox
                  key={o.key}
                  o={o}
                  role={role}
                  index={expIdx}
                  armed={armedKey === o.key}
                  sortBy={sortBy}
                  onArm={armBench}
                  onDragKey={setDragKey}
                  onFocus={setFocusKey}
                />
              );
            })}
          </div>
        </div>

        {/* RIGHT — the council (lifted). Flat dark ground (.ds-stage), no
            hero art or gradient — the seats themselves carry the content. */}
        <div className="flex flex-col gap-3">
          <div
            className="ds-stage relative overflow-hidden rounded-xl flex items-start justify-center"
            style={{ minHeight: 300 }}
          >
            <div className="relative w-full">
              <CouncilStage
                core={core}
                experts={experts}
                maxExperts={MAX_EXPERTS}
                armed={armedKey != null}
                dragActive={dragKey != null}
                onPlace={placeArmed}
                onDropKey={dropOnSeat}
                onRemove={removeSeat}
              />
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM — analytics (≈ first 2 bench columns) + the prompt, aligned. */}
      <div className="grid lg:grid-cols-[0.82fr_1.18fr] gap-5 mt-4 items-start">
        <div className="grid grid-cols-3 gap-1.5">
          <div className="col-span-2">
            <MinistryAnalytics
              model={focusModel}
              lineup={[core, ...experts].filter(Boolean) as MoaModelOption[]}
              live={live}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <MaxTokensControl value={maxTokens} onChange={setMaxTokens} />
          <MinistrySave core={core} experts={experts} maxTokens={maxTokens} />
          <MinistryCopy text={prompt} />
        </div>
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div
      className="border p-5"
      style={{ borderColor: "color-mix(in srgb, var(--foreground) 20%, transparent)", background: "var(--inset)" }}
    >
      <div
        className="flex items-center gap-2 font-mono text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 50%, transparent)" }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: CREAM }} />
        {label}
      </div>
      <div className="font-sans font-semibold mt-2 text-4xl" style={{ color: CREAM }}>
        {value}
      </div>
      <div
        className="font-mono mt-1 text-[13px]"
        style={{ color: "color-mix(in srgb, var(--foreground) 45%, transparent)" }}
      >
        {sub}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Run-in-terminal card — single component used for both the
// "not installed" and "installed but no provider key" states.
//
// Setup intentionally lives in the user's terminal. Hermes has its own
// great `hermes setup` wizard (provider picker, OAuth flows, model
// selection, optional gateways / tts / tools) — we don't reimplement it
// in the browser. The dashboard's value is the chat + insights once
// configured. When state is anything other than "ready", this card hands
// the user the right copy-paste command and gets out of the way.
// ────────────────────────────────────────────────────────────────────────────

function RunInTerminalCard({
  title,
  body,
  command,
  hint,
}: {
  title: string;
  body: ReactNode;
  command: string;
  hint?: string;
}) {
  const { copied, failed, copy } = useCopyState(1500);
  function handleCopy() {
    void copy(command);
  }
  return (
    <Surface className="mb-10 flex flex-col" padding="none">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="text-sm text-muted-foreground">Terminal step</div>
        <BrandMark agent="hermes" size={20} />
      </div>
      <div className="flex flex-col items-center px-6 py-8 text-center md:px-10">
        <h2 className="mb-4 text-2xl font-semibold leading-tight text-foreground">{title}</h2>
        <p className="mb-7 max-w-2xl text-sm leading-relaxed text-muted-foreground">{body}</p>
        <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="text-sm text-muted-foreground">Run in your terminal</span>
            <Button type="button" size="xs" variant="ghost" onClick={handleCopy}>
              {copied && <CheckCircle2 className="h-3 w-3" />}
              {copied ? "Copied" : failed ? "Couldn't copy" : "Copy"}
            </Button>
          </div>
          <div className="bg-inset px-5 py-4 text-left">
            <code className="block break-all font-mono text-sm text-foreground">{command}</code>
          </div>
        </div>
        {hint && <div className="mt-5 max-w-2xl text-sm text-muted-foreground">{hint}</div>}
      </div>
    </Surface>
  );
}
