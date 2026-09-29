// The Command scene's focus return, kept apart from scene-status so the always-loaded host stays tiny (the
// scene itself loads lazily). Pure; bun-tested.
// ── Focus return (REVIEW-T1 R2, low item) ─────────────────────────────────────────────────────────
// The scene has no Radix Trigger, so Radix's close focus had nowhere to go and Escape dropped focus to
// <body>. The host remembers what had focus when the scene opened and the scene returns focus there.
type Focusable = { focus: (o?: FocusOptions) => void; isConnected: boolean; closest: (s: string) => unknown; tagName: string };

/** What had focus when the scene opened, unless that was <body> or a dialog that is closing (the palette). Pure. */
export function sceneOpener(active: Element | null | undefined): HTMLElement | null {
  const el = active as unknown as Focusable | null | undefined;
  if (!el || typeof el.focus !== "function" || el.tagName === "BODY" || el.tagName === "HTML") return null;
  if (el.closest(".cs-stage, .cp-dialog, [role='dialog']")) return null;
  return el as unknown as HTMLElement;
}

/** Where focus goes when the scene closes: the opener if it's still on the page, else the page's scene button, else the palette trigger. */
export function sceneReturnTarget(opener: HTMLElement | null, doc: Pick<Document, "querySelector">): HTMLElement | null {
  if (opener?.isConnected) return opener;
  return doc.querySelector<HTMLElement>("[data-command-scene-trigger]") ?? doc.querySelector<HTMLElement>(".cp-trigger");
}
