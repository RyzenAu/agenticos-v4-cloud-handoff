/**
 * HermesDocumentsGallery — visual gallery of artefacts produced through
 * the Hermes stack (invoices, HTML overviews, images, markdown drops,
 * exported PDFs, video clips). Source folder: ~/Documents/Hermes/.
 *
 * Backend: GET /__hermes_documents (list), GET /__hermes_documents/file
 * (stream one for preview), DELETE /__hermes_documents (remove from
 * disk). All loopback-only, defined in vite.config.ts.
 *
 * Visual language: the shared Agentic OS design system (docs/DESIGN-SYSTEM.md)
 * — dark neutral surfaces, one accent, Inter + JetBrains Mono, honest empty
 * states. This page carries no agent-specific theme of its own.
 *
 * Live updates: polls every 5 seconds so anything dropped into the
 * folder appears in the gallery without a manual refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Image as ImageIcon,
  FileCode2,
  Trash2,
  X,
  Folder,
  RefreshCw,
  Film,
  Music,
  Archive as ArchiveIcon,
  FileJson,
  FileType2,
  File as FileGeneric,
  ExternalLink,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Search,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Section,
  Skeleton,
  Surface,
  fmtCount,
  fmtRelative,
} from "@/components/ds";

interface Doc {
  name: string;
  type: string; // image | pdf | html | markdown | text | data | video | audio | archive | code | other
  ext: string;
  sizeBytes: number;
  modifiedMs: number;
  // Title + description are populated by the backend metadata parser
  // (see parseDocMeta in vite.config.ts). Either may be null when the
  // file doesn't embed them — the card falls back to a humanized
  // filename + a generic per-type blurb in that case.
  title: string | null;
  description: string | null;
}

interface DocsResponse {
  folder: string;
  items: Doc[];
  // Count of items in ~/Documents/Hermes/.trash/ — populated by the
  // backend so the frontend can conditionally render the Trash link
  // without an extra round trip.
  trashCount: number;
}

// One entry in the trash modal. trashId is the on-disk filename inside
// .trash/ ({timestamp}__{originalName}), used for restore/purge.
interface TrashItem {
  trashId: string;
  originalName: string;
  deletedMs: number;
  sizeBytes: number;
}

interface TrashResponse {
  items: TrashItem[];
}

// Module-level stacking counter for body scroll lock. Three modals can
// be open simultaneously (preview + trash + install-prompt would be
// pathological but possible); per-modal snapshot/restore races if they
// close out of order — the second-to-close restores an "unlocked"
// snapshot taken before the first one mounted, leaving the page locked
// forever. A single counter keyed on mounts makes the lock idempotent:
// first mount locks, last unmount restores.
let __scrollLockCount = 0;
let __scrollLockPrevOverflow = "";
let __scrollLockPrevPadding = "";

function lockBodyScroll(): void {
  if (__scrollLockCount === 0) {
    __scrollLockPrevOverflow = document.body.style.overflow;
    __scrollLockPrevPadding = document.body.style.paddingRight;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }
  __scrollLockCount += 1;
}

function unlockBodyScroll(): void {
  __scrollLockCount = Math.max(0, __scrollLockCount - 1);
  if (__scrollLockCount === 0) {
    document.body.style.overflow = __scrollLockPrevOverflow;
    document.body.style.paddingRight = __scrollLockPrevPadding;
  }
}

// Hook wrapper so the three modals each have one line for scroll lock.
function useBodyScrollLock(): void {
  useEffect(() => {
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, []);
}

// Default visible-card cap. Anything beyond this collapses behind a
// "Show all N" toggle so a 24-file gallery doesn't blow out the page.
// Picked to fit cleanly on the grid breakpoints (3 cols × 4 rows on lg,
// 4 cols × 3 rows on xl).
const DEFAULT_VISIBLE = 12;

// The exact prompt a new operator pastes into their Hermes agent so it
// starts writing every artefact into ~/Documents/Hermes/. Lives in the
// component (not a separate doc) so the gallery itself is the onboarding
// surface — install Hermes, open the gallery, copy this, paste it.
const HERMES_GALLERY_PROMPT = `From now on, save artefacts you generate FOR ME into ~/Documents/Hermes/ so they show up in my Documents gallery.

WHEN TO SAVE HERE
  ✓ HTML overviews, decks, reports, invoices
  ✓ PDFs (generated or downloaded for me to read)
  ✓ Markdown notes, digests, summaries
  ✓ Generated images — charts, diagrams, portraits, exports
  ✓ Audio/video clips you produced or recorded
  ✓ JSON/CSV/YAML exports of structured data I asked you to surface
  ✓ Anything I'd want to see, share, preview, or revisit later

WHEN NOT TO SAVE HERE
  ✗ Files that belong inside a project — if you're working in a GitHub repo or codebase, write to that repo's directory, NOT here
  ✗ Build artifacts, dist/, node_modules/, generated lockfiles
  ✗ Temp/scratch/working copies — keep those in /tmp or alongside the source
  ✗ Logs, dumps, traces, telemetry — those go in ~/.hermes/log/
  ✗ System files (.DS_Store, .env, anything starting with a dot)
  ✗ Source code for an active project — that goes in the project's own folder

The litmus test: "would I want to see this in my Documents gallery?" Yes → save here. It's plumbing or in-progress project work? → save in the project's own folder.

NAMING
Descriptive kebab-case filenames with the client or topic and an ISO date when relevant. Examples:
  invoice-2026-005-acme-studio.html
  weekly-notes-2026-w22.md
  hermes-architecture-overview.html

Every file must embed two pieces of metadata so my gallery can display it cleanly:
  • title — five words MAX, the human name of the document
  • description — fifteen words MAX, one sentence of what it is

Embed them per file type as follows. This is non-negotiable, the gallery reads these:

HTML  →  inside <head>, add:
           <meta name="hermes-title" content="Acme Studio Invoice 005" />
           <meta name="hermes-description" content="May retainer invoice for Acme Studio covering Hermes deployment and skill development work." />

Markdown  →  YAML frontmatter as the first thing in the file:
           ---
           title: Weekly Notes W22
           description: Friday snapshot of what shipped, open threads, and memory candidates for next week.
           ---

JSON  →  add a top-level "_hermes" block (preserve all your real keys alongside it):
           {
             "_hermes": {
               "title": "Acme Studio Config",
               "description": "Routing rules, billing terms, and Hermes preferences for the Acme Studio retainer."
             },
             "client": "Acme Studio Ltd.",
             ...
           }

Plain text  →  first line is the title, second line is the description, then a blank line, then the body.

Code files (.ts, .py, etc.)  →  first comment line is the title, second is the description.

Why: this folder powers my Documents gallery in Claude OS. Files appear there within 5 seconds of you writing them. Without the title + description fields the cards fall back to filenames, which is ugly.

Never write outside ~/Documents/Hermes/ unless I explicitly ask. Never delete files in there without confirming.`;

// Type → icon + label. Purely categorical — colour never encodes file
// type (docs/DESIGN-SYSTEM.md: colour means state, not decoration).
const TYPE_META: Record<string, { Icon: typeof FileText; label: string }> = {
  image: { Icon: ImageIcon, label: "Image" },
  pdf: { Icon: FileType2, label: "PDF" },
  html: { Icon: FileCode2, label: "HTML" },
  markdown: { Icon: FileText, label: "Markdown" },
  text: { Icon: FileText, label: "Text" },
  data: { Icon: FileJson, label: "Data" },
  video: { Icon: Film, label: "Video" },
  audio: { Icon: Music, label: "Audio" },
  archive: { Icon: ArchiveIcon, label: "Archive" },
  code: { Icon: FileCode2, label: "Code" },
  other: { Icon: FileGeneric, label: "File" },
};

function metaFor(type: string) {
  return TYPE_META[type] ?? TYPE_META.other;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Strip the extension + transform kebab/snake to title case. Used only
// when the file didn't embed a hermes-title — better than showing the
// raw filename, but a real embedded title always wins.
function humanizeFilename(name: string): string {
  const noExt = name.replace(/\.[^.]+$/, "");
  const words = noExt
    .replace(/[-_]+/g, " ")
    .replace(/\b(\d{4})(\d{2})(\d{2})\b/g, "$1-$2-$3") // re-hyphenate dates
    .split(" ")
    .filter(Boolean);
  return words
    .map((w) => (w.length > 3 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Per-type fallback description, used when the file didn't embed one.
// Kept generic and short — it's strictly worse than a real description
// but better than empty space under the title.
const TYPE_FALLBACK_DESC: Record<string, string> = {
  image: "An image saved to your Hermes documents folder.",
  pdf: "A PDF document — preview to view, arrow to open externally.",
  html: "An HTML document — preview to render inside the dashboard.",
  markdown: "A markdown note — preview to read inline.",
  text: "A plain text file — preview to read inline.",
  data: "A structured data file (JSON, YAML, CSV).",
  video: "A video clip — preview to play inline.",
  audio: "An audio clip — preview to play inline.",
  archive: "A compressed archive — open externally to extract.",
  code: "A source code file — preview to read.",
  other: "A file saved to your Hermes documents folder.",
};

// Bucket a timestamp into one of four labels used by the recency grouping.
function recencyBucket(ms: number): "today" | "yesterday" | "thisWeek" | "earlier" {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfThisWeek = startOfToday - 6 * 86_400_000;
  if (ms >= startOfToday) return "today";
  if (ms >= startOfYesterday) return "yesterday";
  if (ms >= startOfThisWeek) return "thisWeek";
  return "earlier";
}

const RECENCY_LABEL: Record<ReturnType<typeof recencyBucket>, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  earlier: "Earlier",
};

// Group items by recency in the canonical order. Used only when there
// are enough items to warrant the structure (>6).
function groupByRecency(items: Doc[]): Array<{ key: ReturnType<typeof recencyBucket>; label: string; items: Doc[] }> {
  const buckets: Record<ReturnType<typeof recencyBucket>, Doc[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const it of items) buckets[recencyBucket(it.modifiedMs)].push(it);
  return (Object.keys(buckets) as Array<keyof typeof buckets>)
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, label: RECENCY_LABEL[k], items: buckets[k] }));
}

function useHermesDocuments() {
  return useQuery<DocsResponse>({
    queryKey: ["hermes-documents"],
    queryFn: async () => {
      const r = await fetch("/__hermes_documents");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return (await r.json()) as DocsResponse;
    },
    // Live updates — polls every 5s. Cheap (single readdir + stats),
    // matches the cadence of the rest of the Hermes-page panels.
    refetchInterval: 5000,
    staleTime: 2000,
  });
}

export function HermesDocumentsGallery() {
  const { data, isLoading, error, refetch } = useHermesDocuments();
  const queryClient = useQueryClient();
  const items = data?.items ?? [];
  const folder = data?.folder ?? "~/Documents/Hermes";
  const trashCount = data?.trashCount ?? 0;

  // Filter state: "all" or one of the type keys. Only show chips for
  // types actually present in the current gallery — no dead filters.
  const [filter, setFilter] = useState<string>("all");
  const presentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) set.add(it.type);
    return Array.from(set).sort();
  }, [items]);

  // Live search — filters across title, description, filename, type,
  // and extension. Empty query = no search filter applied.
  const [search, setSearch] = useState("");
  const searchActive = search.trim().length > 0;

  const visible = useMemo(() => {
    let list = filter === "all" ? items : items.filter((d) => d.type === filter);
    if (searchActive) {
      const q = search.trim().toLowerCase();
      list = list.filter((d) => {
        const hay = [
          d.name,
          d.type,
          d.ext,
          d.title ?? "",
          d.description ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [items, filter, search, searchActive]);

  // Preview overlay state.
  const [previewing, setPreviewing] = useState<Doc | null>(null);

  // Show all cards vs cap at DEFAULT_VISIBLE. Reset whenever the filter
  // or search changes so the cap behaviour is predictable.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [filter, search]);

  // Install-prompt modal. Opt-in via the header chip — no longer pops
  // up automatically. The empty state still nudges installers toward
  // it ("Install prompt" action button).
  const [promptOpen, setPromptOpen] = useState(false);

  // Trash modal. Opens via the "Trash · N" chip, only shown when
  // trashCount > 0. Operator can restore or permanently delete from
  // there; auto-closes when the trash is emptied.
  const [trashOpen, setTrashOpen] = useState(false);

  // Manual refresh button — invalidates the query immediately so the
  // 5s polling cadence doesn't keep the operator waiting after they
  // drop a file in.
  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["hermes-documents"] });
  };

  // Undo-toast state. Holds the most-recently-soft-deleted file and
  // the trashId the backend returned, so the toast's Undo button knows
  // which trash entry to restore. Null = no toast showing.
  const [undoToast, setUndoToast] = useState<
    { doc: Doc; trashId: string } | null
  >(null);

  // Delete flow: no confirm dialog — the file is soft-deleted (moved
  // to .trash/) so the operator can always recover via the Undo toast
  // within the window, or directly from .trash/ after. Optimistic UI
  // removes the card before the server replies; rollback on failure.
  const handleDelete = async (doc: Doc) => {
    queryClient.setQueryData<DocsResponse | undefined>(
      ["hermes-documents"],
      (cur) => (cur ? { ...cur, items: cur.items.filter((d) => d.name !== doc.name) } : cur),
    );
    if (previewing?.name === doc.name) setPreviewing(null);
    try {
      const r = await fetch(
        `/__hermes_documents?name=${encodeURIComponent(doc.name)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
      const body = (await r.json()) as { ok: boolean; trashId?: string };
      if (body.trashId) {
        // Replace any prior toast — keeping only the most recent
        // undoable action avoids stacking and matches the Linear/Gmail
        // pattern operators already know.
        setUndoToast({ doc, trashId: body.trashId });
      }
    } catch {
      // Rollback by refetching real state.
      void refetch();
      alert(`Could not delete "${doc.name}". The file may be locked or the disk is read-only.`);
    }
  };

  // Undo handler — calls the restore endpoint, dismisses the toast,
  // and refetches so the (possibly renamed) restored file appears in
  // the gallery. Tolerates double-clicks by no-op'ing without a toast.
  // useCallback so the identity is stable — UndoDeleteToast depends
  // on this in a useEffect and a re-created closure would tear down
  // and rebuild its setInterval on every parent render (~10×/s),
  // resetting the countdown's closed-over `start`.
  const handleUndo = useCallback(async () => {
    if (!undoToast) return;
    const { trashId } = undoToast;
    setUndoToast(null); // optimistic — assume restore succeeds
    try {
      const r = await fetch(
        `/__hermes_documents/restore?trashId=${encodeURIComponent(trashId)}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
      void refetch();
    } catch {
      alert(
        `Could not restore the file. You can recover it manually from ~/Documents/Hermes/.trash/`,
      );
    }
  }, [undoToast, refetch]);

  // Stable identity for the toast's onDismiss prop — same reason as
  // handleUndo above. Without useCallback this is a new arrow per
  // render, which thrashes the toast's countdown interval.
  const dismissUndoToast = useCallback(() => setUndoToast(null), []);

  return (
    <Section
      title="Documents"
      description={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-mono text-sm">
            <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
            {folder.replace(/^\/Users\/[^/]+/, "~")}
          </span>
          <span aria-hidden="true">·</span>
          <span className="ds-num">
            {fmtCount(items.length)} {items.length === 1 ? "file" : "files"}
          </span>
        </span>
      }
      actions={
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => setPromptOpen(true)}>
            Install prompt
          </Button>
          {trashCount > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={() => setTrashOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Trash · {fmtCount(trashCount)}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            title="Re-scan the folder now"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </>
      }
    >
      {/* Stats strip — live answer to "what am I producing?". Hidden
          entirely when empty; the empty state below carries the
          orientation instead. */}
      <GalleryStatsStrip items={items} />

      {/* Filter row — type chips on the left, search input on the
          right. The chips are tooltipped with their extension list
          so '.txt vs .md' is never a mystery. */}
      {items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {presentTypes.length > 1 && (
            <>
              <FilterChip
                label={`All · ${fmtCount(items.length)}`}
                active={filter === "all"}
                onClick={() => setFilter("all")}
                title="Show every file regardless of type"
              />
              {presentTypes.map((t) => {
                const count = items.filter((d) => d.type === t).length;
                const meta = metaFor(t);
                const exts = extsForType(t);
                const tip = exts.length
                  ? `${meta.label} · ${exts.map((e) => `.${e}`).join(" ")}`
                  : meta.label;
                return (
                  <FilterChip
                    key={t}
                    label={`${meta.label} · ${fmtCount(count)}`}
                    active={filter === t}
                    onClick={() => setFilter(t)}
                    title={tip}
                  />
                );
              })}
            </>
          )}
          {/* Search — flex-grow pushes the input to fill the rest of
              the row. */}
          <div
            className={cn(
              "ml-auto flex min-w-[220px] max-w-md flex-grow items-center gap-1.5 rounded-lg border bg-inset px-2 py-1.5 transition-colors",
              searchActive ? "border-border-strong" : "border-border",
            )}
          >
            <Search
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                searchActive ? "text-foreground" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, description, filename…"
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Search documents"
            />
            {searchActive && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="ds-interactive flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                title="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Body — grid of cards. Loading / empty / error states are
          handled inline so the section never collapses to nothing. */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border bg-card">
              <Skeleton className="aspect-[5/3] w-full rounded-none" />
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <Notice
          tone="danger"
          title="Couldn't read the folder"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        >
          The /__hermes_documents endpoint didn't respond. Restart the dev server if needed.
        </Notice>
      ) : visible.length === 0 ? (
        items.length === 0 ? (
          <EmptyState
            icon={Folder}
            title="Nothing here yet"
            body={`Drop a file into ${folder} and it'll appear within 5 seconds.`}
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => setPromptOpen(true)}>
                Install prompt
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Search}
            title="No files match this filter"
            body="Switch back to All, or pick a different type."
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter("all");
                  setSearch("");
                }}
              >
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        (() => {
          // Responsive multi-row grid (1/2/3/4/5 cols by breakpoint).
          // Layers:
          //   1. cap visible cards at DEFAULT_VISIBLE; reveal the rest
          //      behind a "Show all N" button
          //   2. when >6 items and no active search, render under
          //      recency-bucket headers (Today / Yesterday / This week
          //      / Earlier) so the wall of cards becomes a story
          //   3. when search is active, force flat — categories stop
          //      helping once the operator is looking for one file
          const totalShown = expanded
            ? visible.length
            : Math.min(visible.length, DEFAULT_VISIBLE);
          const sliced = visible.slice(0, totalShown);
          const overflow = visible.length - DEFAULT_VISIBLE;
          const useGroups = !searchActive && visible.length > 6;
          const groups = useGroups ? groupByRecency(sliced) : null;

          return (
            <>
              {groups ? (
                <div className="flex flex-col gap-6">
                  {groups.map((g) => (
                    <RecencyGroup
                      key={g.key}
                      label={g.label}
                      items={g.items}
                      onPreview={setPreviewing}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              ) : (
                <DocGrid
                  items={sliced}
                  onPreview={setPreviewing}
                  onDelete={handleDelete}
                />
              )}
              {overflow > 0 && (
                <div className="mt-4 flex items-center justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                        Collapse · show {DEFAULT_VISIBLE} of {visible.length}
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        Show all {visible.length} · {overflow} more
                      </>
                    )}
                  </Button>
                </div>
              )}
            </>
          );
        })()
      )}

      {previewing && (
        <PreviewOverlay
          doc={previewing}
          onClose={() => setPreviewing(null)}
          onDelete={() => handleDelete(previewing)}
        />
      )}

      {promptOpen && (
        <InstallPromptModal onClose={() => setPromptOpen(false)} />
      )}

      {trashOpen && (
        <TrashModal
          onClose={() => setTrashOpen(false)}
          onChange={() => {
            // Restore + permanent-delete actions inside the modal
            // mutate the underlying folder state — invalidate the
            // main list so the gallery + trashCount stay in sync.
            void queryClient.invalidateQueries({ queryKey: ["hermes-documents"] });
          }}
        />
      )}

      {undoToast && (
        <UndoDeleteToast
          key={undoToast.trashId}
          doc={undoToast.doc}
          onUndo={handleUndo}
          onDismiss={dismissUndoToast}
        />
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Subcomponents

/**
 * Stats strip — one line summarising what's in the folder. Live-computed
 * from the items list so it stays accurate as files come and go. Renders
 * nothing when the folder is empty — the EmptyState below already carries
 * the orientation for a first-time installer.
 */
function GalleryStatsStrip({ items }: { items: Doc[] }) {
  if (items.length === 0) return null;

  const totalBytes = items.reduce((s, i) => s + i.sizeBytes, 0);
  // Per-type counts, ordered by count desc so the most-produced types
  // come first. Falls back to alpha when counts tie.
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
  const breakdown = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${metaFor(type).label}${n === 1 ? "" : "s"}`);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <span className="ds-num text-foreground">
        {fmtCount(items.length)} {items.length === 1 ? "file" : "files"}
      </span>
      <span aria-hidden="true">·</span>
      <span className="ds-num">{fmtBytes(totalBytes)} total</span>
      {breakdown.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span>{breakdown.join(", ")}</span>
        </>
      )}
    </div>
  );
}

/**
 * Undo-delete toast. Bottom-centre, auto-dismisses after 8 seconds.
 * Pauses the countdown on hover so the operator has time to read +
 * decide. Pressing Undo restores the file via the /restore endpoint.
 * Pressing × commits (the file stays in .trash/ — still recoverable
 * manually from Finder, just not via the in-app button).
 */
const UNDO_TOAST_MS = 8000;

function UndoDeleteToast({
  doc,
  onUndo,
  onDismiss,
}: {
  doc: Doc;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [remaining, setRemaining] = useState(UNDO_TOAST_MS);
  const [paused, setPaused] = useState(false);
  // Refs so the single setInterval below can read the latest paused
  // state and call the latest onDismiss without ever needing to be
  // re-created. This is the fix for the bug where the previous
  // implementation tore down + rebuilt the interval whenever paused
  // toggled or onDismiss got a fresh closure identity (~10×/s during
  // a parent re-render storm).
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Countdown tick — one interval, lives for the toast's lifetime.
  // Decrement is driven by wall-clock elapsed so the bar drains at
  // a real-time rate; pauses freeze the bar by not advancing
  // `startTickMs` while paused.
  useEffect(() => {
    let startTickMs = Date.now();
    let leftover = UNDO_TOAST_MS;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (pausedRef.current) {
        // While paused, slide the start forward so elapsed stays 0.
        startTickMs = now;
        return;
      }
      const elapsed = now - startTickMs;
      startTickMs = now;
      leftover = Math.max(0, leftover - elapsed);
      setRemaining(leftover);
      if (leftover <= 0) {
        window.clearInterval(id);
        onDismissRef.current();
      }
    }, 100);
    return () => window.clearInterval(id);
    // Empty deps — interval is mounted once and reads refs for the
    // latest pause state + dismiss handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = Math.max(0, Math.min(100, (remaining / UNDO_TOAST_MS) * 100));

  return (
    <div
      className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="relative flex min-w-[360px] max-w-[520px] items-center gap-3 overflow-hidden rounded-xl border border-border bg-popover px-4 py-3 shadow-lg">
        {/* Countdown bar at the bottom of the toast */}
        <div
          className="absolute bottom-0 left-0 h-0.5 bg-warn transition-[width]"
          style={{ width: `${pct}%`, transitionDuration: paused ? "0ms" : "100ms" }}
        />
        <Trash2 className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="ds-label">Deleted</div>
          <div className="truncate text-sm text-foreground" title={doc.name}>
            {doc.title ?? doc.name}
          </div>
        </div>
        <Button type="button" variant="accent" size="sm" onClick={onUndo}>
          Undo
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss (file stays in .trash/ — recover from Finder)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// Canonical type → extensions map. The mirror of classifyDoc() in
// vite.config.ts — kept here for tooltips + the rules table in the
// Install Prompt modal. If this drifts from the backend, the filter
// chip tooltips will lie, so keep them in sync.
const TYPE_RULES: Array<{ type: string; label: string; exts: string[]; note: string }> = [
  { type: "image", label: "Image", exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"], note: "Rendered as a real thumbnail." },
  { type: "pdf", label: "PDF", exts: ["pdf"], note: "Previewed inline in an iframe." },
  { type: "html", label: "HTML", exts: ["html", "htm"], note: "Rendered inline. Embed <meta name='hermes-title'> + <meta name='hermes-description'>." },
  { type: "markdown", label: "Markdown", exts: ["md", "markdown", "mdx"], note: "Use YAML frontmatter with title + description." },
  { type: "text", label: "Text", exts: ["txt", "log"], note: "First line = title, second line = description." },
  { type: "data", label: "Data", exts: ["json", "yaml", "yml", "toml", "csv", "tsv"], note: "JSON: add a top-level _hermes block. YAML/TOML: leading title:/description: keys." },
  { type: "video", label: "Video", exts: ["mp4", "mov", "webm", "mkv", "avi"], note: "Previewed inline with native controls." },
  { type: "audio", label: "Audio", exts: ["mp3", "wav", "ogg", "m4a", "flac"], note: "Previewed inline with native audio player." },
  { type: "archive", label: "Archive", exts: ["zip", "tar", "gz", "tgz", "7z", "rar"], note: "Open externally to extract." },
  { type: "code", label: "Code", exts: ["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "c", "cpp", "sh"], note: "First two comment lines = title + description." },
  { type: "other", label: "Other", exts: ["(anything else)"], note: "Falls back to the generic placeholder." },
];

function extsForType(type: string): string[] {
  return TYPE_RULES.find((r) => r.type === type)?.exts ?? [];
}

/**
 * Trash modal — lists every file in ~/Documents/Hermes/.trash/ with
 * Restore + Permanently delete actions per row, plus an Empty-trash
 * button at the bottom. Soft-deletes from this modal are NOT
 * recoverable via the Undo toast — they're truly gone.
 *
 * Auto-closes when the trash is emptied so the operator doesn't have
 * to dismiss an empty modal. onChange() is called after every mutation
 * so the parent can invalidate the main list query and keep the
 * "Trash · N" chip in sync.
 */
function TrashModal({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch + a small helper to refresh after each action.
  const refresh = async () => {
    try {
      const r = await fetch("/__hermes_documents/trash");
      if (!r.ok) throw new Error(`status ${r.status}`);
      const body = (await r.json()) as TrashResponse;
      setItems(body.items);
      onChange();
      // Close ourselves if the trash is empty — no point showing an
      // empty modal once the operator's cleaned everything up.
      if (body.items.length === 0) onClose();
    } catch (e: any) {
      setError(e?.message ?? "could not load trash");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes + lock body scroll (same pattern as the other modals).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Body scroll lock — uses the module-level stacking counter so two
  // modals stacked + closed out-of-order can't leave the page locked.
  useBodyScrollLock();

  const handleRestore = async (item: TrashItem) => {
    setBusy(item.trashId);
    setError(null);
    try {
      const r = await fetch(
        `/__hermes_documents/restore?trashId=${encodeURIComponent(item.trashId)}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
      await refresh();
    } catch (e: any) {
      setError(`Could not restore "${item.originalName}": ${e?.message ?? "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  const handlePurge = async (item: TrashItem) => {
    if (
      !confirm(
        `Permanently delete "${item.originalName}"?\n\nThis cannot be undone — the file is removed from disk entirely.`,
      )
    ) {
      return;
    }
    setBusy(item.trashId);
    setError(null);
    try {
      const r = await fetch(
        `/__hermes_documents/trash?trashId=${encodeURIComponent(item.trashId)}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error(`status ${r.status}`);
      await refresh();
    } catch (e: any) {
      setError(`Could not delete "${item.originalName}": ${e?.message ?? "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  const handleEmptyAll = async () => {
    if (!items || items.length === 0) return;
    if (
      !confirm(
        `Permanently delete all ${items.length} item${items.length === 1 ? "" : "s"} in the trash?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy("all");
    setError(null);
    try {
      const r = await fetch("/__hermes_documents/trash", { method: "DELETE" });
      if (!r.ok) throw new Error(`status ${r.status}`);
      await refresh();
    } catch (e: any) {
      setError(`Could not empty trash: ${e?.message ?? "unknown"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="ds-label">Trash</div>
            <div className="mt-0.5 truncate text-base font-semibold text-foreground">
              {items === null
                ? "Loading…"
                : items.length === 0
                  ? "Trash is empty"
                  : `${fmtCount(items.length)} deleted file${items.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {error && (
            <Notice tone="danger" className="mb-3">
              {error}
            </Notice>
          )}
          {items === null ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Reading the trash folder…
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title="Nothing to recover"
              body="Deleted files appear here. Restore puts them back in your gallery, permanently delete removes them from disk for good."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="ds-label">
                    <th className="bg-inset px-3 py-2 text-left font-normal">File</th>
                    <th className="bg-inset px-3 py-2 text-left font-normal">Deleted</th>
                    <th className="bg-inset px-3 py-2 text-left font-normal">Size</th>
                    <th className="bg-inset px-3 py-2 text-right font-normal" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((item) => (
                    <tr key={item.trashId} className={cn(busy === item.trashId && "opacity-50")}>
                      <td
                        className="max-w-[280px] truncate px-3 py-2 align-middle text-foreground"
                        title={item.trashId}
                      >
                        {item.originalName}
                      </td>
                      <td className="ds-num px-3 py-2 align-middle font-mono text-sm text-muted-foreground">
                        {fmtRelative(item.deletedMs)}
                      </td>
                      <td className="ds-num px-3 py-2 align-middle font-mono text-sm text-muted-foreground">
                        {fmtBytes(item.sizeBytes)}
                      </td>
                      <td className="px-3 py-2 align-middle text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={busy !== null}
                            onClick={() => handleRestore(item)}
                            title="Restore to ~/Documents/Hermes/"
                          >
                            Restore
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="text-danger hover:text-danger"
                            disabled={busy !== null}
                            onClick={() => handlePurge(item)}
                            title="Permanently delete from disk"
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer — Empty all */}
        {items && items.length > 0 && (
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <div className="text-sm text-muted-foreground">
              Restored files keep their original name (with a suffix if a
              new file already took it).
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-danger hover:text-danger"
              disabled={busy !== null}
              onClick={handleEmptyAll}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Empty trash · {fmtCount(items.length)}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function InstallPromptModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(HERMES_GALLERY_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = HERMES_GALLERY_PROMPT;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        /* operator can select manually */
      }
      document.body.removeChild(ta);
    }
  };

  // Close on Esc + backdrop click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Body scroll lock — module-level stacking counter handles
  // out-of-order close races across the three modals.
  useBodyScrollLock();

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="ds-label">Install prompt</div>
            <div className="mt-0.5 truncate text-base font-semibold text-foreground">
              Teach Hermes to save artefacts here
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {/* Save / Don't-save rules — visual two-column panel before
              the prompt so the operator sees the boundary at a glance. */}
          <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-success/30 bg-success-soft p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Save here
              </div>
              <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
                <li>HTML, PDFs, decks, invoices, reports</li>
                <li>Markdown notes, digests, summaries</li>
                <li>Generated images, charts, diagrams</li>
                <li>Audio/video clips you produced</li>
                <li>JSON/CSV/YAML exports for me</li>
                <li>Anything I'd preview, share, or revisit</li>
              </ul>
            </div>
            <div className="rounded-xl border border-danger/30 bg-danger-soft p-3">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-danger">
                <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                Don't save here
              </div>
              <ul className="list-disc space-y-1 pl-4 text-sm leading-relaxed text-foreground">
                <li>Files inside an active GitHub repo or project</li>
                <li>Build artifacts, dist/, node_modules/</li>
                <li>Temp/scratch/working copies</li>
                <li>Logs, dumps, traces, telemetry</li>
                <li>Dotfiles (.DS_Store, .env, .git)</li>
                <li>Source code for an active project</li>
              </ul>
            </div>
          </div>
          <div className="-mt-2 mb-5 text-sm leading-relaxed text-muted-foreground">
            Litmus test: <span className="text-foreground">"would I want to see this in my Documents gallery?"</span> Yes → save here. It's plumbing or in-progress project work? → save in the project's own folder.
          </div>

          {/* Prompt block */}
          <div className="mb-2 flex items-center justify-between">
            <div className="ds-label">Prompt to paste</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={copied ? "border-success/40 text-success" : undefined}
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" aria-hidden="true" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy prompt
                </>
              )}
            </Button>
          </div>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-inset px-3 py-3 font-mono text-sm leading-relaxed text-foreground">
            {HERMES_GALLERY_PROMPT}
          </pre>

          {/* Type rules table */}
          <div className="mt-5">
            <div className="ds-label mb-2">What classifies as what</div>
            <div className="mb-3 text-sm text-muted-foreground">
              Files are classified by extension. Each type has its own
              preview behaviour and metadata format.
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="ds-label">
                    <th className="bg-inset px-3 py-2 text-left font-normal">Type</th>
                    <th className="bg-inset px-3 py-2 text-left font-normal">Extensions</th>
                    <th className="bg-inset px-3 py-2 text-left font-normal">Behaviour</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {TYPE_RULES.map((r) => (
                    <tr key={r.type}>
                      <td className="px-3 py-2 align-top">
                        <Badge tone="neutral">{r.label}</Badge>
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-sm text-muted-foreground">
                        {r.exts.map((e) => `.${e.replace(/^\(/, "(")}`).join(" ")}
                      </td>
                      <td className="px-3 py-2 align-top text-muted-foreground">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 text-sm text-muted-foreground">
            Paste the prompt once into a fresh Hermes session — it persists
            in the session's system context. For a permanent install, drop
            it into your agent's system prompt or skill file.
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "ds-interactive rounded-full border px-2.5 py-1 text-sm font-medium",
        active
          ? "border-transparent bg-brand-soft text-brand"
          : "border-border bg-inset text-muted-foreground hover:border-border-strong hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Responsive multi-row grid — the canonical card layout. Used both as
 * the flat view (when item count ≤ 6 or search is active) and inside
 * each recency group when grouping is active.
 */
function DocGrid({
  items,
  onPreview,
  onDelete,
}: {
  items: Doc[];
  onPreview: (d: Doc) => void;
  onDelete: (d: Doc) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {items.map((doc) => (
        <DocCard
          key={doc.name}
          doc={doc}
          onPreview={() => onPreview(doc)}
          onDelete={() => onDelete(doc)}
        />
      ))}
    </div>
  );
}

/**
 * One recency bucket — label header + a DocGrid of its items.
 */
function RecencyGroup({
  label,
  items,
  onPreview,
  onDelete,
}: {
  label: string;
  items: Doc[];
  onPreview: (d: Doc) => void;
  onDelete: (d: Doc) => void;
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 border-b border-border pb-1">
        <span className="ds-label">{label}</span>
        <span className="ds-num text-[13px] font-normal normal-case tracking-normal text-muted-foreground">
          {items.length}
        </span>
      </div>
      <DocGrid items={items} onPreview={onPreview} onDelete={onDelete} />
    </div>
  );
}

function DocCard({
  doc,
  onPreview,
  onDelete,
}: {
  doc: Doc;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const meta = metaFor(doc.type);
  const Icon = meta.Icon;
  const isImage = doc.type === "image";
  const fileUrl = `/__hermes_documents/file?name=${encodeURIComponent(doc.name)}`;

  // Title + description with graceful fallbacks. The embedded values win;
  // we humanize the filename when no title is embedded, and pick a
  // per-type blurb when no description is embedded.
  const titleText = doc.title ?? humanizeFilename(doc.name);
  const descriptionText =
    doc.description ?? TYPE_FALLBACK_DESC[doc.type] ?? TYPE_FALLBACK_DESC.other;

  return (
    <Surface
      variant="interactive"
      padding="none"
      className="group flex flex-col overflow-hidden"
      onClick={onPreview}
    >
      {/* Thumbnail block — fixed 5:3-ish aspect so cards align. Images
          get a real thumbnail from disk; every other type gets its
          category icon on a neutral well. */}
      <div className="relative w-full overflow-hidden bg-inset" style={{ aspectRatio: "5/3" }}>
        {isImage ? (
          <img
            src={fileUrl}
            alt={doc.name}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          </div>
        )}
        <Badge tone="neutral" className="absolute left-2 top-2">
          {meta.label}
        </Badge>
        {/* Action cluster — top-right. Open-in-new-tab is the secondary
            "I want this full-screen in the browser" action; delete is
            destructive and lives furthest right. Both are always shown
            at low opacity, brightening on card hover, so the operator
            can spot them without exploring. */}
        <div className="absolute right-2 top-2 flex items-center gap-1.5 opacity-60 transition-opacity group-hover:opacity-100">
          <Button asChild variant="outline" size="icon-sm" className="bg-card/90">
            <a
              href={fileUrl}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
              title="Open in a new browser tab"
              aria-label={`Open ${doc.name} in a new tab`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="bg-card/90 text-danger hover:text-danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete this file from disk"
            aria-label={`Delete ${doc.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Card footer — three-tier hierarchy:
            (1) title, prominent — Hermes-embedded if present,
                humanized filename otherwise
            (2) description, muted — Hermes-embedded or per-type
                fallback
            (3) filename + meta, mono, smallest — always visible so
                you never lose the actual filesystem identity */}
      <div className="flex flex-col gap-1 px-3 py-2.5 text-left">
        <div
          className="truncate text-sm font-medium leading-snug text-foreground"
          title={titleText}
        >
          {titleText}
        </div>
        <div
          className="line-clamp-2 text-sm leading-snug text-muted-foreground"
          title={descriptionText}
        >
          {descriptionText}
        </div>
        <div className="mt-1 flex items-center gap-1.5 truncate border-t border-border pt-1.5 font-mono text-[13px] text-muted-foreground">
          <span className="truncate" title={doc.name}>
            {doc.name}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{fmtRelative(doc.modifiedMs)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{fmtBytes(doc.sizeBytes)}</span>
        </div>
      </div>
    </Surface>
  );
}

function PreviewOverlay({
  doc,
  onClose,
  onDelete,
}: {
  doc: Doc;
  onClose: () => void;
  onDelete: () => void;
}) {
  const url = `/__hermes_documents/file?name=${encodeURIComponent(doc.name)}`;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Text-ish formats get fetched + rendered as <pre> for legibility.
  const [textBody, setTextBody] = useState<string | null>(null);
  const isText = ["markdown", "text", "data", "code"].includes(doc.type);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        const t = await r.text();
        if (!cancelled) setTextBody(t);
      } catch {
        /* ignore — fallback renders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, isText]);

  // Close on Esc + on backdrop click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Body scroll lock — uses the shared stacking counter so this and
  // the other modals can coexist without one's cleanup unlocking
  // another's lock.
  useBodyScrollLock();

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-popover shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="truncate text-sm font-semibold text-foreground">{doc.name}</div>
            <Badge tone="neutral" className="shrink-0">
              {metaFor(doc.type).label}
            </Badge>
            <span className="ds-num shrink-0 text-sm text-muted-foreground">
              {fmtBytes(doc.sizeBytes)} · {fmtRelative(doc.modifiedMs)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button asChild variant="outline" size="sm">
              <a href={url} target="_blank" rel="noopener" title="Open in a new tab">
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-danger hover:text-danger"
              onClick={onDelete}
              title="Delete from disk"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body — rendering depends on type. */}
        <div className="flex-1 overflow-auto bg-background">
          {doc.type === "image" ? (
            <div className="flex h-full w-full items-center justify-center p-4">
              <img
                src={url}
                alt={doc.name}
                className="max-h-[78vh] max-w-full object-contain"
              />
            </div>
          ) : doc.type === "pdf" || doc.type === "html" ? (
            <iframe
              src={url}
              title={doc.name}
              className="h-[78vh] w-full border-0"
              style={{ background: doc.type === "html" ? "#fff" : "transparent" }}
            />
          ) : doc.type === "video" ? (
            <div className="flex w-full items-center justify-center p-4">
              <video src={url} controls className="max-h-[78vh] max-w-full" />
            </div>
          ) : doc.type === "audio" ? (
            <div className="flex w-full items-center justify-center p-8">
              <audio src={url} controls className="w-full max-w-xl" />
            </div>
          ) : isText ? (
            <pre className="whitespace-pre-wrap break-words px-5 py-4 font-mono text-sm leading-relaxed text-foreground">
              {textBody ?? "Loading…"}
            </pre>
          ) : (
            <div className="flex flex-col items-center gap-3 p-8 text-center">
              <FileGeneric className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
              <div className="text-sm font-medium text-foreground">
                Preview not available for .{doc.ext}
              </div>
              <div className="text-sm text-muted-foreground">
                Hit <span className="text-foreground">Open</span> above to download it.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
