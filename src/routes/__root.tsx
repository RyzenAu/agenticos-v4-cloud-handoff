import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import operatorCss from "../operator.css?url";
import { MessageSquare } from "lucide-react";
import { docTitle } from "@/components/shell/destinations";
import appCss from "../styles.css?url";
import { AppSidebar, MobileNav } from "@/components/app-sidebar";
// Overlays that poll the server start once the page's own data has arrived (shell/late.tsx).
import { Late, LateAccountsHub, LateFloatingOracle, SettleWatcher } from "@/components/shell/late";
import { JarvisChipSlot, openJarvisText } from "@/components/shell/jarvis-slot";
import { EARLY_REQUEST_TIMING_SCRIPT, InspectorDrawer, InspectorProvider } from "@/components/shell/inspector";
import { HeaderMore } from "@/components/shell/header-more";
import { HYDRATION_GUARD_SCRIPT, markHydrated } from "@/lib/hydration-click-guard";
import { LOAD_WATCHDOG_SCRIPT, clearLoadWatchdog } from "@/lib/load-watchdog";
import { installMotionGuards } from "@/lib/ui-motion";
import { useEffect } from "react";
import { Breadcrumb } from "@/components/shell/breadcrumb";
import { OperatorJobs } from "@/components/operator-jobs";
import { JarvisHudFloating } from "@/components/operator/jarvis-hud";
import { AgentLivePanel } from "@/components/operator/agent-live-panel";
import { ScreenShareControl } from "@/components/operator/screen-share-control";
import { MeetingModeControl, MeetingModePanel } from "@/components/operator/meeting-mode-hud";
import { ScreenDrivePill } from "@/components/operator/screen-drive-pill";
// Track 1: the ONE command palette (Ctrl/⌘K; CRM search is one of its sources) and the page-context API.
import { CommandPaletteButton, CommandPaletteHost } from "@/components/shell/command-palette";
import { PageContextShell } from "@/components/shell/page-context";
import { useKeyboardStart } from "@/components/shell/keyboard-start";
import { OfflineNotice, loadFailureCopy } from "@/components/shell/offline-notice";
import { PairingNotice } from "@/components/shell/pairing-notice";
import { CommandSceneHost } from "@/components/shell/command-scene/host";
// The Dot gateway's UI bundle only (no effect in the founders' app): founders-only requests answered as "not available to Dot".
import { DotGatewayNotice } from "@/components/shell/dot-gateway-notice";
import { installDotGatewayGuard } from "@/lib/dot-gateway";
installDotGatewayGuard();

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="text-6xl font-bold text-muted-foreground" aria-hidden="true">404</p>
        <h1 className="mt-4 text-2xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/business"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const failure = loadFailureCopy(error, typeof navigator === "undefined" ? true : navigator.onLine);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">{failure?.title ?? "Something went wrong"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{failure?.body ?? error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
        {failure && (
          <button onClick={() => router.history.back()} className="ml-2 mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium">
            Go back
          </button>
        )}
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: docTitle("/not-found") },
      {
        name: "description",
        content: "Your business, calendar, inbox and memory in one workspace.",
      },
      { property: "og:title", content: "Agentic OS" },
      { name: "twitter:title", content: "Agentic OS" },
      {
        property: "og:description",
        content: "Your business, calendar, inbox and memory in one workspace.",
      },
      {
        name: "twitter:description",
        content: "Your business, calendar, inbox and memory in one workspace.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      // Without a declared icon the browser asks for /favicon.ico and logs a 404 on every load.
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: operatorCss },
      // Design-system type pairing (docs/DESIGN-SYSTEM.md): Inter for the UI, JetBrains Mono
      // for code, IDs and tabular figures — self-hosted (@font-face in styles.css, files in
      // public/fonts), so first paint no longer waits 270–410 ms on fonts.googleapis.com.
      // Inter's Latin file paints the first frame of every page, so it is fetched up front.
      { rel: "preload", href: "/fonts/inter-latin.woff2", as: "font", type: "font/woff2", crossOrigin: "anonymous" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint — dark is the default. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("theme")!=="light")document.documentElement.classList.add("dark");document.documentElement.dataset.motion=localStorage.getItem("agentic.motion")==="ambient"&&!matchMedia("(prefers-reduced-motion: reduce)").matches?"ambient":"still"}catch(e){}',
          }}
        />
        {/* A click before hydration is queued and replayed once after it (src/lib/hydration-click-guard.ts);
            the resource-timing buffer is raised so the Inspector still sees /__* requests in dev.
            The server's copy is the one that runs; the client's serialisation can differ by a byte. */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: HYDRATION_GUARD_SCRIPT + EARLY_REQUEST_TIMING_SCRIPT + LOAD_WATCHDOG_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  // First effect after hydration commits: replay any click the hydration guard caught.
  useEffect(markHydrated, []);
  // R11: the app is running, so the "didn't finish loading" watchdog stands down.
  useEffect(clearLoadWatchdog, []);
  // One motion language (src/lib/ui-motion.ts): a hidden tab pauses every loop.
  useEffect(() => installMotionGuards(), []);
  useKeyboardStart();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const setupWorkspace = useRouterState({
    select: (state) => state.location.pathname === "/setup",
  });
  const websiteWorkspace = useRouterState({
    select: (state) => state.location.pathname === "/websites",
  });
  // The Jarvis HUD window: just the HUD, no shell (it lives in a small always-on-top window).
  const hudWindow = useRouterState({
    select: (state) => state.location.pathname === "/hud",
  });
  if (hudWindow)
    return (
      <QueryClientProvider client={queryClient}>
        <a href="#op-main-content" className="op-skip-link">Skip to content</a>
        {/* The HUD page is its own <main>: this is only the skip link's target. */}
        <div id="op-main-content" tabIndex={-1}>
          <Outlet />
        </div>
      </QueryClientProvider>
    );

  return (
    <QueryClientProvider client={queryClient}>
      <InspectorProvider>
        <SettleWatcher />
        <PageContextShell />
        <LateAccountsHub />
        {!setupWorkspace && (
          <Late triggers={["jarvis:hud-toggle"]}>
            <JarvisHudFloating />
          </Late>
        )}
        {!setupWorkspace && (
          <Late triggers={["jarvis:agent-feed"]}>
            <AgentLivePanel />
          </Late>
        )}
        <ScreenDrivePill />
        {setupWorkspace ? (
          <>
            <a href="#op-main-content" className="op-skip-link">Skip to content</a>
            <main id="op-main-content" tabIndex={-1} className="ws-fullscreen-route">
              <Outlet />
            </main>
          </>
        ) : (
          <div className="operator-shell flex min-h-screen w-full bg-background text-foreground">
            <a href="#op-main-content" className="op-skip-link">
              Skip to content
            </a>
            <AppSidebar />
            <div className="flex flex-1 min-w-0 flex-col">
              <OfflineNotice />
              <PairingNotice />
              <header className="sh-header sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:px-6">
                <div className="flex min-w-0 shrink items-center gap-2 text-sm">
                  <MobileNav />
                  <Breadcrumb />
                </div>
                <div className="flex min-w-0 shrink items-center gap-1 sm:gap-2">
                  <CommandPaletteButton />
                  {/* The one Jarvis entry on every page: live progress, click to talk. */}
                  <JarvisChipSlot />
                  <button
                    className="op-header-ask"
                    onClick={openJarvisText}
                    aria-label="Type a request"
                  >
                    <MessageSquare size={16} aria-hidden="true" />{" "}
                    <span className="hidden 2xl:inline">Type a request</span>
                  </button>
                  {/* Live state stays in the bar. Below md these live in the navigation drawer (MobileNav mirrors them). */}
                  <div className="hidden items-center gap-1 md:flex">
                    <ScreenShareControl />
                    <MeetingModeControl />
                  </div>
                  <MeetingModePanel />
                  <Late placeholder={<span className="sh-jobs-placeholder" aria-hidden="true" />}>
                    <OperatorJobs />
                  </Late>
                  {/* HUD, motion, Inspector and theme: one labelled menu instead of four small icons. */}
                  <HeaderMore />
                </div>
              </header>
              <div className="ar-workspace-layout">
                <main
                  id="op-main-content"
                  key={pathname}
                  className={websiteWorkspace ? "op-website-main flex-1 min-h-0" : "mo-enter flex-1 overflow-x-hidden p-4 md:p-6"}
                >
                  <DotGatewayNotice />
                  <Outlet />
                </main>
                <LateFloatingOracle enabled />
                <CommandPaletteHost />
                <CommandSceneHost />
              </div>
            </div>
            <InspectorDrawer />
          </div>
        )}
      </InspectorProvider>
    </QueryClientProvider>
  );
}
