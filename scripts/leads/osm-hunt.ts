#!/usr/bin/env bun
// A large, resumable OpenStreetMap lead hunt across Greater Sydney, the Blue Mountains, the
// Central Coast, Wollongong/Illawarra and Newcastle — dental, legal and real estate. Nothing here
// contacts anyone; it only searches, discovers websites, audits and inserts CRM rows (status
// "new", source "osm"). Progress is checkpointed to .operator-data/osm-hunt-progress.json
// (atomic tmp+rename write, same convention as scripts/agent-jobs.ts) so a stopped run resumes
// exactly where it left off — it never re-queries Overpass or re-processes a lead already done.
//
//   bun scripts/leads/osm-hunt.ts run [--hermes-budget 150]
//   bun scripts/leads/osm-hunt.ts status
//
// Pipeline per (region, vertical): Overpass fetch (one query at a time, paced and backed off —
// Overpass itself has no rate limit or pause built in, see osm.ts) -> skip OSM ids already in the
// CRM -> exclusions (government/non-profit/chain, checkExclusion) -> a lead with neither a phone
// nor a website tag is "low data" (reasons only, no schema change — crm.ts has no low_data
// column) and skips discovery/audit entirely -> website discovery, cheapest first: the OSM
// `website` tag, then a verified domain guess, then a polite DuckDuckGo search, then Hermes only
// for what's still unresolved and only while its budget lasts (tracked via crm.ts's existing
// per-sku `usage`/`countCall`, sku "hermes_discovery") -> a plain-fetch audit (no browser here —
// keeps this bulk pass fast; a browser-based redesign audit is what `rescan` is for) -> score ->
// upsertLead. Duplicates (by OSM id/name+postcode within a batch, and by discovered domain/phone
// against the whole CRM — dedupe.ts) are merged after each region+vertical batch.
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countCall, crmPath, knownPlaceIds, openCrm, upsertLead, usage } from "./crm";
import { mergeDuplicates, renderMergeResults } from "./dedupe";
import {
  duckduckgoWebsiteSearch, guessWebsite, hermesWebsiteSearch, searxngWebsiteSearch,
  type DiscoveredWebsite, type DiscoveryInput,
} from "./discovery";
import { enrichWebsite, looksPersonal } from "./enrich";
import { checkExclusion } from "./exclusions";
import {
  dedupeOsmLeads, fetchOsmElements, normaliseOsmElement, type BBox, type OsmLead,
} from "./osm";
import type { Vertical } from "./places";
import { scoreLead } from "./score";
import { EMPTY_SITE_AUDIT } from "./site-audit";
import { dataDirFor } from "../cloud/data-dir";

const ROOT = join(import.meta.dir, "..", "..");
const HERMES_SKU = "hermes_discovery";

// --- Regions, in the order the owner asked for -------------------------------------------------
// Coordinates are approximate LGA-ish boxes — good enough for "find businesses roughly here", the
// same standard osm.ts's own SUBURB_CENTROIDS boxes use. Refine later if a box is missing suburbs.
export const HUNT_REGIONS: { key: string; label: string; bbox: BBox }[] = [
  { key: "greater-sydney", label: "Greater Sydney", bbox: { south: -34.1, west: 150.6, north: -33.6, east: 151.35 } }, // matches osm.ts's SYDNEY_BBOX
  { key: "blue-mountains", label: "Blue Mountains", bbox: { south: -33.85, west: 150.15, north: -33.55, east: 150.65 } },
  { key: "central-coast", label: "Central Coast", bbox: { south: -33.55, west: 151.15, north: -33.1, east: 151.5 } },
  { key: "wollongong-illawarra", label: "Wollongong / Illawarra", bbox: { south: -34.55, west: 150.75, north: -34.2, east: 150.95 } },
  { key: "newcastle", label: "Newcastle", bbox: { south: -33.05, west: 151.55, north: -32.75, east: 151.85 } },
];
const HUNT_VERTICALS: Vertical[] = ["dental", "legal", "real-estate"];

// --- Overpass etiquette this codebase doesn't otherwise enforce (osm.ts's fetchOsmElements has
// no pause/backoff of its own — confirmed before writing this) -------------------------------
const OVERPASS_PAUSE_MS = 5_000; // one query at a time, a breather between each
const OVERPASS_BACKOFF_MS = 30_000; // on a 429/504-style failure, wait longer and retry once
let lastOverpassAt = 0;

/** Up to 3 tries total (1 + 2 backed-off retries) — a 504 under load is common enough (seen live,
 *  25 Sep 2026, on the very first Blue Mountains query) that a single retry isn't always enough,
 *  but this still gives up eventually rather than hanging forever on a truly stuck server. */
async function politeOverpassFetch(vertical: Vertical, bbox: BBox, request: typeof fetch): Promise<OsmLead[]> {
  const backoffs = [0, OVERPASS_BACKOFF_MS, OVERPASS_BACKOFF_MS * 3];
  let lastError: unknown;
  for (const backoff of backoffs) {
    const wait = Math.max(backoff, OVERPASS_PAUSE_MS - (Date.now() - lastOverpassAt));
    if (wait > 0) await sleep(wait);
    lastOverpassAt = Date.now();
    try {
      const elements = await fetchOsmElements(vertical, bbox, request);
      return dedupeOsmLeads(elements.map(normaliseOsmElement).filter((l): l is OsmLead => l !== null));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The actual suburb from OSM's own address string ("162 Bennett Road, St Clair NSW 2759" ->
 *  "St Clair") — never the broad region label ("Greater Sydney"), which a real business page
 *  would never mention and would make every domain-guess/DuckDuckGo verification fail its suburb
 *  check for nothing. Falls back to "" (which discovery.ts's pageMatchesBusiness treats as "don't
 *  check suburb") when OSM gave no usable address, rather than guessing wrong. */
function suburbFromAddress(address: string): string {
  const locality = address.split(",").pop()?.trim() ?? "";
  return locality.replace(/\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s*\d{4}$/i, "").trim();
}

// --- Progress checkpoint (atomic tmp+rename, mirrors scripts/agent-jobs.ts's own save()) -------
type RegionVerticalProgress = {
  status: "pending" | "fetched" | "done";
  searched: number;
  processedIds: string[]; // OSM sourceIds already inserted/updated/excluded/low-data this run
  added: number;
  excluded: number;
  lowData: number;
  websiteDiscovered: number;
  noWebsiteFound: number;
};
type HuntProgress = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  hermesBudget: number;
  hermesUsedThisRun: number;
  regions: Record<string, Partial<Record<Vertical, RegionVerticalProgress>>>;
};

function progressPath(root: string): string {
  return join(dataDirFor(root), "osm-hunt-progress.json");
}

function blankProgress(hermesBudget: number): HuntProgress {
  return { version: 1, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hermesBudget, hermesUsedThisRun: 0, regions: {} };
}

function loadProgress(root: string, hermesBudget: number): HuntProgress {
  const file = progressPath(root);
  if (!existsSync(file)) return blankProgress(hermesBudget);
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (stored?.version !== 1) return blankProgress(hermesBudget);
    return stored as HuntProgress;
  } catch {
    return blankProgress(hermesBudget);
  }
}

function saveProgress(root: string, progress: HuntProgress): void {
  const dir = join(dataDirFor(root));
  mkdirSync(dir, { recursive: true });
  progress.updatedAt = new Date().toISOString();
  const file = progressPath(root);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(progress, null, 2));
  renameSync(temp, file);
}

function regionProgress(progress: HuntProgress, regionKey: string, vertical: Vertical): RegionVerticalProgress {
  progress.regions[regionKey] ??= {};
  progress.regions[regionKey]![vertical] ??= {
    status: "pending", searched: 0, processedIds: [], added: 0, excluded: 0, lowData: 0, websiteDiscovered: 0, noWebsiteFound: 0,
  };
  return progress.regions[regionKey]![vertical]!;
}

// --- Discovery cascade in the order the owner asked for: OSM tag (handled by the caller) -> a
// verified domain guess -> SearXNG (self-hosted meta-search, WSL — falls back to a DuckDuckGo
// scrape if it isn't running) -> Hermes last, budget-capped. This deliberately doesn't use
// discovery.ts's own discoverWebsite() orchestrator (same cascade, reordered the same way as of
// 25 Sep 2026) so this file's own Hermes-budget accounting stays local and explicit. -----------
type HermesSearchFn = (input: DiscoveryInput, request: typeof fetch) => Promise<DiscoveredWebsite | null>;

async function discoverForHunt(
  input: DiscoveryInput,
  db: ReturnType<typeof openCrm>,
  hermesBudget: number,
  request: typeof fetch,
  hermesSearch: HermesSearchFn,
): Promise<DiscoveredWebsite | null> {
  const guessed = await guessWebsite(input, request).catch(() => null);
  if (guessed) return guessed;
  const searxng = await searxngWebsiteSearch(input, request).catch(() => null);
  if (searxng) return searxng;
  const ddg = await duckduckgoWebsiteSearch(input, request).catch(() => null);
  if (ddg) return ddg;
  const hermesUsed = usage(db)[HERMES_SKU] ?? 0;
  if (hermesUsed >= hermesBudget) return null;
  countCall(db, HERMES_SKU);
  return hermesSearch(input, request).catch(() => null);
}

// --- Core: one region + vertical --------------------------------------------------------------
async function huntRegionVertical(
  db: ReturnType<typeof openCrm>,
  root: string,
  region: (typeof HUNT_REGIONS)[number],
  vertical: Vertical,
  progress: HuntProgress,
  request: typeof fetch,
  log: (line: string) => void,
  hermesSearch: HermesSearchFn,
): Promise<void> {
  const rp = regionProgress(progress, region.key, vertical);
  if (rp.status === "done") {
    log(`  ${region.label} / ${vertical}: already done (${rp.added} added, ${rp.excluded} excluded, ${rp.lowData} low-data) — skipping`);
    return;
  }
  log(`  ${region.label} / ${vertical}: fetching from Overpass…`);
  let leads: OsmLead[];
  try {
    leads = await politeOverpassFetch(vertical, region.bbox, request);
  } catch (error) {
    // A persistently unreachable Overpass server is Overpass's problem tonight, not a reason to
    // abandon the rest of the hunt — left "pending" (not saved as fetched), so the next run
    // retries this exact region/vertical instead of skipping it.
    log(`  ${region.label} / ${vertical}: Overpass still failing after retries (${(error as Error).message}) — left pending, will retry next run`);
    return;
  }
  rp.searched = leads.length;
  rp.status = "fetched";
  saveProgress(root, progress);
  log(`  ${region.label} / ${vertical}: ${leads.length} found on OSM`);

  const known = knownPlaceIds(db);
  const processed = new Set(rp.processedIds);
  const fresh = leads.filter((l) => !known.has(l.sourceId) && !processed.has(l.sourceId));

  for (const item of fresh) {
    const exclusion = checkExclusion({ name: item.name, operator: item.operator, brand: item.brand });
    if (exclusion.excluded) {
      upsertLead(db, {
        placeId: item.sourceId, vertical, area: region.label, name: item.name, phone: item.phone,
        address: item.address, website: item.website, mapsUrl: item.mapsUrl, rating: null, reviews: null,
        emails: [], emailOk: false, score: 0, pitch: "website", reasons: [`excluded: ${exclusion.reason}`],
        googleAt: null, source: "osm", attribution: item.attribution, excluded: true, excludedReason: exclusion.reason,
      });
      rp.excluded++;
      rp.processedIds.push(item.sourceId);
      continue;
    }

    if (!item.phone && !item.website) {
      // Low data — no phone and no site tag: nothing useful to discover or audit yet, so don't
      // spend a DuckDuckGo/Hermes lookup or a fetch on it. Still on file, plainly labelled.
      upsertLead(db, {
        placeId: item.sourceId, vertical, area: region.label, name: item.name, phone: "", address: item.address,
        website: "", mapsUrl: item.mapsUrl, rating: null, reviews: null, emails: [], emailOk: false, score: 0,
        pitch: "audit_pending", reasons: ["low data — no phone and no website on file (audit skipped)"],
        googleAt: null, source: "osm", attribution: item.attribution,
      });
      rp.lowData++;
      rp.processedIds.push(item.sourceId);
      continue;
    }

    const suburb = suburbFromAddress(item.address);
    let finalUrl = item.website;
    let websiteSource = item.website ? "osm_tag" : "";
    let websiteConfidence: number | null = item.website ? 1 : null;
    let websiteCheckedAt: string | null = null;

    if (!finalUrl) {
      websiteCheckedAt = new Date().toISOString();
      const discovered = await discoverForHunt(
        { name: item.name, suburb, vertical, phone: item.phone, address: item.address },
        db, progress.hermesBudget, request, hermesSearch,
      );
      if (discovered) {
        finalUrl = discovered.url;
        websiteSource = `discovered_${discovered.source}`;
        websiteConfidence = discovered.confidence;
        rp.websiteDiscovered++;
      } else {
        rp.noWebsiteFound++;
      }
    }

    let audit = EMPTY_SITE_AUDIT;
    const emails = new Set<string>(item.email ? [item.email.toLowerCase()] : []);
    const phones = new Set<string>(item.phone ? [item.phone] : []);
    if (finalUrl) {
      // No browser here — this is the bulk pass; `rescan` does the browser-based redesign audit
      // (390px overflow, retry-on-failure) for leads worth that closer look.
      const result = await enrichWebsite(finalUrl, request, false);
      audit = result.audit;
      finalUrl = audit.finalUrl || finalUrl;
      for (const e of result.emails) emails.add(e.value);
    }
    const usableEmails = [...emails].filter((e) => !looksPersonal(e));
    const scored = scoreLead(
      { website: finalUrl, rating: null, reviews: null, hours: [], noWebsiteCheckedAt: null }, // the bulk hunt cannot prove an absence (it does not know whether search answered), so no check date reaches the scorer
      audit, vertical,
    );
    upsertLead(db, {
      placeId: item.sourceId, vertical, area: region.label, name: item.name, phone: [...phones][0] ?? "",
      address: item.address, website: finalUrl, mapsUrl: item.mapsUrl, rating: null, reviews: null,
      emails: usableEmails, emailOk: usableEmails.length > 0 && !audit.noUnsolicited, score: scored.score,
      pitch: scored.pitch, reasons: scored.reasons, googleAt: null, source: "osm", attribution: item.attribution,
      websiteSource, websiteConfidence, websiteCheckedAt,
      // The bulk hunt cannot tell whether a search engine answered for this lead, so an empty result is never "none-verified":
      // it stays not-checked until a Find or rescan (which do know) establishes it.
      websiteCheck: finalUrl ? "found" : "not-checked",
    });
    rp.added++;
    rp.processedIds.push(item.sourceId);
    if (rp.processedIds.length % 10 === 0) saveProgress(root, progress); // checkpoint every 10 leads
  }

  rp.status = "done";
  saveProgress(root, progress);
  const merged = mergeDuplicates(db);
  if (merged.length) log(`  ${region.label} / ${vertical}: merged ${merged.length} duplicate group(s)\n${renderMergeResults(merged)}`);
  log(`  ${region.label} / ${vertical}: done — ${rp.added} added, ${rp.excluded} excluded, ${rp.lowData} low-data, ${rp.websiteDiscovered} site(s) discovered, ${rp.noWebsiteFound} confirmed no site`);
}

export async function runHunt(
  opts: {
    hermesBudget?: number;
    request?: typeof fetch;
    log?: (line: string) => void;
    /** Defaults to the real repo root (crmPath(root)) — override for tests, so a test run never
     *  touches the production CRM or its progress file. */
    root?: string;
    /** Reuse an already-open connection (e.g. a test's temp DB); the caller keeps ownership and
     *  this function never closes it. Omit to let runHunt open+close its own via crmPath(root). */
    db?: ReturnType<typeof openCrm>;
    regions?: typeof HUNT_REGIONS;
    verticals?: Vertical[];
    /** Injectable for tests, so a run never makes a real Hermes call by accident on a machine
     *  that happens to have it configured. Defaults to the real hermesWebsiteSearch. */
    hermesSearch?: HermesSearchFn;
  } = {},
): Promise<HuntProgress> {
  const request = opts.request ?? fetch;
  const log = opts.log ?? ((line: string) => console.log(line));
  const hermesBudget = opts.hermesBudget ?? 150;
  const root = opts.root ?? ROOT;
  const regions = opts.regions ?? HUNT_REGIONS;
  const verticals = opts.verticals ?? HUNT_VERTICALS;
  const hermesSearch = opts.hermesSearch ?? hermesWebsiteSearch;
  const db = opts.db ?? openCrm(crmPath(root));
  try {
    const progress = loadProgress(root, hermesBudget);
    progress.hermesBudget = hermesBudget;
    for (const region of regions) {
      log(`${region.label}:`);
      for (const vertical of verticals) {
        await huntRegionVertical(db, root, region, vertical, progress, request, log, hermesSearch);
      }
    }
    return progress;
  } finally {
    if (!opts.db) db.close();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [command] = argv;
  const budgetFlagIndex = argv.indexOf("--hermes-budget");
  const hermesBudget = budgetFlagIndex >= 0 ? Number(argv[budgetFlagIndex + 1]) : 150;
  if (command === "status") {
    const progress = loadProgress(ROOT, hermesBudget);
    console.log(JSON.stringify(progress, null, 2));
  } else {
    runHunt({ hermesBudget }).then(
      (progress) => {
        console.log("Hunt complete or checkpointed. Final progress:");
        console.log(JSON.stringify(progress, null, 2));
      },
      (error) => {
        console.error("Hunt stopped:", (error as Error).message);
        process.exit(1);
      },
    );
  }
}
