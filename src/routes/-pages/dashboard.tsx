// Page body for /dashboard (route definition: src/routes/dashboard.tsx).
import { operatorRequest, useOperator } from "@/lib/operator";
import { Link, useNavigate } from "@tanstack/react-router";
import { AiUsageSummary } from "@/components/ai-usage/ai-usage-summary";
import { LeadsDashboardCard } from "@/components/operator/leads-dashboard-card";
import { AwayModeCard } from "@/components/operator/away-mode-card";
import { DreamMorningReport, DreamRunStatus } from "@/components/dream-morning-report";
import {
  fmtAud,
  fmtMoneyOrigin,
  fmtResetIn,
  pressureTone,
  useAiUsage,
  useAiUsageActions,
  type AiUsageSnapshot,
  type PriceSetting,
  type SubscriptionCard,
} from "@/lib/ai-usage";
import { chatgptPriceId } from "../../../scripts/ai-usage/prices";
import { providerModelId } from "../../../scripts/model-router/catalogue";
import { SetupModal } from "./setup";
import { workspaces } from "@/lib/mock-data";
import { useLiveData } from "@/lib/use-live-data";
import { useWorkspaceProfile } from "@/lib/workspace-profile";
import dreamCosmos from "@/assets/dream-cosmos.jpg";
import dreamMemoryPink from "@/assets/dream/memory-pink.png";
import dreamCostOrange from "@/assets/dream/cost-orange.png";
import dreamSkillsBlue from "@/assets/dream/skills-blue.png";
import dreamWorkflowYellow from "@/assets/dream/workflow-yellow.png";
import logoAntigravity from "@/assets/logos/antigravity.png";
import logoApify from "@/assets/logos/apify.png";
import logoCanva from "@/assets/logos/canva.png";
import logoFirecrawl from "@/assets/logos/firecrawl.png";
import logoGamma from "@/assets/logos/gamma.png";
import logoOpenai from "@/assets/logos/openai.png";
import logoOpenrouter from "@/assets/logos/openrouter.svg";
import logoOpenclaw from "@/assets/logos/openclaw.svg";
import logoPinecone from "@/assets/logos/pinecone.png";
import logoNotebooklm from "@/assets/logos/notebooklm.png";
import logoSupabase from "@/assets/logos/supabase.png";
import logoZapier from "@/assets/logos/zapier.png";
import logoNotion from "@/assets/logos/notion.png";
import logoTelegram from "@/assets/logos/telegram.png";
import logoYoutube from "@/assets/logos/youtube.svg";
import logoGmail from "@/assets/logos/gmail.svg";
import logoGoogleCalendar from "@/assets/logos/googlecalendar.svg";
import logoGoogleDrive from "@/assets/logos/googledrive.svg";
import logoGoogleGemini from "@/assets/logos/googlegemini.svg";
import claudeLogo from "@/assets/claude-logo.png";
import graphifyGraph from "@/data/graphs/power-design.json";
import hermesAgentLogo from "@/assets/hermes-agent.png";

const LOCAL_LOGO_MAP: Record<string, string> = {
  apify: logoApify,
  canva: logoCanva,
  firecrawl: logoFirecrawl,
  gamma: logoGamma,
  openai: logoOpenai,
  openrouter: logoOpenrouter,
  openclaw: logoOpenclaw,
  pinecone: logoPinecone,
  notebooklm: logoNotebooklm,
  googlenotebooklm: logoNotebooklm,
  supabase: logoSupabase,
  zapier: logoZapier,
  notion: logoNotion,
  telegram: logoTelegram,
  youtube: logoYoutube,
  gmail: logoGmail,
  googlecalendar: logoGoogleCalendar,
  googledrive: logoGoogleDrive,
  googlegemini: logoGoogleGemini,
};
import {
  ArrowUpRight,
  Brain,
  Sparkles,
  Activity as ActivityIcon,
  DollarSign,
  Wand2,
  Zap,
  CheckCircle2,
  XCircle,
  Plug,
  Database,
  Calendar,
  Mail,
  FileText,
  Youtube,
  Workflow,
  Bot,
  Image as ImageIco,
  Send,
  Search,
  Layers,
  Clock,
  AlertTriangle,
  Lightbulb,
  Pencil,
  TrendingUp,
  Megaphone,
  ScrollText,
  HandCoins,
  PlayCircle,
  Network,
  MessageSquare,
  MousePointerClick,
  Loader2,
  X,
  ChevronRight,
  Terminal as TerminalIcon,
  Users,
  Plane,
  Gauge,
  Moon,
  BrainCircuit,
  Cpu,
  Orbit,
} from "lucide-react";
import { InCalmSection } from "@/components/calm/calm";
import { DeckGrid, DeckSection, type DeckItem } from "@/components/shell/widgets";
import { MeasuredTokens } from "@/components/measured-tokens";
import { useQuery } from "@tanstack/react-query";
import { leadsApi } from "@/lib/leads";
import * as React from "react";
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";

// Cinematic full-screen replay of last night's Dream run — loaded on demand
// so the homepage bundle doesn't pay for it until the user hits ▶ Replay.
const DreamReplay = lazy(() => import("@/components/dream-replay"));
import {
  useTimeSaved,
  totals,
  formatHours,
  getDefaultMinutes,
  type Period,
} from "@/lib/time-saved";
import { TrendsPanel } from "@/components/trends-panel";
import { pageName } from "@/components/shell/destinations";
import {
  BottomPanelSwitcher,
  BottomPanel,
  ModelIntelligence,
} from "@/components/model-intelligence";
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  Notice,
  PageHeader,
  Segmented,
  StatTile,
  StatusDot,
  Surface,
  fmtCompact,
  fmtCount,
} from "@/components/ds";
import { currencyPrefix, fmtDateTime, fmtDay, fmtMoney as formatMoney, fmtProse, fmtTime, fmtWeekday } from "@/lib/format";
import { useValueRate } from "@/lib/value-metrics";

const MemoryGraph3D = lazy(() => import("@/components/memory-graph-3d"));
const GraphifyGraph3D = lazy(() => import("@/components/graphify-graph-3d"));
const KG_NODES = ((graphifyGraph as any).nodes ?? []).length;
const KG_LINKS = ((graphifyGraph as any).links ?? []).length;
const KG_COMMUNITIES = new Set(((graphifyGraph as any).nodes ?? []).map((n: any) => n.community))
  .size;



// ---------- Live-data derivations ----------
// liveData is whatever scripts/aggregate.ts most recently emitted.
// On first run we ship src/data/live-data.example.json (isExample=true)
// so the dashboard boots with sensible numbers before the user runs the
// aggregator. Real numbers replace these once `bun run aggregate` runs.

// Moved to component scope — see DashboardPage below
let ld: any = {};
let isDemoData = true;
let hasRealActivity = false;
// "Cold real" = aggregator ran but found no activity (fresh user, FDA denied,
// or Claude Code never used). Different from demo state.
let isColdReal = false;

// The days the aggregator measured, for the Activity sparkline. No sample series: with no days, no line.
const usageDaily: { day: string; cost: number; runs: number }[] =
  Array.isArray(ld?.daily) && ld.daily.length > 0
    ? ld.daily.map((d: any) => ({
        day: fmtWeekday(new Date(d.day)),
        cost: Number(d.cost) || 0,
        runs: Math.max(1, Math.round((Number(d.messages) || 0) / 6)),
      }))
    : [];

// ---------- Demo data unique to this page ----------

type SkillStatus = "active" | "dormant" | "dead";
interface DemoSkill {
  name: string;
  icon: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  uses: number; // this period
  minsPerRun: number; // estimate
  status: SkillStatus;
  lastUsed: string;
  estimateSource: "you" | "ai" | "manual";
}

// Sample shipped with the app. Used only when the dashboard is in demo
// mode (live-data.example.json copied to live-data.json on first run).
// Real deployments replace this with skills derived from liveData.skills.active.

// Map a live `/<command>` to a reasonable icon. Falls back to Sparkles.
function iconForSkill(
  name: string,
): ComponentType<{ className?: string; style?: React.CSSProperties }> {
  const n = name.toLowerCase();
  if (n.includes("title")) return Pencil;
  if (n.includes("research") || n.includes("recall")) return Search;
  if (n.includes("wrap") || n.includes("session") || n.includes("handoff")) return Network;
  if (n.includes("intro") || n.includes("script")) return ScrollText;
  if (n.includes("comment")) return MessageSquare;
  if (n.includes("video") || n.includes("play")) return PlayCircle;
  if (n.includes("invoice") || n.includes("money") || n.includes("bill")) return HandCoins;
  if (n.includes("ad") || n.includes("sponsor") || n.includes("market")) return Megaphone;
  if (n.includes("trend") || n.includes("signal") || n.includes("report")) return TrendingUp;
  if (n.includes("hook") || n.includes("scroll")) return MousePointerClick;
  return Sparkles;
}

// Derive home-page skill cards from liveData.skills.active. Each entry's
// "uses" reflects the trailing 7d, so periodFactor (day/week/month) maps
// cleanly onto it. minsPerRun is a heuristic until the user calibrates per
// skill on the Skills page.
function deriveSkillsFromLive(): DemoSkill[] {
  const live = ld?.skills?.active;
  if (!Array.isArray(live) || live.length === 0) return [];
  const now = Date.now();
  return live.map((s: any): DemoSkill => {
    const uses = Number(s?.uses7d) || 0;
    const lastUsedMs = Number(s?.lastUsedMs) || 0;
    const ageDays = lastUsedMs ? (now - lastUsedMs) / (1000 * 60 * 60 * 24) : 999;
    const status: SkillStatus = uses > 0 ? "active" : ageDays > 30 ? "dead" : "dormant";
    const name = String(s?.name || "/skill");
    return {
      name,
      icon: iconForSkill(name),
      uses,
      // Defensible per-skill default minutes-per-run from time-saved.ts.
      // The user can override any of these via the Skills page — this just
      // gives the dashboard a believable starting value instead of $0.
      minsPerRun: getDefaultMinutes(name),
      status,
      lastUsed: String(s?.lastUsed || "—"),
      estimateSource: "manual",
    };
  });
}

let liveDerivedSkills = deriveSkillsFromLive();
// Pick which list to render in the "Your skills" section.
// - DEMO: use the rich shipped sample so a fresh install looks alive.
// - REAL: use whatever the aggregator found. Empty real → empty state.
let demoSkills: DemoSkill[] = liveDerivedSkills;

// Rising 14-day activity trend.
// When liveData.daily has entries (after running `bun run aggregate`), the
// most recent 7 days come from real data; older days are backfilled with a
// synthetic but believable trend so the chart isn't half-empty on day one.
function computeDailyActivity(): {
  date: string;
  label: string;
  sessions: number;
  minutes: number;
}[] {
  // Prefer REAL per-day session counts when the aggregator has emitted
  // them (new schema in `daily[*].sessions`). Fall back to the old
  // messages/6 heuristic only when that field is missing (older
  // live-data files). Final fallback (no day-bucket at all) is 0 — the
  // previous fake "noise + base" filler created phantom days that
  // looked like real activity, which is exactly the bug that made the
  // dashboard show "20 sessions on disk" or "used once this week" when
  // disk reality was much higher.
  const realByDay = new Map<string, { messages: number; sessions: number | null }>();
  if (Array.isArray(ld?.daily)) {
    for (const d of ld.daily) {
      if (d?.day) {
        realByDay.set(String(d.day), {
          messages: Number(d.messages) || 0,
          sessions: typeof d.sessions === "number" ? Number(d.sessions) : null,
        });
      }
    }
  }
  const out: { date: string; label: string; sessions: number; minutes: number }[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const real = realByDay.get(iso);
    let sessions: number;
    if (real?.sessions !== null && real?.sessions !== undefined) {
      sessions = real.sessions;
    } else if (real?.messages) {
      sessions = Math.max(1, Math.round(real.messages / 6));
    } else {
      sessions = 0;
    }
    out.push({
      date: iso,
      label:
        i === 0
          ? "Today"
          : i === 1
            ? "Yesterday"
            : fmtDay(d, { weekday: true }),
      sessions,
      minutes: sessions === 0 ? 0 : sessions * (32 + ((sessions * 7) % 18)),
    });
  }
  return out.reverse();
}
let dailyActivity = computeDailyActivity();

// Skill recommendations — research-backed, evidence-driven.
interface SkillRecommendation {
  name: string;
  command: string;
  evidenceCount: number;
  basis: string;
  predictedSavings: { hoursPerMonth: number; dollarsPerMonth: number };
  confidence: number;
  inspiredBy: string[];
}

let liveRecommended = ld?.skills?.recommended;
let skillRecommendations: SkillRecommendation[] = Array.isArray(liveRecommended)
  ? liveRecommended
  : [];

// Integrations come from liveData (the aggregator filters to signals it can
// actually verify — keychain creds, env vars, OAuth files). The UI hides
// the section when the list is empty. Each entry must already be `connected`
// because the aggregator only emits real signals — no dead/false tiles.
type IntegrationTileData = {
  name: string;
  slug: string;
  connected: boolean;
  color: string;
  tagline?: string;
};
let liveIntegrations = ld?.integrations;
let integrations: IntegrationTileData[] = Array.isArray(liveIntegrations) ? liveIntegrations : [];

type KnowledgeStoreTileData = {
  kind?: string;
  slug: string;
  title: string;
  detail: string;
  brand?: string;
  color?: string;
  name?: string;
};
let liveKnowledgeStores = ld?.knowledgeStores;
let knowledgeStores: KnowledgeStoreTileData[] = Array.isArray(liveKnowledgeStores)
  ? liveKnowledgeStores.map((k: any) => ({
      ...k,
      name: k.name ?? (k.kind === "pinecone" ? "Pinecone" : (k.kind ?? "Vector store")),
      brand: k.brand ?? "FFFFFF",
      color: k.color ?? "1F1F1F",
    }))
  : [];

type AutomationRow = {
  name: string;
  cadence: string;
  lastRun: string;
  nextRun: string;
  status: "success" | "failed" | "pending" | string;
  source?: "cowork" | "codex" | "claude" | "claude-os";
  meta?: string;
};
let liveAutomations = ld?.automations;
let automations: AutomationRow[] = Array.isArray(liveAutomations) ? liveAutomations : [];

type DreamTone = "pink" | "orange" | "blue" | "yellow";

interface DreamSuggestion {
  id?: string;
  cat: "MEMORY" | "COST" | "SKILLS" | "WORKFLOW";
  tone: DreamTone;
  headline: string;
  prescription: string;
  evidence: string[];
  command?: string;
  dollarImpact: number;
  timeImpactMins: number;
  /** Lifecycle from ~/.claude-os/dreams/state.json (merged by the aggregator).
   *  "dismissed"/"accepted" items start hidden; /__dream_action keeps the
   *  verdict across refreshes. */
  status?: string;
  /** Days since this prescription id first appeared — recurring items get a
   *  "seen Nd" chip so they read differently from fresh ones. */
  ageDays?: number;
}

// Persist a Skip / Mark done / Restore verdict to ~/.claude-os/dreams/state.json
// via the dev server. Best-effort: the UI hides the card optimistically either
// way; on failure the verdict just doesn't survive the next refresh.
async function postDreamAction(id: string | undefined, action: "dismissed" | "accepted" | "restored") {
  if (!id) return;
  try {
    const { token } = await fetch("/__token").then((r) => r.json());
    await fetch("/__dream_action", {
      method: "POST",
      headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
  } catch {
    /* dev server endpoint unavailable (static build) — session-only hide */
  }
}

// Real prescriptions from ~/.claude-os/dreams/dream-{date}.json (inlined by
// the aggregator). Empty array = "all caught up" empty state.
let livePrescriptions = ld?.dream?.prescriptions;
let dreamSuggestions: DreamSuggestion[] =
  Array.isArray(livePrescriptions) && livePrescriptions.length > 0 ? livePrescriptions : [];
let dreamGeneratedAt: string | null = ld?.dream?.generatedAt ?? null;
let dreamDate: string | null = ld?.dream?.date ?? null;

// "Mark done" dismissals persist per-Dream in localStorage so a page refresh
// doesn't resurrect cards already cleared. Keyed by the Dream's date below.
function readDismissedDreams(key: string): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(arr) ? arr.filter((n: unknown): n is number => typeof n === "number") : [],
    );
  } catch {
    return new Set();
  }
}
// Dream cron health metadata from the aggregator. Drives the empty-state
// "Connect now" card — see DreamConnectCard below.
let dreamHealthStatus: string | null = ld?.dream?.healthStatus ?? null;
let dreamFixHint: string | null = ld?.dream?.fixHint ?? null;

// Engine picker. The OS's whole pitch is "operator console above your AI
// tools" — Dream picks up that thesis: we detect every engine the user has
// (Hermes / Claude Code / Codex / future: API key, Gemini, Ollama), show
// status for each, and let the operator pick which one runs their daily
// review. No defaults baked in. The chosen engine is persisted to
// localStorage so the same one is pre-selected on next visit.
type DreamEngine = {
  id: string;
  name: string;
  description: string;
  installed: boolean;
  ready: boolean;
  needsAction: string | null;
  cost: string;
};

// Always-visible engine chip that lives on the Dream Review header. Shows
// the currently-picked engine (from ~/.claude-os/config.json) so the user
// always knows what's running their Dream, and clicking it expands the
// same picker the empty-state card uses. Lets the user switch engines
// without having to break their existing dream first.
function DreamEngineSwitcher() {
  const [open, setOpen] = useState(false);
  const [engines, setEngines] = useState<DreamEngine[] | null>(null);
  const [currentChoice, setCurrentChoice] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orModel, setOrModel] = useState<string>(providerModelId("openrouter/claude-fable-5"));
  const [orModels, setOrModels] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    fetch("/__dream_engines")
      .then((r) => r.json())
      .then((d) => {
        setEngines(d.engines || []);
        if (d.openRouterModel) setOrModel(d.openRouterModel);
        if (Array.isArray(d.openRouterModels)) setOrModels(d.openRouterModels);
        // Backend config wins; fall back to localStorage (set on first
        // successful generate) so the chip remembers across visits even
        // before a daily cron has run with the new engine.
        let choice: string | null = d.currentChoice ?? null;
        if (!choice) {
          try {
            choice = localStorage.getItem("claude-os.dream.engine");
          } catch {
            /* localStorage blocked */
          }
        }
        setCurrentChoice(choice);
      })
      .catch(() => setEngines([]));
  }, []);

  const generate = async (engineId: string) => {
    setErrorMsg(null);
    setGenerating(engineId);
    try {
      const tokRes = await fetch("/__token");
      const { token } = await tokRes.json();
      const res = await fetch("/__trigger_dream", {
        method: "POST",
        headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineId }),
      });
      const data = await res.json();
      if (data.ok) {
        try {
          localStorage.setItem("claude-os.dream.engine", engineId);
        } catch {
          /* localStorage blocked */
        }
        window.location.reload();
        return;
      }
      // Map auth failures (e.g. `claude -p` with no setup-token → 401) to the
      // engine's own setup guidance instead of a cryptic raw API error.
      const raw = (data.stderr || data.stdout || data.error || "").trim();
      const looksAuth = /401|invalid authentication|unauthor|api key|setup-token|credential/i.test(
        raw,
      );
      const eng = engines?.find((x) => x.id === engineId);
      if (looksAuth && eng && !eng.ready && eng.needsAction) {
        setErrorMsg(`${eng.name} needs a one-time setup — ${eng.needsAction}`);
      } else {
        const tail = raw.split("\n").slice(-2).join(" ");
        setErrorMsg(tail || "Generation failed. Try a different engine.");
      }
      setGenerating(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setGenerating(null);
    }
  };

  const saveModel = async (model: string) => {
    setOrModel(model);
    try {
      const { token } = await fetch("/__token").then((r) => r.json());
      await fetch("/__set_dream_engine", {
        method: "POST",
        headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" },
        // Keep whatever engine is current; just record the OpenRouter model.
        body: JSON.stringify({ engine: currentChoice || "openrouter", model }),
      });
    } catch {
      /* best-effort */
    }
  };

  const currentEngine = engines?.find((e) => e.id === currentChoice) ?? null;

  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {currentEngine ? (
          <>
            <span className="text-muted-foreground">Engine</span>
            <span>{currentEngine.name}</span>
          </>
        ) : (
          <span>Pick engine</span>
        )}
        <ChevronRight className={`transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </Button>

      {open && (
        <div className="absolute left-0 sm:right-0 sm:left-auto top-full mt-2 z-30 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 shadow-lg">
          <div className="text-sm font-semibold text-foreground mb-1">
            Pick which engine runs your Dream
          </div>
          <div className="text-xs text-muted-foreground mb-4">
            Your choice is saved + used by the daily cron.
          </div>

          {engines === null ? (
            <div className="text-xs text-muted-foreground text-center py-4">
              Detecting engines…
            </div>
          ) : (
            <div className="space-y-2">
              {engines.map((e) => {
                const isGenerating = generating === e.id;
                const isCurrent = currentChoice === e.id;
                const anyGenerating = generating !== null;
                const statusLabel = isGenerating
                  ? "Generating…"
                  : isCurrent
                    ? "Current"
                    : e.ready
                      ? "Ready"
                      : e.installed
                        ? "Set up"
                        : "Not installed";
                const statusTone = isGenerating
                  ? "text-foreground"
                  : isCurrent
                    ? "text-muted-foreground"
                    : e.ready
                      ? "text-success"
                      : e.installed
                        ? "text-warn"
                        : "text-muted-foreground";
                const borderTone = isCurrent
                  ? "border-border bg-brand-soft"
                  : e.ready
                    ? "border-success/40 hover:border-success/40 hover:bg-success-soft"
                    : e.installed
                      ? "border-warn/40 hover:border-warn/40 hover:bg-warn-soft"
                      : "border-border cursor-not-allowed";
                return (
                  <div key={e.id} className="space-y-1.5">
                    <button
                      onClick={() => e.installed && generate(e.id)}
                      disabled={!e.installed || anyGenerating}
                      className={`w-full text-left rounded-xl border bg-inset px-3 py-2.5 transition-colors disabled:opacity-50 ${borderTone}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-foreground">{e.name}</div>
                          <div className="text-xs text-muted-foreground">{e.description}</div>
                        </div>
                        <div
                          className={`text-xs shrink-0 ${statusTone}`}
                        >
                          {statusLabel}
                        </div>
                      </div>
                    </button>
                    {e.id === "openrouter" && e.installed && orModels.length > 0 && (
                      <div className="flex items-center gap-2 pl-3 pr-1">
                        <span className="text-xs text-muted-foreground shrink-0">
                          Model
                        </span>
                        <select
                          value={orModel}
                          onChange={(ev) => saveModel(ev.target.value)}
                          className="flex-1 min-w-0 text-xs rounded-md bg-inset border border-border text-muted-foreground px-2 py-1 outline-none focus:border-border"
                        >
                          {orModels.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {errorMsg && (
            <div className="mt-3 rounded-lg bg-danger-soft border border-danger/40 px-3 py-2 text-xs text-danger">
              {errorMsg}
            </div>
          )}
          {generating && (
            <div className="mt-3 text-xs text-muted-foreground text-center">
              Generating via {engines?.find((e) => e.id === generating)?.name}… ~30–90s
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DreamConnectCard({ headline }: { headline: string }) {
  const [engines, setEngines] = useState<DreamEngine[] | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/__dream_engines")
      .then((r) => r.json())
      .then((d) => setEngines(d.engines))
      .catch(() => setEngines([]));
  }, []);

  const generate = async (engineId: string) => {
    setErrorMsg(null);
    setGenerating(engineId);
    try {
      const tokRes = await fetch("/__token");
      const { token } = await tokRes.json();
      const res = await fetch("/__trigger_dream", {
        method: "POST",
        headers: { "X-Claude-OS-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineId }),
      });
      const data = await res.json();
      if (data.ok) {
        // Remember the operator's choice for next visit + the cron picker.
        try {
          localStorage.setItem("claude-os.dream.engine", engineId);
        } catch {
          /* localStorage blocked */
        }
        window.location.reload();
        return;
      }
      // Map auth failures (e.g. `claude -p` with no setup-token → 401) to the
      // engine's own setup guidance instead of a cryptic raw API error.
      const raw = (data.stderr || data.stdout || data.error || "").trim();
      const looksAuth = /401|invalid authentication|unauthor|api key|setup-token|credential/i.test(
        raw,
      );
      const eng = engines?.find((x) => x.id === engineId);
      if (looksAuth && eng && !eng.ready && eng.needsAction) {
        setErrorMsg(`${eng.name} needs a one-time setup — ${eng.needsAction}`);
      } else {
        const tail = raw.split("\n").slice(-2).join(" ");
        setErrorMsg(tail || "Generation failed. Try a different engine.");
      }
      setGenerating(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setGenerating(null);
    }
  };

  if (engines === null) {
    return (
      <div className="rounded-xl border border-border bg-card p-7 text-center text-sm text-muted-foreground">
        Detecting engines…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-base font-semibold text-foreground mb-1">{headline}</div>
      <div className="text-xs text-muted-foreground mb-5">
        Pick which engine runs your Dream. Your choice is saved.
      </div>

      <div className="space-y-2">
        {engines.map((e) => {
          const isGenerating = generating === e.id;
          const anyGenerating = generating !== null;
          const statusLabel = isGenerating
            ? "Generating…"
            : e.ready
              ? "Ready"
              : e.installed
                ? "Set up"
                : "Not installed";
          const statusTone = isGenerating
            ? "text-foreground"
            : e.ready
              ? "text-success"
              : e.installed
                ? "text-warn"
                : "text-muted-foreground";
          const borderTone = e.ready
            ? "border-success/40 hover:border-success/40 hover:bg-success-soft"
            : e.installed
              ? "border-warn/40 hover:border-warn/40 hover:bg-warn-soft"
              : "border-border cursor-not-allowed";
          return (
            <button
              key={e.id}
              onClick={() => e.installed && generate(e.id)}
              disabled={!e.installed || anyGenerating}
              className={`w-full text-left rounded-xl border bg-inset px-4 py-3 transition-colors disabled:opacity-50 ${borderTone}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">{e.name}</div>
                  <div className="text-xs text-muted-foreground">{e.description}</div>
                </div>
                <div
                  className={`text-xs shrink-0 ${statusTone}`}
                >
                  {statusLabel}
                </div>
              </div>
              {e.needsAction && !isGenerating && (
                <div className="text-xs text-muted-foreground mt-1.5">{e.needsAction}</div>
              )}
              <div className="text-xs text-muted-foreground mt-1">{e.cost}</div>
            </button>
          );
        })}
      </div>

      {errorMsg && (
        <div className="mt-4 rounded-lg bg-danger-soft border border-danger/40 px-3 py-2 text-xs text-danger leading-relaxed">
          {errorMsg}
        </div>
      )}

      {generating && (
        <div className="mt-4 text-xs text-muted-foreground text-center">
          Generating via {engines.find((e) => e.id === generating)?.name}… usually 30–90s
        </div>
      )}
    </div>
  );
}

// ---------- Page ----------

export function Home({ forceSetupModal = false }: { forceSetupModal?: boolean } = {}) {
  const { state: operatorState } = useOperator();
  // Hydrate the module-level `ld` from the runtime hook so all helper
  // functions that read `ld` pick up the latest data from disk.
  ld = useLiveData();
  isDemoData = ld?.isExample === true;
  hasRealActivity = !isDemoData && Number(ld?.summary?.totalAssistantMessages ?? 0) > 0;
  isColdReal = !isDemoData && !hasRealActivity;

  // Re-derive module-level data captures from the freshly hydrated `ld`.
  // Without this, the `let`-bound module globals hold the value computed at
  // module-init when `ld = {}`, and the dashboard renders empty rails for
  // automations / integrations / knowledge stores / skill recs / dream.
  liveRecommended = ld?.skills?.recommended;
  skillRecommendations = Array.isArray(liveRecommended) ? liveRecommended : [];
  liveIntegrations = ld?.integrations;
  integrations = Array.isArray(liveIntegrations) ? liveIntegrations : [];
  liveKnowledgeStores = ld?.knowledgeStores;
  knowledgeStores = Array.isArray(liveKnowledgeStores)
    ? liveKnowledgeStores.map((k: any) => ({
        ...k,
        name: k.name ?? (k.kind === "pinecone" ? "Pinecone" : (k.kind ?? "Vector store")),
        brand: k.brand ?? "FFFFFF",
        color: k.color ?? "1F1F1F",
      }))
    : [];
  liveAutomations = ld?.automations;
  automations = Array.isArray(liveAutomations) ? liveAutomations : [];
  liveDerivedSkills = deriveSkillsFromLive();
  demoSkills = liveDerivedSkills;
  dailyActivity = computeDailyActivity();
  livePrescriptions = ld?.dream?.prescriptions;
  dreamSuggestions =
    Array.isArray(livePrescriptions) && livePrescriptions.length > 0 ? livePrescriptions : [];
  dreamGeneratedAt = ld?.dream?.generatedAt ?? null;
  dreamDate = ld?.dream?.date ?? null;
  dreamHealthStatus = ld?.dream?.healthStatus ?? null;
  dreamFixHint = ld?.dream?.fixHint ?? null;
  // Modal-based setup gating: instead of navigating away to /setup, the
  // dashboard always renders and we layer the SetupModal over it when the
  // user has no config yet (or when /setup forced the modal open via prop).
  //
  // Why no `useLayoutEffect` redirect: every navigate races with localStorage
  // and the sidecar config probe. Eliminating the navigate eliminates the
  // entire class of "loop bugs" — the dashboard is one continuous render and
  // the modal is a state toggle.
  //
  // Initial modal state is computed synchronously from localStorage so we
  // don't flash the dashboard before the modal mounts on first paint.
  // Do NOT auto-open the wizard on every page load just because localStorage
  // is empty — that was the old behaviour and it haunted users who never
  // touched the wizard. The wizard now opens only when:
  //   1. The /setup route renders this component with forceSetupModal=true, or
  //   2. The /__just-installed endpoint returns true (the terminal `bun run
  //      setup` script writes ~/.claude-os/show-wizard, the middleware reads
  //      + deletes it on first GET).
  // The second useEffect below handles case 2 reactively.
  const [showSetupModal, setShowSetupModal] = React.useState<boolean>(() => {
    return forceSetupModal;
  });

  // Section 7 view: the bottom slot flips between "Sessions per day" and "Model intelligence".
  // Persisted so the dashboard remembers which view you last left it on.
  const [activityTab, setActivityTab] = React.useState<"sessions" | "models">(() => {
    try {
      // Default to the Model Intelligence view so the flagship leaderboard is
      // visible on first load; returning users keep whichever view they left on.
      return (localStorage.getItem("claude-os-activity-tab") as "sessions" | "models") ?? "models";
    } catch {
      return "models";
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem("claude-os-activity-tab", activityTab);
    } catch {
      /* ignore */
    }
  }, [activityTab]);

  // Just-installed override: when the terminal `bun run setup` finishes it
  // drops ~/.claude-os/show-wizard. The vite middleware reads that file
  // exactly once at /__just-installed and self-deletes. If we see it, we
  // force-open the wizard even when claude-os-config exists in localStorage
  // — this handles the "reinstalled on a laptop that already had Claude OS"
  // case where the browser's cached config would otherwise skip the wizard.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/__just-installed");
        if (!res.ok || cancelled) return;
        const j = await res.json();
        if (j?.justInstalled) setShowSetupModal(true);
      } catch {
        /* dev server not exposing the endpoint — ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (forceSetupModal) {
      setShowSetupModal(true);
      return;
    }
    let cancelled = false;

    const checkConfigured = async () => {
      if (typeof window === "undefined") return;

      // Pure-localStorage check. Sidecar is gone; the wizard's "Save"
      // button is the only path that writes claude-os-config, and it
      // runs synchronously before unmounting the modal — so by the time
      // the dashboard re-checks, the value is already there.
      let configured = false;
      try {
        configured = !!window.localStorage.getItem("claude-os-config");
      } catch (err) {
        console.warn("[home] localStorage config check failed:", err);
      }

      if (cancelled) return;

      // Sidecar may have hydrated localStorage with a config we didn't know
      // about — close the modal in that case. Conversely, never open the
      // modal here as a side-effect of the probe; the synchronous initializer
      // already opened it if localStorage was empty on first paint.
      if (configured) {
        setShowSetupModal(false);
        try {
          if (window.localStorage.getItem("claude-os-just-installed")) {
            window.localStorage.removeItem("claude-os-just-installed");
            import("canvas-confetti").then(({ default: confetti }) => {
              const colors = ["#FFC371", "#FF7A3D", "#FF4E50", "#a78bfa", "#3ddc97", "#60a5fa"];
              confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 }, colors });
              setTimeout(
                () =>
                  confetti({
                    particleCount: 80,
                    angle: 60,
                    spread: 70,
                    origin: { x: 0, y: 0.7 },
                    colors,
                  }),
                200,
              );
              setTimeout(
                () =>
                  confetti({
                    particleCount: 80,
                    angle: 120,
                    spread: 70,
                    origin: { x: 1, y: 0.7 },
                    colors,
                  }),
                350,
              );
            });
          }
        } catch (err) {
          console.warn("[home] just-installed marker check failed:", err);
        }
      }
    };

    void checkConfigured();
    return () => {
      cancelled = true;
    };
  }, [forceSetupModal]);

  const handleSetupClose = React.useCallback(() => {
    setShowSetupModal(false);
    // Persist the dismiss so the wizard doesn't re-pop on every reload.
    // Only the wizard's Save path writes claude-os-config; the X CLOSE
    // path writes -dismissed so closing means "leave me alone." If the
    // user later wants the wizard back, they can clear the sentinel or
    // visit /setup directly.
    try {
      if (typeof window !== "undefined" && !window.localStorage.getItem("claude-os-config")) {
        window.localStorage.setItem("claude-os-config-dismissed", "1");
      }
    } catch {
      /* localStorage unavailable — best effort */
    }
    // Fire celebration confetti when the modal closes after a successful
    // activate. The wizard sets "claude-os-just-installed" before calling
    // onClose, so reading + clearing it here is the natural gate.
    try {
      if (
        typeof window !== "undefined" &&
        window.localStorage.getItem("claude-os-just-installed")
      ) {
        window.localStorage.removeItem("claude-os-just-installed");
        import("canvas-confetti").then(({ default: confetti }) => {
          const colors = ["#FFC371", "#FF7A3D", "#FF4E50", "#a78bfa", "#3ddc97", "#60a5fa"];
          confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 }, colors });
          setTimeout(
            () =>
              confetti({
                particleCount: 80,
                angle: 60,
                spread: 70,
                origin: { x: 0, y: 0.7 },
                colors,
              }),
            200,
          );
          setTimeout(
            () =>
              confetti({
                particleCount: 80,
                angle: 120,
                spread: 70,
                origin: { x: 1, y: 0.7 },
                colors,
              }),
            350,
          );
        });
      }
    } catch (err) {
      console.warn("[home] confetti on close failed:", err);
    }
  }, []);
  // Display currency — converts USD figures at render time only.
  const [period, setPeriod] = useState<Period>("week");
  const [skillsExpanded, setSkillsExpanded] = useState<boolean>(false);
  // Persist dismissals per-Dream (keyed by date) so refreshes keep cleared
  // cards hidden, while a new night's Dream resets the slate — the index is
  // positional, so carrying an old set onto a fresh list would hide the wrong
  // cards. Falls back to generatedAt, then "none", if no date is present.
  const dreamDismissKey = `claude-os-dismissed-dreams:${dreamDate ?? dreamGeneratedAt ?? "none"}`;
  const [dismissedDreams, setDismissedDreams] = useState<Set<number>>(() =>
    readDismissedDreams(dreamDismissKey),
  );
  // Reload when the active Dream changes (e.g. after an in-page data refresh).
  useEffect(() => {
    setDismissedDreams(readDismissedDreams(dreamDismissKey));
  }, [dreamDismissKey]);
  // Write back on every change (dismiss or "Restore dismissed").
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(dreamDismissKey, JSON.stringify([...dismissedDreams]));
    } catch {
      /* localStorage unavailable — best effort */
    }
  }, [dreamDismissKey, dismissedDreams]);
  // "Restore dismissed" override: when true, prescriptions hidden by their
  // persisted state.json status (dismissed/accepted) come back for this
  // session; the restore is also written back via /__dream_action.
  const [dreamsRestored, setDreamsRestored] = useState(false);
  // Full-screen cinematic replay of last night's dream (▶ Replay button).
  const [replayOpen, setReplayOpen] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [expandedKpi, setExpandedKpi] = useState<"skills" | null>(null);
  const [dreamIdx, setDreamIdx] = useState(0);
  const [spendView, setSpendView] = useState<"subscription" | "tokens">("subscription");
  const { minutesFor, setMinutesFor } = useTimeSaved();
  // The hourly rate is the one shared figure from src/lib/value-metrics.ts /
  // workspace-profile.ts (Settings → Profile), not a page-local override —
  // this used to keep its own rate in localStorage, which is why Mission
  // Control, Skills and Share used to disagree on $/hour.
  const valueProfile = useWorkspaceProfile();
  const rate = valueProfile.rate;

  // Skill totals from demo skills (per-period scaling: assumes "uses" is week)
  const periodFactor = period === "day" ? 1 / 7 : period === "week" ? 1 : 30 / 7;
  const skillStats = demoSkills.map((s) => {
    const uses = s.uses * periodFactor;
    const mins = uses * s.minsPerRun;
    return { ...s, periodUses: uses, mins, dollars: (mins / 60) * rate.rate };
  });
  const saved = skillStats.reduce(
    (a, s) => ({ minutes: a.minutes + s.mins, dollars: a.dollars + s.dollars }),
    { minutes: 0, dollars: 0 },
  );

  // Rolling 28-day skills saved (independent of the per-card period)
  const saved28 = demoSkills.reduce(
    (a, s) => {
      const uses = s.uses * 4; // weekly → 28d
      const mins = uses * s.minsPerRun;
      return { minutes: a.minutes + mins, dollars: a.dollars + (mins / 60) * rate.rate };
    },
    { minutes: 0, dollars: 0 },
  );

  // AI Spend with its own filter (drives top KPI + per-model strip)
  const [spendPeriod, setSpendPeriod] = useState<Period>("month");
  // The AI spend tile reads the /usage snapshot: real AUD for this month (fixed + metered).
  const aiUsage = useAiUsage().data;
  const navigate = useNavigate();
  // The spend period only scales the skills-saved estimate; the tokens view below is this month, measured.
  const spendFactor = spendPeriod === "day" ? 1 / 7 : spendPeriod === "week" ? 1 : 4;


  // Skills saved scaled to the selected period
  const savedPeriod = {
    minutes: saved28.minutes * (spendFactor / 4),
    dollars: saved28.dollars * (spendFactor / 4),
  };
  const configuredCount = demoSkills.filter((s) => minutesFor(s.name) > 0).length;
  const skillsConfigured = configuredCount > 0;
  const dreamCount = dreamSuggestions.length;
  // The values on the section widgets. Leads and Away mode read the same queries their panels use
  // (same keys, so opening one reuses the answer); the rest come from the data already on this page.
  const leadCalls = useQuery({ queryKey: ["leads-calls", 5], queryFn: () => leadsApi.calls(5), refetchInterval: 60_000 });
  const leadSummary = useQuery({ queryKey: ["leads-summary"], queryFn: leadsApi.summary, refetchInterval: 60_000 });
  const away = useQuery({
    queryKey: ["away-mode"],
    queryFn: () => operatorRequest<{ on: boolean; paused: boolean; armed: boolean; pending: unknown; tasks: { status: string }[] }>("/away"),
    refetchInterval: 15_000,
  });
  const awayValue = away.data ? (away.data.on ? (away.data.paused ? "Paused" : "On") : "Off") : null;
  const awayQueue = (away.data?.tasks ?? []).filter((t) => t.status === "queued" || t.status === "running").length;
  const awayLine = !away.data ? "Reading the queue" : away.data.pending ? "Waiting for your code on Telegram" : `${awayQueue} in the queue`;
  const trendDays = Array.isArray(ld?.history) ? ld.history.length : 0;
  const automationsFailed = automations.filter((a) => a.status === "failed").length;

  return (
    <>
      {showSetupModal && <SetupModal onClose={handleSetupClose} />}
      <div className="min-w-0">
        {/* ============= PAGE HEADER ============= */}
        <PageHeader
          title={pageName("/dashboard")}
          description={
            <>
              <GreetingHeadline /> Spend, usage, skills, memory and agents, today at a glance.
            </>
          }
          meta={
            <>
              <EyebrowAvatar />
              {isDemoData && (
                <Badge
                  tone="warn"
                  title="Sample data shipped with the app. Run `bun run scripts/aggregate.ts` to populate with your real ~/.claude/ activity."
                >
                  Demo data
                </Badge>
              )}
              {isColdReal && (
                <Badge
                  tone="danger"
                  title="The aggregator ran but found no Claude activity. Either run a Claude Code session and re-run `bun run scripts/aggregate.ts`, or check Full Disk Access for your terminal in System Settings."
                >
                  Needs a session
                </Badge>
              )}
              <NowWorkingOn />
            </>
          }
          actions={
            <Segmented
              ariaLabel="Period"
              value={spendPeriod}
              onChange={setSpendPeriod}
              options={[
                { value: "day", label: "Today" },
                { value: "week", label: "7 days" },
                { value: "month", label: "28 days" },
              ]}
            />
          }
        />

        <section aria-label="Key numbers" className="mb-12">
          {/* L10 (29 Sep 2026): the section leads with MEASURED numbers only (AI spend, activity).
              The skills-saved figure is assumption x assumption, so it lives in the collapsed
              "Estimates" disclosure below, never beside measured spend. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <StatTile
              label="AI spend"
              icon={Zap}
              value={aiUsage ? fmtAud(aiUsage.totals.monthAud) : null}
              hint={
                aiUsage
                  ? `${aiUsage.month.label} so far · fixed + metered, AUD · open breakdown`
                  : "Reading plan prices and API spend…"
              }
              onClick={() => void navigate({ to: "/usage" })}
            />
            <StatTile
              label="Activity"
              icon={TrendingUp}
              value={Number(ld?.summary?.totalAssistantMessages ?? 0).toLocaleString("en-AU")}
              unit="turns"
              hint={`${Number(ld?.summary?.messagesLast7d ?? 0).toLocaleString("en-AU")} turns last 7 days · ${Number(ld?.summary?.projectsTracked ?? 0)} projects`}
              trend={usageDaily.length > 1 ? usageDaily.map((d) => (d as any).messages ?? d.runs ?? d.cost) : undefined}
            />
          </div>

          {/* Per-model spend strip — Subscription / Tokens tabs */}
          <Surface className="mt-3">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Segmented
                ariaLabel="Spend view"
                value={spendView}
                onChange={setSpendView}
                options={[
                  { value: "subscription", label: "Subscriptions" },
                  { value: "tokens", label: "Tokens · API-equivalent" },
                ]}
              />
              <div className="ds-num text-xs text-muted-foreground">
                {spendView === "subscription" ? <>Detected on this machine</> : <>This month, this PC · measured</>}
              </div>
            </div>

            {spendView === "subscription" && <SubscriptionStrip />}
            {spendView === "tokens" && (
              <MeasuredTokens usage={aiUsage} expandedModel={expandedModel} setExpandedModel={setExpandedModel} />
            )}          </Surface>

          {/* Estimates: multiplied assumptions, folded away and labelled plainly. */}
          <Disclosure
            className="mt-3"
            summary={<span className="font-medium">Estimates</span>}
            meta="Assumed, not measured"
          >
            <p className="mb-3 max-w-[70ch] text-sm text-muted-foreground">
              These figures multiply one assumption by another. They are not money spent or saved, and they are not part of the measured spend above.
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <StatTile
                label="Skills saved (assumed)"
                icon={DollarSign}
                value={skillsConfigured ? formatMoney(savedPeriod.dollars, { currency: rate.currency, whole: true }) : null}
                hint={
                  skillsConfigured
                    ? `${formatHours(savedPeriod.minutes)} saved · ${configuredCount} skills configured${rate.assumed ? ` · ${rate.label}` : ""}`
                    : `${demoSkills.length} skills detected · set time per run to see savings`
                }
                active={expandedKpi === "skills"}
                onClick={() => setExpandedKpi(expandedKpi === "skills" ? null : "skills")}
              />
            </div>
            {expandedKpi === "skills" && (
              <SkillsSavedExpansion
                onClose={() => setExpandedKpi(null)}
                rate={rate}
                onRateChange={(n) => void valueProfile.save({ hourlyRate: n })}
                skills={demoSkills}
                minutesFor={minutesFor}
                setMinutesFor={setMinutesFor}
                period={period}
              />
            )}
          </Disclosure>
        </section>

        <DeckGrid className="mb-10">

        {/* ============= LEADS — top five to call today + pipeline counts ============= */}
        <McSection id="mc-leads" icon={Users} title="Leads to call today" value={leadCalls.data ? leadCalls.data.leads.length : null} line={leadSummary.data ? `${leadSummary.data.callWindow.open ? "Calling hours open" : "Calling hours closed"} · top five` : "Top five to call, from the CRM"} persistKey="mc-leads">
        <LeadsDashboardCard />
        </McSection>

        {/* ============= AWAY MODE — Jarvis's queue while he's out (Telegram approvals) ============= */}
        <McSection id="mc-away" icon={Plane} title="Away mode" value={awayValue} line={awayLine} persistKey="mc-away">
        <AwayModeCard />
        </McSection>

        {/* ============= LIVE USAGE — plan limits and AUD spend (same data as /usage) ============= */}
        <McSection id="mc-usage" icon={Gauge} title="Plan limits & spend" value={aiUsage ? fmtAud(aiUsage.totals.monthAud) : null} line="This month · fixed + metered, AUD" persistKey="mc-usage">
        <AiUsageSummary title="Plan limits & spend" />
        </McSection>

        {/* ============= TRENDS — daily history snapshots over time ============= */}
        <McSection id="mc-trends" icon={TrendingUp} title="Trends" value={trendDays || null} line={trendDays ? (trendDays === 1 ? "day tracked" : "days tracked") : "No daily snapshots yet"} persistKey="mc-trends">
        <TrendsPanel />
        </McSection>

        {/* ============= DREAM REVIEW ============= */}
        <McSection id="mc-dream" icon={Moon} title="Dream review" value={dreamCount || null} line={dreamCount ? `${dreamCount === 1 ? "improvement" : "improvements"} to review${dreamDate ? ` · from ${fmtProse(dreamDate)}` : ""}` : dreamDate ? `Nothing new to review · last run ${fmtProse(dreamDate)}` : "The overnight review hasn't run yet."} persistKey="mc-dream">
        <section className="relative mb-12" aria-labelledby="dream-review-title">
          <Surface padding="lg">
            <div>
              <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                  {(() => {
                    // Age of the dream itself — "found overnight" is only an
                    // honest headline for a fresh run. An old dream still
                    // renders, but says how old it is instead of pretending.
                    const dreamAgeDays = dreamDate
                      ? Math.floor((Date.now() - new Date(dreamDate).getTime()) / 86_400_000)
                      : 0;
                    // Count both hide mechanisms (session clicks + persisted
                    // state.json verdicts) without double-counting overlaps.
                    const shownCount = dreamSuggestions.filter(
                      (d, i) =>
                        !dismissedDreams.has(i) &&
                        (dreamsRestored || (d.status !== "dismissed" && d.status !== "accepted")),
                    ).length;
                    return (
                      <>
                        <h2
                          id="dream-review-title"
                          className="text-lg font-semibold leading-snug tracking-[-0.01em] text-foreground"
                        >
                          Dream review:{" "}
                          <span className="ds-num">{shownCount}</span> improvement
                          {shownCount === 1 ? "" : "s"}{" "}
                          {dreamAgeDays <= 1 ? "found overnight" : `from ${dreamAgeDays} days ago`}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {dreamGeneratedAt
                            ? `Pattern analysis across 7 days · generated ${fmtDateTime(new Date(dreamGeneratedAt))}`
                            : dreamCount === 0
                              ? "No Dream review yet. Choose an engine to generate one."
                              : "Pattern analysis across 7 days"}
                          {dreamAgeDays > 3 && (
                            <span className="ml-2 text-warn">
                              · cron may be failing — check ~/.claude-os/dream-cron.log
                            </span>
                          )}
                        </p>
                      </>
                    );
                  })()}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(dismissedDreams.size > 0 ||
                    (!dreamsRestored &&
                      dreamSuggestions.some(
                        (d) => d.status === "dismissed" || d.status === "accepted",
                      ))) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // Un-hide locally AND write the restore back so the
                        // items stay visible after a refresh / next dream run.
                        for (const d of dreamSuggestions) {
                          if (d.status === "dismissed" || d.status === "accepted") {
                            void postDreamAction(d.id, "restored");
                          }
                        }
                        setDismissedDreams(new Set());
                        setDreamsRestored(true);
                      }}
                    >
                      Restore dismissed
                    </Button>
                  )}
                  {dreamSuggestions.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReplayOpen(true)}
                      title="Watch a replay of last night's dream — every number is real"
                    >
                      <PlayCircle /> Replay the dream
                    </Button>
                  )}
                  <DreamEngineSwitcher />
                </div>
              </div>

              <DreamRunStatus dream={ld?.dream} />

              {(() => {
                const hiddenByState = (d: DreamSuggestion) =>
                  !dreamsRestored && (d.status === "dismissed" || d.status === "accepted");
                const visible = dreamSuggestions
                  .map((d, i) => ({ ...d, originalIndex: i }))
                  .filter((d) => !dismissedDreams.has(d.originalIndex) && !hiddenByState(d));
                if (visible.length === 0) {
                  // Empty-state branches by healthStatus from the aggregator:
                  //   silent_failure → cron scheduled but no JSON; almost
                  //     always headless-auth (claude -p doesn't read OAuth).
                  //     Show an actionable red banner with the exact fix.
                  //   never_ran      → user hasn't installed the cron yet.
                  //   stale          → last dream is >3 days old.
                  //   healthy + no prescriptions → all caught up.
                  const noDreamYet = dreamSuggestions.length === 0;
                  const status = dreamHealthStatus ?? (noDreamYet ? "never_ran" : "healthy");
                  if (status === "silent_failure") {
                    return <DreamConnectCard headline="Generate your first Dream review" />;
                  }
                  if (status === "stale") {
                    return (
                      <Notice tone="warn" title="Your last review is more than 3 days old">
                        {dreamFixHint ?? "Check ~/.claude-os/dream-cron.log for errors."}
                      </Notice>
                    );
                  }
                  if (status === "never_ran") {
                    return <DreamConnectCard headline="Generate your first Dream review" />;
                  }
                  // failed / skipped / running already have a banner (DreamRunStatus) above.
                  if (status === "failed" || status === "skipped" || status === "running") return null;
                  return (
                    <EmptyState
                      icon={CheckCircle2}
                      title="All caught up"
                      body="Nothing else for tonight."
                    />
                  );
                }
                const safeIdx = dreamIdx % visible.length;
                const cur = visible[safeIdx];
                return (
                  <DreamCarousel
                    cur={cur}
                    total={visible.length}
                    index={safeIdx}
                    prev={() => setDreamIdx((i) => (i - 1 + visible.length) % visible.length)}
                    next={() => setDreamIdx((i) => (i + 1) % visible.length)}
                    onDismiss={() => {
                      void postDreamAction(cur.id, "dismissed");
                      setDismissedDreams((prev) => {
                        const next = new Set(prev);
                        next.add(cur.originalIndex);
                        return next;
                      });
                      setDreamIdx(0);
                    }}
                    onDone={() => {
                      // "Apply & mark done" — persisted as accepted so the next
                      // dream run treats it as handled (30d cool-off per SKILL.md).
                      void postDreamAction(cur.id, "accepted");
                      setDismissedDreams((prev) => {
                        const next = new Set(prev);
                        next.add(cur.originalIndex);
                        return next;
                      });
                      setDreamIdx(0);
                    }}
                  />
                );
              })()}

              {/* Overnight morning report + proposed-improvement briefs. */}
              <DreamMorningReport dream={ld?.dream} />

              {/* Dream sources — visible expand showing every data stream
                  Dream pulled from for this run. Tells the user "what does
                  Dream actually know about", including the new Hermes feed. */}
              <DreamSourcesStrip />
            </div>
          </Surface>

          {/* Cinematic replay — every number sourced from live-data.json. */}
          {replayOpen && (
            <Suspense fallback={null}>
              {(() => {
                const daily = Array.isArray(ld?.daily) ? ld.daily : [];
                const lastDay = daily.length > 0 ? daily[daily.length - 1] : null;
                const counters = [
                  { label: "Messages · 7 days", value: ld?.summary?.messagesLast7d ?? 0 },
                  { label: "Sessions · 24h", value: lastDay?.sessions ?? 0 },
                  { label: "Memory files", value: ld?.memory?.stats?.totalFiles ?? 0 },
                  { label: "Hermes sessions", value: ld?.hermes?.sessionCount ?? 0 },
                ].filter((c) => c.value > 0);
                const srcs = [
                  {
                    name: "Claude Code",
                    color: "#FF7A3D",
                    live: (ld?.recentProjects?.length ?? 0) > 0,
                  },
                  { name: "Hermes", color: "#FFD21E", live: !!ld?.hermes?.installed },
                  {
                    name: "Memory",
                    color: "#a78bfa",
                    live: (ld?.memory?.stats?.totalFiles ?? 0) > 0,
                  },
                  {
                    name: "Skills",
                    color: "#60a5fa",
                    live: (ld?.skills?.active?.length ?? 0) > 0,
                  },
                  {
                    name: "Automations",
                    color: "#34d399",
                    live: (ld?.automations?.length ?? 0) > 0,
                  },
                  { name: "Usage", color: "#fb923c", live: !!ld?.usage?.claudeWindow },
                  {
                    name: "Pinecone",
                    color: "#22D3EE",
                    live: (ld?.memory?.stats?.pineconeIndexes ?? 0) > 0,
                  },
                ];
                const model = String(ld?.dream?.model ?? "");
                // Frontier branding: Fable 5 dreams get the fuchsia frontier
                // chip (same treatment as the Hermes model picker); other
                // engines keep the neutral violet.
                const isFrontier = /fable/i.test(model);
                const engineLabel = isFrontier
                  ? "Fable 5 · frontier"
                  : /hermes/i.test(model)
                    ? "Hermes"
                    : model
                      ? model.slice(0, 22)
                      : "your engine";
                return (
                  <DreamReplay
                    sources={srcs}
                    prescriptions={dreamSuggestions as any}
                    stats={{
                      counters,
                      candidates: Math.max(
                        Number(ld?.dream?.metadata?.totalCandidates) || 0,
                        dreamSuggestions.length,
                      ),
                    }}
                    date={dreamDate}
                    engineName={engineLabel}
                    engineAccent={isFrontier ? "#f0abfc" : undefined}
                    onClose={() => setReplayOpen(false)}
                  />
                );
              })()}
            </Suspense>
          )}
        </section>
        </McSection>

        {/* ============= MISSION CONTROL — agent-agnostic strategic layer
              above /goal. The full board lives on the two agent pages
              (Hermes, Claude Code) where you actually pick up a card and run
              it. Showing the identical board a third time here just crowded
              the home page, so this is a short teaser that links out instead
              of duplicating the whole panel (audit P2-6). */}
        {operatorState.settings.mission && (
          <McSection id="mc-missions" icon={Orbit} title="Strategy missions" line="Pick one up in Hermes or Claude Code" persistKey="mc-missions">
          <section className="mb-12">
            <SectionHead eyebrow="Strategy" title="Mission Control" />
            <Surface className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-xl text-sm text-muted-foreground">
                Strategic missions you can pick up in whichever runtime is convenient — same
                cards, same prompts, either place.
              </p>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to="/agents/hermes">
                    Open in Hermes <ArrowUpRight />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/agents/claude-code">
                    Open in Claude Code <ArrowUpRight />
                  </Link>
                </Button>
              </div>
            </Surface>
          </section>
          </McSection>
        )}

        {/* ============= SECTION 1 — SKILLS ============= */}
        <McSection id="mc-skills" icon={Wand2} title="Your skills" value={demoSkills.length} line={skillsConfigured ? `${configuredCount} with time saved set` : "Time saved not set yet"} persistKey="mc-skills">
        <section className="mb-12">
          <SectionHead
            eyebrow="Skills"
            title="Your skills"
            right={
              <Link
                to="/skills"
                className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                All skills <ArrowUpRight className="h-3 w-3" />
              </Link>
            }
          />
          {(() => {
            if (skillStats.length === 0) {
              return (
                <EmptyState
                  icon={Sparkles}
                  title="No skills detected yet"
                  body={
                    <>
                      Run any <code className="font-mono text-foreground">/&lt;command&gt;</code> in
                      Claude Code (e.g. <code className="font-mono text-foreground">/wrap-up</code>),
                      then <code className="font-mono text-foreground">bun run scripts/aggregate.ts</code>.
                    </>
                  }
                />
              );
            }
            const sorted = [...skillStats].sort((a, b) => b.dollars - a.dollars);
            const visible = skillsExpanded ? sorted : sorted.slice(0, 4);
            return (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {visible.map((s) => (
                    <SkillCard key={s.name} s={s} period={period} />
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
                  <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lightbulb className="h-3 w-3" />
                    Time-per-run is AI-estimated. Click any card to edit on the Skills tab.
                  </div>
                  {sorted.length > 4 && (
                    <Button variant="outline" size="xs" onClick={() => setSkillsExpanded((v) => !v)}>
                      {skillsExpanded ? "Show top 4" : `Show all ${sorted.length}`}
                    </Button>
                  )}
                </div>
              </>
            );
          })()}
        </section>
        </McSection>

        {/* ============= SECTION 2 — MEMORY ============= */}
        <McSection id="mc-memory" icon={BrainCircuit} title="Your memory" value={ld?.memory?.stats?.totalFiles ?? null} line="files in the memory graph" persistKey="mc-memory">
        <section className="mb-12">
          <SectionHead
            eyebrow="Memory"
            title="Your memory"
            right={
              <Link
                to="/memory"
                className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Open map <ArrowUpRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="ds-stage relative w-full" style={{ height: 460 }}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading memory graph…
                  </div>
                }
              >
                {/* MemoryGraph3D (shared with Memory, HUD and Voice) draws its own
                    bottom-left legend. We used to draw a second, differently-worded
                    one here (Decisions/Sessions/Stale/Missing vs. its
                    File/Decision/Session/Skill) — two legends for one graph. Let the
                    shared component be the single source of truth instead. */}
                <MemoryGraph3D onSelect={() => {}} embedded />
              </Suspense>

              {/* RIGHT overlay — recent signals from the aggregator's memory.events feed */}
              <MemorySignalsOverlay />
            </div>
            <MemoryStatsFooter />
          </div>
        </section>
        </McSection>

        {/* ============= SECTION 2.5 — KNOWLEDGE GRAPH (graphify) ============= */}
        <McSection id="mc-graph" icon={Network} title="Example graph" value={KG_NODES.toLocaleString("en-AU")} line="Sample knowledge graph, not your project" persistKey="mc-graph">
        <section className="mb-12">
          <SectionHead
            eyebrow="Knowledge Graph"
            title="Project knowledge graph"
            right={
              <Link
                to="/codegraph"
                className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Open graph <ArrowUpRight className="h-3 w-3" />
              </Link>
            }
          />
          <div className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="ds-stage relative w-full" style={{ height: 360 }}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading knowledge graph…
                  </div>
                }
              >
                <GraphifyGraph3D graph={graphifyGraph as any} accent="#3ddc97" embedded />
              </Suspense>
              <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border border-border bg-popover/90 px-3 py-2 text-xs shadow-md">
                <div className="ds-label mb-0.5">Example graph · not your project</div>
                <div className="font-semibold text-foreground">power-design (public repo)</div>
                <div className="ds-num mt-0.5 text-muted-foreground">
                  {KG_NODES} nodes · {KG_LINKS} edges · {KG_COMMUNITIES} communities
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span>
                Example only: a public repo graphed with graphify, not your project. Code edges are{" "}
                <span className="font-medium text-success">EXTRACTED</span> (free, AST).
              </span>
              <Link
                to="/codegraph"
                className="inline-flex items-center gap-1 font-medium text-foreground/85 hover:text-foreground"
              >
                All projects <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </section>
        </McSection>

        {/* ============= SECTION 3 — INTEGRATIONS ============= */}
        {integrations.length > 0 && (
          <McSection id="mc-integrations" icon={Plug} title="Integrations" value={integrations.length} line="plugged into your stack" persistKey="mc-integrations">
          <section className="mb-12">
            <SectionHead eyebrow="Integrations" title="What's plugged into your stack" />
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {integrations.map((it) => (
                <IntegrationTile key={it.name} {...it} />
              ))}
            </div>
          </section>
          </McSection>
        )}

        {/* ============= SECTION 4 — VECTOR INDEXES ============= */}
        {knowledgeStores.length > 0 && (
          <McSection id="mc-vectors" icon={Database} title="Vector indexes" value={knowledgeStores.length} line={knowledgeStores.length === 1 ? "connected index" : "connected indexes"} persistKey="mc-vectors">
          <section className="mb-12">
            <SectionHead eyebrow="Memory sources" title="Connected vector indexes" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {knowledgeStores.map((k) => (
                <Surface key={k.title} className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-inset">
                    <img
                      src={`https://cdn.simpleicons.org/${k.slug}/FFFFFF`}
                      alt={k.name ?? k.title}
                      className="h-5 w-5 object-contain"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="ds-label">{k.name ?? k.title}</div>
                    <div className="truncate text-sm font-semibold">{k.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{k.detail}</div>
                  </div>
                </Surface>
              ))}
            </div>
          </section>
          </McSection>
        )}

        {/* ============= SECTION 5 — AUTOMATIONS ============= */}
        <McSection id="mc-automations" icon={Workflow} title="Scheduled tasks" value={automations.length || null} line={automations.length ? (automationsFailed ? `${automationsFailed} failed · ${automations.length} detected` : "detected · none failing") : "No automations detected"} persistKey="mc-automations">
        <section className="mb-12">
          <SectionHead eyebrow="Automations" title="Scheduled tasks" />
          {automations.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="No automations detected"
              body={
                <>
                  Set up scheduled tasks in Cowork or automations in Codex, or add tasks to{" "}
                  <code className="font-mono text-foreground">~/.claude/tasks/</code>.
                </>
              }
            />
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
              {automations.map((a) => (
                <div
                  key={a.name}
                  className="grid grid-cols-12 items-center px-4 py-3 gap-3 text-xs"
                >
                  <div className="col-span-12 md:col-span-4 flex items-center gap-2 min-w-0">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    {a.source && (
                      <Badge tone="neutral">
                        {a.source === "claude-os"
                          ? "OS"
                          : a.source.charAt(0).toUpperCase() + a.source.slice(1)}
                      </Badge>
                    )}
                  </div>
                  <div className="col-span-6 md:col-span-3 text-muted-foreground">{a.cadence}</div>
                  <div className="col-span-6 md:col-span-2 text-muted-foreground">
                    last: {a.lastRun}
                  </div>
                  <div className="col-span-6 md:col-span-2 text-muted-foreground">
                    next: {a.nextRun}
                  </div>
                  <div className="col-span-6 md:col-span-1 flex md:justify-end">
                    {a.status === "success" ? (
                      <StatusDot tone="success" label="OK" />
                    ) : a.status === "failed" ? (
                      <StatusDot tone="danger" label="Failed" />
                    ) : (
                      <StatusDot
                        tone="warn"
                        label={String(a.status).charAt(0).toUpperCase() + String(a.status).slice(1)}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        </McSection>

        {/* ============= SECTION 7 — DAILY ACTIVITY / MODEL INTELLIGENCE ============= */}
        <McSection id="mc-models" icon={Cpu} title={activityTab === "sessions" ? "Sessions per day" : "Model intelligence"} line="Which models lead, what they cost, and your sessions per day" persistKey="mc-models">
        <section className="mb-10">
          <SectionHead
            eyebrow={activityTab === "sessions" ? "Activity" : "Models"}
            title={activityTab === "sessions" ? "Sessions per day" : "Model intelligence"}
            right={<BottomPanelSwitcher value={activityTab} onChange={setActivityTab} />}
          />
          <BottomPanel
            tab={activityTab}
            sessions={<DailyActivityRows />}
            models={<ModelIntelligence />}
          />
        </section>
        </McSection>

        {/* ============= SECTION 8 — SKILL RECOMMENDER ============= */}
        {skillRecommendations.length > 0 && (
          <McSection id="mc-recommender" icon={Sparkles} title="Skills your sessions are asking for" value={skillRecommendations.length} line="recommended from your sessions" persistKey="mc-recommender">
          <section className="mb-12">
            <SectionHead
              eyebrow="Recommender"
              title="Skills your sessions are asking for"
              right={
                <span className="text-xs text-muted-foreground">
                  Based on {skillRecommendations.reduce((a, s) => a + s.evidenceCount, 0)} signals ·
                  refreshed this morning
                </span>
              }
            />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {skillRecommendations.map((s) => (
                <SkillRecommenderCard key={s.name} rec={s} />
              ))}
            </div>
          </section>
          </McSection>
        )}
        </DeckGrid>
      </div>
    </>
  );
}

// ---------- Pieces ----------

/**
 * A Mission Control section: one summary widget (icon, title, one value, one line) whose "Open"
 * reveals the section itself as a full-width panel under its row. The body mounts only when opened,
 * so the 3D graphs and long tables cost nothing until asked for, and the choice is remembered (the
 * same `calm-open:mc-*` keys the folded rows used). Sections still hide their own heading inside.
 */
function McSection({ children, ...item }: Omit<DeckItem, "detail"> & { children: React.ReactNode }) {
  return <DeckSection {...item} detail={() => <InCalmSection.Provider value={true}>{children}</InCalmSection.Provider>} />;
}

function SectionHead({
  title,
  right,
}: {
  /** Kept for call-site compatibility; the design system has no kicker above headings. */
  eyebrow?: string;
  title: string;
  right?: React.ReactNode;
}) {
  // Inside a CalmSection the section row already names it: keep only the controls on the right.
  const folded = React.useContext(InCalmSection);
  if (folded) return right ? <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{right}</div> : null;
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <h2 className="text-lg font-semibold leading-snug tracking-[-0.01em]">{title}</h2>
      {right}
    </div>
  );
}

function SkillCard({
  s,
  period,
}: {
  s: DemoSkill & { periodUses: number; mins: number; dollars: number };
  period: Period;
}) {
  const rate = useValueRate();
  const Icon = s.icon;
  const statusTone = s.status === "active" ? "success" : s.status === "dormant" ? "warn" : "neutral";
  const periodWord = period === "day" ? "today" : period === "week" ? "this week" : "this month";
  return (
    <Link
      to="/skills"
      className="ds-interactive flex flex-col rounded-xl border border-border bg-card shadow-sm hover:border-border-strong hover:bg-surface-raised"
    >
      <div className="flex items-center justify-between px-4 pt-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-inset">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </span>
        <StatusDot
          tone={statusTone}
          label={s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "Unused"}
        />
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{s.name}</div>
          <div className="text-xs text-muted-foreground">Last used {s.lastUsed}</div>
        </div>

        <div className="flex items-baseline gap-1">
          <span className="ds-num text-xl font-semibold">{formatMoney(s.dollars, { currency: rate.currency, whole: true })}</span>
          <span className="text-xs text-muted-foreground">est. saved {periodWord}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-border pt-2 text-xs">
          <div>
            <div className="ds-label">Used</div>
            <div className="ds-num font-semibold">
              {Math.round(s.periodUses)}× {periodWord}
            </div>
          </div>
          <div>
            <div className="ds-label inline-flex items-center gap-1">
              ~Per run{" "}
              {s.estimateSource === "ai" ? (
                <Sparkles className="h-2.5 w-2.5" />
              ) : (
                <Pencil className="h-2.5 w-2.5" />
              )}
            </div>
            <div className="ds-num font-semibold">{s.minsPerRun} min</div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function IntegrationTile({
  name,
  slug,
  connected,
  color,
  tagline,
}: {
  name: string;
  slug: string;
  connected: boolean;
  color: string;
  tagline?: string;
}) {
  const local = LOCAL_LOGO_MAP[slug];
  const logo = local ?? `https://cdn.simpleicons.org/${slug}/${color}`;
  const isLocal = !!local;
  const initial = name.charAt(0);
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-border bg-card p-3 ${
        connected ? "" : "opacity-60"
      }`}
    >
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-inset">
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-muted-foreground"
        >
          {initial}
        </span>
        <img
          src={logo}
          alt={name}
          className="relative h-5 w-5 object-contain"
          loading="lazy"
          style={isLocal ? { filter: "none" } : undefined}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold tracking-tight">{name}</div>
        <StatusDot
          tone={connected ? "success" : "neutral"}
          label={<span className="truncate">{tagline ?? (connected ? "Connected" : "Not connected")}</span>}
          className="max-w-full"
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// DreamSourcesStrip — collapsible row showing every data stream the Dream
// skill reads from. Lets the user verify "what does Dream actually know
// about". Each source has a status pill: ✓ live / ○ optional / – missing.
// Hermes appears here once the aggregator picks it up.
// ────────────────────────────────────────────────────────────────────────────
// One source entry — `kind` selects which logo treatment to render.
// `image` is for proper brand marks; `IconComp` is the lucide fallback.
type DreamSourceKind = "image" | "icon";
interface DreamSource {
  name: string;
  status: "live" | "optional" | "missing";
  detail: string;
  kind: DreamSourceKind;
  image?: string;
  IconComp?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  /** Brand accent — drives the glow / chip tint on each row. */
  accent: string;
}

function DreamSourcesStrip() {
  // Default-EXPANDED so the operator can see at a glance which streams are
  // live without an extra click. Newly-added tools (e.g. Antigravity) show
  // up immediately rather than hiding behind an accordion.
  const [expanded, setExpanded] = useState(true);
  const hermesPresent = !!(ld as any)?.hermes?.installed;
  const memStats = (ld as any)?.memory?.stats ?? {};
  const integrationCount = Array.isArray((ld as any)?.integrations)
    ? (ld as any).integrations.length
    : 0;
  const skillCount = Array.isArray((ld as any)?.skills?.active)
    ? (ld as any).skills.active.length
    : 0;
  const projectCount = Array.isArray((ld as any)?.recentProjects)
    ? (ld as any).recentProjects.length
    : 0;
  const automationCount = Array.isArray((ld as any)?.automations)
    ? (ld as any).automations.length
    : 0;

  const sources: DreamSource[] = [
    {
      name: "Claude Code activity",
      status: projectCount > 0 ? "live" : "missing",
      detail:
        projectCount > 0
          ? `${projectCount} project${projectCount === 1 ? "" : "s"} · 7d window`
          : "no recent activity",
      kind: "image",
      image: claudeLogo,
      accent: "#FF7A3D",
    },
    // Antigravity (Google's Gemini-powered IDE/CLI agent). Detected by the
    // aggregator at /Applications/Antigravity.app + usage scanned from
    // ~/.gemini/antigravity/conversations/*.pb. Sits next to Claude Code so
    // the user can see both coding agents' activity side-by-side.
    (() => {
      const ag = (ld as any)?.detection?.apps?.antigravity ?? {};
      const agInstalled = !!ag.detected;
      const agConvs = ag.usage?.conversations ?? 0;
      const agAgo = ag.usage?.lastActiveAgo ?? "—";
      // Surface-level label: "IDE + CLI" / "IDE only" / "CLI only" / ""
      // so the operator can see at a glance which surfaces are wired.
      const ideOn = !!ag.surfaces?.ide?.detected;
      const cliOn = !!ag.surfaces?.cli?.detected;
      const surfacesLabel =
        ideOn && cliOn ? "IDE + CLI" : ideOn ? "IDE only" : cliOn ? "CLI only" : "";
      let detail: string;
      if (agInstalled && agConvs > 0) {
        detail = surfacesLabel
          ? `${surfacesLabel} · ${agConvs} conversation${agConvs === 1 ? "" : "s"} · last active ${agAgo}`
          : `${agConvs} conversation${agConvs === 1 ? "" : "s"} · last active ${agAgo}`;
      } else if (agInstalled) {
        detail = surfacesLabel
          ? `${surfacesLabel} · installed · no activity yet`
          : "installed · no activity yet";
      } else {
        detail = "not installed";
      }
      const status: DreamSource["status"] =
        agInstalled && agConvs > 0 ? "live" : agInstalled ? "optional" : "missing";
      return {
        name: "Antigravity",
        status,
        detail,
        kind: "image" as const,
        image: logoAntigravity,
        accent: "#8E75B2",
      };
    })(),
    {
      name: "Memory files",
      status: memStats?.totalFiles > 0 ? "live" : "missing",
      detail:
        memStats?.totalFiles > 0
          ? `${memStats.totalFiles} files · ${memStats.totalWorkspaces ?? 0} workspaces`
          : "no memory files found",
      kind: "icon",
      IconComp: Brain,
      accent: "#f472b6",
    },
    {
      name: "Skills usage",
      status: skillCount > 0 ? "live" : "missing",
      detail: skillCount > 0 ? `${skillCount} active skills` : "no skills used",
      kind: "icon",
      IconComp: Sparkles,
      accent: "#60a5fa",
    },
    {
      name: "Integrations",
      status: integrationCount > 0 ? "live" : "missing",
      detail: integrationCount > 0 ? `${integrationCount} connected` : "nothing connected",
      kind: "icon",
      IconComp: Plug,
      accent: "#86efac",
    },
    {
      name: "Automations",
      status: automationCount > 0 ? "live" : "missing",
      detail: automationCount > 0 ? `${automationCount} scheduled tasks` : "no automations",
      kind: "icon",
      IconComp: Workflow,
      accent: "#a78bfa",
    },
    {
      name: "Hermes Agent",
      status: hermesPresent ? "live" : "missing",
      detail: hermesPresent
        ? `${(ld as any)?.hermes?.sessionCount ?? 0} sessions · ${(ld as any)?.hermes?.personaCount ?? 0} personas`
        : "not installed",
      kind: "image",
      image: hermesAgentLogo,
      accent: "#FFD21E",
    },
  ];

  const liveCount = sources.filter((s) => s.status === "live").length;

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-border bg-inset">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="ds-interactive flex w-full items-center justify-between gap-3 px-4 py-3 hover:bg-accent"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-medium text-foreground">Sources</span>
          <span className="ds-num text-xs text-muted-foreground">
            {liveCount} of {sources.length} streams live
          </span>
        </div>
        <ChevronRight
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="grid grid-cols-1 gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((s) => (
            <DreamSourceTile key={s.name} source={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function DreamSourceTile({ source }: { source: DreamSource }) {
  const isLive = source.status === "live";
  const isOptional = source.status === "optional";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-inset">
        {source.kind === "image" && source.image ? (
          <img
            src={source.image}
            alt=""
            className="object-contain"
            style={{ width: 20, height: 20, opacity: isLive ? 1 : 0.5, filter: isLive ? "none" : "grayscale(0.7)" }}
          />
        ) : source.IconComp ? (
          <source.IconComp className={`h-4 w-4 ${isLive ? "text-foreground" : "text-muted-foreground"}`} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{source.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{source.detail}</div>
      </div>
      <Badge tone={isLive ? "success" : isOptional ? "warn" : "neutral"}>
        {isLive ? "Live" : isOptional ? "Off" : "Missing"}
      </Badge>
    </div>
  );
}

function DreamItem({
  cat,
  text,
  tone,
  index,
  dismissed,
  onDismiss,
}: {
  cat: string;
  text: string;
  tone: DreamTone;
  index: number;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const [bursting, setBursting] = useState(false);
  const [hidden, setHidden] = useState(false);
  React.useEffect(() => {
    if (dismissed) {
      setBursting(true);
      const t = setTimeout(() => setHidden(true), 700);
      return () => clearTimeout(t);
    }
  }, [dismissed]);

  if (hidden) return null;

  const palette = DREAM_PALETTES[tone];

  const catIcon =
    cat === "MEMORY"
      ? Brain
      : cat === "COST"
        ? DollarSign
        : cat === "SKILLS"
          ? Sparkles
          : cat === "WORKFLOW"
            ? Workflow
            : Lightbulb;
  const CatIcon = catIcon;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border bg-card p-5 transition-opacity duration-300 ${
        bursting ? "opacity-0" : "opacity-100"
      }`}
    >

      <div className="relative flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-inset">
          <CatIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge tone={palette.tone}>{cat.charAt(0) + cat.slice(1).toLowerCase()}</Badge>
            {tone === "pink" && <AlertTriangle className="h-3 w-3 text-warn" />}
          </div>
          <p className="text-sm leading-relaxed text-foreground">{text}</p>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Mark as done"
          className="h-7 w-7 rounded-lg border border-border bg-inset text-muted-foreground hover:bg-success-soft hover:border-success/40 hover:text-success transition-all shrink-0 flex items-center justify-center"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {bursting && <Confetti seed={index} />}
    </div>
  );
}

function Confetti({ seed }: { seed: number }) {
  const pieces = React.useMemo(
    () =>
      Array.from({ length: 22 }).map((_, i) => {
        const rand = (n: number) =>
          (((Math.sin(seed * 9.7 + i * 12.3 + n) * 43758.5453) % 1) + 1) % 1;
        const angle = rand(1) * Math.PI * 2;
        const dist = 60 + rand(2) * 90;
        return {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist - 20,
          r: rand(3) * 360,
          c: ["#a78bfa", "#f472b6", "#3ddc97", "#fde68a", "#bae6fd", "#ddd6fe"][
            Math.floor(rand(4) * 6)
          ],
          d: 4 + rand(5) * 6,
        };
      }),
    [seed],
  );
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute block confetti-piece"
          style={{
            background: p.c,
            width: `${p.d}px`,
            height: `${p.d * 0.4}px`,
            // @ts-expect-error custom props
            "--tx": `${p.x}px`,
            "--ty": `${p.y}px`,
            "--rot": `${p.r}deg`,
          }}
        />
      ))}
    </div>
  );
}


function Stat({ n, label, tone }: { n: string; label: string; tone?: "amber" | "red" }) {
  const c = tone === "red" ? "text-danger" : tone === "amber" ? "text-warn" : "text-foreground";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`ds-num font-semibold ${c}`}>{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

// Pulled from liveData.memory.events (real activity from the aggregator).
// Renders nothing if the aggregator hasn't surfaced any events.
function MemorySignalsOverlay() {
  const events: any[] = ld?.memory?.events ?? [];
  if (!Array.isArray(events) || events.length === 0) return null;
  const toneForType = (t: string) =>
    t === "edit" ? "success" : t === "vectorize" ? "accent" : t === "recall" ? "warn" : "info";
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10 hidden w-60 space-y-2 rounded-lg border border-border bg-popover/90 p-3 text-xs shadow-md sm:block">
      <div className="ds-label">Latest signals</div>
      {events.slice(0, 4).map((e, i) => {
        const tone = toneForType(String(e?.type || "")) as "success" | "accent" | "warn" | "info";
        const title = String(e?.target ?? "—");
        const subtitle = `${String(e?.time ?? "—")}${
          e?.meta?.hits ? ` · ${e.meta.hits} hits` : e?.destination ? ` → ${e.destination}` : ""
        }`;
        return (
          <div key={String(e?.id ?? i)} className="flex items-start gap-2">
            <StatusDot tone={tone} label="" className="mt-1" />
            <div className="min-w-0">
              <div className="truncate text-foreground">{title}</div>
              <div className="text-xs text-muted-foreground">{subtitle}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Footer stats bar under the home memory graph. Every number comes from
// liveData.memory.stats — the same totals the Memory page header uses.
// We hide tiles that have no data instead of falling back to invented numbers.
function MemoryStatsFooter() {
  const stats: any = ld?.memory?.stats ?? {};
  const totalFiles = Number.isFinite(stats?.totalFiles) ? Number(stats.totalFiles) : null;
  const totalWorkspaces = Number.isFinite(stats?.totalWorkspaces)
    ? Number(stats.totalWorkspaces)
    : null;
  const stale = Number.isFinite(stats?.stale) ? Number(stats.stale) : null;
  const missing = Number.isFinite(stats?.missing) ? Number(stats.missing) : null;
  const types =
    stats?.typeBreakdown && typeof stats.typeBreakdown === "object"
      ? Object.values(stats.typeBreakdown).filter((v: any) => Number(v) > 0).length
      : null;

  const cells = [
    totalFiles !== null ? <Stat key="files" n={String(totalFiles)} label="memories" /> : null,
    types !== null && types > 0 ? <Stat key="types" n={String(types)} label="types" /> : null,
    totalWorkspaces !== null ? (
      <Stat key="ws" n={String(totalWorkspaces)} label="projects" />
    ) : null,
    stale !== null && stale > 0 ? (
      <Stat key="stale" n={String(stale)} label="stale" tone="amber" />
    ) : null,
    missing !== null && missing > 0 ? (
      <Stat
        key="missing"
        n={String(missing)}
        label={missing === 1 ? "missing" : "missing"}
        tone="red"
      />
    ) : null,
  ].filter(Boolean);

  if (cells.length === 0) {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        No memory parsed yet — run{" "}
        <code className="text-foreground/80">bun run scripts/aggregate.ts</code> to populate.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
      {cells}
    </div>
  );
}

// ---------- Skills KPI expansion ----------

function SkillsSavedExpansion({
  onClose,
  rate,
  onRateChange,
  skills,
  minutesFor,
  setMinutesFor,
  period,
}: {
  onClose: () => void;
  /** The one shared hourly rate — see src/lib/value-metrics.ts / workspace-profile.ts. */
  rate: import("@/lib/workspace-profile").HourlyRate;
  onRateChange: (n: number) => void;
  skills: DemoSkill[];
  minutesFor: (name: string) => number;
  setMinutesFor: (name: string, value: number) => void;
  period: Period;
}) {
  const factor = period === "day" ? 1 / 7 : period === "week" ? 1 : 30 / 7;
  const sorted = [...skills].sort((a, b) => b.uses * b.minsPerRun - a.uses * a.minsPerRun);
  const configuredCount = skills.filter((s) => minutesFor(s.name) > 0).length;
  const [showAskAi, setShowAskAi] = useState(false);
  // Per-row unit toggles: "min" or "hr"
  const [units, setUnits] = useState<Record<string, "min" | "hr">>({});
  const getUnit = (name: string) => units[name] ?? "min";

  const askAiCommand = `claude "Look at my skills in ~/.claude/ and estimate how many minutes each one saves per run compared to doing it manually. Output JSON like {\\"skillName\\": minutes}. Be conservative — only count time the skill genuinely saves."`;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          <div className="text-sm font-semibold">Skills saved · tune your estimates</div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="xs" onClick={() => setShowAskAi((v) => !v)} aria-expanded={showAskAi}>
            <TerminalIcon /> Ask AI
          </Button>
          <Button variant="ghost" size="xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {/* Ask AI command panel */}
      {showAskAi && (
        <div className="px-5 py-4 border-b border-border/60 bg-brand-soft]">
          <div className="flex items-start gap-3">
            <div className="h-8 w-8 rounded-lg bg-brand-soft border border-border flex items-center justify-center shrink-0 mt-0.5">
              <TerminalIcon className="h-3.5 w-3.5 text-brand" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold mb-1">
                Let Claude estimate your time savings
              </div>
              <div className="text-xs text-muted-foreground mb-3">
                Paste this command in your terminal. Claude will scan your skills and estimate how
                many minutes each one saves per run. Then enter the numbers below.
              </div>
              <div className="relative group">
                <pre className="bg-inset border border-border/60 rounded-lg p-3 text-xs text-success font-mono overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                  {askAiCommand}
                </pre>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(askAiCommand);
                  }}
                  className="absolute top-2 right-2 text-xs px-2 py-1 rounded border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:border-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hourly rate */}
      <div className="px-5 py-4 border-b border-border/60 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[260px]">
          <div className="text-xs font-semibold mb-0.5">Your hourly rate</div>
          <div className="text-xs text-muted-foreground">
            What an hour of your time is worth. Shared with Skills and Share — set it once here
            and every {currencyPrefix(rate.currency).trim()} value saved on those pages updates too.
            {rate.assumed && " Not set yet, so this is a guess:"}
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-xs text-muted-foreground">{currencyPrefix(rate.currency).trim()}</span>
          <input
            type="number"
            min={0}
            defaultValue={rate.rate}
            key={rate.rate}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) onRateChange(n);
            }}
            className="w-20 bg-transparent outline-none text-sm font-semibold tabular-nums"
          />
          <span className="text-xs text-muted-foreground">/ hour</span>
        </div>
      </div>

      {/* Empty state when no skills are configured */}
      {configuredCount === 0 && skills.length > 0 && (
        <div className="px-5 py-6 border-b border-border/60">
          <div className="rounded-xl border border-dashed border-success/40 bg-success-soft] p-5 text-center">
            <div className="text-sm font-semibold mb-1">No time estimates configured yet</div>
            <div className="text-xs text-muted-foreground max-w-sm mx-auto mb-3">
              Set how many minutes each skill saves per run to start tracking your ROI. Use the{" "}
              <strong className="text-brand">Ask AI</strong> button above to get estimates
              automatically, or enter them manually below.
            </div>
            <div className="text-xs text-muted-foreground">
              {skills.length} skill{skills.length !== 1 ? "s" : ""} detected · all showing $0 until
              configured
            </div>
          </div>
        </div>
      )}

      {/* Skills table */}
      <div className="max-h-[320px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/20 text-xs text-muted-foreground sticky top-0 backdrop-blur">
            <tr>
              <th className="text-left font-medium px-4 py-2">Skill</th>
              <th className="text-right font-medium px-4 py-2">Uses</th>
              <th className="text-left font-medium px-4 py-2">Time saved per run (your estimate)</th>
              <th className="text-right font-medium px-4 py-2">Saved (assumed)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {sorted.map((s) => {
              const min = minutesFor(s.name) || s.minsPerRun;
              const uses = s.uses * factor;
              const dollars = ((min * uses) / 60) * rate.rate;
              const unit = getUnit(s.name);
              const displayValue = unit === "hr" ? +(min / 60).toFixed(2) : min;
              return (
                <tr key={s.name} className="hover:bg-accent/20">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <s.icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium truncate">{s.name}</span>
                      {s.estimateSource === "ai" && (
                        <span
                          title="AI-estimated"
                          className="inline-flex items-center gap-0.5 text-xs text-brand"
                        >
                          <Sparkles className="h-2.5 w-2.5" /> ai
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {Math.round(uses)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        step={unit === "hr" ? 0.25 : 1}
                        value={displayValue}
                        onChange={(e) => {
                          const v = Number(e.target.value) || 0;
                          setMinutesFor(s.name, unit === "hr" ? Math.round(v * 60) : v);
                        }}
                        className="w-16 bg-background border border-border rounded px-2 py-1 text-right text-xs tabular-nums outline-none focus:border-foreground/40"
                      />
                      <button
                        onClick={() =>
                          setUnits((u) => ({ ...u, [s.name]: unit === "min" ? "hr" : "min" }))
                        }
                        className="text-xs px-1.5 py-1 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/40 w-8 text-center"
                        title="Toggle between minutes and hours"
                      >
                        {unit}
                      </button>
                    </div>
                  </td>
                  <td className="ds-num px-4 py-2 text-right font-semibold text-foreground">
                    ${Math.round(dollars).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Dream categories map onto the semantic tones — no per-category colour worlds.
const DREAM_PALETTES: Record<
  DreamTone,
  { tone: "danger" | "warn" | "info" | "accent"; image: string }
> = {
  pink: { tone: "danger", image: dreamMemoryPink },
  orange: { tone: "warn", image: dreamCostOrange },
  blue: { tone: "info", image: dreamSkillsBlue },
  yellow: { tone: "accent", image: dreamWorkflowYellow },
};

// (sidecar removed — wizard + dashboard are pure browser; aggregator runs in terminal)

type StreamState =
  | { kind: "idle" }
  | { kind: "streaming"; output: string }
  | { kind: "done"; output: string; exitCode: number | null }
  | { kind: "error"; output: string; message: string };

function DreamCarousel({
  cur,
  total,
  index,
  prev,
  next,
  onDismiss,
  onDone,
}: {
  cur: DreamSuggestion & { originalIndex: number };
  total: number;
  index: number;
  prev: () => void;
  next: () => void;
  onDismiss: () => void;
  onDone: () => void;
}) {
  const palette = DREAM_PALETTES[cur.tone];
  const [copiedFix, setCopiedFix] = useState(false);
  const [stream, setStream] = useState<StreamState>({ kind: "idle" });
  const [copyToast, setCopyToast] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const abortRef = React.useRef<AbortController | null>(null);

  // Reset streaming UI + collapse the evidence when the user navigates to a
  // different prescription, so every card opens in the same compact state.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStream({ kind: "idle" });
    setShowWhy(false);
    setCopiedFix(false);
  }, [cur.originalIndex]);

  const CatIcon =
    cur.cat === "MEMORY"
      ? Brain
      : cur.cat === "COST"
        ? DollarSign
        : cur.cat === "SKILLS"
          ? Sparkles
          : Workflow;
  const headlineByCat: Record<string, string> = {
    MEMORY: "Sharpen your memory",
    COST: "Spend smarter",
    SKILLS: "Compound your skills",
    WORKFLOW: "Tighten the loop",
  };

  const fallbackCopy = () => {
    if (!cur.command) return;
    navigator.clipboard?.writeText(cur.command).then(() => {
      setCopiedFix(true);
      setCopyToast(true);
      setTimeout(() => setCopiedFix(false), 1800);
      setTimeout(() => setCopyToast(false), 4000);
    });
  };

  // Sidecar removed — clicking [Run this fix →] now copies the underlying
  // `claude -p "<prescription>"` command to the clipboard so the user can
  // paste it into Claude Code (or any AI agent) themselves. No backend
  // streaming, no race conditions.
  const runFix = () => {
    fallbackCopy();
  };

  const closeStream = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStream({ kind: "idle" });
  };

  const updatedLabel = dreamGeneratedAt
    ? fmtTime(new Date(dreamGeneratedAt))
    : "3:12 AM";

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-inset md:flex md:h-[420px]">
      <div className="grid w-full grid-cols-1 md:min-h-0 md:flex-1 md:grid-cols-[240px_1fr]">
        {/* Category photograph — framed, not feathered into a themed stage */}
        <div className="relative hidden overflow-hidden border-r border-border md:block">
          <img
            src={palette.image}
            alt={`Dream · ${cur.cat.toLowerCase()}`}
            loading="lazy"
            width={1280}
            height={720}
            className="absolute inset-0 h-full w-full object-cover opacity-80"
          />
          <div className="relative flex h-full items-end p-4">
            <div className="flex items-center gap-2.5 rounded-lg border border-border bg-popover/90 px-3 py-2 shadow-md">
              <CatIcon className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-semibold text-foreground">
                {headlineByCat[cur.cat] ?? "Suggestion"}
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="relative p-5 md:p-7 flex flex-col md:min-h-0 md:overflow-hidden">
          {/* Top-right meta cluster — vertical: time saved + dollar impact + last refreshed */}
          <div className="absolute top-3 right-3 flex flex-col items-end gap-1.5">
            {(typeof cur.dollarImpact === "number" || typeof cur.timeImpactMins === "number") && (
              <div
                className="ds-num inline-flex items-center gap-2 rounded-lg bg-success-soft px-2.5 py-1.5 text-xs text-success"
                title="Estimated impact if you act on this"
              >
                {typeof cur.dollarImpact === "number" && (
                  <span className="font-semibold tracking-tight">≈ ${cur.dollarImpact}/mo</span>
                )}
                {typeof cur.dollarImpact === "number" && typeof cur.timeImpactMins === "number" && (
                  <span className="opacity-60">·</span>
                )}
                {typeof cur.timeImpactMins === "number" && (
                  <span className="opacity-90">≈ {cur.timeImpactMins} min saved (estimate)</span>
                )}
              </div>
            )}
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              Refreshed {updatedLabel}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3 mt-1">
            <Badge tone={palette.tone}>{cur.cat.charAt(0) + cur.cat.slice(1).toLowerCase()}</Badge>
            {typeof cur.ageDays === "number" && cur.ageDays >= 2 && (
              <Badge
                tone="warn"
                title={`This issue has been surfacing for ${cur.ageDays} days without being resolved`}
              >
                Recurring · {cur.ageDays}d
              </Badge>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              {index + 1} / {total}
            </span>
          </div>
          <div className="mb-3 max-w-[52ch] text-base font-semibold leading-snug text-foreground">
            {cur.headline}
          </div>

          <div className="flex-1 md:overflow-y-auto pr-1 space-y-4">
            <p className="text-xs md:text-sm leading-relaxed text-muted-foreground max-w-[74ch]">
              {cur.prescription}
            </p>

            <div className="pl-3 border-l border-border">
              <button
                type="button"
                onClick={() => setShowWhy((v) => !v)}
                aria-expanded={showWhy}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${showWhy ? "rotate-90" : ""}`}
                />
                Why we're suggesting this
                <span className="tabular-nums normal-case tracking-normal text-muted-foreground">
                  ({cur.evidence.length})
                </span>
              </button>
              {showWhy && (
                <ul className="space-y-1.5 mt-2">
                  {cur.evidence.map((e, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-xs text-muted-foreground leading-snug"
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 h-1 w-1 rounded-full shrink-0"
                        style={{ background: "var(--muted-foreground)" }}
                      />
                      <span className="break-words">{e}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {cur.command && (
              <div>
                <div className="text-xs text-muted-foreground mb-1.5 flex items-center justify-between gap-2">
                  <span>Try it now — copy this and paste into Claude Code</span>
                  <button
                    onClick={runFix}
                    disabled={stream.kind === "streaming"}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-inset hover:bg-accent transition-colors text-xs text-muted-foreground disabled:opacity-60"
                    title={
                      stream.kind === "streaming"
                        ? "Running…"
                        : copiedFix
                          ? "Copied — paste into Claude Code"
                          : "Copy this command to your clipboard"
                    }
                  >
                    {stream.kind === "streaming" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : copiedFix ? (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    ) : (
                      <ArrowUpRight className="h-3 w-3" />
                    )}
                    {stream.kind === "streaming"
                      ? "Running…"
                      : copiedFix
                        ? "Copied"
                        : "Run this fix"}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={runFix}
                  disabled={stream.kind === "streaming"}
                  className="block w-full text-left text-xs md:text-xs font-mono px-3 py-2 rounded-md bg-inset border border-border text-foreground break-all hover:border-border-strong transition-colors cursor-copy disabled:cursor-progress"
                  title="Click to copy the command"
                >
                  {cur.command}
                </button>

                {copyToast && stream.kind === "idle" && (
                  <div className="mt-2 text-xs text-warn bg-warn-soft border border-warn/40 rounded-md px-2.5 py-1.5">
                    Copied to clipboard. Tip:
                    <span className="font-mono"> bun run server </span>
                    runs this for you with one click.
                  </div>
                )}

                {stream.kind !== "idle" && (
                  <div className="mt-3 rounded-md border border-border bg-inset overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border text-xs">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <TerminalIcon className="h-3 w-3" />
                        {stream.kind === "streaming" && "Streaming…"}
                        {stream.kind === "done" && (
                          <span
                            className={
                              stream.exitCode === 0 || stream.exitCode === null
                                ? "text-success"
                                : "text-danger"
                            }
                          >
                            {stream.exitCode === 0 || stream.exitCode === null
                              ? `Done · exit ${stream.exitCode ?? 0}`
                              : `Failed · exit ${stream.exitCode}`}
                          </span>
                        )}
                        {stream.kind === "error" && (
                          <span className="text-danger">Failed · {stream.message}</span>
                        )}
                      </span>
                      <button
                        onClick={closeStream}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-inset"
                      >
                        <X className="h-2.5 w-2.5" /> Close
                      </button>
                    </div>
                    <pre className="px-3 py-2 text-xs font-mono text-foreground max-h-48 overflow-auto whitespace-pre-wrap">
                      {stream.output || (stream.kind === "streaming" ? "" : "")}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-border flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <button
                onClick={prev}
                className="h-8 w-8 rounded-lg border border-border bg-inset text-muted-foreground hover:bg-accent transition-colors flex items-center justify-center"
                aria-label="Previous"
              >
                <span aria-hidden>‹</span>
              </button>
              <button
                onClick={next}
                className="h-8 w-8 rounded-lg border border-border bg-inset text-muted-foreground hover:bg-accent transition-colors flex items-center justify-center"
                aria-label="Next"
              >
                <span aria-hidden>›</span>
              </button>
              <div className="flex items-center gap-1.5 px-2">
                {Array.from({ length: total }).map((_, i) => (
                  <span
                    key={i}
                    className="h-1.5 rounded-full transition-all"
                    style={{
                      width: i === index ? 16 : 5,
                      background: i === index ? "var(--brand)" : "var(--border-strong)",
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onDismiss} title="Skip this suggestion">
                <XCircle /> Skip
              </Button>
              <Button
                variant="accent"
                size="sm"
                onClick={onDone}
                title="Mark as handled — Dream won't resurface this for 30 days"
              >
                <CheckCircle2 /> Apply &amp; mark done
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DailyActivityRows() {
  const max = Math.max(...dailyActivity.map((d) => d.sessions));
  const totalSessions = dailyActivity.reduce((a, d) => a + d.sessions, 0);
  const totalMinutes = dailyActivity.reduce((a, d) => a + d.minutes, 0);
  const last7Avg = Math.round(dailyActivity.slice(-7).reduce((a, d) => a + d.sessions, 0) / 7);
  const prev7Avg = Math.round(dailyActivity.slice(0, 7).reduce((a, d) => a + d.sessions, 0) / 7);
  const trendPct = prev7Avg > 0 ? Math.round(((last7Avg - prev7Avg) / prev7Avg) * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 border-b border-border text-xs tabular-nums">
        <span className="text-muted-foreground">14d total</span>
        <span className="font-semibold text-foreground">{totalSessions} sessions</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {Math.round(totalMinutes / 60)} hours of focused work
        </span>
        <span className={`ml-auto inline-flex items-center gap-1.5 ${trendPct >= 0 ? "text-success" : "text-danger"}`}>
          <TrendingUp className="h-3.5 w-3.5" />
          {trendPct >= 0 ? "+" : ""}
          {trendPct}% week-over-week
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {dailyActivity
          .slice()
          .reverse()
          .map((d) => {
            const pct = d.sessions / max;
            const isToday = d.label === "Today";
            return (
              <div key={d.date} className="grid grid-cols-12 items-center px-5 py-2.5 gap-3">
                <div
                  className={`col-span-3 md:col-span-2 text-xs ${isToday ? "text-foreground font-medium" : "text-muted-foreground"}`}
                >
                  {d.label}
                </div>
                <div className="relative col-span-6 h-2 overflow-hidden rounded-full bg-border md:col-span-7">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${isToday ? "bg-brand" : "bg-muted-foreground/50"}`}
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
                <div className="col-span-2 text-right text-xs tabular-nums">
                  <span
                    className={isToday ? "text-foreground font-semibold" : "text-muted-foreground"}
                  >
                    {d.sessions}
                  </span>
                  <span className="text-muted-foreground"> sess.</span>
                </div>
                <div className="col-span-1 text-right text-xs tabular-nums text-muted-foreground hidden md:inline">
                  {Math.round(d.minutes / 60)}h
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function SkillRecommenderCard({ rec }: { rec: SkillRecommendation }) {
  const conf = Math.round(rec.confidence * 100);
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    try {
      navigator.clipboard?.writeText(rec.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div>
        <div className="flex items-center justify-between mb-3">
          <Badge tone="accent">
            <Lightbulb className="h-3 w-3" />
            Recommended skill
          </Badge>
          <div className="text-xs tabular-nums text-muted-foreground">{conf}% confidence</div>
        </div>
        <div className="font-mono text-base font-semibold mb-1.5 text-foreground">{rec.name}</div>
        <p className="text-xs text-muted-foreground leading-relaxed mb-3">{rec.basis}</p>

        <div className="flex items-center gap-3 mb-3 text-xs tabular-nums">
          <span className="inline-flex items-center gap-1.5 text-success">
            <TrendingUp className="h-3 w-3" />≈ ${rec.predictedSavings.dollarsPerMonth}/mo (predicted)
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground">≈ {rec.predictedSavings.hoursPerMonth}h saved (predicted)</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground">{rec.evidenceCount} signals</span>
        </div>

        <div className="rounded-md bg-inset border border-border px-2.5 py-2 mb-3 flex items-center gap-2">
          <code className="font-mono text-xs text-muted-foreground truncate flex-1">
            {rec.command}
          </code>
          <button
            onClick={onCopy}
            className="text-xs px-2 py-1 rounded border border-border bg-inset hover:bg-accent transition-colors text-muted-foreground hover:text-foreground shrink-0"
            title="Copy"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {rec.inspiredBy.map((s, i) => (
            <span
              key={i}
              className="text-xs font-mono text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/[0.04]"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// The price setting a subscription card is billed under — same lookup the
// server uses (scripts/ai-usage/prices.ts) so the box below never guesses a
// different plan than the one the totals were built from.
function subscriptionPriceId(sub: SubscriptionCard): string | null {
  if (sub.provider === "anthropic") return "claude-max-20x";
  if (sub.provider === "openai") return chatgptPriceId(sub.planSlug);
  return null;
}

function SubscriptionStrip() {
  // Real subscriptions, real AUD prices, real % of each plan's limit — the
  // same cached /__ai_usage snapshot the /usage page and AiUsageSummary
  // read, so this panel can never disagree with them. No more machine-
  // guessed "Claude Max 20x US$200" placeholders.
  const { data } = useAiUsage();
  const actions = useAiUsageActions();

  if (!data) {
    return (
      <EmptyState
        title="Reading subscriptions…"
        body="Pulling live plan data and prices from the AI usage & spend snapshot."
      />
    );
  }

  const subs = data.subscriptions;
  if (subs.length === 0) {
    return (
      <EmptyState
        title="No AI subscriptions detected yet"
        body={
          <>
            Sign in to Claude or Codex, then run{" "}
            <code className="font-mono text-foreground">bun run scripts/aggregate.ts</code>.
          </>
        }
      />
    );
  }

  // Flat monthly total straight from the usage totals (fixed subscription
  // fees, AUD incl. GST) — the same figure the "Fixed subscriptions" tile
  // on /usage shows, not a locally re-summed guess.
  const flatTotal = data.totals.fixedAud;

  // API-equivalent from the usage module (Claude transcripts this month, priced at list rates).
  // Without it the figure is "not measured": nothing here is filled in from a guess.
  const claudeApiEquivalent =
    "rows" in data.claudeModels ? (data.claudeModels.totalApiEquivalent?.aud ?? null) : null;

  // Free-agent contribution — equivalent value of work the operator did
  // through Antigravity (Google's free Gemini-powered coding agent) that
  // WOULD have cost $ if run on a paid Claude/GPT subscription. Counted
  // here so the ROI reflects the operator's TRUE total leverage, not
  // just the paid-token cost. Logo + attribution shown as a chip below.
  const ag = (ld as any)?.detection?.apps?.antigravity;
  const antigravitySaved: number = Number(ag?.usage?.savedEquivalent) || 0;
  const apiEquivalentAud = claudeApiEquivalent;
  const roi = apiEquivalentAud !== null && flatTotal > 0 ? apiEquivalentAud / flatTotal : null;

  const nearest = [...subs]
    .filter((s) => s.peakPercent !== null)
    .sort((a, b) => (b.peakPercent ?? 0) - (a.peakPercent ?? 0))[0];

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-1 text-xs">
        <span className="text-muted-foreground">Flat monthly spend</span>
        <span className="text-foreground font-semibold tabular-nums text-base">
          {fmtAud(flatTotal)}
        </span>
      </div>
      {/* L10: API-equivalent value and value-per-dollar are assumed, so they sit in a collapsed
          "Estimates" disclosure, in A$, and never beside the measured flat spend. */}
      <Disclosure className="mb-2" summary={<span className="text-sm">Estimates</span>} meta="Assumed, not measured">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 pb-2 text-xs">
          <span className="text-muted-foreground" title="What the same tokens would cost at public API prices. Not money spent or saved.">API-equivalent value (assumed)</span>
          <span className="text-foreground font-semibold tabular-nums text-base">
            {apiEquivalentAud !== null ? fmtAud(apiEquivalentAud) : "—"}
          </span>
          <span className="text-muted-foreground/70">·</span>
          {roi !== null ? (
            <span className="text-muted-foreground" title="Assumed: API-equivalent value divided by flat monthly spend. Assumes you would otherwise have paid public API prices for the same tokens.">about {roi.toFixed(1)}× value per dollar (assumed)</span>
          ) : (
            <span className="text-muted-foreground" title="The Claude token totals couldn't be read, so there is nothing to divide.">value per dollar: not measured</span>
          )}
          {antigravitySaved > 0 && (
            <span
              className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              title={`Equivalent value of work done through Antigravity (free), would have cost about ${formatMoney(Math.round(antigravitySaved), { whole: true })} on a paid plan.`}
            >
              <img src={logoAntigravity} alt="Antigravity" className="h-3 w-3 object-contain" />
              +{formatMoney(Math.round(antigravitySaved), { whole: true })} free via Antigravity (aggregator estimate, not in the total)
            </span>
          )}
        </div>
      </Disclosure>
      {nearest && (
        <p className="mb-3 text-xs text-muted-foreground">
          Closest to its cap: <span className="font-medium text-foreground">{nearest.owner}</span> ({nearest.plan}) at{" "}
          <span className="ds-num font-medium text-foreground">{Math.round(nearest.peakPercent ?? 0)}%</span>.
        </p>
      )}
      <div
        className={`grid gap-2.5 ${subs.length >= 3 ? "grid-cols-2 sm:grid-cols-3" : subs.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}
      >
        {subs.map((s) => (
          <SubscriptionTileCompact key={s.id} sub={s} prices={data.prices} savePrice={actions.savePrice} />
        ))}
      </div>
    </>
  );
}

function SubscriptionTileCompact({
  sub,
  prices,
  savePrice,
}: {
  sub: SubscriptionCard;
  prices: PriceSetting[];
  savePrice: ReturnType<typeof useAiUsageActions>["savePrice"];
}) {
  const priceId = subscriptionPriceId(sub);
  const price = priceId ? (prices.find((p) => p.id === priceId) ?? null) : null;
  const slug = sub.provider === "anthropic" ? "anthropic" : "openai";
  const local = LOCAL_LOGO_MAP[slug];
  const logoSrc = local ?? `https://cdn.simpleicons.org/${slug}/FFFFFF`;
  const top = sub.status.ok && sub.status.windows.length > 0 ? [...sub.status.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] : null;
  const tone = pressureTone(sub.peakPercent);

  return (
    <div className="rounded-lg border border-border bg-inset p-3">
      <div className="mb-2 flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card">
          <img
            src={logoSrc}
            alt={sub.owner}
            className="h-5 w-5 object-contain"
            loading="lazy"
            style={slug === "openai" ? { filter: "brightness(0) invert(1)" } : undefined}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{sub.owner}</div>
          <div className="truncate text-xs text-muted-foreground">{sub.plan}</div>
        </div>
      </div>

      {top ? (
        <div className="mb-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-border"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(top.usedPercent)}
            aria-label={`${sub.owner} ${top.label}`}
          >
            <div
              className={`h-full rounded-full ${tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-brand"}`}
              style={{ width: `${Math.max(0.5, Math.min(100, top.usedPercent))}%` }}
            />
          </div>
          <div className="ds-num mt-1 text-xs text-muted-foreground">
            {top.label} {Math.round(top.usedPercent)}% · {fmtResetIn(top.resetsAt)}
          </div>
        </div>
      ) : (
        <div className="mb-2 text-xs text-muted-foreground">
          Usage unavailable{!sub.status.ok ? `: ${sub.status.reason}` : ""}
        </div>
      )}

      <div className="flex items-baseline justify-between gap-2">
        {price ? (
          <InlineSubscriptionPrice price={price} monthlyAud={sub.monthly?.aud ?? null} savePrice={savePrice} />
        ) : (
          <span className="ds-num text-base font-semibold text-foreground">
            {sub.monthly ? fmtAud(sub.monthly.aud) : "—"}
          </span>
        )}
        {sub.monthly && fmtMoneyOrigin(sub.monthly) && (
          <span className="ds-num text-xs text-muted-foreground">{fmtMoneyOrigin(sub.monthly)}</span>
        )}
      </div>
    </div>
  );
}

// Click-to-edit monthly price, writing straight to the same prices store
// /usage edits (POST /__ai_usage/settings via useAiUsageActions) — so a
// price changed here is the price changed everywhere. Reading shows the
// AUD figure (matching the rest of the panel); editing works in the
// provider's own billing currency, same as the price row on /usage.
function InlineSubscriptionPrice({
  price,
  monthlyAud,
  savePrice,
}: {
  price: PriceSetting;
  monthlyAud: number | null;
  savePrice: ReturnType<typeof useAiUsageActions>["savePrice"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(price.amount === null ? "" : String(price.amount));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing) setDraft(price.amount === null ? "" : String(price.amount));
  }, [editing, price.amount]);

  const commit = async () => {
    setEditing(false);
    const raw = draft.trim();
    const parsed = raw === "" ? null : Number(raw);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
    if (parsed === price.amount) return;
    setBusy(true);
    try {
      await savePrice(price.id, parsed === null ? null : { amount: parsed, currency: price.currency, gstIncluded: price.gstIncluded });
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span className="text-base font-semibold text-foreground">{price.currency === "AUD" ? "A$" : "US$"}</span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          value={draft}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="ds-interactive w-16 bg-transparent border-b border-foreground/30 text-base font-semibold tabular-nums outline-none text-foreground"
        />
        <span className="text-xs text-muted-foreground tabular-nums">
          {price.currency} / mo{price.gstIncluded ? " incl. GST" : " + GST"}
        </span>
      </span>
    );
  }

  return (
    <span
      className="ds-interactive inline-flex items-baseline gap-1 group/price cursor-pointer"
      onClick={() => setEditing(true)}
      title={price.source}
    >
      <span className="ds-num text-base font-semibold text-foreground">
        {busy ? "Saving…" : price.amount === null ? "—" : monthlyAud !== null ? fmtAud(monthlyAud) : `${price.currency === "AUD" ? "A$" : "US$"}${price.amount.toFixed(2)}`}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">/ mo{price.gstIncluded ? " incl. GST" : " + GST"}</span>
      <Pencil className="h-2.5 w-2.5 text-muted-foreground/70 opacity-0 group-hover/price:opacity-100 transition-opacity ml-1" />
    </span>
  );
}

const EYEBROW_AVATAR_KEY = "claude-os.avatar.v1";
const OPERATOR_NAME_KEY = "claude-os.operator-name.v1";

function EyebrowAvatar() {
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      if (typeof window === "undefined") return null;
      try {
        return window.localStorage.getItem(EYEBROW_AVATAR_KEY);
      } catch {
        return null;
      }
    };
    setAvatar(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === EYEBROW_AVATAR_KEY || e.key === null) setAvatar(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  if (!avatar) return null;
  return (
    <img src={avatar} alt="" className="h-4 w-4 rounded-full object-cover ring-1 ring-border" />
  );
}

// Time-of-day greeting using the operator's name. Defaults to "Operator".
// Reads ~/.claude-os name from localStorage and re-renders on storage events
// so name changes from the wizard hit immediately.
function GreetingHeadline() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      if (typeof window === "undefined") return null;
      try {
        return window.localStorage.getItem(OPERATOR_NAME_KEY);
      } catch {
        return null;
      }
    };
    setName(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === OPERATOR_NAME_KEY || e.key === null) setName(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const trimmed = (name ?? "").trim();
  const firstName = trimmed ? trimmed.split(/\s+/)[0] : null;
  const hour = new Date().getHours();
  const slot =
    hour < 5
      ? "Up late"
      : hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening";
  return (
    <>
      {slot}
      {firstName ? `, ${firstName}.` : "."}
    </>
  );
}

function NowWorkingOn() {
  const projects = ld?.recentProjects;
  const top = Array.isArray(projects) && projects.length > 0 ? projects[0] : null;
  if (!top) return null;
  // If the last activity was over an hour ago, the emerald pulse misleads —
  // show a static amber dot instead. "Currently in" still refers to the
  // most-recent project, but the dot stops claiming live presence.
  const lastMs = Number(top.lastActiveMs);
  const isLive = Number.isFinite(lastMs) && lastMs > 0 && Date.now() - lastMs < 60 * 60 * 1000;
  return (
    <div className="ds-num inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <StatusDot tone={isLive ? "success" : "warn"} pulse={isLive} label="" />
      <span>Currently in</span>
      <span
        className="max-w-[24ch] truncate font-mono text-foreground"
        title={top.displayName ?? top.key}
      >
        {top.displayName ?? top.key}
      </span>
      <span className="text-muted-foreground/70">·</span>
      <span>{top.lastActiveAgo ?? "—"}</span>
      {Number.isFinite(top.sessions) && (
        <>
          <span className="text-muted-foreground/70">·</span>
          <span>
            {top.sessions} session{top.sessions === 1 ? "" : "s"}
          </span>
        </>
      )}
    </div>
  );
}
