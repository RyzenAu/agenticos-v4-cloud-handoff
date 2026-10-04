import { useWorkspaceProfile } from "@/lib/workspace-profile";
import "./operator/workspace-settings.css";
const defaultAvatar = "/operator-avatar.svg";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowUpRight, AudioLines, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useOperator } from "@/lib/operator";
import { useWorkspacePanel } from "@/components/workspace/api";
import { useHydrated } from "@/lib/use-hydrated";
import { sidebarBadge } from "../../scripts/workspace/needs-you";
import "./operator/brand-refinements.css";
import "./operator/sidebar-profile.css";
import "./operator/sidebar-nav.css";
import "./shell/shell.css";

import { ScreenShareControl } from "./operator/screen-share-control";
import { MeetingModeControl } from "./operator/meeting-mode-hud";
import { JarvisHudToggle } from "./operator/jarvis-hud";
import { ThemeToggle } from "@/components/theme-toggle";
import { DESTINATIONS, NAV_ACTIVE_OPTIONS, drilldownHref, locate, visibleDrilldowns, type Destination } from "./shell/destinations";
import { guardDoubleClick } from "./shell/double-click";
import { useSignedIn } from "./shell/signed-in";

// Eight destinations (docs/design-20260927/BRIEF.md). The destination you're in opens to show its
// drilldowns; the others stay one line each, so the whole nav fits a laptop screen without folds.
// On desktop the sidebar can collapse to an icon rail (remembered per browser).

const RAIL_KEY = "agentic-os.sidebar-rail.v1";

export function useSidebarRail(): [boolean, () => void] {
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try {
      setRail(localStorage.getItem(RAIL_KEY) === "1");
    } catch {
      /* default: expanded */
    }
  }, []);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-sidebar-rail", rail);
  }, [rail]);
  const toggle = () =>
    setRail((v) => {
      try {
        localStorage.setItem(RAIL_KEY, v ? "0" : "1");
      } catch {
        /* not persisted */
      }
      return !v;
    });
  return [rail, toggle];
}

/**
 * The Today badge: the server's ONE "needs you" count (scripts/workspace/needs-you.ts), the same
 * number Today's "Waiting on you" tile and the Jarvis HUD show. "12+" when a source couldn't be
 * read (a lower bound, never a zero); nothing at all while it's unknown.
 */
function useNeedsYou() {
  const query = useWorkspacePanel("needsYou");
  // Nothing until hydrated, like the server render (merge review U1).
  const hydrated = useHydrated();
  const panel = hydrated && query.data?.ok ? query.data.data : null;
  return sidebarBadge({
    loading: !hydrated || query.isLoading,
    failed: hydrated && (query.isError || (query.data !== undefined && !query.data.ok)),
    panel,
  });
}

function SidebarBody({ onNavigate, rail = false, onToggleRail }: { onNavigate?: () => void; rail?: boolean; onToggleRail?: () => void }) {
  const { profile } = useWorkspaceProfile();
  // The signed-in person (V7): shown instead of a typed profile name whenever the server knows it.
  const signedIn = useSignedIn();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const view = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown> | undefined)?.view;
      return typeof v === "string" ? v : undefined;
    },
  });
  const { state } = useOperator();
  const [name, setName] = useState("Operator");
  const [avatar, setAvatar] = useState(defaultAvatar);
  const needsYou = useNeedsYou();
  const navRef = useRef<HTMLElement>(null);
  const lastNavClick = useRef(0);
  useEffect(() => {
    const update = () => {
      try {
        const savedName = localStorage.getItem("claude-os.operator-name.v1")?.trim();
        setName(savedName && savedName.toLowerCase() !== "operator" ? savedName : "Operator");
        const savedAvatar = localStorage.getItem("claude-os.avatar.v1");
        setAvatar(savedAvatar?.startsWith("data:image/") ? savedAvatar : defaultAvatar);
      } catch {
        setName("Operator");
        setAvatar(defaultAvatar);
      }
    };
    update();
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  // The Business page reads its tab from ?view= (audit F1-21), so a drilldown link is enough.
  const here = locate(path, view);
  const destinationLink = (d: Destination) => {
    const inside = here?.destination.id === d.id;
    const onLanding = inside && !here?.drilldown;
    // Zero shows no badge; unknown shows a muted "?" (never nothing, never a zero).
    const view = d.id === "today" ? needsYou : null;
    const badge = view?.text ?? null;
    const badgeLabel = view?.label ?? "";
    const drilldowns = visibleDrilldowns(d, state.settings);
    return (
      <li key={d.id} className="sh-dest" data-inside={inside || undefined}>
        <Link
          to={d.to as never}
          onClick={onNavigate}
          activeOptions={NAV_ACTIVE_OPTIONS}
          className={`op-nav-link sh-dest-link${inside ? " active" : ""}`}
          aria-current={onLanding ? "page" : undefined}
          aria-label={rail ? `${d.label}${badge ? `, ${badgeLabel}` : ""}` : undefined}
          title={rail ? d.label : undefined}
        >
          <d.icon size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="sh-rail-hide">{d.label}</span>
          {badge && (
            <b className="sh-rail-dot" aria-label={rail ? undefined : badgeLabel} title={badgeLabel} data-unknown={view?.unknown || undefined}>
              <span className="sh-rail-hide">{badge}</span>
            </b>
          )}
        </Link>
        {inside && !rail && drilldowns.length > 0 && (
          <ul className="sh-drill" aria-label={`${d.label} pages`}>
            {drilldowns.map((dd) => {
              const active = here?.drilldown === dd;
              return (
                <li key={drilldownHref(dd)}>
                  <Link
                    to={dd.to as never}
                    search={(dd.view ? { view: dd.view } : dd.to === "/business" ? {} : undefined) as never}
                    onClick={onNavigate}
                    activeOptions={NAV_ACTIVE_OPTIONS}
                    className={`sh-drill-link${active ? " active" : ""}`}
                    aria-current={active ? "page" : undefined}
                  >
                    {dd.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };
  return (
    <div className="op-sidebar-inner sh-sidebar-inner">
      <div className="sh-brand-row">
        <Link to="/business" className="op-brand ar-brand-refined" onClick={onNavigate} aria-label="Agentic OS, Home">
          {/* A single fixed mark (audit P1-6): the M&U gold rotated square (muv-marketing icon.svg). */}
          <span className="op-brand-symbol sh-mu-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" fill="currentColor" />
            </svg>
          </span>
          <span className="sh-rail-hide sh-wordmark">
            <small className="sh-wordmark-eyebrow">M&amp;U Ventures</small>
            <span className="whitespace-nowrap">
              Agentic<span className="op-brand-os"> OS</span>
            </span>
          </span>
        </Link>
        {onToggleRail && (
          <button
            type="button"
            className="sh-rail-toggle"
            onClick={onToggleRail}
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={rail}
            title={rail ? "Expand sidebar" : "Collapse sidebar"}
          >
            {rail ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          </button>
        )}
      </div>
      <nav className="op-sidebar-nav sh-nav" aria-label="Main" ref={navRef} onClickCapture={(e) => guardDoubleClick(e, lastNavClick)}>
        <ul>{DESTINATIONS.map(destinationLink)}</ul>
      </nav>
      <div className="op-sidebar-bottom">
        {/* R11: the pairing banner at the top of every page already says "Confirm this browser" with the link; no second copy here. */}
        <Link
          to="/settings"
          hash="personal-profile"
          onClick={onNavigate}
          className="op-identity ar-sidebar-profile"
          aria-label={`${signedIn?.name || profile.name || name}, ${signedIn ? "signed in" : "personal profile"}`}
          title={rail ? `${signedIn?.name || profile.name || name}: ${signedIn ? "signed in" : "personal profile"}` : undefined}
        >
          <img src={profile.avatar || avatar} alt="" width={36} height={36} onError={() => setAvatar(defaultAvatar)} />
          <div className="sh-rail-hide">
            {signedIn?.name || profile.name || name}
            <small>{signedIn ? "Signed in · profile" : "Personal profile"}</small>
          </div>
          <ArrowUpRight size={14} aria-hidden="true" className="sh-rail-hide" />
        </Link>
      </div>
    </div>
  );
}

export function AppSidebar() {
  const [rail, toggleRail] = useSidebarRail();
  return (
    <aside className="op-sidebar sh-sidebar hidden lg:flex" data-rail={rail || undefined}>
      <SidebarBody rail={rail} onToggleRail={toggleRail} />
    </aside>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button className="lg:hidden op-icon-button shrink-0" aria-label="Open navigation">
          <Menu size={20} />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[288px] max-w-[85vw] p-0 flex flex-col" aria-describedby={undefined} aria-label="Navigation">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SidebarBody onNavigate={() => setOpen(false)} />
        </div>
        {/* The header's Share, Meeting, HUD and theme controls live only in the desktop header;
        mirrored here so the drawer isn't a dead end for them on mobile. */}
        <div className="op-drawer-actions">
          <button
            type="button"
            className="op-header-ask"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("operator:voice"));
            }}
          >
            <AudioLines size={15} aria-hidden="true" /> Voice
          </button>
          <ScreenShareControl labels="always" />
          <MeetingModeControl labels="always" />
          <JarvisHudToggle />
          <ThemeToggle />
        </div>
      </SheetContent>
    </Sheet>
  );
}
