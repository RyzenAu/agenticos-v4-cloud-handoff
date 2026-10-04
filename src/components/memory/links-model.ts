/**
 * How the memory pieces connect, in words and tones (W-D, 29 Sep 2026: "memory map is cool but no
 * sign of Hindsight"; "knowledge graph doesn't connect with Hermes"). Pure: it only reads what the OS
 * reported (/__memory/status, /__memory/links, /__hermes_status) and never guesses. Anything it could
 * not read is "not checked", never "connected" and never "off".
 */
import type { HindsightState, SyncStatus } from "../../../scripts/memory/types";
import type { LinksView } from "../../../scripts/memory/links";

export type LinkTone = "ok" | "warn" | "bad" | "neutral";
export type EdgeState = "live" | "read-only" | "off" | "broken" | "unknown";
export type HermesStatusLike = { installed?: boolean; configured?: boolean; needsSetup?: boolean } | null;
export type Loaded<T> = { data: T | null; error: string | null; loading: boolean };

export type LinkNode = {
  id: "vault" | "os" | "hindsight" | "hermes";
  title: string;
  /** The state in a few words ("Connected", "Not checked"). */
  state: string;
  tone: LinkTone;
  /** One sentence of detail. */
  detail: string;
};
export type LinkEdge = { from: LinkNode["id"]; to: LinkNode["id"]; label: string; state: EdgeState };
export type LinksModel = {
  nodes: Record<LinkNode["id"], LinkNode>;
  edges: LinkEdge[];
  /** One plain sentence for the top of the card. */
  headline: string;
  hindsight: {
    indexed: number | null;
    docs: number | null;
    memories: number | null;
    notes: number | null;
    pending: number | null;
    errors: number | null;
    bank: string | null;
    mode: "off" | "read" | "on" | null;
    lastSync: string | null;
    lastScan: string | null;
  };
  hermes: { lastCallAt: string | null; lastTool: string | null; calls: number | null; since: string | null };
};

const HINDSIGHT_TONE: Record<HindsightState, LinkTone> = {
  ok: "ok",
  unknown: "neutral",
  disabled: "neutral",
  "writes-off": "neutral",
  "proxy-writes-off": "warn",
  "writer-refused": "bad",
  "removals-waiting": "warn",
  unavailable: "warn",
  "auth-failed": "bad",
  misconfigured: "bad",
};
const HINDSIGHT_STATE: Record<HindsightState, string> = {
  ok: "Connected",
  unknown: "Not checked yet",
  disabled: "Off",
  "writes-off": "Read only",
  "proxy-writes-off": "Proxy writes off",
  "writer-refused": "Refused this OS as writer",
  "removals-waiting": "Removals waiting",
  unavailable: "Down",
  "auth-failed": "Refused the key",
  misconfigured: "Misconfigured",
};

const adminNote = (count: number) => `${count} admin tool${count === 1 ? "" : "s"} deliberately not offered.`;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function describeLinks(status: Loaded<SyncStatus>, links: Loaded<LinksView>, hermesStatus: Loaded<HermesStatusLike>): LinksModel {
  const s = status.data;
  // L2: the OS probes Hindsight's health in the background (~60 s), so "connected" no longer waits
  // for the first recall or save; "not-checked" only before that first probe answers. A down probe
  // makes an ok / unknown / read-only state Down; an up probe turns "unknown" into Connected.
  const health = s?.hindsight_health ?? null;
  const reported: HindsightState | null = s ? s.hindsight : null;
  const hs: HindsightState | null =
    reported && health === "down" && (reported === "ok" || reported === "unknown" || reported === "writes-off") ? "unavailable" : reported === "unknown" && health === "connected" ? "ok" : reported;
  const counts = s?.counts;
  const hindsight = {
    indexed: n(counts?.indexed),
    docs: n(counts?.docs),
    memories: n(counts?.memories),
    notes: n(counts?.notes),
    pending: n(s?.pending),
    errors: s ? s.errors.length : null,
    bank: s?.settings.bank ?? null,
    mode: s?.settings.mode ?? null,
    lastSync: s?.last_success_at ?? null,
    lastScan: s?.last_scan_at ?? null,
  };

  const unknownWhy = status.loading ? "Checking memory status…" : `Memory status couldn't be read${status.error ? ` (${status.error})` : ""}.`;
  const os: LinkNode = s
    ? { id: "os", title: "AgenticOS", state: hindsight.mode === "on" ? "The one memory writer" : hindsight.mode === "read" ? "Read only" : "Writes off", tone: "ok", detail: "Screens every save, keeps provenance and syncs the vault into Hindsight." }
    : { id: "os", title: "AgenticOS", state: "Not checked", tone: "neutral", detail: unknownWhy };
  const vault: LinkNode = s
    ? { id: "vault", title: "Obsidian vault", state: hindsight.notes !== null ? `${hindsight.notes.toLocaleString("en-AU")} notes` : "—", tone: "ok", detail: hindsight.lastScan ? "Scanned for changes; curated notes and saved facts live here." : "Not scanned yet since the OS started." }
    : { id: "vault", title: "Obsidian vault", state: "Not checked", tone: "neutral", detail: unknownWhy };
  const hindsightNode: LinkNode = s && hs
    ? {
        id: "hindsight",
        title: "Hindsight",
        state: hs === "writes-off" && health === "connected" ? "Connected, read only" : HINDSIGHT_STATE[hs],
        tone: hs === "writes-off" && health === "connected" ? "ok" : HINDSIGHT_TONE[hs],
        detail:
          hindsight.indexed !== null && hindsight.docs !== null
            ? `${hindsight.indexed.toLocaleString("en-AU")} of ${hindsight.docs.toLocaleString("en-AU")} documents indexed in the ${hindsight.bank ?? "shared"} bank.`
            : "Index counts not reported.",
      }
    : { id: "hindsight", title: "Hindsight", state: "Not checked", tone: "neutral", detail: unknownWhy };

  // Hermes: installed (from /__hermes_status) AND pointed at this memory (from /__memory/links).
  const h = hermesStatus.data;
  const link = links.data?.hermes ?? null;
  let hermes: LinkNode;
  if (h && h.installed === false) hermes = { id: "hermes", title: "Hermes", state: "Not installed", tone: "neutral", detail: "Hermes isn't installed on this PC, so nothing reads or saves memory through it." };
  else if (link?.checked && link.configured && link.port_matches !== false)
    // L7: "Connected" once every tool Hermes' config asks for is either served or deliberately withheld
    // (write/admin tools the OS never offers). Only a real gap is a warning, named in one line.
    hermes =
      link.missing_tools > 0
        ? {
            id: "hermes",
            title: "Hermes",
            state: `Connected, ${link.missing_tools} tool${link.missing_tools === 1 ? "" : "s"} missing`,
            tone: "warn",
            detail: `Its config asks for ${link.missing_names.length > 0 ? link.missing_names.join(", ") + (link.missing_tools > link.missing_names.length ? ` and ${link.missing_tools - link.missing_names.length} more` : "") : `${link.missing_tools} tool${link.missing_tools === 1 ? "" : "s"}`} that this memory endpoint doesn't have, so ${link.missing_tools === 1 ? "that call" : "those calls"} will fail.${link.withheld_tools > 0 ? ` ${adminNote(link.withheld_tools)}` : ""}`,
          }
        : {
            id: "hermes",
            title: "Hermes",
            state: "Connected",
            tone: "ok",
            detail: `Hermes saves, recalls and browses through this OS, never straight into Hindsight.${link.withheld_tools > 0 ? ` ${adminNote(link.withheld_tools)}` : ""}`,
          };
  else if (link?.checked && link.configured && link.port_matches === false)
    hermes = { id: "hermes", title: "Hermes", state: "Points elsewhere", tone: "warn", detail: "Hermes' memory tools point at a different OS port, so it isn't using this memory." };
  else if (link?.checked && !link.configured)
    hermes = { id: "hermes", title: "Hermes", state: "Not connected", tone: "warn", detail: "Hermes is set up, but its config has no memory tools pointing at this OS, so it can't recall or save here." };
  else
    hermes = {
      id: "hermes",
      title: "Hermes",
      state: "Not checked",
      tone: "neutral",
      detail: links.loading || hermesStatus.loading ? "Checking Hermes…" : link && !link.checked ? "No Hermes config was found to check." : "Hermes' connection couldn't be read.",
    };

  const hindsightEdge: EdgeState = !s || !hs ? "unknown" : hs === "ok" ? (hindsight.mode === "on" ? "live" : "read-only") : hs === "disabled" ? "off" : hs === "writes-off" ? "read-only" : hs === "unknown" ? "unknown" : "broken";
  const hermesEdge: EdgeState = hermes.state.startsWith("Connected") ? "live" : hermes.state === "Not installed" ? "off" : hermes.tone === "warn" ? "broken" : "unknown";
  const edges: LinkEdge[] = [
    { from: "vault", to: "os", label: "notes & saved facts", state: s ? (hindsight.lastScan ? "live" : "unknown") : "unknown" },
    { from: "os", to: "hindsight", label: hindsightEdge === "read-only" ? "recall only" : "indexes & recalls", state: hindsightEdge },
    { from: "hermes", to: "os", label: "remembers & recalls through the OS", state: hermesEdge },
  ];

  const parts: string[] = [];
  if (!s) parts.push(status.loading ? "Checking how memory connects." : "Memory status couldn't be read, so nothing below is assumed.");
  else if (hs === "ok")
    parts.push(
      hindsight.indexed !== null && hindsight.docs !== null
        ? `Hindsight is connected: ${hindsight.indexed.toLocaleString("en-AU")} of ${hindsight.docs.toLocaleString("en-AU")} documents indexed.`
        : "Hindsight is connected.",
    );
  else if (hs) parts.push(`Hindsight: ${HINDSIGHT_STATE[hs].toLowerCase()}.`);
  parts.push(hermes.state === "Connected" ? "Hermes is connected." : hermes.state.startsWith("Connected") ? `Hermes is connected (${hermes.state.slice(11)}).` : hermes.state === "Not checked" ? "Hermes not checked." : `Hermes: ${hermes.state.toLowerCase()}.`);

  return {
    nodes: { vault, os, hindsight: hindsightNode, hermes },
    edges,
    headline: parts.join(" "),
    hindsight,
    hermes: {
      lastCallAt: links.data?.agent_calls.last_at ?? null,
      lastTool: links.data?.agent_calls.last_tool ?? null,
      calls: links.data ? links.data.agent_calls.count : null,
      since: links.data?.agent_calls.since ?? null,
    },
  };
}
