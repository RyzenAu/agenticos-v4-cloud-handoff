import { useEffect, useId, useState } from "react";
import { Button, Notice } from "@/components/ds";
import { readingPace, scenePrompt, timeScenes, type SceneDraft } from "@/lib/scene-plan";

const KEY = "mu.motion.scene-plan.v1";
const blank = (): SceneDraft => ({ id: crypto.randomUUID(), title: "New scene", seconds: 10, words: "", visual: "" });
export function ScenePlanner({ onUse }: { onUse: (prompt: string, seconds: number) => void }) {
  const id = useId();
  const [scenes, setScenes] = useState<SceneDraft[]>([]);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    try { const raw = localStorage.getItem(KEY); if (raw) setScenes(timeScenes(JSON.parse(raw))); }
    catch { setNotice("The saved plan couldn't be read. It is preserved until you explicitly save a replacement."); }
    setReady(true);
  }, []);
  let timed: ReturnType<typeof timeScenes> = [], error = "";
  try { if (scenes.length) timed = timeScenes(scenes); } catch (e) { error = (e as Error).message; }
  const patch = (index: number, changes: Partial<SceneDraft>) => setScenes((rows) => rows.map((row, i) => i === index ? { ...row, ...changes } : row));
  const move = (index: number, offset: number) => setScenes((rows) => { const next = [...rows]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; });
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(timeScenes(scenes))); setNotice("Plan saved in this browser. No generation started."); }
    catch (e) { setNotice(`Couldn't save: ${(e as Error).message}`); }
  };
  const exportPlan = () => {
    const blob = new Blob([JSON.stringify({ version: 1, scenes: timed }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "mu-scene-plan.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const field = "min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <section aria-label="Scene planner" className="mx-auto max-w-5xl space-y-6 py-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Plan the film before generating</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Write the script, set the pace and review each scene. Send a scene to the existing composer when it is ready.</p></div><Button variant="outline" onClick={() => setScenes((s) => [...s, blank()])} disabled={!ready || scenes.length >= 12}>Add scene</Button></div>
    {!ready ? <p role="status">Reading your saved plan…</p> : !scenes.length ? <p className="text-muted-foreground">No scenes yet. Add your opening scene to begin.</p> : <>
      <p role="status" className="text-sm text-muted-foreground">{scenes.length} scenes{timed.length ? ` · ${timed.at(-1)!.end} seconds total · continuous timing` : " · timing needs attention"}</p>
      <ol className="divide-y divide-border">{scenes.map((scene, i) => <li key={scene.id} className="space-y-4 py-6 first:pt-0">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Scene {i + 1}{timed[i] && <span className="ml-3 text-sm font-normal text-muted-foreground">{timed[i].start}–{timed[i].end}s</span>}</h3><div className="flex flex-wrap gap-2"><Button variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move scene ${i + 1} earlier`}>Earlier</Button><Button variant="ghost" disabled={i === scenes.length - 1} onClick={() => move(i, 1)} aria-label={`Move scene ${i + 1} later`}>Later</Button><Button variant="ghost" onClick={() => setScenes((s) => s.filter((r) => r.id !== scene.id))} aria-label={`Remove scene ${i + 1}`}>Remove</Button></div></div>
        <div className="grid gap-4 sm:grid-cols-[1fr_140px]"><div><label htmlFor={`${id}-${i}-title`} className="mb-1 block text-sm">Title</label><input id={`${id}-${i}-title`} className={field} value={scene.title} maxLength={120} onChange={(e) => patch(i, { title: e.target.value })} /></div><div><label htmlFor={`${id}-${i}-duration`} className="mb-1 block text-sm">Seconds</label><input id={`${id}-${i}-duration`} type="number" min={3} max={60} step={1} className={field} value={Number.isFinite(scene.seconds) ? scene.seconds : ""} onChange={(e) => patch(i, { seconds: e.target.valueAsNumber })} /></div></div>
        <div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor={`${id}-${i}-script`} className="mb-1 block text-sm">Spoken script · optional</label><textarea id={`${id}-${i}-script`} rows={3} maxLength={2000} className={field} value={scene.words} onChange={(e) => patch(i, { words: e.target.value })} /></div><div><label htmlFor={`${id}-${i}-visual`} className="mb-1 block text-sm">Visual direction</label><textarea id={`${id}-${i}-visual`} rows={3} maxLength={2000} className={field} value={scene.visual} onChange={(e) => patch(i, { visual: e.target.value })} /></div></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{scene.words.trim() ? `${readingPace(scene)} words/minute${readingPace(scene) > 170 ? " · consider more time for a calm delivery" : " · pacing estimate"}` : "Silent scene"}</p><Button variant="outline" disabled={!timed[i]} onClick={() => onUse(scenePrompt(timed[i]), timed[i].seconds)}>Use scene {i + 1} in composer</Button></div>
      </li>)}</ol>
      {error && <Notice tone="warn">{error}</Notice>}
      <div className="flex flex-wrap gap-3"><Button disabled={!timed.length} onClick={save}>Save plan</Button><Button variant="outline" disabled={!timed.length} onClick={exportPlan}>Export plan</Button></div>
    </>}
    <Button variant="ghost" disabled={!ready} onClick={() => { try { localStorage.removeItem(KEY); setNotice("Saved copy cleared. Your current scenes remain available until you leave this page."); } catch { setNotice("Couldn't clear the saved copy. Browser storage is unavailable."); } }}>Clear saved copy</Button>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
  </section>;
}
