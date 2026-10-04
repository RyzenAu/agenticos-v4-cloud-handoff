import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Video } from "lucide-react";
import { Button, EmptyState, PageHeader, Surface } from "@/components/ds";

export const Route = createFileRoute("/transitions")({
  head: () => ({
    meta: [
      { title: docTitle("/transitions") },
      { name: "description", content: "Preview a local video clip in the browser." },
    ],
  }),
  component: TransitionsPage,
});

// ── Transition lab ──────────────────────────────────────────────────────
// A local-only clip previewer: choose a video file from this device and
// play it back. Nothing is uploaded, generated or exported. This used to be
// embedded as a self-contained static page (public/transitions/index.html)
// with its own hero-style chrome ("COMMUNITY EDITION / TRANSITION LAB" +
// display heading), which broke the one-accent/no-marketing-voice rules
// (docs/DESIGN-SYSTEM.md #4, #7). Same behaviour, now the standard
// PageHeader + EmptyState anatomy used on /dashboard, /automations and
// /settings.
function TransitionsPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  function handleFile(selected: File | null) {
    if (!selected) return;
    if (!selected.type.startsWith("video/")) {
      setError("Choose a video file.");
      return;
    }
    if (url) URL.revokeObjectURL(url);
    setError("");
    setFile(selected);
    setUrl(URL.createObjectURL(selected));
  }

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title="Transition lab"
        description="Preview a local clip in the browser. Nothing is uploaded, generated or exported here."
      />
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="sr-only"
        aria-label="Choose a local clip"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
      />
      {!url ? (
        <EmptyState
          icon={Video}
          title="No clip loaded"
          body={error || "Choose a video file from this device to preview it here."}
          action={
            <Button variant="accent" onClick={() => inputRef.current?.click()}>
              Choose a local clip
            </Button>
          }
        />
      ) : (
        <Surface padding="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{file?.name}</div>
              <div className="text-xs text-muted-foreground">Local preview · not uploaded</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              Choose a different clip
            </Button>
          </div>
          <video
            key={url}
            src={url}
            controls
            playsInline
            className="mt-4 w-full rounded-lg bg-inset"
            style={{ maxHeight: "60vh" }}
            onError={() => setError("This browser could not play the clip. Try an MP4 with H.264 video.")}
          />
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </Surface>
      )}
    </div>
  );
}
