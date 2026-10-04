/**
 * "Made in this video": the pieces built for the Motion Video, each with the
 * prompt that made it. Code pieces run live (the story loops and the coffee
 * B-roll are pure render(t) functions, loaded from /motion/made/code/); the
 * community collection excludes the branded and reference-led video samples.
 * Framework-free; browser-only for the live pieces.
 */
import { HOUSE_LINE } from "../engine/prompt";
import type { MotionStyle, Theme } from "../engine/types";

export type MadeSource =
  | { kind: "loop"; key: string }
  | { kind: "scene" }
  | { kind: "video"; src: string; poster: string };

export interface MadeItem {
  id: string;
  name: string;
  tagline: string;
  group: string;
  prompt: string;
  /** Loop length in seconds. */
  duration: number;
  source: MadeSource;
  /** Live pieces: an adapter that runs in the wall's runner. */
  style?: MotionStyle;
}

const BASE = "/motion/made";
const HORIZON: Theme = {
  bg: "#07080c",
  ink: "#faf9f5",
  accent: "#d97757",
  accent2: "#e3b23c",
  font: "Newsreader",
};

type LoopFn = { dur: number; render: (ctx: unknown, t: number, w: number, h: number) => void };
type SceneFn = { DUR: number; render: (ctx: unknown, t: number, w: number, h: number) => void };
const win = () =>
  (typeof window !== "undefined" ? window : {}) as {
    STORY_LOOPS?: Record<string, LoopFn>;
    SCENE?: SceneFn;
  };

// ── the live code ────────────────────────────────────────────────────────
const LOOP_FILES = [
  "shared.js",
  "level-1.js",
  "level-2.js",
  "level-3.js",
  "level-4.js",
  "level-5.js",
  "level-6.js",
  "level-7.js",
  "loop-firecrawl.js",
  "loop-levels.js",
  "loop-finale.js",
  "loop-proof.js",
];
const SCENE_FILES = ["broll-logos.js", "broll-scene.js"];

let loading: Promise<void> | null = null;
/** Load the story loops and the B-roll scene once (classic scripts, in order). */
export function loadMadeCode(): Promise<void> {
  if (loading) return loading;
  if (typeof document === "undefined") return Promise.resolve();
  loading = new Promise<void>((resolve) => {
    const files = [...LOOP_FILES, ...SCENE_FILES];
    let left = files.length;
    const done = () => {
      left--;
      if (left <= 0) resolve();
    };
    for (const f of files) {
      const s = document.createElement("script");
      s.src = `${BASE}/code/${f}`;
      s.async = false;
      s.onload = done;
      s.onerror = done;
      document.head.appendChild(s);
    }
    setTimeout(resolve, 15000);
  });
  return loading;
}

function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = HORIZON.bg;
  ctx.fillRect(0, 0, w, h);
}

function loopStyle(id: string, key: string, name: string, tagline: string, fallbackDur: number) {
  const s: MotionStyle = {
    id,
    name,
    look: tagline,
    move: tagline,
    rules: [],
    prompt: "",
    theme: HORIZON,
    tagline,
    get duration() {
      return win().STORY_LOOPS?.[key]?.dur ?? fallbackDur;
    },
    render(ctx, t, _theme, w, h) {
      const L = win().STORY_LOOPS?.[key];
      if (!L) return placeholder(ctx as CanvasRenderingContext2D, w, h);
      L.render(ctx, t, w, h);
    },
  };
  return s;
}

function sceneStyle(id: string, name: string, tagline: string) {
  const s: MotionStyle = {
    id,
    name,
    look: tagline,
    move: tagline,
    rules: [],
    prompt: "",
    theme: HORIZON,
    tagline,
    get duration() {
      return win().SCENE?.DUR ?? 10;
    },
    render(ctx, t, _theme, w, h) {
      const S = win().SCENE;
      if (!S) return placeholder(ctx as CanvasRenderingContext2D, w, h);
      S.render(ctx, t, w, h);
    },
  };
  return s;
}

// ── prompts ──────────────────────────────────────────────────────────────
const HORIZON_LOOK =
  "Horizon Strike on a dark screen: night #07080C ground with a dawn planet rim at the foot, ivory #FAF9F5 ink lines and paper, clay #D97757 as the one accent (under 3% of pixels), torn ochre paper and ink sketch as art touches, fine grain. Newsreader 500 at opsz 36 for words, Inter for tiny labels. At most 3 words on screen.";

function story(o: {
  title: string;
  words: string;
  setup: string;
  turn: string;
  payoff: string;
  seconds: number;
}) {
  return `R — References
• The Horizon Strike deck look: night ground, dawn planet rim, ivory ink, one clay accent, torn ochre paper.
• An engineer's field notebook: ink over pencil construction, compass sketches, paper collage.

I — Idea
${o.title}: a ${o.seconds}-second story loop in three beats, designed as a cycle (the frame at t = ${o.seconds} equals t = 0, no fade to black). Words on screen: "${o.words}".
• Set-up: ${o.setup}.
• Turn: ${o.turn}.
• Pay-off: ${o.payoff}.

S — Style
Looks: ${HORIZON_LOOK}
Moves: calm, precise and editorial; ink draws on along its path, eased in and out; one thing moves at a time; the clay accent does the work.
Rules:
1. One pure render(ctx, t, w, h) in a 1920x1080 design space, scaled to any 16:9 size.
2. Seeded hashes only, no Math.random; same t, same frame.
3. No third-party logos (abstract marks only).
4. Hold every word at least 1.2 s.
5. Grain and a soft vignette on every frame.

E — Examine
${HOUSE_LINE}`;
}

function level(r: string, i: string, s: string) {
  return `R — References
${r}

I — Idea
${i}

S — Style
${s}

E — Examine
${HOUSE_LINE}`;
}

const L4 = level(
  'My voiceover ends: "With enough coffee, anything is possible."',
  "A coffee cup whose steam draws a YouTube screen, an Instagram screen and an X post, each with a tiny living scene, then curls back into the cup.",
  "Looks dark editorial with warm coffee light. Moves smooth, 10 seconds, and the last frame matches the first. ONE scene that re-lays itself for 16:9, 9:16 and 1:1 (never a crop). Put const DRINK = 'coffee' at the top so I can change it.",
);
// Community examples contain only original live code scenes.

function made(item: Omit<MadeItem, "style">): MadeItem {
  const out: MadeItem = { ...item };
  if (item.source.kind === "loop")
    out.style = loopStyle(
      `made-${item.id}`,
      item.source.key,
      item.name,
      item.tagline,
      item.duration,
    );
  if (item.source.kind === "scene")
    out.style = sceneStyle(`made-${item.id}`, item.name, item.tagline);
  if (out.style) out.style.prompt = item.prompt;
  return out;
}

const loop = (key: string) => ({ kind: "loop" as const, key });

export const MADE: MadeItem[] = [
  made({
    id: "story-finale",
    name: "Motion Library",
    tagline: "The whole system in one loop",
    group: "Story loops",
    duration: 10,
    source: loop("finale"),
    prompt: story({
      title: "The payoff",
      words: "Motion Library, Launch",
      setup:
        "a dark app window with a left sidebar; the Motion Library tab lit at the lower left; seven live tiles",
      turn: "a cursor visits the tiles; a rough idea becomes a full prompt; a logo pulled from a URL drops into the brand slot",
      payoff: "Launch pulses in clay, then everything eases back to the start",
      seconds: 10,
    }),
  }),
  made({
    id: "story-1",
    name: "Slides that move",
    tagline: "A chart builds, bar by bar",
    group: "Story loops",
    duration: 10,
    source: loop("1"),
    prompt: story({
      title: "Presentations",
      words: "Slides that move",
      setup:
        "an ivory slide on the dark screen; the chart builds bar by bar, its trend line drawing itself",
      turn: "the slide glides into a presentation window drawn in ink, where the same loop plays again",
      payoff:
        "the camera pushes back into the slide; the chart settles to its baseline; back to the start",
      seconds: 10,
    }),
  }),
  made({
    id: "story-2",
    name: "Sites that live",
    tagline: "A voice wave turns into birds",
    group: "Story loops",
    duration: 10,
    source: loop("2"),
    prompt: story({
      title: "Website",
      words: "Sites that live",
      setup:
        "a browser frame inks itself over its pencil sketch while the brand is pulled from the URL",
      turn: "a voice wave rises in the hero; its peaks lift off as birds that land and become the typed headline",
      payoff:
        "a footer wordmark writes itself and drifts; the words take flight and the ink lifts back to pencil",
      seconds: 10,
    }),
  }),
  made({
    id: "story-3",
    name: "Use them together",
    tagline: "Graphic above, captions below",
    group: "Story loops",
    duration: 9,
    source: loop("3"),
    prompt: story({
      title: "The reel",
      words: "Use them together",
      setup:
        "a phone between two sources: a graphic sketch on torn ochre paper and a talking-head sketch on ivory",
      turn: "the top half pops the graphic as two marks pull together and lock; the bottom half is the face, talking",
      payoff:
        "the caption words light up one at a time as they are spoken; then it all relaxes back",
      seconds: 9,
    }),
  }),
  made({
    id: "story-4",
    name: "Any size",
    tagline: "One scene in every ratio",
    group: "Story loops",
    duration: 9,
    source: loop("4"),
    prompt: story({
      title: "B-roll",
      words: "Any size",
      setup: "one 16:9 frame: a coffee cup on a table, its steam rising toward the words",
      turn: "the frame morphs 16:9, 9:16, 1:1 while the scene re-lays itself inside (never a crop)",
      payoff: "back to 16:9; the steam never stops, it is the thread through every size",
      seconds: 9,
    }),
  }),
  made({
    id: "story-5",
    name: "Logo + jingle",
    tagline: "A logo strikes on the beat",
    group: "Story loops",
    duration: 9,
    source: loop("5"),
    prompt: story({
      title: "Logo + jingle",
      words: "Logo + jingle",
      setup: "an address bar above a faint mark outline; the logo is read from the URL",
      turn: "the logo flies out of the address bar, grows and strikes in: a dawn horizon inside a disc",
      payoff:
        "sound rings pulse out on the jingle's beat (da, da, da-da, DAA); it settles, glows and dims back",
      seconds: 9,
    }),
  }),
  made({
    id: "story-6",
    name: "Unlimited styles",
    tagline: "A wall of styles, one picked",
    group: "Story loops",
    duration: 10,
    source: loop("6"),
    prompt: story({
      title: "Motion Library",
      words: "Unlimited styles",
      setup: "a wall of tiny tiles, every one a different style, all animating",
      turn: "a cursor glides in and picks one; it grows into a large live preview while the wall dims",
      payoff: "Launch; a clay pulse; the preview settles back into the wall and the cursor leaves",
      seconds: 10,
    }),
  }),
  made({
    id: "story-7",
    name: "×100",
    tagline: "A hundred brands in one wave",
    group: "Story loops",
    duration: 10,
    source: loop("7"),
    prompt: story({
      title: "At scale",
      words: "×100",
      setup: "a list of URLs scrolls past a scan line that reads each one",
      turn: "the list speeds up; tiles pop into a 10x10 grid in a diagonal wave, each a different brand colour",
      payoff:
        "×100 counts up with the grid and holds; the wave clears and the list slows back to reading pace",
      seconds: 10,
    }),
  }),
  made({
    id: "story-firecrawl",
    name: "URL in. Brand out.",
    tagline: "A site read into a brand card",
    group: "Story loops",
    duration: 10,
    source: loop("firecrawl"),
    prompt: story({
      title: "Firecrawl",
      words: "URL in. Brand out.",
      setup: "a URL is typed into an address bar that carries a scanner chip",
      turn: "the page loads; a flame scans it top to bottom and marks the logo, the type and the colours",
      payoff:
        "the logo, three colours and a type specimen fly out and settle into a clean brand card; then it eases back",
      seconds: 10,
    }),
  }),
  made({
    id: "story-levels",
    name: "Seven levels",
    tagline: "Seven loops on one rising path",
    group: "Story loops",
    duration: 10,
    source: loop("levels"),
    prompt: story({
      title: "Levels",
      words: "none (the headline sits above)",
      setup:
        "a rising path with seven stations, each its level's real loop running in a small card",
      turn: "a clay pulse travels the path and lights each station as it passes",
      payoff: "the light moves on and wraps to the start; one pass per loop",
      seconds: 10,
    }),
  }),
  made({
    id: "story-proof",
    name: "Opus 5.5, in one graphic",
    tagline: "Three facts, three beats",
    group: "Story loops",
    duration: 10,
    source: loop("proof"),
    prompt: story({
      title: "Proof",
      words: "at most 6 per beat",
      setup: 'the Opus 5.5 bar rises to the Fable 5.1 line: "Fable 5.1 level, on most work"',
      turn: 'the Opus 5 row appears as the base; Opus 5.5 drops to 60% of it: "40% cheaper, vs Opus 5"',
      payoff: 'Opus 5.5 runs past the Opus 5 end: "30%+ faster, vs Opus 5"; linear bars from zero',
      seconds: 10,
    }),
  }),
  made({
    id: "broll",
    name: "Coffee B-roll",
    tagline: "Steam draws three screens",
    group: "B-roll",
    duration: 10,
    source: { kind: "scene" },
    prompt: L4,
  }),

];

export function madeById(id: string): MadeItem | undefined {
  return MADE.find((m) => m.id === id);
}
