/**
 * Motion library → "M&U kit" tab (W-F, 29 Sep 2026): ready-to-use web motion in M&U black and gold. Each
 * card is a live preview of the exact snippet you copy (a sandboxed iframe: scripts only, no same-origin,
 * no network but Google Fonts), with a Full / Reduced motion switch, Replay, and Copy HTML / Copy React.
 * Previews run only while their card is on screen.
 */
import { Atom, Code2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Disclosure, Segmented } from "@/components/ds";
import { htmlSnippet, previewDoc, reactSnippet, searchKit, type KitPiece } from "@/motion/kit";
import { copyText } from "./api";

type Motion = "full" | "reduced";

function osPrefersReduced(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

export function KitCard({
  piece,
  initialMotion,
  notify,
}: {
  piece: KitPiece;
  initialMotion: Motion;
  notify: (message: string) => void;
}) {
  const [motion, setMotion] = useState<Motion>(initialMotion);
  const [visible, setVisible] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  // Only previews on (or near) the screen run; the rest are unmounted to keep the page light.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
      rootMargin: "240px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const doc = useMemo(() => previewDoc(piece, { reduced: motion === "reduced" }), [piece, motion]);
  const html = useMemo(() => htmlSnippet(piece), [piece]);
  const react = useMemo(() => reactSnippet(piece), [piece]);
  const copy = async (text: string, what: string) =>
    notify(
      (await copyText(text)) ? `${piece.name}: ${what} copied.` : "Couldn't reach the clipboard.",
    );

  return (
    <article
      data-kit={piece.id}
      aria-labelledby={`kit-${piece.id}-title`}
      className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
    >
      <div ref={box} className="relative aspect-[16/10] w-full bg-[#080808]">
        {visible && (
          <iframe
            ref={frame}
            title={`${piece.name}, live preview${motion === "reduced" ? " with reduced motion" : ""}`}
            srcDoc={doc}
            sandbox="allow-scripts"
            className="absolute inset-0 size-full border-0"
          />
        )}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-black/65 px-2.5 py-1 text-xs font-medium text-[#f3efe6] backdrop-blur-sm">
            {piece.category}
          </span>
          {motion === "reduced" && (
            <span className="rounded-full bg-black/65 px-2.5 py-1 text-xs text-[#e4c887] backdrop-blur-sm">
              Reduced motion
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h3 id={`kit-${piece.id}-title`} className="text-lg font-semibold leading-snug">
            {piece.name}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{piece.tagline}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel={`Motion for ${piece.name}`}
            value={motion}
            onChange={setMotion}
            options={[
              { value: "full", label: "Full motion" },
              { value: "reduced", label: "Reduced" },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            onClick={() => frame.current?.contentWindow?.postMessage("mu-kit:replay", "*")}
            disabled={!visible}
          >
            <RotateCcw /> Replay
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            onClick={() => void copy(html, "HTML")}
          >
            <Code2 /> Copy HTML
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full"
            onClick={() => void copy(react, "React component")}
          >
            <Atom /> Copy React
          </Button>
        </div>

        <div className="-mx-3 mt-auto flex flex-col">
          <Disclosure summary={<span className="font-medium">How it moves</span>}>
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Motion</dt>
                <dd className="mt-0.5 leading-relaxed">{piece.move}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reduced motion</dt>
                <dd className="mt-0.5 leading-relaxed">{piece.reduced}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Use it for</dt>
                <dd className="mt-0.5 leading-relaxed">{piece.useFor}</dd>
              </div>
              {piece.sampleCopy && (
                <p className="rounded-xl bg-inset px-3 py-2 text-xs text-muted-foreground">
                  The words and figures are samples. Replace them with sourced copy before it goes
                  on a site.
                </p>
              )}
            </dl>
          </Disclosure>
          <Disclosure
            summary={<span className="font-medium">Show the HTML</span>}
            meta={`${html.split("\n").length} lines`}
          >
            <pre
              className="max-h-72 overflow-auto rounded-xl bg-inset p-3 font-mono text-xs leading-relaxed text-muted-foreground"
              tabIndex={0}
              aria-label={`${piece.name} HTML`}
            >
              {html}
            </pre>
          </Disclosure>
        </div>
      </div>
    </article>
  );
}

export function KitTab({ query, notify }: { query: string; notify: (message: string) => void }) {
  const pieces = useMemo(() => searchKit(query), [query]);
  // Previews start the way this person's system asks (Reduced if it prefers reduced motion).
  const [initial] = useState<Motion>(() => (osPrefersReduced() ? "reduced" : "full"));
  return (
    <>
      <p className="ml-lede">
        Ready-to-use motion for M&U sites, in black and gold. Each piece is plain HTML and CSS with
        a few lines of script where it needs them, plays once as it scrolls into view, and has a
        reduced-motion fallback. Copy it as HTML or as a React component.
      </p>
      <div className="grid gap-4 md:grid-cols-2 lg:gap-6 xl:grid-cols-3">
        {pieces.map((p) => (
          <KitCard key={p.id} piece={p} initialMotion={initial} notify={notify} />
        ))}
      </div>
      {!pieces.length && <p className="ml-empty">No kit piece matches “{query}”.</p>}
    </>
  );
}
