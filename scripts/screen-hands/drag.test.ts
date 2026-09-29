// Teach Mode drags (25 Sep): a field onto an area, a slider along its track, a clip on a timeline.
import { describe, expect, test } from "bun:test";
import type { WindowInfo } from "../jarvis-skills/windows";
import { FLAGS_OFF } from "./flags";
import type { Hands } from "./index";
import { createLesson, type LessonMinds } from "./lesson";
import type { Overlay } from "./overlay";
import type { Snapshot, UiElement } from "./plan";
import { dropPoint, judgeDrag, parseLessonAction, parseCoachPlan, stepLine } from "./teach";

let id = 1;
const el = (type: string, name: string, x: number, y: number, extra: Partial<UiElement> = {}): UiElement => ({
  id: id++, type, x, y, w: 100, h: 30, password: false, enabled: true, focused: false, hasValue: false, readOnly: false, name, aid: "", help: "", value: "", ...extra,
});
const snap = (elements: UiElement[]): Snapshot => ({ window: { x: 0, y: 0, w: 1200, h: 800 }, elements, focused: null, browser: false });
const WIN: WindowInfo = { handle: 5, process: "msedge", cls: "x", title: "Drag bench" };

describe("drag: the pure parts", () => {
  test("the planner and the coach can say drag", () => {
    expect(parseLessonAction('{"do":"drag","id":3,"to":7}')).toEqual({ do: "drag", id: 3, to: 7 });
    expect(parseLessonAction('{"do":"drag","id":3,"percent":80}')).toEqual({ do: "drag", id: 3, percent: 80 });
    expect(parseLessonAction('{"do":"drag","id":3}')).toBeNull();
    expect(parseCoachPlan('{"steps":[{"do":"drag","label":"Region","to":"Rows"}]}', "m", 1)?.steps[0]).toMatchObject({ do: "drag", label: "Region", to: "Rows" });
  });
  test("drop point and lines", () => {
    const zoom = el("Slider", "Zoom", 100, 200, { w: 200 });
    expect(dropPoint({ to: zoom, percent: 80 })).toEqual({ x: 260, y: 215 });
    const field = el("Button", "Region", 10, 10);
    const rows = el("List", "Rows area", 400, 100, { w: 200, h: 150 });
    expect(stepLine({ do: "drag", element: field, to: rows }, snap([]).window, "teach")).toMatch(/^Drag Region, .+, to Rows area\. Hold the mouse button down all the way\.$/);
    expect(stepLine({ do: "drag", element: zoom, to: zoom, percent: 80 }, snap([]).window, "drive")).toBe("Dragging Zoom to 80%.");
  });
  test("judgeDrag: landed in the area, a slider's value moved, a clip moved along; nothing else counts", () => {
    const field = el("Button", "Region", 10, 10);
    const rows = el("List", "Rows area", 400, 100, { w: 200, h: 150 });
    const before = snap([field, rows]);
    expect(judgeDrag({ do: "drag", element: field, to: rows }, before, snap([field, rows, el("ListItem", "Region", 410, 110)])).advanced).toBe(true);
    expect(judgeDrag({ do: "drag", element: field, to: rows }, before, snap([field, rows])).advanced).toBe(false);
    const zoom = el("Slider", "Zoom", 100, 200, { value: "50" });
    expect(judgeDrag({ do: "drag", element: zoom, to: zoom, percent: 80 }, snap([zoom]), snap([{ ...zoom, value: "80" }])).advanced).toBe(true);
    const clip = el("Button", "Clip 1", 100, 300);
    expect(judgeDrag({ do: "drag", element: clip, to: clip, percent: 50 }, snap([clip, field]), snap([{ ...clip, x: 400 }, field])).advanced).toBe(true);
  });
});

function fakeOverlay(log: string[]): Overlay {
  return {
    glide: async (p) => void log.push(`glide ${p.x},${p.y}`), ring: () => undefined, caption: () => undefined, tap: () => void log.push("tap"), flash: () => undefined, hide: () => undefined, watch: () => undefined,
    onClick: () => () => undefined, follow: () => undefined, home: () => undefined, thinking: () => undefined, stat: async () => null, excludeFromCapture: async () => true, warm: () => undefined, pid: () => null, affinity: true, close: () => undefined,
  };
}
function world(extraTarget?: UiElement) {
  const field = el("Button", "Region", 10, 10);
  const rows = extraTarget ?? el("List", "Rows area", 400, 100, { w: 200, h: 150 });
  const elements = [field, rows];
  const log: string[] = [];
  const drop = () => void elements.push(el("ListItem", "Region", 410, 110));
  const hands: Hands = {
    foreground: async () => WIN, windows: async () => [WIN], focus: async () => true,
    snapshot: async () => snap(elements.map((e) => ({ ...e }))), focused: async () => null, at: async () => null,
    click: async () => undefined, type: async () => undefined, keys: async () => undefined, wheel: async () => undefined, capture: async () => null,
    probe: async () => ({ front: WIN.handle, title: WIN.title, focused: null, at: null }),
    drag: async (_h, from, to) => {
      log.push(`drag ${from.x},${from.y} -> ${to.x},${to.y}`);
      drop();
    },
  };
  const minds: LessonMinds = {
    next: async (i) => {
      if (i.history.length) return { do: "done", say: "Region's in Rows." };
      const idOf = (label: string) => Number(i.elements.split("\n").find((l) => l.includes(`"${label}"`))?.split(" ")[0] ?? -1);
      return { do: "drag", id: idOf("Region"), to: idOf(labelOfTarget(rows)) };
    },
  };
  return { hands, minds, log, drop, rows };
}
const labelOfTarget = (e: UiElement) => e.name;
const fast = { flags: () => FLAGS_OFF, pollMs: 5, fullEveryMs: 10, settleMs: 1, replyMs: 3000, coachWaitMs: 5, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))) };

describe("drag lessons", () => {
  test("show: Jarvis drags it (a real press, move, release) and it's verified", async () => {
    const w = world();
    const olog: string[] = [];
    const lesson = createLesson({ goal: "put Region in Rows", mode: "drive", style: "show" }, { hands: w.hands, overlay: fakeOverlay(olog), minds: w.minds, ...fast });
    const done = await lesson.finished;
    expect(done.ok).toBe(true);
    expect(w.log).toEqual(["drag 60,25 -> 500,175"]);
    expect(done.results?.[0]).toMatchObject({ did: 'I dragged "Region" to "Rows area"', status: "verified" });
  });
  test("guide: the cursor shows the drag, then his own drag is noticed", async () => {
    const w = world();
    const olog: string[] = [];
    const lesson = createLesson({ goal: "put Region in Rows", mode: "teach", style: "guide" }, { hands: w.hands, overlay: fakeOverlay(olog), minds: w.minds, ...fast });
    expect((await lesson.started).said).toMatch(/^Drag Region/);
    expect(olog).toEqual(expect.arrayContaining(["glide 60,25", "tap", "glide 500,175"]));
    w.drop();
    const done = await lesson.finished;
    expect(done.results?.[0]).toMatchObject({ by: "he", status: "verified" });
    expect(w.log).toEqual([]);
  });
  test("a drop onto a bin needs his yes; nothing is dragged without it", async () => {
    const w = world(el("List", "Recycle Bin", 400, 100, { w: 200, h: 150 }));
    const lesson = createLesson({ goal: "bin Region", mode: "drive", style: "show" }, { hands: w.hands, overlay: fakeOverlay([]), minds: w.minds, ...fast });
    expect(await lesson.started).toMatchObject({ state: "confirm", confirm: "Recycle Bin" });
    lesson.stop();
    expect(w.log).toEqual([]);
  });
});

describe("a planned click that is really a drag", () => {
  test("dragFromGoal", async () => {
    const { dragFromGoal } = await import("./teach");
    const zoom = el("Slider", "Zoom", 100, 200, { w: 200 });
    const clip = el("Button", "Clip 1", 100, 300);
    const track = el("List", "Timeline", 100, 290, { w: 600, h: 50 });
    const rows = el("List", "Rows area", 400, 100);
    const region = el("Button", "Region", 10, 10);
    const s = snap([zoom, clip, track, rows, region]);
    expect(dragFromGoal("set the Zoom slider to about 80 percent", zoom, s)).toMatchObject({ do: "drag", percent: 80 });
    expect(dragFromGoal("move Clip 1 to the middle of the Timeline", clip, s)).toMatchObject({ do: "drag", to: { name: "Timeline" }, percent: 50 });
    expect(dragFromGoal("put the Region field in the Rows area", region, s)).toMatchObject({ do: "drag", to: { name: "Rows area" } });
    expect(dragFromGoal("put the Region field in the Rows area", rows, s)).toMatchObject({ do: "drag", element: { name: "Region" }, to: { name: "Rows area" } });
    expect(dragFromGoal("open the Region settings", region, s)).toBeNull();
    expect(dragFromGoal("click Zoom", zoom, s)).toBeNull();
  });
});
