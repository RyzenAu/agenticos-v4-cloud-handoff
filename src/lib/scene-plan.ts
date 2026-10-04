/** Scene timing adapted from V4.4's reel validation; existing Motion renders each selected scene. */
export type SceneDraft = { id: string; title: string; seconds: number; words: string; visual: string };
export type TimedScene = SceneDraft & { start: number; end: number };
export function timeScenes(value: unknown): TimedScene[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error("Use 1 to 12 scenes.");
  const ids = new Set<string>();
  let start = 0;
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.id) || ids.has(raw.id)) throw new Error("Each scene needs a unique identifier.");
    if (typeof raw.seconds !== "number" || !Number.isInteger(raw.seconds) || raw.seconds < 3 || raw.seconds > 60) throw new Error("Each scene must last 3 to 60 whole seconds.");
    for (const field of ["title", "words", "visual"]) {
      if (typeof raw[field] !== "string" || raw[field].length > (field === "title" ? 120 : 2000)) throw new Error("Keep scene titles under 120 characters and script or visual notes under 2,000.");
    }
    if (!raw.title.trim() || !raw.visual.trim()) throw new Error("Give each scene a title and visual direction.");
    ids.add(raw.id);
    const end = Math.round((start + raw.seconds) * 1000) / 1000;
    if (end > 600) throw new Error("Keep the complete plan under 10 minutes.");
    const scene = { id: raw.id, title: raw.title.trim(), seconds: raw.seconds, words: raw.words.trim(), visual: raw.visual.trim(), start, end };
    start = end;
    return scene;
  });
}
export function scenePrompt(scene: TimedScene): string {
  return `Create this scene using the selected brand and motion style.\nScene: ${scene.title}\nDuration: ${scene.seconds} seconds (${scene.start}–${scene.end}s in the full film).\nSpoken script: ${scene.words || "Silent scene"}\nVisual direction: ${scene.visual}\nLeave time for the words and visuals to be understood. Do not add product claims. This is one scene; preserve its place in the plan.`;
}
export function readingPace(scene: Pick<SceneDraft, "words" | "seconds">): number {
  return scene.seconds > 0 ? Math.round((scene.words.trim().match(/\S+/g)?.length ?? 0) * 60 / scene.seconds) : 0;
}
