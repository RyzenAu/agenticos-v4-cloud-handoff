/**
 * Structured listing data model.
 *
 * Everything the presentation layer renders comes through these types.
 * A CRM or listing-feed adapter maps its own records into `Listing`
 * (see src/lib/listings/adapters.ts and docs/CRM-INTEGRATION.md), so the
 * pages never care where a listing came from.
 */

export type ListingStatus = "for-sale" | "under-offer" | "sold" | "for-rent" | "leased" | "withdrawn";
export type SaleMethod = "private-treaty" | "auction" | "contact-agent" | "lease";
export type PropertyType = "house" | "terrace" | "semi" | "apartment" | "townhouse" | "warehouse";
export type ArtStyle = "terrace" | "federation" | "warehouse" | "modern" | "semi" | "apartment";
export type ArtView = "exterior" | "living" | "kitchen" | "bedroom" | "outdoor" | "floorplan";

export interface ArtSpec {
  style: ArtStyle;
  /** Six colours that tie every view of one property together. */
  palette: {
    sky: string;
    wall: string;
    trim: string;
    roof: string;
    ground: string;
    accent: string;
  };
  /** Which views the gallery shows, in order. */
  views: ArtView[];
  /** Outdoor scene variant; defaults by style when omitted. */
  outdoor?: "garden" | "courtyard" | "pool" | "water";
}

export interface Photo {
  /** Path under /public, e.g. /photos/27-darling-street-balmain/1.jpg */
  src: string;
  alt: string;
  /** The room shown, or "photo" for a supplied photograph whose subject is not known. */
  view: ArtView | "photo";
  /** Attribution for licensed photography: photographer, licence, source. */
  credit: string;
  creditUrl?: string;
  width: number;
  height: number;
}

/** Site-level licensed photograph (articles, panels, page heroes). */
export interface StockImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  credit: string;
}

export interface Inspection {
  /** ISO date, e.g. 2026-09-12 */
  date: string;
  start: string;
  end: string;
}

export interface FloorplanRoom {
  label: string;
  /** Grid units on a 12-wide plan. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ListingEvent {
  type: "listed" | "price-updated" | "under-offer" | "sold" | "leased" | "withdrawn" | "inspection-added";
  at: string;
  note?: string;
}

export interface Listing {
  id: string;
  slug: string;
  status: ListingStatus;
  method: SaleMethod;
  type: PropertyType;
  headline: string;
  address: { street: string; suburb: string; postcode: string; state: "NSW" };
  /** Display string, e.g. "Price guide $2,850,000" or "$920 per week". */
  priceDisplay: string;
  /** Numeric value used for filtering and sorting (weekly rent for leases). */
  priceValue: number;
  /** Result shown once sold/leased. */
  resultDisplay?: string;
  auctionAt?: string;
  beds: number;
  baths: number;
  cars: number;
  landSqm?: number;
  internalSqm?: number;
  description: string[];
  features: string[];
  inspections: Inspection[];
  agentSlugs: string[];
  art: ArtSpec;
  /** Licensed photographs. When present they replace the generated art. */
  photos?: Photo[];
  floorplan: FloorplanRoom[];
  listedAt: string;
  updatedAt: string;
  events: ListingEvent[];
  /** For rentals: availability and bond. */
  rental?: { availableFrom: string; bondWeeks: number; furnished: boolean; petsConsidered: boolean };
  /** Free-text notes the assistant may use verbatim. */
  assistantNotes?: string[];
  /** True for a listing the business itself supplied for this preview (the template's example stock never sets it). */
  supplied?: boolean;
  /** A supplied listing with no photograph: a plain "photos not supplied" tile is shown, never generated art. */
  noPhotos?: boolean;
  /** The business's own page for this listing on a property portal, when it supplied one (http or https only). */
  portalUrl?: string;
  /** Extra line shown with a price that was not published (a sold property whose price is not disclosed). */
  priceNote?: string;
  /** Counts the business did not supply (shown as a dash, never as zero). */
  unspecified?: ("beds" | "baths" | "cars")[];
}

export interface Agent {
  slug: string;
  name: string;
  role: string;
  team: "sales" | "property-management";
  phone: string;
  email: string;
  bio: string[];
  expertise: string[];
  suburbs: string[];
  initials: string;
  /** Portrait tint for the illustrated avatar. */
  tint: string;
  /** Photograph of the agent's patch, shown on agent cards instead of a face. */
  patch?: StockImage;
  languages?: string[];
}

export interface Suburb {
  slug: string;
  name: string;
  postcode: string;
  tagline: string;
  overview: string[];
  lifestyle: string[];
  amenities: string[];
  schools: string[];
  transport: string[];
  /** Demonstration figures. Clearly labelled fictional in the UI. */
  demoStats: { medianHouse: string; medianUnit: string; daysOnMarket: string; rentalYield: string };
  /** Position on the illustrated area map (0–100). */
  map: { x: number; y: number };
  character: "waterfront" | "terraces" | "warehouse" | "village" | "parkside";
}

export interface Article {
  slug: string;
  title: string;
  category: "Selling" | "Buying" | "Renting" | "Investing" | "Living here";
  excerpt: string;
  authorSlug: string;
  publishedAt: string;
  readMinutes: number;
  body: { type: "p" | "h2" | "ul"; text?: string; items?: string[] }[];
  cta: { label: string; href: string; blurb: string };
  tint: string;
  /** Lead image; falls back to the tint when absent. */
  image?: StockImage;
}

export interface Faq {
  q: string;
  a: string;
}
