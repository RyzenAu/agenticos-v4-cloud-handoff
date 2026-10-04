// The OS's main navigation: nine destinations (R12: Departments added; Memory, Studio and System fold under "More") built from the existing routes. Every routable
// page has exactly one home here; detail pages are drilldowns of a destination, never a ninth
// top-level item. Old URLs keep working (they are the drilldowns); only `/` and `/workspace`
// redirect, to Today. Map and rationale: docs/design-20260927/BRIEF.md.
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AudioLines,
  BookMarked,
  Bot,
  BrainCircuit,
  Briefcase,
  Building2,
  CalendarDays,
  Clapperboard,
  Cpu,
  Film,
  FolderKanban,
  Gauge,
  Globe2,
  Handshake,
  Inbox,
  Landmark,
  ListChecks,
  Map as MapIcon,
  Monitor,
  MessageSquare,
  Network,
  Orbit,
  Palette,
  PhoneCall,
  Receipt,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Home,
  Target,
  Users,
  UsersRound,
  Wallet,
  Wand2,
  Workflow,
} from "lucide-react";

export type DestinationId = "today" | "jarvis" | "departments" | "receptionist" | "work" | "memory" | "finance" | "studio" | "system";

export type Drilldown = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** A Business page tab reached as `/business?view=…`. */
  view?: "finance" | "progress" | "audience";
  /** Only listed while this settings toggle is on (the page itself stays reachable). */
  setting?: "openclaw" | "mission";
  /** One line: what the page is for. Shown on the destination's landing page. */
  purpose: string;
};

export type Destination = {
  id: DestinationId;
  /** R12: listed under the sidebar's "More" until you are inside it (rarely used; keeps the main list short). */
  more?: boolean;
  label: string;
  icon: LucideIcon;
  /** The landing route. */
  to: string;
  /** One line under the page title. */
  purpose: string;
  drilldowns: Drilldown[];
  /** Other paths (and their children) that belong here without being listed. */
  alsoMatches?: string[];
};

export const DESTINATIONS: readonly Destination[] = [
  {
    // Home (29 Sep 2026, owner): Today merged into the Business brief, which is the landing page.
    // The id stays "today" so existing references keep working.
    id: "today",
    label: "Home",
    icon: Home,
    to: "/business",
    purpose: "What needs you now, then the business at a glance: finance, progress and audience.",
    drilldowns: [
      { to: "/inbox", label: "Inbox", icon: Inbox, purpose: "Every channel, triaged. Reply to what needs you." },
      { to: "/inbox-triage", label: "Inbox triage", icon: ShieldCheck, purpose: "Today's triage log and the Jev shadow review. Read-only." },
      { to: "/calendar", label: "Calendar", icon: CalendarDays, purpose: "Schedule and meeting prep." },
      { to: "/business", view: "audience", label: "Audience", icon: UsersRound, purpose: "Followers and content by platform." },
    ],
    alsoMatches: ["/today", "/workspace"],
  },
  {
    id: "jarvis",
    label: "Jarvis",
    icon: AudioLines,
    to: "/jarvis",
    purpose: "Give your assistant a task by voice or text.",
    drilldowns: [
      { to: "/chat", label: "Chat", icon: MessageSquare, purpose: "Typed conversations and history." },
      { to: "/agents/workspace", label: "Agents", icon: UsersRound, purpose: "Pick an agent (Research, Builder): chat, its computer, its tasks and files, its setup." },
      { to: "/agents/hermes", label: "Hermes", icon: Bot, purpose: "The executor: sessions, skills, missions and models." },
      { to: "/agents/claude-code", label: "Claude Code", icon: SquareTerminal, purpose: "Claude Code sessions on this PC. Agent jobs live under Work." },
      { to: "/automations", label: "Automations", icon: Workflow, purpose: "Scheduled jobs: failing first." },
      { to: "/activity", label: "Activity", icon: Activity, purpose: "What agents did, in order." },
      { to: "/dashboard", label: "Mission Control", icon: Orbit, setting: "mission", purpose: "The older all-in-one dashboard: spend, agents and activity." },
    ],
    alsoMatches: ["/hud"],
  },
  {
    // R12 (4 Oct 2026): the AI departments under Jarvis, each with its agents, work queue, hand-offs and saved results.
    id: "departments",
    label: "Departments",
    icon: Building2,
    to: "/departments",
    purpose: "Each department's agents, work, hand-offs and results.",
    drilldowns: [],
  },
  {
    id: "receptionist",
    label: "Receptionist",
    icon: PhoneCall,
    to: "/receptionist",
    purpose: "Calls, clients and launch readiness.",
    drilldowns: [
      { to: "/operations", label: "Packages & economics", icon: Receipt, purpose: "Package prices, margins, receipts and delivery checks." },
    ],
  },
  {
    id: "work",
    label: "Work",
    icon: Briefcase,
    to: "/work",
    purpose: "Approvals, calls, pipeline, sites and projects.",
    drilldowns: [
      { to: "/leads", label: "Leads", icon: Users, purpose: "Calls to make and the pipeline." },
      { to: "/crm", label: "CRM", icon: Handshake, purpose: "Clients, deals, follow-ups and delivery." },
      { to: "/websites", label: "Websites", icon: Globe2, purpose: "Live sites, flagships, previews and drafts." },
      { to: "/business", view: "progress", label: "Goals", icon: Target, purpose: "Goals and progress against them." },
      { to: "/workspaces", label: "Workspaces", icon: FolderKanban, purpose: "M&U Ventures, Receptionist and Websites, each with its projects." },
      { to: "/coding", label: "Coding", icon: SquareTerminal, purpose: "Agent coding jobs: plan, changes, tests, review, approvals." },
    ],
  },
  {
    id: "memory",
    more: true,
    label: "Memory",
    icon: BrainCircuit,
    to: "/memory",
    purpose: "The vault, its sources, search and corrections.",
    drilldowns: [
      { to: "/memory/vault", label: "Vault", icon: BookMarked, purpose: "Curated facts with sources: search, correct, forget." },
      { to: "/memory-map", label: "Memory map", icon: MapIcon, purpose: "Where each kind of memory lives." },
      { to: "/codegraph", label: "Knowledge graph", icon: Network, purpose: "Code and document graph." },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    icon: Wallet,
    to: "/finance",
    purpose: "Cash, invoices, costs and margins.",
    drilldowns: [
      { to: "/business", view: "finance", label: "Finances", icon: Landmark, purpose: "Stripe revenue and the finance snapshot." },
      { to: "/usage", label: "AI usage & spend", icon: Gauge, purpose: "Plan limits and AUD spend for every AI account." },
    ],
  },
  {
    id: "studio",
    more: true,
    label: "Studio",
    icon: Clapperboard,
    to: "/studio",
    purpose: "Proposals, decks, videos, scripts and assets.",
    drilldowns: [
      { to: "/design", label: "Design", icon: Palette, purpose: "Image and video generation, brands and the media ledger." },
      { to: "/motion", label: "Motion Library", icon: Film, purpose: "Reusable motion styles." },
      { to: "/transitions", label: "Transition lab", icon: Sparkles, purpose: "Transition experiments." },
      // Behind the same Settings switch as Mission Control (audit S15): a card of subscription ROI built from sample numbers is not part of the everyday OS.
      { to: "/share", label: "Share card", icon: Share2, setting: "mission", purpose: "A shareable card of your stack." },
    ],
  },
  {
    id: "system",
    more: true,
    label: "System",
    icon: Cpu,
    to: "/system",
    purpose: "Models, tools, devices, usage and diagnostics.",
    drilldowns: [
      { to: "/models", label: "Models", icon: Cpu, purpose: "Every model route: free, subscription or metered, health, usage, cost and failures." },
      { to: "/computers", label: "Computers", icon: Monitor, purpose: "Your paired PCs and the shared computers agents work on: state, who controls them, what they do." },
      { to: "/skills", label: "Skills", icon: Wand2, purpose: "Installed skills and what they do." },
      { to: "/skill-drafts", label: "Skill drafts", icon: ListChecks, purpose: "Skills waiting for review." },
      { to: "/settings", label: "Settings", icon: Settings, purpose: "Profile, connections and preferences." },
      // Moved from Jarvis (29 Sep 2026): OpenClaw is a device connection, not something he talks to.
      { to: "/agents/openclaw", label: "OpenClaw", icon: Bot, setting: "openclaw", purpose: "The phones and relay devices OpenClaw links." },
    ],
    alsoMatches: ["/setup"],
  },
];

export const DESTINATION_BY_ID = Object.fromEntries(DESTINATIONS.map((d) => [d.id, d])) as Record<DestinationId, Destination>;

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Which destination (and drilldown) a location belongs to. Unknown paths belong to none. */
export function locate(pathname: string, view?: string): { destination: Destination; drilldown: Drilldown | null } | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { destination: DESTINATION_BY_ID.today, drilldown: null };
  // A view-specific Business tab wins over the plain /business drilldown.
  if (path === "/business" && (view === "finance" || view === "progress" || view === "audience")) {
    for (const destination of DESTINATIONS) {
      const drilldown = destination.drilldowns.find((d) => d.to === "/business" && d.view === view);
      if (drilldown) return { destination, drilldown };
    }
  }
  for (const destination of DESTINATIONS) {
    const drilldown = destination.drilldowns.find((d) => !d.view && under(path, d.to));
    if (drilldown) return { destination, drilldown };
  }
  for (const destination of DESTINATIONS) {
    if (under(path, destination.to) || destination.alsoMatches?.some((p) => under(path, p))) return { destination, drilldown: null };
  }
  return null;
}

/** Drilldowns shown for the current settings (OpenClaw / Mission Control follow their toggles). */
export function visibleDrilldowns(destination: Destination, settings: Partial<Record<"openclaw" | "mission", unknown>>) {
  return destination.drilldowns.filter((d) => !d.setting || !!settings[d.setting]);
}

/**
 * activeOptions for every sidebar <Link>. The router marks a link active (and sets aria-current)
 * on its own; by default it matches path prefixes and partial search, so "/business" with no view
 * also matched "/business?view=progress" and both Business brief and Goals carried aria-current
 * (audit F1-20). Exact matching leaves `locate` as the one judge of which entry is current.
 */
export const NAV_ACTIVE_OPTIONS = { exact: true, includeSearch: true } as const;

/** href for a drilldown, matching what <Link to search> renders. */
export function drilldownHref(d: Pick<Drilldown, "to" | "view">) {
  return d.view ? `${d.to}?view=${d.view}` : d.to;
}

// --- one name per page ------------------------------------------------------------------------------------
// The sidebar labels above ARE the names. Browser tab titles, page headings, breadcrumbs, the palette and the
// Settings links all read them through pageName(), so one page can't have three names (audit P2-1).
export const OS_NAME = "Agentic OS";

/** Pages that are not navigation entries, and the /business tabs. */
export const EXTRA_PAGE_NAMES: Readonly<Record<string, string>> = {
  "/setup": "Setup",
  "/hud": "Jarvis HUD",
  "/coding/job": "Coding job",
  "/workspaces/detail": "Workspace",
  "/not-found": "Page not found",
};

/** Canonical name of the page at `path` (with the /business `view`, when there is one). */
export function pageName(path: string, view?: string | null): string {
  const key = `${path}${view ? `?view=${view}` : ""}`;
  if (EXTRA_PAGE_NAMES[key]) return EXTRA_PAGE_NAMES[key];
  if (EXTRA_PAGE_NAMES[path]) return EXTRA_PAGE_NAMES[path];
  const here = locate(path, view ?? undefined);
  if (!here) return OS_NAME;
  return here.drilldown?.label ?? here.destination.label;
}

/** Browser tab title: one pattern for every page, "Name — Agentic OS". */
export function docTitle(pathOrName: string, view?: string | null): string {
  const name = pathOrName.startsWith("/") ? pageName(pathOrName, view) : pathOrName;
  return `${name} — ${OS_NAME}`;
}

/** The drilldown for a route (its label and one purpose line): Settings shows the same words as the sidebar. */
export function drilldownFor(to: string): Drilldown | undefined {
  for (const d of DESTINATIONS) {
    const found = d.drilldowns.find((x) => x.to === to && !x.view);
    if (found) return found;
  }
  return undefined;
}

/** Pages removed from the top level and where they went, for the brief and the redirect test. */
export const REDIRECTS: Readonly<Record<string, string>> = { "/": "/business", "/today": "/business", "/workspace": "/business" };
