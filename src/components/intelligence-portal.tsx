import { useCallback, useEffect, useRef, useState } from "react";
import { X, Mic, MicOff, Square, Send, Settings2, Play, Keyboard, Zap, Loader2 } from "lucide-react";
import { HermesMind3D, CL, type CoreMode } from "@/components/hermes-mind-3d";
import { OraclePlasma } from "@/components/oracle-plasma";
import { OracleSonar } from "@/components/oracle-sonar";
import { OracleWaveform } from "@/components/oracle-waveform";
import { OracleRider } from "@/components/oracle-rider";
import { StageAurora } from "@/components/stage-aurora";
import { StageCosmos } from "@/components/stage-cosmos";
import { SyntheticVoice } from "@/lib/synthetic-voice";
import hermesAvatar from "@/assets/hermes-portrait-v2.png";
import { cn } from "@/lib/utils";
import { Badge, BrandMark, Button, Notice, Segmented, Surface, StatusDot } from "@/components/ds";
import { providerModelId } from "../../scripts/model-router/catalogue";

// Oracle/Stage visual props still take raw hex — they colour the WebGL/canvas
// content of the mind visualisation itself (docs/DESIGN-SYSTEM.md § 8 exempts a
// 3D scene's own rendering), not this file's DOM chrome, which now runs on ds tokens.
const VOICE_TOKEN_URL = "http://localhost:8099/api/session";

export type IntelState = "idle" | "thinking" | "responding";
export type AppKey = string;
export type ActivityEvent = { id: string; app: AppKey; status: "running" | "done" | "error"; detail?: string; result?: string; error?: string };

// Inline brand marks for integrations missing from the icon set, so they never fall back to text
const LINKEDIN = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:100%;height:100%"><path d="M4.98 3.5A2.5 2.5 0 1 1 2.5 6 2.5 2.5 0 0 1 4.98 3.5zM2.85 8.98h4.2v12.5h-4.2zM9.3 8.98h4.02v1.71h.06a4.4 4.4 0 0 1 3.96-2.18c4.24 0 5.02 2.79 5.02 6.42v6.55h-4.18v-5.8c0-1.39-.03-3.17-1.93-3.17s-2.23 1.51-2.23 3.07v5.9H9.3z"/></svg>`;
const CLAY = `<svg viewBox="0 0 24 24" style="width:100%;height:100%"><path d="M3 16a9 9 0 0 1 18 0z" fill="currentColor"/></svg>`;

type IconDef = { face?: boolean; lucide?: any; slug?: string; domain?: string; glyph?: string; color: string; letter: string };
// brands → real favicon (true colours + white parts) on a light tile
// concepts (Hermes's OWN native powers) → the Hermes face, ringed in its cluster colour — so they sit as medallions next to the brand logos
const ICONS: Record<string, IconDef> = {
  github: { domain: "github.com", color: "#FFFFFF", letter: "GH" },
  reddit: { domain: "reddit.com", color: "#ff4500", letter: "R" },
  linkedin: { domain: "linkedin.com", color: "#0a66c2", letter: "in" },
  x: { domain: "x.com", color: "#FFFFFF", letter: "X" },
  clay: { domain: "clay.com", color: "#FFD21E", letter: "Cl" },
  web: { face: true, color: "#60a5fa", letter: "W" },
  youtube: { domain: "youtube.com", color: "#ff3b3b", letter: "YT" },
  notion: { domain: "notion.so", color: "#FFFFFF", letter: "N" },
  drive: { domain: "drive.google.com", color: "#46e0a0", letter: "Dr" },
  obsidian: { domain: "obsidian.md", color: "#a78bfa", letter: "Ob" },
  supabase: { domain: "supabase.com", color: "#3ecf8e", letter: "Sb" },
  granola: { domain: "granola.ai", color: "#FFE6CB", letter: "Gr" },
  memory: { face: true, color: "#ff9da7", letter: "M" },
  pinecone: { domain: "pinecone.io", color: "#ff9da7", letter: "Pc" },
  claude: { domain: "claude.ai", color: "#ff8a3c", letter: "Cl" },
  gemini: { domain: "gemini.google.com", color: "#60a5fa", letter: "Gm" },
  codex: { domain: "openai.com", color: "#FFFFFF", letter: "AI" },
  agents: { face: true, color: "#b9a6ff", letter: "Ag" },
  writing: { face: true, color: "#ff5a7a", letter: "Wr" },
  elevenlabs: { domain: "elevenlabs.io", color: "#FFFFFF", letter: "11" },
  higgsfield: { domain: "higgsfield.ai", color: "#c8ff00", letter: "Hg" },
  notebooklm: { domain: "notebooklm.google.com", color: "#60a5fa", letter: "NB" },
  telegram: { domain: "telegram.org", color: "#2aabee", letter: "Tg" },
  email: { glyph: `<svg viewBox="0 0 24 24" fill="#EA4335" style="width:100%;height:100%"><path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>`, color: "#EA4335", letter: "@" },
  calendar: { glyph: `<svg viewBox="0 0 24 24" fill="#4285F4" style="width:100%;height:100%"><path d="M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z"/></svg>`, color: "#4285F4", letter: "Ca" },
  slack: { domain: "slack.com", color: "#e8d7c8", letter: "Sl" },
  code: { face: true, color: "#ff8a3c", letter: "</>" },
  cron: { face: true, color: "#ff8a3c", letter: "Cr" },
  n8n: { domain: "n8n.io", color: "#ea4b71", letter: "n8" },
  zapier: { domain: "zapier.com", color: "#ff4f00", letter: "Z" },
  mcp: { face: true, color: "#ff8a3c", letter: "MCP" },
  skills: { face: true, color: "#ff8a3c", letter: "Sk" },
};

const CLUSTER_CAPS: Record<string, string[]> = {
  research: ["github", "reddit", "linkedin", "x", "clay", "web", "youtube"],
  knowledge: ["notion", "drive", "obsidian", "supabase", "granola"],
  memory: ["memory", "pinecone"],
  thinking: ["claude", "gemini", "codex", "agents"],
  creation: ["writing", "elevenlabs", "higgsfield", "notebooklm"],
  comms: ["telegram", "email", "calendar", "slack"],
  action: ["code", "cron", "n8n", "zapier", "mcp", "skills"],
};
const CLUSTER_OF: Record<string, string> = {};
for (const [cl, caps] of Object.entries(CLUSTER_CAPS)) for (const c of caps) CLUSTER_OF[c] = cl;
const CAP_COUNT = Object.values(CLUSTER_CAPS).reduce((n, a) => n + a.length, 0);
const DOCK = CL.map((c) => ({ key: c.key, label: c.label, color: c.color, caps: CLUSTER_CAPS[c.key] ?? [] }));
const NAMES: Record<string, string> = {
  github: "GitHub", reddit: "Reddit", linkedin: "LinkedIn", x: "X / Twitter", clay: "Clay", web: "Web Search", youtube: "YouTube",
  notion: "Notion", drive: "Google Drive", obsidian: "Obsidian", supabase: "Supabase", granola: "Granola",
  memory: "Memory Core", pinecone: "Pinecone",
  claude: "Claude", gemini: "Gemini", codex: "Codex", agents: "Sub-agents",
  writing: "Writing", elevenlabs: "ElevenLabs", higgsfield: "Higgsfield", notebooklm: "NotebookLM",
  telegram: "Telegram", email: "Gmail", calendar: "Calendar", slack: "Slack",
  code: "Code / Bash", cron: "Schedule", n8n: "n8n", zapier: "Zapier", mcp: "MCP Tools", skills: "Skills",
};
const VOICES = [
  { id: "cedar", label: "Cedar", vibe: "warm · natural" },
  { id: "marin", label: "Marin", vibe: "bright · friendly" },
  { id: "alloy", label: "Alloy", vibe: "neutral · clear" },
  { id: "ash", label: "Ash", vibe: "calm · low" },
  { id: "coral", label: "Coral", vibe: "lively · warm" },
  { id: "sage", label: "Sage", vibe: "soft · measured" },
  { id: "verse", label: "Verse", vibe: "expressive" },
  { id: "ballad", label: "Ballad", vibe: "gentle" },
];
const SAMPLE_URL = "http://localhost:8099/api/sample";

// Character voices — Fish Audio community models. These speak Hermes's
// typed-mode replies through the /__fish_tts proxy; live realtime calls still
// use the OpenAI voices above. The community edition ships no presets: add
// only voices you have the right to use, as { id: "fish:<model id>", label, vibe, sample }.
const FISH_VOICES: { id: string; label: string; vibe: string; sample: string }[] = [];
const isFishVoice = (id: string) => id.startsWith("fish:");

// robust icon: Lucide concept icon · Simple Icons vector → DuckDuckGo real favicon → lettermark
function Cap({ cap }: { cap: string }) {
  // Fallback colours below (m.color) are the capability's OWN logo/lettermark colour
  // (DESIGN-SYSTEM.md § 8 keeps a provider mark's colour on the mark itself); the
  // neutral default is for the rare unmapped capability, not a page tint.
  const m: IconDef = ICONS[cap] || { color: "var(--muted-foreground)", letter: "?" };
  const [err, setErr] = useState(false);
  if (m.face) return <img className="h-full w-full rounded-full object-cover" src={hermesAvatar} alt="" draggable={false} />;
  if (m.lucide) { const I = m.lucide; return <I className="h-[58%] w-[58%]" color={m.color} strokeWidth={2} />; }
  if (m.glyph) return <span className="grid h-full w-full place-items-center p-[3px]" dangerouslySetInnerHTML={{ __html: m.glyph }} />;
  // real brand favicon (true colours + white parts) on a light app-tile
  if (m.domain && !err) return <img className="aspect-square w-full rounded-md bg-[#fbfbfb] object-contain p-0.5" src={`https://icons.duckduckgo.com/ip3/${m.domain}.ico`} alt="" onError={() => setErr(true)} />;
  if (m.slug && !err) return <img className="h-[58%] w-[58%] object-contain" src={`https://cdn.simpleicons.org/${m.slug}/${m.color.replace("#", "")}`} alt="" onError={() => setErr(true)} />;
  return <span className="font-mono text-xs font-semibold" style={{ color: m.color }}>{m.letter}</span>;
}

type Live = { status: "running" | "done" | "error"; result?: string; error?: string; n: number };

export function IntelligencePortal({ state, events, demo = true, onVoiceRequest, onClose }: { state: IntelState; events?: ActivityEvent[]; demo?: boolean; onVoiceRequest?: (request: string, opts?: { sessionId?: string; context?: string; save?: boolean; yolo?: boolean; voice?: boolean }) => Promise<string>; onClose: () => void }) {
  const [active, setActive] = useState<Record<string, Live | undefined>>({});
  const [recent, setRecent] = useState<{ id: string; app: string; result?: string; error?: string }[]>([]);
  const [hoverCap, setHoverCap] = useState<{ name: string; x: number; y: number; color: string } | null>(null);
  const [callState, setCallState] = useState<"off" | "connecting" | "live">("off");
  const [directMode, setDirectMode] = useState(false);  // Companion: instant ack, THEN calls Hermes (feels fast). ⚡ toggle for every-turn-Hermes.
  const groupN = useRef<Record<string, number>>({});
  // domino plays once on mount, then nv-in is dropped so live re-renders can't restart it (which froze chips mid-scale)
  const [entered, setEntered] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setEntered(true), 1250); return () => window.clearTimeout(t); }, []);
  // hovering a strip logo lights its cluster's branch in the graph
  const [hoverCluster, setHoverCluster] = useState<string | null>(null);
  const [nodeMode, setNodeMode] = useState<"atlas" | "plasma" | "sonar" | "waveform" | "rider">("atlas");
  // full-view ART DIRECTION — Aurora (warm) · Cosmos (cosmic) · Classic (3D Atlas + orbs). Persisted + ?design= override.
  const [design, setDesign] = useState<"classic" | "aurora" | "cosmos">(() => {
    try {
      const u = new URLSearchParams(window.location.search).get("design");
      if (u === "classic" || u === "aurora" || u === "cosmos") return u;
      const s = localStorage.getItem("hermes-intel-design");
      if (s === "classic" || s === "aurora" || s === "cosmos") return s;
    } catch { /* SSR / privacy mode */ }
    return "aurora";
  });
  useEffect(() => { try { localStorage.setItem("hermes-intel-design", design); } catch { /* ignore */ } }, [design]);
  // synthetic state reported up from the attract-mode stages → keeps the HUD label/telemetry coherent
  // attract-mode synthetic drive (level + state) so the reactive visuals look alive with no live call
  const [attractLevel, setAttractLevel] = useState(0);
  const [attractState, setAttractState] = useState<CoreMode>("dormant");
  const [engineUp, setEngineUp] = useState(false);     // is the local voice engine reachable?
  const [engineKeyed, setEngineKeyed] = useState(false); // …and does it already hold a key?
  // cinematic boot reveal — replays when the view opens or the design changes
  const [showBoot, setShowBoot] = useState(true);
  useEffect(() => { setShowBoot(true); const tb = window.setTimeout(() => setShowBoot(false), 2000); return () => window.clearTimeout(tb); }, [design]);
  // check the voice engine's health on open so the chat setup card + Talk button know if it's ready
  // (startVoice / connectWithKey re-check freshly on each attempt)
  useEffect(() => { let alive = true; fetch("http://localhost:8099/api/health").then((r) => r.json()).then((h) => { if (alive) { setEngineUp(true); setEngineKeyed(!!h?.keyed); } }).catch(() => { if (alive) setEngineUp(false); }); return () => { alive = false; }; }, []);
  // drive the synthetic attract signal — paused when hidden, in a live call, or on the calm Atlas
  useEffect(() => {
    if (!(demo && callState !== "live")) { setAttractLevel(0); setAttractState("dormant"); return; }
    const synth = new SyntheticVoice();
    let raf = 0, prev = performance.now(), lastSet = 0, lastMode = "";
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) { prev = now; return; }
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const s = synth.tick(dt);
      if (now - lastSet > 45) { setAttractLevel(s.level); lastSet = now; }  // ~22fps; orbs smooth between
      if (s.mode !== lastMode) { lastMode = s.mode; setAttractState(s.mode); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [demo, callState, design, nodeMode]);
  // draggable divider → resize the chat panel
  const [chatW, setChatW] = useState(272);
  const dragW = useRef(false);
  useEffect(() => {
    const mm = (e: MouseEvent) => { if (dragW.current) setChatW((w) => Math.max(212, Math.min(640, w + e.movementX))); };
    const mu = () => { if (dragW.current) { dragW.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; } };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
    return () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); };
  }, []);

  const ignite = (app: string, _detail?: string) => {
    if (!ICONS[app]) return;
    groupN.current[app] = (groupN.current[app] ?? 0) + 1;
    setActive((a) => ({ ...a, [app]: { status: "running", n: groupN.current[app] } }));
  };
  const settle = (app: string, ok: boolean, result?: string, error?: string) => {
    if (!ICONS[app]) return;
    setActive((a) => ({ ...a, [app]: { ...(a[app] ?? { n: 1 }), status: ok ? "done" : "error", result, error } as Live }));
    setRecent((r) => [...r.slice(-6), { id: app + "_" + Math.round(performance.now()), app, result, error }]);
    window.setTimeout(() => setActive((a) => { const n = { ...a }; delete n[app]; groupN.current[app] = 0; return n; }), ok ? 4000 : 6500);
  };

  // the "piano cascade" — light every capability in sequence (replays the domino sweep on demand)
  function playCascade() {
    const caps = DOCK.flatMap((d) => d.caps);
    caps.forEach((cap, i) => {
      window.setTimeout(() => { ignite(cap); window.setTimeout(() => settle(cap, true), 620); }, i * 46);
    });
  }

  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!events) return;
    for (const e of events) { const k = e.id + e.status; if (seen.current.has(k)) continue; seen.current.add(k); if (e.status === "running") ignite(e.app, e.detail); else settle(e.app, e.status === "done", e.result, e.error); }
  }, [events]);

  useEffect(() => {
    if (!demo || callState === "live") return;  // never run the demo reel during a real voice call
    let alive = true; let timers: number[] = [];
    const seq = () => {
      const s: [number, () => void][] = []; let t = 0;
      const f = (app: string, dur: number, res?: string, err?: string) => { s.push([t += 850, () => alive && ignite(app)]); s.push([t += dur, () => alive && settle(app, !err, res, err)]); };
      f("web", 1700, "12 results");
      s.push([t += 200, () => { if (alive) { ignite("github"); ignite("claude"); } }]);
      s.push([t += 2200, () => { if (alive) { settle("github", true, "3 repos"); settle("claude", true, "reasoned"); } }]);
      f("memory", 1500, "5 hits");
      f("notion", 1500, "updated");
      f("writing", 1700, "drafted");
      f("telegram", 1500, "sent");
      timers = s.map(([ms, fn]) => window.setTimeout(fn, ms));
      timers.push(window.setTimeout(seq, t + 3400));
    };
    seq();
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, [demo, callState]);

  // ---- voice (OpenAI Realtime via voice-lab token) ----
  const [turns, setTurns] = useState<{ who: "you" | "hermes"; text: string }[]>([]);
  const [caption, setCaption] = useState("");
  const [breath, setBreath] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [hermesWorking, setHermesWorking] = useState(false);  // a real Hermes turn is running (the ~slow brain call)
  const [micMuted, setMicMuted] = useState(false);  // mute YOUR mic mid-call (silences your input, keeps the line open)
  const [typing, setTyping] = useState(false);        // a typed (text-only) Hermes turn is in flight — no voice engine
  const [draft, setDraft] = useState("");
  const [voiceId, setVoiceId] = useState("sage");  // calm female default; voice is subjective → sample all via the ⚙
  const [settingsOpen, setSettingsOpen] = useState(false);
  // voice provider setup — chooser modal + a key the user saves on their own machine
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  // first-run welcome — explains what Voice is + the local-vs-paid choice; shown once per machine
  const [welcomed, setWelcomed] = useState<boolean>(() => { try { return localStorage.getItem("hermes-intel-welcomed") === "1"; } catch { return true; } });
  const dismissWelcome = (openSetup = false) => { try { localStorage.setItem("hermes-intel-welcomed", "1"); } catch { /* ignore */ } setWelcomed(true); if (openSetup) setVoiceSetupOpen(true); };
  // skip setup and talk anyway — uses the running engine's key if it has one; if not, startCall falls back to the chooser
  const skipAndTalk = () => { try { localStorage.setItem("hermes-intel-welcomed", "1"); } catch { /* ignore */ } setWelcomed(true); setVoiceSetupOpen(false); startCall(); };
  // ?fresh=1 → reset to a clean first-run (forget the saved key + replay the welcome) for on-camera startup demos
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("fresh") === "1") {
        localStorage.removeItem("hermes-openai-key"); localStorage.removeItem("hermes-intel-welcomed");
        setOpenaiKey(""); setWelcomed(false);
      }
    } catch { /* ignore */ }
  }, []);
  const [openaiKey, setOpenaiKey] = useState<string>(() => { try { return localStorage.getItem("hermes-openai-key") || ""; } catch { return ""; } });
  const [keyDraft, setKeyDraft] = useState("");
  const [setupHint, setSetupHint] = useState<"idle" | "engine">("idle");
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);  // auto-starting the voice engine
  const copyCmd = (txt: string) => { try { navigator.clipboard?.writeText(txt); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const shq = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";  // shell-quote a pasted key so it can't inject into the copy-and-run command
  const [sampling, setSampling] = useState<string | null>(null);
  const sampleAudio = useRef<HTMLAudioElement | null>(null);
  // Speak any text through a Fish Audio character voice (server-side proxy
  // holds the key). Used for samples AND for typed-mode replies.
  async function fishSpeak(text: string, fishId: string): Promise<void> {
    const refId = fishId.replace(/^fish:/, "");
    const t = await fetch("/__token").then((r) => r.json()).catch(() => null);
    const r = await fetch("/__fish_tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t?.token ? { "X-Claude-OS-Token": t.token } : {}) },
      body: JSON.stringify({ text: text.slice(0, 1200), voice: refId }),
    });
    if (!r.ok) throw new Error("fish tts");
    const a = new Audio(URL.createObjectURL(await r.blob()));
    sampleAudio.current?.pause();
    sampleAudio.current = a;
    await a.play();
    await new Promise<void>((done) => { a.onended = () => done(); a.onerror = () => done(); });
  }
  async function playSample(v: string) {
    try {
      sampleAudio.current?.pause();
      setSampling(v);
      if (isFishVoice(v)) {
        const fv = FISH_VOICES.find((f) => f.id === v);
        await fishSpeak(fv?.sample ?? "Hello from Hermes.", v);
        setSampling(null);
        return;
      }
      const r = await fetch(SAMPLE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: v, ...(openaiKey ? { key: openaiKey } : {}) }) });
      if (!r.ok) throw new Error("sample");
      const a = new Audio(URL.createObjectURL(await r.blob()));
      sampleAudio.current = a; a.onended = () => setSampling(null);
      await a.play();
    } catch { setSampling(null); }
  }
  const voice = useRef<any>({});
  const turnsRef = useRef<{ who: "you" | "hermes"; text: string }[]>([]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  const curAI = useRef("");
  const speakingRef = useRef(false);  // Schmitt-trigger for "Hermes is talking" → no talking/listening strobe between syllables
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight; }, [turns.length, caption]);

  // ── Character call — mic → speech-to-text → Hermes → Fish TTS out loud.
  // OpenAI's realtime engine can only speak its own voices, so when a Fish
  // character is selected the live call runs through our own loop instead.
  // No voice engine or OpenAI key needed: STT is the browser's, the brain is
  // Hermes, the mouth is /__fish_tts.
  async function startCharacterCall() {
    setCallState("connecting");
    try {
      const actx = new AudioContext();
      // AudioContexts can spawn suspended even inside a click handler — a
      // suspended context feeds the analyser flat silence forever, which
      // reads as "it can't hear me".
      await actx.resume().catch(() => {});
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const micAn = actx.createAnalyser(); micAn.fftSize = 512;
      actx.createMediaStreamSource(mic).connect(micAn);
      voice.current = { ...voice.current, actx, mic, micAna: micAn, charActive: true };
      setCallState("live");
      setCaption("speak — i'm listening");
      pumpVoice();
      charListenLoop();
    } catch { setCallState("off"); }
  }
  // Voice-activity loop: watch the mic's RMS level; when speech is followed
  // by ~1.1s of silence, ship the recorded clip to Whisper via the voice
  // engine, then run the turn. No browser speech API involved.
  function charListenLoop() {
    const v = voice.current;
    if (!v.micAna || !v.mic) return;
    const data = new Uint8Array(v.micAna.fftSize);
    let recorder: MediaRecorder | null = null;
    let clip: Blob[] = [];
    let recStart = 0;
    let speaking = false, speechMs = 0, silenceMs = 0;
    // Auto-calibrating gate: track the ambient noise floor and trigger a few
    // dB above it, so quiet mics still register and loud rooms don't
    // false-trigger. A fixed threshold was deaf on low-gain mics.
    let floor = 0.008, aliveMs = 0, everHeard = false;
    const STEP = 120;
    const stopRec = () => new Promise<void>((res) => {
      const rc = recorder; recorder = null;
      if (!rc || rc.state !== "recording") return res();
      rc.onstop = () => res();
      try { rc.stop(); } catch { res(); }
    });
    const tick = async () => {
      if (!voice.current.charActive) { void stopRec(); return; }
      // while the character talks (or mic is muted) → don't record, don't listen
      const muted = !(voice.current.mic?.getAudioTracks?.()[0]?.enabled ?? true);
      if (voice.current.charSpeaking || muted) {
        speaking = false; speechMs = 0; silenceMs = 0;
        await stopRec(); clip = [];
        window.setTimeout(tick, STEP);
        return;
      }
      if (!recorder) {
        try {
          recorder = new MediaRecorder(v.mic);
          clip = []; recStart = performance.now();
          recorder.ondataavailable = (e) => { if (e.data.size > 0) clip.push(e.data); };
          recorder.start(250);
        } catch { window.setTimeout(tick, 1000); return; }
      }
      v.micAna.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const d = (data[i] - 128) / 128; sum += d * d; }
      const rms = Math.sqrt(sum / data.length);
      // floor snaps down fast, drifts up slowly → tracks the room
      floor = rms < floor ? floor * 0.8 + rms * 0.2 : floor * 0.995 + rms * 0.005;
      const loud = rms > Math.max(0.012, floor * 2.6);
      aliveMs += STEP;
      if (rms > 0.004) everHeard = true;
      if (!everHeard && aliveMs > 6_000 && aliveMs <= 6_000 + STEP)
        setCaption("mic looks silent — check input device / permission for this site");
      if (loud) {
        if (!speaking) { speaking = true; setListening(true); }
        setCaption("hearing you…");
        speechMs += STEP; silenceMs = 0;
      } else if (speaking) {
        silenceMs += STEP;
      } else if (performance.now() - recStart > 15_000) {
        // idle housekeeping: restart the recorder so silence never piles up
        await stopRec(); clip = [];
      }
      if (speaking && silenceMs >= 850) {
        setListening(false); setCaption("");
        await stopRec();
        const chunks = clip; clip = [];
        const hadSpeech = speechMs >= 300;
        speaking = false; speechMs = 0; silenceMs = 0;
        if (hadSpeech && chunks.length > 0) {
          const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
          void charTranscribe(blob);
        }
      }
      window.setTimeout(tick, STEP);
    };
    tick();
  }
  async function charTranscribe(blob: Blob) {
    setThinking(true);
    try {
      const r = await fetch("http://localhost:8099/api/stt", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
      const j: any = r.ok ? await r.json() : null;
      const text = (j?.text ?? "").trim();
      if (text) { await charTurn(text); return; }
    } catch { /* engine down — stay in call */ }
    setThinking(false);
  }
  async function charTurn(text: string) {
    if (!onVoiceRequest) return;
    setTurns((t) => [...t.slice(-30), { who: "you", text }]);
    setThinking(true);
    let reply = "";
    try { reply = (await onVoiceRequest(text, { voice: true, save: true, yolo: true })).trim(); } catch { reply = "I couldn't reach the agent just now."; }
    setThinking(false);
    if (!reply) return;
    setTurns((t) => [...t.slice(-30), { who: "hermes", text: reply }]);
    // speak through the character — mic transcription pauses so the
    // character doesn't hear itself through the speakers. The reply is
    // split into sentence chunks synthesized IN PARALLEL and played in
    // order, so the first sentence starts in ~a second instead of waiting
    // for the whole paragraph to render.
    const v = voice.current;
    v.charSpeaking = true;
    try { v.charRec?.stop(); } catch { /* not running */ }
    try {
      const refId = voiceId.replace(/^fish:/, "");
      const tok = await fetch("/__token").then((r) => r.json()).catch(() => null);
      const fetchChunk = async (text: string): Promise<Blob | null> => {
        try {
          const r = await fetch("/__fish_tts", { method: "POST", headers: { "Content-Type": "application/json", ...(tok?.token ? { "X-Claude-OS-Token": tok.token } : {}) }, body: JSON.stringify({ text, voice: refId }) });
          return r.ok ? await r.blob() : null;
        } catch { return null; }
      };
      // sentence-ish chunks, tiny ones merged so pacing stays natural
      const parts = reply.slice(0, 1600).replace(/\s+/g, " ").match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) ?? [reply.slice(0, 1600)];
      const chunks: string[] = [];
      let buf = "";
      for (const p of parts) { buf += p; if (buf.trim().length > 70) { chunks.push(buf.trim()); buf = ""; } }
      if (buf.trim()) chunks.push(buf.trim());
      const inflight = chunks.slice(0, 10).map(fetchChunk);
      for (const f of inflight) {
        if (!voice.current.charActive && callState !== "live") break;
        const blob = await f;
        if (!blob) continue;
        const a = new Audio(URL.createObjectURL(blob));
        // wire the character's output into the same analyser the orb reads —
        // the core lights up and breathes exactly like a realtime call
        try { const src = v.actx.createMediaElementSource(a); const an = v.actx.createAnalyser(); an.fftSize = 256; src.connect(an); an.connect(v.actx.destination); voice.current.aiAna = an; } catch { /* analyser optional */ }
        await a.play();
        await new Promise<void>((done) => { a.onended = () => done(); a.onerror = () => done(); });
      }
    } catch { /* stay in the call even if one line fails to speak */ }
    v.charSpeaking = false;
    if (v.charActive) { try { v.charRec?.start(); } catch { /* already running */ } }
  }
  async function startCall(keyOverride?: string) {
    if (isFishVoice(voiceId)) return startCharacterCall();
    const key = (keyOverride ?? openaiKey).trim();
    setCallState("connecting");
    try {
      const s = await fetch(VOICE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: voiceId, mode: directMode ? "direct" : "companion", ...(key ? { key } : {}) }) }).then((r) => r.json());
      if (!s.value) throw new Error("no token");
      const pc = new RTCPeerConnection();
      const audio = new Audio(); audio.autoplay = true;
      const actx = new AudioContext();
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.play().catch(() => {}); const an = actx.createAnalyser(); an.fftSize = 256; actx.createMediaStreamSource(e.streams[0]).connect(an); voice.current.aiAna = an; };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(mic.getAudioTracks()[0], mic);
      const micAn = actx.createAnalyser(); micAn.fftSize = 256; actx.createMediaStreamSource(mic).connect(micAn); voice.current.micAna = micAn;
      const dc = pc.createDataChannel("oai-events"); dc.onmessage = onVoiceEvent; dc.onopen = () => { setCallState("live"); pumpVoice(); };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const ans = await fetch((s.base || "https://api.openai.com") + "/v1/realtime/calls?model=" + encodeURIComponent(s.model || providerModelId("openai/gpt-realtime")), { method: "POST", body: offer.sdp, headers: { Authorization: "Bearer " + s.value, "Content-Type": "application/sdp" } });
      await pc.setRemoteDescription({ type: "answer", sdp: await ans.text() } as any);
      voice.current = { ...voice.current, pc, dc, mic, actx, audio };
    } catch { setCallState("off"); setEngineUp(false); setVoiceSetupOpen(true); if (openaiKey) setSetupHint("engine"); }
  }
  // gate the call behind the setup chooser until a reachable, keyed voice engine exists
  async function startVoice() {
    // Character calls don't touch the OpenAI voice engine at all — no key,
    // no engine gate. Straight into the STT → Hermes → Fish loop.
    if (isFishVoice(voiceId)) return startCharacterCall();
    try {
      const h = await fetch("http://localhost:8099/api/health").then((r) => r.json());
      setEngineUp(true); setEngineKeyed(!!h?.keyed);
      // Engine already keyed → go. Otherwise (up but unkeyed, e.g. after a
      // dev-server restart) ask the server to key it — it re-loads the saved
      // OPENAI_API_KEY from ~/.hermes/.env, so we don't need a localStorage
      // key on this port at all.
      if (h?.keyed) return startCall();
      const started = await startEngine(openaiKey).catch(() => null);
      if (started?.ok && started?.keyed) { setEngineKeyed(true); return startCall(openaiKey || undefined); }
    } catch {
      setEngineUp(false);
      // Engine isn't up — spawn it. Pass the localStorage key if we have one;
      // otherwise the server falls back to the key saved in ~/.hermes/.env, so
      // voice keeps working across ports and restarts without re-prompting.
      const started = await startEngine(openaiKey).catch(() => null);
      if (started?.ok && started?.keyed) { setEngineUp(true); setEngineKeyed(true); return startCall(openaiKey || undefined); }
    }
    setVoiceSetupOpen(true);  // only prompt when there's genuinely no saved key anywhere
  }
  // ask the dev server to spawn voice-lab with the user's key — no terminal needed
  async function startEngine(key: string, base?: string) {
    let token = "";
    try { token = (await fetch("/__token").then((r) => r.json()))?.token ?? ""; } catch { /* no token endpoint */ }
    const r = await fetch("/__start_voice", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Claude-OS-Token": token } : {}) }, body: JSON.stringify({ ...(key ? { key } : {}), ...(base ? { base } : {}) }) });
    return r.ok ? r.json().catch(() => null) : null;
  }
  async function connectWithKey() {
    const k = keyDraft.trim(); if (!k) return;
    try { localStorage.setItem("hermes-openai-key", k); } catch { /* ignore */ }
    setOpenaiKey(k); setStarting(true);
    const started = await startEngine(k).catch(() => null);
    setStarting(false);
    if (started?.ok) { setEngineUp(true); setEngineKeyed(true); setKeyDraft(""); setVoiceSetupOpen(false); startCall(k); }
    else { setEngineUp(false); setSetupHint("engine"); }  // auto-start failed → show the terminal fallback
  }
  function forgetKey() { try { localStorage.removeItem("hermes-openai-key"); } catch { /* ignore */ } setOpenaiKey(""); }
  // mute YOUR mic without dropping the call — disables the mic track (silence → OpenAI hears nothing, no cost on idle audio)
  function toggleMute() {
    if (callState !== "live") return;
    setMicMuted((m) => {
      const next = !m;
      const tracks = voice.current?.mic?.getAudioTracks?.() || [];
      tracks.forEach((tr: MediaStreamTrack) => { tr.enabled = !next; });
      if (next) { setListening(false); setVoiceLevel(0); }  // calm the orb the instant you mute
      return next;
    });
  }
  // press M to mute / unmute during a live call (ignored while typing in the chat box)
  useEffect(() => {
    if (callState !== "live") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M" || e.metaKey || e.ctrlKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callState]);
  function endCall() {
    const v = voice.current; try { v.charActive = false; v.charSpeaking = false; window.clearTimeout(v.charTimer); v.charRec?.abort?.(); cancelAnimationFrame(v.raf); v.dc?.close(); v.pc?.close(); v.mic?.getTracks?.().forEach((t: any) => t.stop()); v.actx?.close?.(); } catch {}
    // hand the whole conversation back to Hermes so it persists what mattered
    const convo = turnsRef.current;
    if (convo.length > 1 && onVoiceRequest) {
      const transcript = convo.map((t) => `${t.who === "you" ? "User" : "Hermes"}: ${t.text}`).join("\n");
      onVoiceRequest(`The voice call just ended. Save anything important from it to memory and note any follow-ups. Do not reply conversationally.\n\nTRANSCRIPT:\n${transcript}`, { voice: true, save: true, yolo: true }).catch(() => {});
    }
    voice.current = {}; speakingRef.current = false; setCallState("off"); setBreath(0); setVoiceLevel(0); setListening(false); setThinking(false); setHermesWorking(false); setMicMuted(false); setCaption("");
  }
  function onVoiceEvent(e: MessageEvent) {
    let m: any; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "input_audio_buffer.speech_started") setListening(true);
    else if (m.type === "input_audio_buffer.speech_stopped") { setListening(false); setThinking(true); }
    else if (m.type === "conversation.item.input_audio_transcription.delta") setCaption((c) => c + (m.delta || ""));
    else if (m.type === "conversation.item.input_audio_transcription.completed") { if (m.transcript?.trim()) setTurns((t) => [...t.slice(-30), { who: "you", text: m.transcript.trim() }]); setCaption(""); }
    else if (m.type === "response.created") { curAI.current = ""; setThinking(true); }
    else if (m.type === "response.audio_transcript.delta" || m.type === "response.output_audio_transcript.delta") { setThinking(false); curAI.current += m.delta || ""; setCaption(curAI.current); }
    else if (m.type === "response.done") {
      const out = m.response?.output || [];
      const calls = out.filter((o: any) => o.type === "function_call");
      if (calls.length) { for (const c of calls) handleToolCall(c); return; }
      setThinking(false);
      // show Hermes's reply in the rail — prefer streamed deltas, else pull the output item transcript
      let finalText = curAI.current.trim();
      if (!finalText) { for (const it of out) for (const ct of (it.content || [])) if (ct && ct.transcript) finalText = (finalText + " " + ct.transcript).trim(); }
      if (finalText) setTurns((t) => [...t.slice(-30), { who: "hermes", text: finalText }]);
      curAI.current = ""; setCaption("");
    }
  }
  // the realtime voice called ask_hermes → run the REAL agent (lights nodes), feed result back to speak
  async function handleToolCall(c: any) {
    let request = "";
    try { request = JSON.parse(c.arguments || "{}").request || ""; } catch {}
    setThinking(true); setHermesWorking(true); curAI.current = ""; setListening(false); setCaption("· checking with Hermes …");
    let result = "I couldn't reach the agent.";
    try { if (onVoiceRequest && request) result = await onVoiceRequest(request, { voice: true, yolo: true }); } catch {}
    setHermesWorking(false);
    const dc = voice.current?.dc;
    if (dc && dc.readyState === "open") {
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: String(result).slice(0, 4000) } }));
        // speak the result WITHOUT calling a tool again (session forces the tool, so override per-response)
        dc.send(JSON.stringify({ type: "response.create", response: { tool_choice: "none" } }));
      } catch {}
    }
  }
  function pumpVoice() {
    const rms = (an: any) => { if (!an) return 0; const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d); let s = 0; for (let i = 0; i < d.length; i++) { const x = (d[i] - 128) / 128; s += x * x; } return Math.min(1, Math.sqrt(s / d.length) * 4); };
    const loop = () => {
      if (!voice.current.dc) return;
      // Hermes's speaking level → low-passed so the core GROWS smoothly (no glitchy jumps)
      const aiR = rms(voice.current.aiAna);
      voice.current.smB = (voice.current.smB || 0) * 0.9 + aiR * 0.1;
      setBreath(voice.current.smB);
      // your mic level → smoothed, so the core's crown reacts while YOU speak too
      const mic = voice.current.micAna;
      let micL = 0;
      if (mic) {
        const NB = mic.frequencyBinCount; const f = (voice.current.f ||= new Uint8Array(NB)); mic.getByteFrequencyData(f);
        let e = 0; for (let k = 2; k < 46; k++) e += f[k];
        const lvl = Math.min(1, (e / 44 / 255) * 2.5);
        voice.current.lvl = (voice.current.lvl || 0) * 0.82 + lvl * 0.18;
        micL = voice.current.lvl;
      }
      // snappy + amplified — the Oracle orbs (Pulse/Plasma/Rider) react quickly to speech
      const combined = Math.max(voice.current.smB, micL);
      const gated = Math.max(0, combined - 0.1) * 1.7;  // drop the ambient noise floor → ~0 at rest, dynamic on real speech (KR bar stops sitting fully-extended)
      voice.current.vlOut = (voice.current.vlOut || 0) * 0.55 + gated * 0.45;
      setVoiceLevel(Math.min(1, voice.current.vlOut));
      voice.current.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  async function sendText(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim(); if (!text) return;
    setDraft("");
    setTurns((t) => [...t.slice(-30), { who: "you", text }]);
    const dc = voice.current?.dc;
    if (callState === "live" && dc && dc.readyState === "open") {
      // on a live call → inject the typed line into the realtime conversation (Hermes can speak it back)
      try {
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch {}
      return;
    }
    // TYPE MODE — straight to the real Hermes brain. No mic, no voice engine, no cost.
    if (!onVoiceRequest) { startCall(); return; }
    setTyping(true);
    try {
      const reply = await onVoiceRequest(text, { save: true });
      const spoken = (reply || "").trim() || "…";
      setTurns((t) => [...t.slice(-30), { who: "hermes", text: spoken }]);
      // Character voice picked → the reply is spoken out loud too.
      if (isFishVoice(voiceId) && spoken !== "…") fishSpeak(spoken, voiceId).catch(() => {});
    } catch {
      setTurns((t) => [...t.slice(-30), { who: "hermes", text: "I couldn't reach the agent just now." }]);
    }
    setTyping(false);
  }
  useEffect(() => () => endCall(), []);

  const runningCount = Object.values(active).filter((a) => a?.status === "running").length;
  const activeClusters = [...new Set(Object.keys(active).filter((k) => active[k]?.status === "running").map((k) => CLUSTER_OF[k]).filter(Boolean))];
  // Schmitt trigger: latch "talking" above 0.07, release below 0.03. The speech envelope dipping between
  // syllables can no longer strobe talking↔listening — that single-threshold flip WAS the orb "spasm".
  if (callState === "live") {
    if (breath > 0.07) speakingRef.current = true;
    else if (breath < 0.03) speakingRef.current = false;
  } else speakingRef.current = false;
  const hermesSpeaking = speakingRef.current;

  let mode: CoreMode;
  if (callState === "live") { if (hermesSpeaking) mode = "talking"; else if (listening) mode = "listening"; else if (runningCount > 0 || hermesWorking) mode = "working"; else if (thinking) mode = "thinking"; else mode = "listening"; }
  else if (state === "responding") mode = "talking"; else if (state === "thinking") mode = "thinking"; else if (runningCount > 0) mode = "working"; else mode = "dormant";

  const STATE_LABEL: Record<CoreMode, string> = { dormant: "asleep", listening: "listening", thinking: "thinking", talking: "speaking", working: "working" };
  // Chrome tone for the mode chip/telemetry — a state means one of the four semantic
  // tones (docs/DESIGN-SYSTEM.md § "Colour means state"), not a per-cluster hue.
  const MODE_TONE: Record<CoreMode, "neutral" | "info" | "warn" | "success" | "accent"> = {
    dormant: "neutral", listening: "info", thinking: "warn", talking: "success", working: "accent",
  };
  const live = callState === "live";
  const clLabel = (k: string) => CL.find((c) => c.key === k)?.label ?? k;
  const stateText = callState === "connecting" ? "Connecting"
    : activeClusters.length ? `${live ? "Live · " : ""}${activeClusters.map((k) => clLabel(k)).join(" + ")}`
    : live ? `Live · ${STATE_LABEL[mode]}` : STATE_LABEL[mode];
  const stateTone = callState === "connecting" ? "warn" : activeClusters.length ? "accent" : MODE_TONE[mode];
  const oracleLevel = Math.max(voiceLevel, breath);
  // attract drives a synthetic level+state so the WHOLE mind looks alive with no live call —
  // the orbs react, Aurora/Cosmos bloom, and the Atlas core fires up (all heavily damped).
  const attracting = demo && !live;
  const displayMode: CoreMode = attracting ? attractState : mode;
  const displayLevel = live ? oracleLevel : attracting ? attractLevel : 0;
  // Oracle/Stage components colour the mind visualisation itself (3D/canvas content,
  // exempt per DESIGN-SYSTEM.md § 8) — kept as literal hex, unrelated to page chrome.
  const oracleColor = displayMode === "thinking" ? "#FFD21E" : displayMode === "working" ? "#ff8a3c" : displayMode === "talking" ? "#aef3dd" : "#7be0c8";
  const dispLabel = micMuted && live ? "Mic muted" : attracting ? STATE_LABEL[attractState] : stateText;
  const dispTone = micMuted && live ? "warn" : attracting ? MODE_TONE[attractState] : stateTone;
  const loadPct = activeClusters.length ? 88 : ({ dormant: 8, listening: 34, thinking: 72, talking: 58, working: 90 } as Record<CoreMode, number>)[displayMode];
  // voice is "ready" only when the engine is reachable AND has a key (env or the one the user pasted)
  const voiceReady = engineUp && (engineKeyed || !!openaiKey);
  // HermesMind3D is memoized (so the 60fps voice props can't flash it) → an unstable onTapHub could
  // go stale (in demo mode a call-state flip may not change displayMode, skipping the ref refresh).
  // Give it ONE constant identity that always runs the latest behaviour via a ref.
  const tapHubRef = useRef<() => void>(() => {});
  tapHubRef.current = () => (callState === "off" ? startVoice() : endCall());
  const tapHub = useCallback(() => tapHubRef.current(), []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <style>{`
        @keyframes ip-boot{0%{opacity:0;transform:scale(.96)}20%{opacity:1}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.02)}}
        @keyframes nv-domino{0%{opacity:0;transform:translateY(6px) scale(.6)}60%{opacity:1;transform:translateY(0) scale(1.08)}100%{opacity:1;transform:scale(1)}}
        .nv-in{animation:nv-domino .4s ease backwards}
      `}</style>

      {/* hover tooltip — fixed so the sidebar's overflow never clips it */}
      {hoverCap && (
        <div
          className="pointer-events-none fixed z-[999] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-md"
          style={{ left: Math.min(Math.max(hoverCap.x, 72), (typeof window !== "undefined" ? window.innerWidth : 1280) - 72), top: hoverCap.y - 9, transform: "translate(-50%,-100%)" }}
        >
          {hoverCap.name}
        </div>
      )}

      {/* HUD */}
      <div className="relative z-10 flex shrink-0 items-center justify-between border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <BrandMark agent="hermes" size={16} />
          Hermes intelligence
          {mode !== "dormant" && <StatusDot tone="success" label="" pulse />}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {/* art-direction selector — the full-view design */}
          <Segmented
            ariaLabel="Visual style"
            value={design}
            onChange={setDesign}
            options={[
              { value: "aurora", label: "Aurora" },
              { value: "cosmos", label: "Cosmos" },
              { value: "classic", label: "Classic" },
            ]}
          />
          {design === "classic" && (
            <Segmented
              ariaLabel="Graph view"
              value={nodeMode}
              onChange={setNodeMode}
              options={[
                { value: "atlas", label: "Atlas" },
                { value: "plasma", label: "Plasma" },
                { value: "sonar", label: "Sonar" },
                { value: "waveform", label: "Pulse" },
                { value: "rider", label: "Rider" },
              ]}
            />
          )}
          <span className="hidden xl:inline">{CAP_COUNT} capabilities · {CL.length} clusters</span>
          <Button variant="ghost" size="icon-sm" onClick={playCascade} aria-label="Play capability cascade" title="Play the capability cascade">
            <Zap className="h-4 w-4" />
          </Button>
          <Button variant={settingsOpen ? "outline" : "ghost"} size="icon-sm" onClick={() => setSettingsOpen((s) => !s)} aria-label="Voice settings" aria-pressed={settingsOpen}>
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={onClose} aria-label="Close">
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>

      {/* voice settings popover */}
      {settingsOpen && (
        <div className="absolute right-4 top-12 z-[60] w-[232px] overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <span className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Mic className="h-3 w-3" />
              Voice
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(false)} aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          {/* Configure — one place to set up the connection; shows live status (the stats) */}
          <button
            type="button"
            onClick={() => { setSettingsOpen(false); setVoiceSetupOpen(true); }}
            className="ds-interactive flex w-full items-center justify-between border-b border-border px-3.5 py-2.5 hover:bg-surface-raised"
          >
            <span className="flex flex-col items-start gap-0.5 text-left leading-tight">
              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Settings2 className="h-3 w-3" />
                Configure voice
              </span>
              <span className="text-xs text-muted-foreground">
                {voiceReady ? (openaiKey ? "OpenAI key saved · engine ready" : "engine ready · using its key") : engineUp ? "engine up · no key yet" : "not set up — connect a voice"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <StatusDot tone={voiceReady ? "success" : "warn"} label="" />
              <span className="text-sm text-muted-foreground">›</span>
            </span>
          </button>
          {openaiKey && (
            <div className="flex items-center justify-between border-b border-border px-3.5 py-2">
              <span className="text-xs text-success">Key on this machine only</span>
              <Button variant="ghost" size="xs" onClick={() => { forgetKey(); setEngineKeyed(false); }} className="text-danger hover:text-danger">
                Disconnect key
              </Button>
            </div>
          )}
          <button type="button" onClick={() => setDirectMode((d) => !d)} className="ds-interactive flex w-full items-center justify-between border-b border-border px-3.5 py-2.5 hover:bg-surface-raised">
            <span className="flex flex-col items-start gap-0.5 text-left leading-tight">
              <span className={cn("text-xs font-medium", directMode ? "text-brand" : "text-foreground")}>Hermes direct</span>
              <span className="text-xs text-muted-foreground">every turn straight to Hermes · slower, fully real</span>
            </span>
            <span className={cn("relative h-[18px] w-[34px] shrink-0 rounded-full transition-colors", directMode ? "bg-brand/45" : "bg-inset")}>
              <span className={cn("absolute top-0.5 h-3.5 w-3.5 rounded-full transition-[left]", directMode ? "left-[18px] bg-brand" : "left-0.5 bg-muted-foreground")} />
            </span>
          </button>
          <div className="max-h-[300px] overflow-y-auto py-1.5">
            {VOICES.map((v) => {
              const sel = voiceId === v.id;
              return (
                <div key={v.id} className="flex items-center gap-1.5 px-2">
                  <button
                    type="button"
                    onClick={() => setVoiceId(v.id)}
                    className={cn(
                      "ds-interactive flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                      sel ? "bg-brand-soft" : "hover:bg-surface-raised",
                    )}
                  >
                    <StatusDot tone={sel ? "accent" : "neutral"} label="" />
                    <span className="flex flex-col leading-tight">
                      <span className="text-xs text-foreground">{v.label}</span>
                      <span className="text-xs text-muted-foreground">{v.vibe}</span>
                    </span>
                  </button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => playSample(v.id)}
                    className={cn("shrink-0 rounded-full", sampling === v.id && "text-brand")}
                    aria-label={`Play ${v.label} sample`}
                  >
                    {sampling === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" fill="currentColor" />}
                  </Button>
                </div>
              );
            })}
            {FISH_VOICES.length > 0 && <div className="px-4 pb-1 pt-2.5 text-xs text-warn">Character · Fish Audio</div>}
            {FISH_VOICES.map((v) => {
              const sel = voiceId === v.id;
              return (
                <div key={v.id} className="flex items-center gap-1.5 px-2">
                  <button
                    type="button"
                    onClick={() => setVoiceId(v.id)}
                    className={cn(
                      "ds-interactive flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                      sel ? "bg-warn-soft" : "hover:bg-surface-raised",
                    )}
                  >
                    <StatusDot tone={sel ? "warn" : "neutral"} label="" />
                    <span className="flex flex-col leading-tight">
                      <span className="text-xs text-foreground">{v.label}</span>
                      <span className="text-xs text-muted-foreground">{v.vibe}</span>
                    </span>
                  </button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => playSample(v.id)}
                    className={cn("shrink-0 rounded-full", sampling === v.id && "text-warn")}
                    aria-label={`Play ${v.label} sample`}
                  >
                    {sampling === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" fill="currentColor" />}
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
            Standard: applies to next call · character: speaks typed replies · ▶ preview
          </div>
        </div>
      )}

      {/* first-run welcome — what Voice is + the local-vs-paid choice (shown once per machine) */}
      {!welcomed && (
        <div className="absolute inset-0 z-[85] grid place-items-center bg-background/90 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
            <div className="px-6 pb-1 pt-6 text-center">
              <img src={hermesAvatar} alt="" className="mx-auto mb-3 h-[54px] w-[54px] rounded-full border border-border object-cover" />
              <div className="text-sm font-medium text-foreground">Talk to Hermes</div>
              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                This is a live line to <span className="text-foreground">Hermes</span> — your real local agent, with its own
                tools and memory. <span className="text-foreground">Type any time, free.</span> To{" "}
                <span className="text-brand">talk out loud</span>, give it a voice:
              </p>
            </div>
            {/* how voice works — 3 steps */}
            <div className="flex items-stretch gap-2 px-6 py-3">
              {([["1", "You speak"], ["2", "A speech engine turns voice into text and back"], ["3", "Hermes thinks, acts and speaks back"]] as const).map(([n, t]) => (
                <div key={n} className="flex-1 rounded-lg border border-border bg-inset px-2 py-2 text-center">
                  <div className="text-sm text-brand">{n}</div>
                  <div className="mt-1 text-xs leading-snug text-muted-foreground">{t}</div>
                </div>
              ))}
            </div>
            {/* the two ways to power the voice */}
            <div className="grid grid-cols-2 gap-2.5 px-6 pb-1 pt-1">
              <Surface variant="inset" padding="sm">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">Free · local</span>
                  <span className="text-sm text-success">$0</span>
                </div>
                <div className="text-xs leading-snug text-muted-foreground">Runs fully on your Mac. Private. A bit of setup.</div>
              </Surface>
              <Surface variant="inset" padding="sm">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">Paid · OpenAI</span>
                  <span className="text-xs text-muted-foreground">~5–10¢/min</span>
                </div>
                <div className="text-xs leading-snug text-muted-foreground">Instant, top quality. Paste a key — one click.</div>
              </Surface>
            </div>
            <div className="flex items-center gap-2.5 px-6 pb-2 pt-3">
              <Button variant="accent" className="flex-1" onClick={() => dismissWelcome(true)}>Set up voice</Button>
              <Button variant="outline" onClick={() => dismissWelcome(false)}>Explore first</Button>
            </div>
            <div className="px-6 pb-5 text-center">
              <Button variant="link" size="sm" onClick={skipAndTalk} className="h-auto p-0 text-xs text-muted-foreground">
                Skip setup — talk now
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* voice provider chooser — surfaces cost + a free alternative before any call */}
      {voiceSetupOpen && (
        <div className="absolute inset-0 z-[80] grid place-items-center bg-background/85 p-6 backdrop-blur-sm" onClick={() => setVoiceSetupOpen(false)}>
          <div className="w-full max-w-[600px]" onClick={(e) => e.stopPropagation()}>
            <div className="overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
              <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Mic className="h-3.5 w-3.5" />
                  Give Hermes a voice
                </span>
                <Button variant="ghost" size="icon-sm" onClick={() => setVoiceSetupOpen(false)} aria-label="Close">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="px-5 py-4">
                <p className="mb-3.5 text-xs leading-relaxed text-muted-foreground">
                  Pick a <span className="text-foreground">speech engine</span> — it's only the{" "}
                  <span className="text-foreground">ears and mouth</span> (turns your voice into text and back).{" "}
                  <span className="text-foreground">Hermes</span> stays the brain either way. Two ways to power it:
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {/* OpenAI */}
                  <Surface variant="inset" padding="sm" className="flex flex-col">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium text-foreground">OpenAI realtime</span>
                      <Badge tone="warn">Recommended</Badge>
                    </div>
                    <div className="mb-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
                      <div className="text-sm text-foreground">
                        ≈ $3–6<span className="text-xs text-muted-foreground"> / hr talking</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">~5–10¢/min · only while audio flows</div>
                    </div>
                    <input
                      value={keyDraft}
                      onChange={(e) => { setKeyDraft(e.target.value); setSetupHint("idle"); }}
                      placeholder="Paste your OpenAI key (sk-…)"
                      type="password"
                      autoComplete="off"
                      className="ds-interactive mb-2 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-xs text-foreground outline-none"
                    />
                    <Button variant="accent" size="sm" onClick={connectWithKey} disabled={!keyDraft.trim() || starting}>
                      {starting ? "Starting…" : "Connect"}
                    </Button>
                    <div className="mt-1.5 text-center text-xs text-muted-foreground">starts the engine for you · no terminal</div>
                    {setupHint === "engine" && (
                      <Notice tone="warn" className="mt-2.5" title="Couldn't auto-start — run this, then Connect">
                        <button type="button" onClick={() => copyCmd(`OPENAI_API_KEY=${shq(openaiKey || keyDraft.trim())} bun run voice`)} className="ds-interactive w-full rounded-md border border-border bg-inset px-2 py-1.5 text-left font-mono text-xs text-foreground">
                          {copied ? "Copied to clipboard" : "Copy: OPENAI_API_KEY=… bun run voice"}
                        </button>
                      </Notice>
                    )}
                    <div className="mt-2 flex items-center gap-2.5">
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">Get a key →</a>
                      <a href="https://platform.openai.com/settings/organization/billing" target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-foreground">Add credits →</a>
                    </div>
                    <Notice tone="info" className="mt-2">
                      Getting a 401 or "key doesn't work"? A ChatGPT <span className="text-foreground">Plus/Pro</span> plan does{" "}
                      <span className="text-foreground">not</span> include API access — voice bills the API separately, so add a
                      little credit under Billing. And use <span className="text-foreground">Chrome</span> — Safari isn't fully
                      supported.
                    </Notice>
                  </Surface>
                  {/* Local / open-source */}
                  <Surface variant="inset" padding="sm" className="flex flex-col">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium text-foreground">Local · open-source</span>
                      <Badge tone="success">Free</Badge>
                    </div>
                    <div className="mb-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
                      <div className="text-sm text-foreground">
                        $0<span className="text-xs text-muted-foreground"> · private</span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">runs on your Mac · ~20-min setup</div>
                    </div>
                    <div className="mb-2 text-xs leading-relaxed text-muted-foreground">
                      Run an OpenAI-compatible voice server locally, then start the engine pointed at it:
                    </div>
                    <button type="button" onClick={() => copyCmd("OPENAI_BASE_URL=http://localhost:8080 OPENAI_API_KEY=local bun run voice")} className="ds-interactive mb-2 w-full rounded-md border border-border bg-inset px-2 py-1.5 text-left font-mono text-xs text-foreground">
                      {copied ? "Copied to clipboard" : "Copy: OPENAI_BASE_URL=… bun run voice"}
                    </button>
                    <div className="text-xs leading-relaxed text-muted-foreground">
                      Pieces: faster-whisper (STT) · Piper (TTS). Full guide: <span className="font-mono text-foreground">docs/local-voice-setup.md</span> — or ask Hermes to walk you through it.
                    </div>
                  </Surface>
                </div>
                <p className="mt-3 text-xs leading-snug text-muted-foreground">
                  <span className="text-foreground">Not sure?</span> Start with OpenAI — one click, and you only pay while
                  you're actually talking. You can switch to local any time.
                </p>
                {openaiKey && (
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                    <span className="text-xs text-success">Key saved on this machine only</span>
                    <Button variant="ghost" size="xs" onClick={forgetKey} className="text-danger hover:text-danger">Forget key</Button>
                  </div>
                )}
                <Button variant="outline" className="mt-3 w-full" onClick={skipAndTalk}>Skip — talk to Hermes anyway</Button>
                <p className="mt-2 text-center text-xs text-muted-foreground">just exploring? the mind animates for free — no key needed</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* LEFT — conversation (resizable) */}
        <div className="flex shrink-0 flex-col border-r border-border" style={{ width: chatW }}>
          {/* header */}
          <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-border px-3.5">
            <div className="flex items-center gap-1.5">
              <BrandMark agent="hermes" size={14} />
              <span className="text-xs font-medium text-foreground">Hermes</span>
            </div>
            <StatusDot tone={live ? "danger" : "neutral"} pulse={live} label={live ? "Live" : "Chat"} />
          </div>
          {/* transcript */}
          <div ref={transcriptRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
            {callState === "off" && !voiceReady && (
              <div className="flex flex-col gap-1.5">
                <Notice tone="warn" title="Give Hermes a voice" action={<Button variant="outline" size="xs" onClick={() => setVoiceSetupOpen(true)}>Options</Button>}>
                  Paste your OpenAI key and it just works — no terminal. ≈$3–6/hr · your key, your machine.
                </Notice>
                <div className="text-center text-xs text-muted-foreground">or just watch the mind — it's free</div>
              </div>
            )}
            {turns.length === 0 && !caption && voiceReady && (
              <div className="mt-6 flex flex-col items-center gap-2.5 px-2 text-center">
                <img src={hermesAvatar} alt="" className="h-[46px] w-[46px] rounded-full border border-border object-cover" />
                <div className="text-xs leading-relaxed text-muted-foreground">Tap the core or type below to talk with Hermes. Interrupt any time.</div>
              </div>
            )}
            {turns.map((t, i) => t.who === "you" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[84%] rounded-2xl rounded-br-md border border-border bg-surface-raised px-3 py-2 text-xs leading-snug text-foreground">{t.text}</div>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-2">
                <img src={hermesAvatar} alt="" className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full border border-border object-cover" />
                <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-border bg-inset px-3 py-2 text-xs leading-snug text-foreground">{t.text}</div>
              </div>
            ))}
            {caption && (listening ? (
              <div className="flex justify-end">
                <div className="max-w-[84%] rounded-2xl rounded-br-md border border-border bg-surface-raised px-3 py-2 text-xs italic leading-snug text-muted-foreground">{caption}</div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <img src={hermesAvatar} alt="" className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full border border-border object-cover" />
                <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-border bg-inset px-3 py-2 text-xs italic leading-snug text-muted-foreground">{caption}</div>
              </div>
            ))}
            {typing && (
              <div className="flex items-start gap-2">
                <img src={hermesAvatar} alt="" className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full border border-border object-cover" />
                <div className="rounded-2xl rounded-bl-md border border-border bg-inset px-3 py-2 text-xs italic leading-snug text-muted-foreground">Hermes is thinking…</div>
              </div>
            )}
          </div>
          {/* text input — typing here talks to Hermes by text (no voice engine) unless a call is live */}
          <form onSubmit={sendText} className="flex shrink-0 flex-col gap-1.5 border-t border-border px-2.5 py-2">
            {!live && (
              <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                <Keyboard className="h-2.5 w-2.5" />
                Type-only — talks to Hermes · no voice, no cost
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={live ? "Message Hermes…" : "Message Hermes — no voice needed…"}
                className="ds-interactive min-w-0 flex-1 rounded-md bg-transparent px-1 text-xs text-foreground outline-none"
              />
              <Button type="submit" variant={draft.trim() ? "accent" : "outline"} size="icon-sm" disabled={!draft.trim()} className="rounded-full" aria-label="Send">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </form>
        </div>

        {/* drag handle — resize the chat panel */}
        <div
          onMouseDown={() => { dragW.current = true; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; }}
          className="group relative shrink-0 cursor-col-resize self-stretch"
          style={{ width: 7, zIndex: 20 }}
          title="Drag to resize chat"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-border-strong" />
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-[3px] opacity-30 transition-opacity group-hover:opacity-100">
            <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground" />
            <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground" />
            <span className="h-[3px] w-[3px] rounded-full bg-muted-foreground" />
          </div>
        </div>

        {/* CENTER — the living mind graph. .ds-stage: a WebGL/canvas visual sits on a
            fixed dark ground in both themes (docs/DESIGN-SYSTEM.md § 2 "Stage"). */}
        <div className="ds-stage relative min-w-0 flex-1">
          <div className="absolute inset-0" style={{ zIndex: 0 }}>
            {design === "aurora" ? (
              <StageAurora mode={displayMode} level={displayLevel} activeClusters={activeClusters} onTap={() => (callState === "off" ? startVoice() : endCall())} />
            ) : design === "cosmos" ? (
              <StageCosmos mode={displayMode} level={displayLevel} activeClusters={activeClusters} onTap={() => (callState === "off" ? startVoice() : endCall())} />
            ) : nodeMode === "atlas" ? (
              <HermesMind3D mode={displayMode} breath={breath} voiceLevel={displayLevel} activeClusters={hoverCluster ? [...activeClusters, hoverCluster] : activeClusters} onTapHub={tapHub} />
            ) : (
              <div className="w-full h-full" style={{ cursor: "pointer" }} onClick={() => (callState === "off" ? startVoice() : endCall())}>
                {nodeMode === "plasma" ? <OraclePlasma level={displayLevel} mode={displayMode} color={oracleColor} />
                  : nodeMode === "sonar" ? <OracleSonar level={displayLevel} mode={displayMode} color={oracleColor} />
                  : nodeMode === "rider" ? <OracleRider level={displayLevel} mode={displayMode} color={oracleColor} />
                  : <OracleWaveform level={displayLevel} mode={displayMode} color={oracleColor} />}
              </div>
            )}
          </div>
          <div className="pointer-events-none absolute left-4 top-4 z-[41]">
            <Badge tone={dispTone} className="h-7 gap-1.5 px-3 text-xs">
              <StatusDot tone={dispTone} pulse={live || attracting} label="" />
              {dispLabel}
            </Badge>
          </div>
          {/* telemetry HUD — the FUI command-center readouts (cinematic designs only) */}
          {design !== "classic" && (
            <div className="pointer-events-none absolute right-4 top-4 z-[41] hidden w-[190px] sm:block">
              <div className="overflow-hidden rounded-xl border border-border bg-popover/90 backdrop-blur">
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="ds-label flex items-center gap-1.5 text-muted-foreground">
                    <StatusDot tone={dispTone} pulse={live || attracting} label="" />
                    Neural core
                  </span>
                  <span className="text-xs text-muted-foreground">{live ? "Live" : attracting ? "Demo" : "Idle"}</span>
                </div>
                <div className="flex flex-col gap-2 px-3 py-2.5">
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Neural load</span><span className="ds-num text-foreground">{loadPct}%</span></div>
                    <div className="h-[3px] overflow-hidden rounded-full bg-inset"><div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${loadPct}%` }} /></div>
                  </div>
                  {(([["Capabilities", String(CAP_COUNT)], ["Clusters", String(CL.length)], ["Active", activeClusters.length ? activeClusters.map(clLabel).join(" · ") : "standby"], ["Channel", directMode ? "Hermes direct" : "Companion"]]) as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2 text-xs">
                      <span className="shrink-0 text-muted-foreground">{k}</span>
                      <span className={cn("truncate text-right", v === "standby" ? "text-muted-foreground" : "text-foreground")}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {/* cinematic boot reveal — systems coming online */}
          {design !== "classic" && showBoot && (
            <div className="pointer-events-none absolute inset-0 z-[42] grid place-items-center">
              <div className="text-center" style={{ animation: "ip-boot 2s ease forwards" }}>
                <div className="text-sm font-medium text-foreground">Initialising</div>
                <div className="mt-2 text-xs text-muted-foreground">neural core · {CAP_COUNT} capabilities online</div>
              </div>
            </div>
          )}
          {live && hermesWorking && (
            <div className="pointer-events-none absolute left-1/2 z-[42] -translate-x-1/2" style={{ bottom: 116 }}>
              <Badge tone="warn" className="h-7 gap-2 px-3 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking with Hermes…
              </Badge>
            </div>
          )}
          <div className="absolute bottom-7 left-1/2 z-[41] flex -translate-x-1/2 items-center justify-center gap-2.5">
            {live && (
              <Button
                type="button"
                variant="outline"
                onClick={toggleMute}
                className={cn("rounded-full", micMuted && "border-warn/50 bg-warn-soft text-warn")}
                aria-label={micMuted ? "Unmute your mic" : "Mute your mic"}
                title="Mute / unmute your mic (M)"
              >
                {micMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {micMuted ? "Unmute" : "Mute"}
              </Button>
            )}
            <Button
              type="button"
              variant={live ? "outline" : "accent"}
              onClick={() => (callState === "off" ? startVoice() : endCall())}
              disabled={callState === "connecting"}
              className={cn("rounded-full", live && "border-danger/50 bg-danger-soft text-danger")}
            >
              {callState === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" /> : live ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Mic className="h-4 w-4" />}
              {callState === "connecting" ? "Connecting…" : live ? "End voice" : "Talk to Hermes"}
            </Button>
          </div>
        </div>

      </div>

      {/* BOTTOM — nerve strip (classic Atlas only) */}
      {design === "classic" && nodeMode === "atlas" && (
      <div className="relative z-10 flex min-h-[62px] shrink-0 items-stretch border-t border-border">
        <div className="flex min-w-0 flex-1 items-stretch justify-end gap-2.5 px-2 py-2">
          {(() => { let gi = -1; return DOCK.map((cat) => {
            const liveN = cat.caps.filter((c) => active[c]?.status === "running").length;
            return (
              <div key={cat.key} className={cn("flex items-center justify-center gap-1.5 border-b-2 pb-1.5 transition-colors", liveN ? "border-brand" : "border-transparent")}>
                  {cat.caps.map((c) => {
                    gi++;
                    const st = active[c];
                    const concept = !!ICONS[c]?.face;
                    return (
                      <div
                        key={c}
                        className={cn(
                          "ds-interactive relative grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border transition-all",
                          entered ? "" : "nv-in",
                          st?.status === "running" ? "scale-110 border-brand bg-surface-raised opacity-100"
                            : st?.status === "done" ? "border-success/40 opacity-90"
                            : st?.status === "error" ? "border-danger/40 opacity-90"
                            : concept ? "border-transparent opacity-60 hover:opacity-100"
                            : "border-border bg-inset opacity-60 hover:border-border-strong hover:opacity-100",
                        )}
                        style={{ animationDelay: `${gi * 32}ms` }}
                        onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverCap({ name: NAMES[c] ?? c, x: r.left + r.width / 2, y: r.top, color: cat.color }); setHoverCluster(cat.key); }}
                        onMouseLeave={() => { setHoverCap(null); setHoverCluster(null); }}
                      >
                        <Cap cap={c} />
                        {st?.status === "running" && <StatusDot tone="accent" pulse label="" className="absolute -bottom-1 -right-1" />}
                        {st?.status === "done" && <span className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full border border-border bg-background text-xs text-success">✓</span>}
                        {st?.status === "error" && <span className="absolute -bottom-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full border border-border bg-background text-xs text-danger">!</span>}
                      </div>
                    );
                  })}
              </div>
            );
          }); })()}
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center gap-0.5 border-l border-border px-4">
          <span className="ds-label text-muted-foreground">Activity</span>
          <span className={cn("text-xs", runningCount > 0 ? "text-brand" : "text-muted-foreground")}>
            {runningCount > 0 ? `${runningCount} running` : `${recent.length} recent`}
          </span>
        </div>
      </div>
      )}
    </div>
  );
}
