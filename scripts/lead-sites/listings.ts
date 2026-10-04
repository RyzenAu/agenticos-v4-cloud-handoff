// A real-estate prospect's OWN listings, as a structured input to the lead-site generator.
//
// The Aldergate preview used to carry the template's thirteen example properties on every site. A preview now shows only what the
// business supplied: this module checks and normalises that input, copies the supplied photographs into the preview, and writes one
// property page per listing. With no listings the preview has an honest empty state, never another agency's stock.
//
// Input (GenerateOptions.listings, an array of ListingInput):
//   id        the business's own identifier (any text); the page address comes from the street address
//   status    "for-sale" | "under-offer" | "sold" | "for-rent" | "leased" | "withdrawn"
//   address   "9 Ironbark Rise, Marrow Creek" or { street, suburb, postcode?, state? }
//   price     the price line as the business publishes it for a property on the market (omit when none is published)
//   result    the result line for sold / leased (omit when the price is not disclosed)
//   photos    local image files: [{ file, alt?, credit? }] or plain paths. Remote links are never fetched.
//   portalUrl the business's own page for the listing on a property portal (http or https)
//   plus optional headline, description[], features[], type, beds, baths, cars, landSqm, internalSqm, priceValue (for sorting),
//   inspections[], auctionAt, listedAt, soldAt, rental { availableFrom, bondWeeks, furnished, petsConsidered }
// Withdrawn listings get no page and are not shown anywhere: a withdrawn property is not available.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { namesStaff, readsAsClaim } from "./own-claims";
import { promisesIn } from "./promise-phrases";

export const LISTING_STATUSES = ["for-sale", "under-offer", "sold", "for-rent", "leased", "withdrawn"] as const;
export type ListingStatusInput = (typeof LISTING_STATUSES)[number];
export const PROPERTY_TYPES = ["house", "terrace", "semi", "apartment", "townhouse", "warehouse"] as const;

export type ListingPhotoInput = string | { file: string; alt?: string; credit?: string };
export type ListingInput = {
  id: string;
  status: ListingStatusInput;
  address: string | { street: string; suburb?: string; postcode?: string; state?: string };
  price?: string | null;
  result?: string | null;
  priceValue?: number;
  headline?: string;
  description?: string[];
  features?: string[];
  type?: (typeof PROPERTY_TYPES)[number];
  beds?: number;
  baths?: number;
  cars?: number;
  landSqm?: number;
  internalSqm?: number;
  photos?: ListingPhotoInput[];
  portalUrl?: string;
  inspections?: { date: string; start: string; end: string }[];
  auctionAt?: string;
  listedAt?: string;
  soldAt?: string;
  rental?: { availableFrom: string; bondWeeks?: number; furnished?: boolean; petsConsidered?: boolean };
};

/** One listing as the preview page reads it (the template's Listing type). */
export type PreviewListing = {
  id: string;
  slug: string;
  status: Exclude<ListingStatusInput, "withdrawn">;
  method: "private-treaty" | "auction" | "contact-agent" | "lease";
  type: (typeof PROPERTY_TYPES)[number];
  headline: string;
  address: { street: string; suburb: string; postcode: string; state: "NSW" };
  priceDisplay: string;
  priceValue: number;
  resultDisplay?: string;
  priceNote?: string;
  auctionAt?: string;
  beds: number;
  baths: number;
  cars: number;
  /** Counts the business did not supply: the page shows a dash, never a zero. */
  unspecified?: ("beds" | "baths" | "cars")[];
  landSqm?: number;
  internalSqm?: number;
  description: string[];
  features: string[];
  inspections: { date: string; start: string; end: string }[];
  agentSlugs: string[];
  art: { style: "modern"; palette: Record<"sky" | "wall" | "trim" | "roof" | "ground" | "accent", string>; views: ["exterior"] };
  photos?: { src: string; alt: string; view: "photo"; credit: string; width: number; height: number }[];
  noPhotos?: boolean;
  floorplan: [];
  listedAt: string;
  updatedAt: string;
  events: { type: "listed" | "sold" | "leased"; at: string; note?: string }[];
  rental?: { availableFrom: string; bondWeeks: number; furnished: boolean; petsConsidered: boolean };
  supplied: true;
  portalUrl?: string;
};

export type PhotoCopy = { from: string; to: string };
export type NormalisedListings = { items: PreviewListing[]; photos: PhotoCopy[]; notes: string[]; withdrawn: number };

export const MAX_LISTINGS = 40;
export const MAX_PHOTOS_PER_LISTING = 20;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_LISTINGS_FILE_BYTES = 1024 * 1024;
export const PLACEHOLDER_SLUG = "preview-listing";

const NEUTRAL = { sky: "#e5e4e0", wall: "#d9d4c7", trim: "#f2efe8", roof: "#6b6660", ground: "#7c8a75", accent: "#4e6b6a" };

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 99 ? Math.round(v) : undefined);
const area = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1_000_000 ? Math.round(v) : undefined);
const isoDay = (v: unknown): string | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v.slice(0, 10) : undefined);

/** "9 Ironbark Rise, Marrow Creek" → street and suburb. Only the pieces the business wrote are used. */
export function splitAddress(address: ListingInput["address"]): { street: string; suburb: string; postcode: string; state: "NSW" } | null {
  if (typeof address === "string") {
    const parts = address.split(",").map((p) => text(p, 120)).filter(Boolean);
    if (!parts.length) return null;
    const rest = parts.slice(1).join(", ");
    const post = /\b(\d{4})\b/.exec(rest);
    return { street: parts[0], suburb: rest.replace(/\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/gi, "").replace(/\b\d{4}\b/g, "").replace(/\s+/g, " ").trim(), postcode: post?.[1] ?? "", state: "NSW" };
  }
  const street = text(address?.street, 120);
  if (!street) return null;
  return { street, suburb: text(address.suburb, 80), postcode: /^\d{4}$/.test(String(address.postcode ?? "")) ? String(address.postcode) : "", state: "NSW" };
}

export function listingSlug(address: { street: string; suburb: string }, taken: Set<string>): string {
  const base =
    `${address.street} ${address.suburb}`
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70)
      .replace(/-+$/g, "") || "listing";
  let slug = base === PLACEHOLDER_SLUG ? `${base}-1` : base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`.slice(0, 80);
  taken.add(slug);
  return slug;
}

/** Real image files only: the extension and the first bytes must agree, and the file must be a sensible size. */
export function imageKind(file: string): "jpg" | "png" | "webp" | null {
  const ext = extname(file).toLowerCase();
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    if ((ext === ".jpg" || ext === ".jpeg") && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
    if (ext === ".png" && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (ext === ".webp" && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
    return null;
  } finally {
    closeSync(fd);
  }
}

export { STOCK_LEAK } from "./stock-leak";
import { STOCK_LEAK } from "./stock-leak";

/** Does this field read as a claim, or carry the example agency's identity? `own` (the business's own name, suburb, phone) is set aside first. */
export function fieldProblem(value: string, own: (v: string) => string, opts: { priceLine?: boolean } = {}): "claim" | "stock" | null {
  const t = own(value);
  if (STOCK_LEAK.some((re) => re.test(t))) return "stock";
  return readsAsClaim(value, opts) || namesStaff(value) || promisesIn(value).length ? "claim" : null;
}

export function normaliseListings(input: unknown, opts: { photosRoot?: string; now: Date; own?: (v: string) => string }): NormalisedListings {
  const setAside = opts.own ?? ((v: string) => v);
  let photosReal: string | null = null;
  try { photosReal = opts.photosRoot ? realpathSync(opts.photosRoot) : null; } catch { photosReal = null; }
  const notes: string[] = [];
  const items: PreviewListing[] = [];
  const photos: PhotoCopy[] = [];
  const taken = new Set<string>();
  let withdrawn = 0;
  let totalBytes = 0;
  const list = Array.isArray(input) ? (input as unknown[]) : [];
  if (input !== undefined && !Array.isArray(input)) notes.push("Listings were ignored: the input was not a list.");
  if (list.length > MAX_LISTINGS) notes.push(`Only the first ${MAX_LISTINGS} of ${list.length} listings are used.`);
  for (const raw of list.slice(0, MAX_LISTINGS)) {
    const l = (raw ?? {}) as Partial<ListingInput>;
    const id = text(l.id, 60) || "(no id)";
    const status = LISTING_STATUSES.find((s) => s === l.status);
    if (!status) { notes.push(`Listing ${id} skipped: unknown status.`); continue; }
    const address = splitAddress(l.address as ListingInput["address"]);
    if (!address) { notes.push(`Listing ${id} skipped: no street address.`); continue; }
    if (status === "withdrawn") { withdrawn++; notes.push(`Listing ${id} (${address.street}) is withdrawn: no page, not shown.`); continue; }
    const slug = listingSlug(address, taken);
    const onMarket = status === "for-sale" || status === "under-offer" || status === "for-rent";
    const rent = status === "for-rent" || status === "leased";
    // Free-text fields are the business's words but not exempt: each is read on its own, and one that reads as an award, guarantee or rating,
    // or names the template's example agency, agents or properties, is withheld and noted. Only the address is the business's own exempt text.
    const streetLine = `${address.street}${address.suburb ? `, ${address.suburb}` : ""}`;
    const clean = (value: unknown, max: number, field: string): string => {
      const t = text(value, max);
      const problem = t ? fieldProblem(t, (v) => setAside(v.split(streetLine).join(" ")), { priceLine: field === "price" || field === "result" }) : null;
      if (problem) { notes.push(`Listing ${id} (${address.street}): the ${field} was withheld (${problem === "claim" ? "it reads as an award, guarantee, rating or named staff member" : "it names the template's example agency, agent or street"}).`); return ""; }
      return t;
    };
    const price = clean(l.price, 120, "price");
    const result = clean(l.result, 120, "result");
    const auctionAt = typeof l.auctionAt === "string" && !Number.isNaN(Date.parse(l.auctionAt)) ? l.auctionAt : undefined;
    // What a visitor reads as the price. An unpublished price says so; it is never invented or guessed from the other fields.
    let priceDisplay = onMarket ? price || (rent ? "Contact the agency for the rent" : "Contact the agency for the price") : result || (rent ? "Leased" : "Sold");
    let resultDisplay: string | undefined;
    let priceNote: string | undefined;
    if (!onMarket) {
      resultDisplay = result || (rent ? "Leased" : "Sold");
      priceNote = result ? undefined : rent ? "The rent was not disclosed." : "The sale price was not disclosed.";
      priceDisplay = resultDisplay;
    }
    // Photographs: local files only, copied into the preview. Remote links are never fetched or hot-linked.
    const copied: NonNullable<PreviewListing["photos"]> = [];
    let refused = 0;
    const supplied = Array.isArray(l.photos) ? l.photos : [];
    if (supplied.length > MAX_PHOTOS_PER_LISTING) notes.push(`Listing ${id}: only the first ${MAX_PHOTOS_PER_LISTING} of ${supplied.length} photos are used.`);
    for (const p of supplied.slice(0, MAX_PHOTOS_PER_LISTING)) {
      const file = typeof p === "string" ? p : p?.file;
      if (typeof file !== "string" || !file.trim()) { refused++; continue; }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file.trim())) { refused++; notes.push(`Listing ${id}: a photo link was not used (photos must be local files).`); continue; }
      if (!photosReal) { refused++; notes.push(`Listing ${id}: photos were not used because the photos folder was not found or was not given.`); continue; }
      // The real path (junctions and links followed) must sit inside the photos folder: no "../", no absolute path elsewhere.
      let path = "";
      let kind: ReturnType<typeof imageKind> = null;
      try {
        path = realpathSync(isAbsolute(file) ? file : resolve(photosReal, file));
        const rel = relative(photosReal, path);
        const inside = rel !== "" && rel.split(/[\\/]/)[0] !== ".." && !isAbsolute(rel); // a segment named exactly ".." escapes; a file called "..x.jpg" does not
        kind = inside && statSync(path).isFile() && statSync(path).size > 0 && statSync(path).size <= MAX_PHOTO_BYTES ? imageKind(path) : null;
        if (!inside) { refused++; notes.push(`Listing ${id}: ${text(file, 80)} is outside the photos folder and was not used.`); continue; }
      } catch { kind = null; }
      if (!kind) { refused++; notes.push(`Listing ${id}: ${text(file, 80)} is not a usable jpg, png or webp image (up to ${MAX_PHOTO_BYTES / 1048576} MB).`); continue; }
      const size = statSync(path).size;
      if (totalBytes + size > MAX_TOTAL_PHOTO_BYTES) { refused++; notes.push(`Listing ${id}: ${text(file, 80)} was skipped because the photos already total ${Math.round(totalBytes / 1048576)} MB (the limit is ${MAX_TOTAL_PHOTO_BYTES / 1048576} MB).`); continue; }
      totalBytes += size;
      const n = copied.length + 1;
      const to = `listing-photos/${slug}/${n}.${kind}`;
      photos.push({ from: path, to });
      const alt = typeof p === "string" ? "" : clean(p.alt, 160, "photo caption");
      copied.push({ src: `/${to}`, alt: alt || `Photograph ${n} of ${address.street}${address.suburb ? `, ${address.suburb}` : ""}`, view: "photo", credit: (typeof p === "string" ? "" : clean(p.credit, 120, "photo credit")) || "Supplied by the business", width: 0, height: 0 });
    }
    const portal = typeof l.portalUrl === "string" && /^https?:\/\/[^\s]+$/i.test(l.portalUrl.trim()) ? l.portalUrl.trim().slice(0, 300) : undefined;
    if (l.portalUrl && !portal) notes.push(`Listing ${id}: the portal link was not used (it must start with http:// or https://).`);
    const beds = count(l.beds), baths = count(l.baths), cars = count(l.cars);
    const unspecified = (["beds", "baths", "cars"] as const).filter((k) => ({ beds, baths, cars })[k] === undefined);
    const listedAt = isoDay(l.listedAt);
    const soldAt = isoDay(l.soldAt);
    const headline = clean(l.headline, 160, "headline");
    const description = (Array.isArray(l.description) ? l.description : []).map((d) => clean(d, 1500, "description")).filter(Boolean).slice(0, 6);
    const features = (Array.isArray(l.features) ? l.features : []).map((f) => clean(f, 120, "feature")).filter(Boolean).slice(0, 30);
    const events: PreviewListing["events"] = [];
    if (listedAt) events.push({ type: "listed", at: listedAt });
    if (soldAt && !onMarket) events.push({ type: rent ? "leased" : "sold", at: soldAt });
    const inspections = (Array.isArray(l.inspections) ? l.inspections : []).flatMap((i) => (isoDay(i?.date) ? [{ date: isoDay(i.date)!, start: text(i.start, 20), end: text(i.end, 20) }] : [])).slice(0, 8);
    const rental = rent && l.rental && isoDay(l.rental.availableFrom)
      ? { availableFrom: isoDay(l.rental.availableFrom)!, bondWeeks: count(l.rental.bondWeeks) ?? 4, furnished: Boolean(l.rental.furnished), petsConsidered: Boolean(l.rental.petsConsidered) }
      : undefined;
    items.push({
      id,
      slug,
      status,
      method: rent ? "lease" : auctionAt ? "auction" : price || result ? "private-treaty" : "contact-agent",
      type: PROPERTY_TYPES.find((t) => t === l.type) ?? "house",
      headline: headline || `${address.street}${address.suburb ? `, ${address.suburb}` : ""}`,
      address,
      priceDisplay,
      priceValue: typeof l.priceValue === "number" && Number.isFinite(l.priceValue) && l.priceValue >= 0 ? l.priceValue : 0,
      ...(resultDisplay ? { resultDisplay } : {}),
      ...(priceNote ? { priceNote } : {}),
      ...(auctionAt ? { auctionAt } : {}),
      beds: beds ?? 0,
      baths: baths ?? 0,
      cars: cars ?? 0,
      ...(unspecified.length ? { unspecified: [...unspecified] } : {}),
      ...(area(l.landSqm) ? { landSqm: area(l.landSqm) } : {}),
      ...(area(l.internalSqm) ? { internalSqm: area(l.internalSqm) } : {}),
      description,
      features,
      inspections,
      agentSlugs: [],
      art: { style: "modern", palette: NEUTRAL, views: ["exterior"] },
      ...(copied.length ? { photos: copied } : { noPhotos: true as const }),
      floorplan: [],
      listedAt: listedAt ?? opts.now.toISOString().slice(0, 10),
      updatedAt: soldAt ?? listedAt ?? opts.now.toISOString().slice(0, 10),
      events,
      ...(rental ? { rental } : {}),
      supplied: true,
      ...(portal ? { portalUrl: portal } : {}),
    });
    if (!copied.length) notes.push(`Listing ${id} (${address.street}) has no photograph: the page says photos were not supplied.`);
    if (refused && copied.length) notes.push(`Listing ${id}: ${refused} photo(s) could not be used.`);
  }
  return { items, photos, notes, withdrawn };
}

/** The only listing text that counts as the business's own for the leak and claims scans: the address. Price, result, captions and credits are checked like any other field. */
export function listingTexts(items: PreviewListing[]): string[] {
  return items.flatMap((l) => [l.address.street, l.address.suburb]).filter(Boolean);
}

/** Copies the supplied photographs into the preview. */
export function copyListingPhotos(dir: string, photos: PhotoCopy[]) {
  for (const p of photos) {
    const to = join(dir, p.to);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(p.from, to);
  }
}

const walkFiles = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).map((p) => join(dir, p)).filter((p) => statSync(p).isFile()) : []);

/** The template exports ONE placeholder property page (property/preview-listing). Writes a copy of its files for every supplied
 *  listing under the listing's own address and removes the placeholder, so the preview has exactly the business's property pages.
 *  Text files have the placeholder slug replaced; file and folder names too. Returns the pages written. */
export function writePropertyPages(dir: string, pages: { slug: string; title: string }[]): number {
  const base = join(dir, "property");
  const files = walkFiles(base).filter((f) => {
    const rel = relative(base, f).replace(/\\/g, "/");
    return rel === `${PLACEHOLDER_SLUG}.html` || rel === `${PLACEHOLDER_SLUG}.txt` || rel.startsWith(`${PLACEHOLDER_SLUG}/`);
  });
  for (const { slug, title } of pages) {
    for (const file of files) {
      const rel = relative(base, file).replace(/\\/g, "/");
      const target = join(base, rel.split(PLACEHOLDER_SLUG).join(slug));
      mkdirSync(dirname(target), { recursive: true });
      if (/\.(html|txt|json|js|css)$/i.test(file)) {
        let body = readFileSync(file, "utf8").split(PLACEHOLDER_SLUG).join(slug);
        // Each property page has its own tab title, so browser tabs and history can tell the pages apart.
        if (/\.html$/i.test(file)) body = body.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`);
        writeFileSync(target, body, "utf8");
      }
      else copyFileSync(file, target);
    }
  }
  for (const file of files) rmSync(file, { force: true });
  // The placeholder's folders are empty now: remove them one by one (rmdir only ever removes an empty folder).
  const folders = existsSync(base) ? (readdirSync(base, { recursive: true }) as string[]).filter((p) => p.split(/[/\\]/)[0] === PLACEHOLDER_SLUG && statSync(join(base, p)).isDirectory()) : [];
  for (const p of [...folders].sort((x, y) => y.length - x.length)) { try { rmdirSync(join(base, p)); } catch { /* not empty: leave it */ } }
  try { rmdirSync(join(base, PLACEHOLDER_SLUG)); } catch { /* absent or not empty */ }
  return pages.length;
}

/** Reads a listings file the way a person on Windows may have saved it: UTF-8 with or without a byte-order mark, or UTF-16 (little or big endian,
 *  the PowerShell 5.1 default for ">" and Out-File). Returns the parsed value, or a plain reason when it cannot be read. */
export function readListingsFile(file: string): { value?: unknown; problem?: string } {
  try {
    const size = statSync(file).size;
    if (size > MAX_LISTINGS_FILE_BYTES) return { problem: `listings.json is too large (${Math.round(size / 1024)} KB; the limit is ${MAX_LISTINGS_FILE_BYTES / 1024} KB), so no listings were used.` };
    const buf = readFileSync(file);
    let textValue: string;
    if (buf[0] === 0xff && buf[1] === 0xfe) textValue = new TextDecoder("utf-16le").decode(buf.subarray(2));
    else if (buf[0] === 0xfe && buf[1] === 0xff) textValue = new TextDecoder("utf-16be").decode(buf.subarray(2));
    else textValue = new TextDecoder("utf-8").decode(buf).replace(/^\uFEFF/, "");
    return { value: JSON.parse(textValue) };
  } catch {
    return { problem: "listings.json could not be read as a list of listings (save it as plain text, UTF-8 or UTF-16, containing valid JSON), so no listings were used." };
  }
}
