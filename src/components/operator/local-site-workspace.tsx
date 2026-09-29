// The connected-localhost workspace that used to be the whole Website page: preview a site running on
// this PC at desktop/tablet/mobile sizes and hand its source-editing setup to an agent. Sales ->
// Website now opens it from a small "Connect a local site" box (src/routes/websites.tsx).
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  Globe2,
  Image,
  Loader2,
  Maximize2,
  Monitor,
  Palette,
  RefreshCw,
  Smartphone,
  Tablet,
  Type,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MobileNav } from "@/components/app-sidebar";

type Site = {
  url: string;
  title: string;
  folder: string | null;
  editorURL: string | null;
  embeddingWarning: string | null;
};
type Tab = "website" | "design" | "graphics" | "copy";
export const HISTORY_KEY = "website-os.connections.v1";
const MODELS = [
  {
    label: "Images",
    name: "Nano Banana 2",
    id: "nano-banana-2",
    detail: "1K default",
    Icon: Image,
  },
  {
    label: "Video",
    name: "Seedance 2 Fast",
    id: "byte-plus-seedance-2-fast",
    detail: "720p",
    Icon: Video,
  },
];
export function validLocal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function readHistory(): Site[] {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(items)
      ? items.filter((s) => validLocal(s?.url) && typeof s.title === "string").slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export function LocalSiteWorkspace({ startUrl, onExit }: { startUrl: string; onExit: () => void }) {
  const navigate = useNavigate();
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState(startUrl);
  const [site, setSite] = useState<Site | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState<Tab>("website");
  const [size, setSize] = useState({ width: 1440, height: 900 });
  const [scale, setScale] = useState(1);
  const [reload, setReload] = useState(0);
  const [folder, setFolder] = useState("");
  const [copied, setCopied] = useState(false);
  const [enablePanel, setEnablePanel] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setReady(true);
    void connect(startUrl);
    return () => request.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startUrl]);
  useEffect(() => {
    const sync = () => {
      if (!document.fullscreenElement) setFocused(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) setFocused(false);
    };
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const fit = () =>
      setScale(
        Math.max(
          0.1,
          Math.min(
            1,
            (element.clientWidth - 40) / size.width,
            (element.clientHeight - 36) / size.height,
          ),
        ),
      );
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [site, size, active, enablePanel]);

  async function connect(value = input) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/__website-os/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
        signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Start Agentic OS with bun run dev to connect a local website.");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not connect.");
      if (!validLocal(result.url) || (result.editorURL && !validLocal(result.editorURL)))
        throw new Error("The connection returned an invalid address.");
      const connected: Site = {
        url: result.url,
        title: String(result.title || new URL(result.url).host).slice(0, 180),
        folder: typeof result.folder === "string" ? result.folder : null,
        editorURL: result.editorURL || null,
        embeddingWarning: result.embeddingWarning || null,
      };
      setSite(connected);
      setFolder(connected.folder || "");
      setInput(connected.url);
      setActive("website");
      setEnablePanel(false);
      const history = [connected, ...readHistory().filter((s) => s.url !== connected.url)].slice(
        0,
        8,
      );
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      } catch {
        /* Usable with storage disabled. */
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function fullScreen() {
    if (focused) {
      if (document.fullscreenElement === container.current)
        await document.exitFullscreen().catch(() => {});
      setFocused(false);
    } else {
      setFocused(true);
      await container.current?.requestFullscreen?.().catch(() => {});
    }
  }
  function handoffText() {
    return `Use the Website OS skill bundled at skills/website-os/SKILL.md in this Agentic OS project. I want to enable source editing for my website.\n\nLocal preview URL: ${site?.url}\nProject folder: ${folder.trim() || "Ask me to choose the source folder before changing any files."}\n\nInspect that project's instructions, framework and source. Preserve its current design, assets and functionality. For a static HTML site, connect the Website OS field model and local editor using references/06-existing-homepage.md. For React/Vite or Next.js, preserve the framework and wire its actual content/components to the same preview, apply and undo workflow. Do not convert a framework app to static HTML.\n\nConnect Website, Design, Graphics and Copy to real source data. Show the exact files that save changes will affect. Keep drafts separate and let me review before applying edits. Generation must disclose OpenArt, the exact model and resolution before submission: Nano Banana 2 (nano-banana-2, 1K default) for images; Seedance 2 Fast (byte-plus-seedance-2-fast, 720p) for video. Use my own provider account and do not generate paid media during setup. Do not publish anything.\n\nRun the site, verify a real edit/save/undo cycle, and give me the localhost editor URL to connect here. Tell me which model you are using for this setup. If a framework needs a custom adapter, explain that rather than claiming it is already connected.`;
  }
  async function copySetup() {
    try {
      await navigator.clipboard.writeText(handoffText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(
        "Clipboard is unavailable. Use Open in agent to put the setup request into the composer.",
      );
    }
  }
  function openAgent() {
    try {
      sessionStorage.setItem("website-os.agent-request.v1", handoffText());
      void navigate({ to: "/" });
    } catch {
      setError("Session storage is unavailable. Copy the setup request instead.");
    }
  }
  const panel = site && !site.editorURL && (active !== "website" || enablePanel);
  const panelTitle =
    active === "design"
      ? "Connect your design system"
      : active === "graphics"
        ? "Your graphics, your models"
        : active === "copy"
          ? "Connect your website copy"
          : "Enable source editing";
  return (
    <div
      ref={container}
      className={`op-websites ${focused ? "fixed inset-0 z-50" : "h-[calc(100dvh-66px)]"} flex min-h-0 flex-col bg-[#eeeee8] text-[#262722]`}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[#d8d8ce] bg-[#f7f7f2] px-4">
        <div className="flex min-w-0 items-center gap-2.5 text-xs">
          {!focused && <MobileNav />}
          <Globe2 className="h-4 w-4 text-[#6d774c]" />
          <span className="hidden text-[#8a8c80] sm:inline">Agentic OS</span>
          <span className="hidden text-[#b9bbb0] sm:inline">/</span>
          <span className="font-medium">Website</span>
        </div>
        <button onClick={fullScreen} className="wos-c-button">
          {focused ? <ArrowLeft size={13} /> : <Maximize2 size={13} />}{" "}
          {focused ? "Back to OS" : "Full screen"}
        </button>
      </header>
      {site?.editorURL ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#dcddd2] px-4 text-[11px]">
            <span>Connected source editor · {new URL(site.editorURL).host}</span>
            <button
              className="underline underline-offset-4"
              onClick={() => {
                setSite(null);
                setEnablePanel(false);
                onExit();
              }}
            >
              Switch website
            </button>
          </div>
          <iframe
            title="Connected website editor"
            src={site.editorURL}
            allow="fullscreen; clipboard-write"
            allowFullScreen
            className="min-h-0 w-full flex-1 border-0"
          />
        </div>
      ) : (
        <>
          {site && (
            <div className="flex min-h-[70px] shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#d8d8ce] bg-[#fafaf7] px-6 py-3">
              <div className="flex items-center gap-3">
                <span className="border-r border-[#d9dbcf] pr-4 text-[30px] font-semibold leading-none tracking-[-4px]">
                  w.
                </span>
                <div className="text-[13px] font-medium">
                  Website
                  <small className="mt-0.5 block max-w-[190px] truncate text-[11px] font-normal tracking-wide text-[#8b8f80]">
                    {site ? new URL(site.url).host : "YOUR WEBSITE WORKSPACE"}
                  </small>
                </div>
              </div>
              {site ? (
                <nav aria-label="Website tools" className="flex gap-1 rounded-lg bg-[#efefe9] p-1">
                  {(["website", "design", "graphics", "copy"] as Tab[]).map((tab) => (
                    <button
                      key={tab}
                      aria-pressed={active === tab}
                      onClick={() => {
                        setActive(tab);
                        setEnablePanel(false);
                      }}
                      className={`rounded-md px-3 py-2 text-xs capitalize ${active === tab ? "bg-white shadow-sm" : "text-[#7a7d72]"}`}
                    >
                      {tab}
                    </button>
                  ))}
                </nav>
              ) : (
                <span className="hidden text-[11px] text-[#858b77] sm:block">
                  A familiar home for every website.
                </span>
              )}
              {site && (
                <button
                  className="wos-c-button"
                  onClick={() => {
                    setSite(null);
                    setError("");
                    onExit();
                  }}
                >
                  Switch website
                </button>
              )}
            </div>
          )}
          {!site ? (
            <div className="wos-c-grid flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-md text-center">
                {error ? (
                  <>
                    <p role="alert" className="rounded-lg border border-[#e3c7ba] bg-[#fff4eb] p-3 text-xs text-[#915539]">
                      {error}
                    </p>
                    <div className="mt-4 flex justify-center gap-2">
                      <button className="wos-c-button" onClick={onExit}>
                        <ArrowLeft size={13} /> Back to websites
                      </button>
                      <button className="wos-c-primary" disabled={busy} onClick={() => void connect(input)}>
                        <RefreshCw size={13} /> Try again
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="inline-flex items-center gap-2 text-xs text-[#858b77]">
                    <Loader2 size={14} className="animate-spin" /> Opening {input}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#d9ddcf] px-4 py-2.5">
                  <div className="flex gap-1" role="group" aria-label="Preview size">
                    {[
                      { label: "Desktop", width: 1440, height: 900, Icon: Monitor },
                      { label: "Tablet", width: 768, height: 1024, Icon: Tablet },
                      { label: "Mobile", width: 390, height: 844, Icon: Smartphone },
                    ].map(({ label, width, height, Icon }) => (
                      <button
                        key={label}
                        aria-pressed={size.width === width && size.height === height}
                        onClick={() => setSize({ width, height })}
                        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${size.width === width && size.height === height ? "bg-[#e0e5d5]" : "text-[#8b907e]"}`}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-[#858d76]">
                    <input
                      type="number"
                      min="320"
                      max="2560"
                      value={size.width}
                      aria-label="Preview width"
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (n >= 320 && n <= 2560) setSize({ ...size, width: n });
                      }}
                      className="w-[55px] rounded border border-[#d6ddc9] bg-white px-1.5 py-1"
                    />
                    × {size.height}
                    <button
                      title="Rotate preview"
                      aria-label="Rotate preview"
                      onClick={() => setSize({ width: size.height, height: size.width })}
                      className="p-1"
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      title="Reload preview"
                      aria-label="Reload preview"
                      onClick={() => setReload((n) => n + 1)}
                      className="p-1"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>
                {site.embeddingWarning && (
                  <div
                    role="status"
                    className="border-b border-[#ddd9bb] bg-[#f4f0d9] px-4 py-2 text-xs text-[#8c7a40]"
                  >
                    {site.embeddingWarning}{" "}
                    <a href={site.url} target="_blank" rel="noreferrer" className="underline">
                      Open website
                    </a>
                  </div>
                )}
                <div
                  ref={stage}
                  className="wos-c-grid relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
                >
                  <div
                    className="relative overflow-hidden rounded-md border border-[#d6d9cc] bg-white shadow-[0_10px_35px_#38442109]"
                    style={{ width: size.width * scale, height: size.height * scale }}
                  >
                    <iframe
                      key={`${site.url}:${size.width}:${size.height}:${reload}`}
                      title="Your local website preview"
                      src={site.url}
                      style={{
                        width: size.width,
                        height: size.height,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                      }}
                      className="border-0"
                    />
                  </div>
                </div>
                <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-[#d9ddcf] px-4 text-[11px] text-[#8a927b]">
                  <span>Connected preview · {Math.round(scale * 100)}% fit</span>
                  <button
                    className="underline underline-offset-4"
                    onClick={() => {
                      setActive("website");
                      setEnablePanel(true);
                    }}
                  >
                    Enable editing <ArrowRight size={10} className="inline" />
                  </button>
                </div>
              </div>
              {panel && (
                <aside className="flex w-[340px] max-w-[88vw] shrink-0 flex-col border-l border-[#d7ddc9] bg-[#fafbf6] max-lg:absolute max-lg:inset-y-[122px] max-lg:right-0 max-lg:z-20 max-lg:shadow-xl">
                  <div className="flex items-start justify-between border-b border-[#dce1d2] px-6 py-6">
                    <div>
                      <span className="text-[11px] uppercase tracking-[.13em] text-[#929a81]">
                        Your website / {active}
                      </span>
                      <h2 className="mt-3 text-[22px] leading-tight tracking-[-.7px]">
                        {panelTitle}
                      </h2>
                    </div>
                    <button
                      aria-label="Close panel"
                      onClick={() => {
                        setActive("website");
                        setEnablePanel(false);
                      }}
                      className="p-1 text-[#8a9477]"
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
                    <p className="text-xs leading-6 text-[#7c866c]">
                      {active === "design"
                        ? "Your colours and typography need to be linked to the actual CSS and components before they can save."
                        : active === "copy"
                          ? "Connect the page's real headings and text to review copy, SlopMonster rewrites and SEO changes before applying them."
                          : active === "graphics"
                            ? "Connect the real image and video slots to replace media, generate alternatives and restore originals."
                            : "Let your coding agent connect this preview to its source folder. Then your changes can save to the actual project."}
                    </p>
                    {active === "graphics" && (
                      <div className="mt-5 space-y-3">
                        {MODELS.map(({ label, name, id, detail, Icon }) => (
                          <div key={id} className="rounded-lg border border-[#dce2d0] bg-white p-4">
                            <span className="flex items-center gap-2 text-[11px] text-[#8b9678]">
                              <Icon size={13} />
                              {label} · OpenArt
                            </span>
                            <strong className="mt-2 block text-sm font-medium">
                              {name} · {detail}
                            </strong>
                            <code className="mt-1 block break-all text-[11px] text-[#8b937d]">
                              {id}
                            </code>
                          </div>
                        ))}
                        <p className="text-[11px] leading-5 text-[#959c88]">
                          Uses your connected OpenArt account and credits. You choose when to
                          generate. Alternatives are reviewed before saving.
                        </p>
                      </div>
                    )}
                    <label
                      className="mt-6 block text-[11px] text-[#89957a]"
                      htmlFor="source-folder"
                    >
                      Project folder {site.folder ? "· detected" : "· optional until setup"}
                    </label>
                    <input
                      id="source-folder"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      maxLength={1024}
                      placeholder="Path to your website project"
                      className="mt-2 w-full rounded-md border border-[#d7dfca] bg-white px-3 py-2.5 text-[11px] outline-[#8c9f71]"
                    />
                    <div className="mt-5 rounded-lg border border-[#dce3ce] bg-[#f0f3e8] p-4">
                      <p className="text-[11px] font-medium">Your agent, your model.</p>
                      <p className="mt-2 text-[11px] leading-5 text-[#899479]">
                        The OS composer shows the coding model and provider before you send. This
                        setup request does not run automatically or generate media.
                      </p>
                    </div>
                    {error && (
                      <p role="alert" className="mt-3 text-xs text-[#965435]">
                        {error}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2 border-t border-[#dce1d2] px-6 py-5">
                    <button onClick={openAgent} className="wos-c-primary w-full justify-center">
                      Open in agent <ArrowRight size={13} />
                    </button>
                    <button
                      onClick={() => void copySetup()}
                      className="wos-c-button w-full justify-center"
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}{" "}
                      {copied ? "Copied" : "Copy setup request"}
                    </button>
                    <p className="pt-1 text-center text-[11px] leading-4 text-[#959d88]">
                      Review the request, choose your model, then send.
                    </p>
                  </div>
                </aside>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
