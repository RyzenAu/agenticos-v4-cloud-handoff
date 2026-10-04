// Stage 2: art direction. Per-vertical design SYSTEMS, not palette swaps: every vertical has four
// distinct art directions (palette, type pairing, grid idea, motion language, imagery brief) and
// every direction can be composed with any of three hero compositions. A lead's name + suburb +
// vertical seed the pick, so the same lead always gets the same site across re-drafts while ten
// leads in one vertical spread over 4 x 3 = 12 different-feeling combinations (plus a per-lead
// imagery subject), not ten recolours of one template.
//
// Grounding (24 Sep 2026 teardown, see docs/WEBSITE-DRAFTS.md "v3"): the bars were Tend
// (hellotend.com, dental), Allens (allens.com.au, legal) and BresicWhitney (bresicwhitney.com.au,
// real estate). What the directions take from them is mechanism, not look: one oversized display
// voice per page, one accent used at most twice a screen, full-bleed place imagery rather than
// stock people, and a primary action that is always one tap away. What they refuse is the
// generated-site default (frontend-design / impeccable craft floor): cream + terracotta, eyebrow
// labels, identical card grids, gradient blobs, the same fade-up on every section, and people.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lead } from "../leads/crm";
import { contrast, hasBrand, type BrandTokens } from "./brand";

export type HeroVariant = "cinema" | "window" | "frame";
export type ShotId = "hero-wide" | "hero-close" | "section" | "detail";
export type Shot = { prompt: string; aspect: "16:9" | "3:4"; focalX?: number };

export type Direction = {
  seed: number;
  id: string;
  name: string;
  palette: {
    name: string;
    mode: "light" | "dark";
    /** Text colour. */
    ink: string;
    /** Page background. */
    paper: string;
    /** The single accent, used at most twice per screen. */
    accent: string;
    /** A quiet tint of the accent for fills. */
    accentSoft: string;
    /** Raised surface (drawers, the interactive tool). */
    surface: string;
    /** Secondary text; must pass AA on paper. */
    muted: string;
    /** Hairlines. */
    line: string;
    /** Text colour on an accent fill. */
    accentInk: string;
  };
  typePairing: {
    heading: string;
    body: string;
    note: string;
    /** Google Fonts css2 `family=` values, already encoded. */
    googleFamilies: string[];
    headingWeight: number;
    /** Tracking for the display face, in em. */
    headingTracking: number;
    /** Uppercase display (condensed grotesks) vs sentence case. */
    headingCase: "none" | "uppercase";
    /** font-stretch for the display face, as a percentage (variable width axis). */
    headingStretch?: number;
  };
  /** Grid / layout idea in one sentence. */
  layout: string;
  hero: HeroVariant;
  motion: { id: "drift" | "curtain" | "shutter"; description: string };
  imageryBrief: string;
  /** Four distinct stills, each used once on the page, and the film made FROM the hero-wide still. */
  imagePlan: Record<ShotId, Shot> & { film: { prompt: string } };
  tone: string;
  /** The one memorable moment this direction spends its boldness on (hero moment + material detail). */
  signature: string;
  /** Shape language: button and media corner radii, so directions don't share one kit. */
  shape: { button: string; media: string; arch: boolean };
  /** The lead's own brand tokens (brand.ts) and what the direction did with them. */
  brand?: { sourceUrl: string; colour: string | null; applied: boolean; fonts: string[]; logoUrl: string | null; note: string };
};

/** Small deterministic string hash (FNV-1a), then mulberry32 for a stable PRNG from that seed. */
function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  // Always consume exactly one roll so later picks don't shift when a pool changes size.
  return items[Math.floor(rand() * items.length) % items.length];
}

type Template = Omit<Direction, "seed" | "hero" | "imagePlan" | "motion" | "layout" | "shape"> & {
  shape?: Direction["shape"];
  scene: { wide: string; close: string; section: string; detail: string; move: string };
};

// Every prompt ends with this: mu-killer-site's negative block, phrased positively because the
// video models have no negative-prompt field and naming a thing ("no teeth") tends to prime it.
// Subjects above are already chosen to contain nothing clinical, nothing that reads as a result,
// and no real premises or listing.
export const NEGATIVE_BLOCK =
  "The space is completely empty of people. No text, lettering, numbers, logos, labels or signage anywhere in frame. Not a recognisable real building.";

/** For image models that do take a negative prompt. */
export const NEGATIVE_PROMPT =
  "people, person, face, hands, body, crowd, text, letters, words, numbers, logo, watermark, signage, label, screen, medical equipment, teeth";

const CAMERA =
  "Single continuous shot, one smooth cinematic camera move, 35mm lens, stable geometry: nothing morphs, bends or appears, lighting unchanged, photographic realism.";

const STILL_TAIL =
  "Natural light, photographic realism, subtle film grain, rich but restrained colour. The space is completely empty of people. No text, lettering, numbers, logos, labels or signage anywhere in frame.";

const DENTAL: Template[] = [
  {
    id: "dental-stone",
    shape: { button: "999px", media: "28px", arch: true },
    name: "Stone Clinic",
    palette: { name: "Stone and lapis", mode: "light", ink: "#1b1d21", paper: "#e9e6e1", accent: "#2d43b8", accentSoft: "#dadcf0", surface: "#f4f2ef", muted: "#55585e", line: "#c9c5bf", accentInk: "#ffffff" },
    typePairing: { heading: "Bricolage Grotesque", body: "Figtree", note: "a characterful optical-size grotesk, tight and large, over a friendly geometric body", googleFamilies: ["Bricolage+Grotesque:opsz,wght@12..96,500..800", "Figtree:wght@400;500;600"], headingWeight: 700, headingTracking: -0.035, headingCase: "none" },
    imageryBrief: "A calm, premium dental clinic: the treatment room and chair in soft morning light, the instrument tray, the reception, the everyday objects of dental care. Unmistakably dental; never a before/after or a smile as a result.",
    tone: "plain-spoken and reassuring",
    signature: "arched and pill-rounded forms that echo the plaster arches in the imagery, and one lapis-blue action colour",
    scene: {
      wide: "Vertical interior photograph of a calm, modern dental treatment room: a sculpted pale dental chair beneath an articulated overhead examination light, warm limestone-toned walls, a tall window with a sheer linen curtain letting in soft morning light, clean white cabinetry, minimal and premium, editorial architectural photography, 28mm lens, deep focus.",
      close: "Vertical close photograph in a calm dental treatment room: a stainless steel instrument tray with a dental mirror and probe laid neatly on a linen cloth, the pale headrest of the dental chair and the overhead examination light softly out of focus behind, soft morning window light, 50mm lens, shallow depth of field.",
      section: "Wide interior photograph of a calm dental clinic reception and waiting area: a curved limestone reception desk, pale timber bench seating, an arched plaster doorway through to a treatment room with a dental chair just visible, soft daylight, a eucalyptus branch in a stone vase, empty, editorial.",
      detail: "Macro still-life photograph: a bamboo toothbrush, a coil of dental floss and a sprig of fresh mint on a honed limestone ledge in soft morning light, shallow depth of field, 100mm macro lens.",
      move: "Slow, steady dolly-in toward the dental chair and the overhead examination light; the sheer curtain drifts gently at the window; the soft morning light stays constant.",
    },
  },
  {
    id: "dental-dusk",
    shape: { button: "999px", media: "18px", arch: false },
    name: "Dusk Room",
    palette: { name: "Blue dusk", mode: "dark", ink: "#ece8e1", paper: "#14171c", accent: "#b9c8ff", accentSoft: "#262b36", surface: "#1c2027", muted: "#a7abb3", line: "#343a45", accentInk: "#14171c" },
    typePairing: { heading: "Newsreader", body: "Inter Tight", note: "a literary display serif at large optical size, a compact grotesk for everything practical", googleFamilies: ["Newsreader:opsz,wght@6..72,300..600", "Inter+Tight:wght@400;500;600"], headingWeight: 400, headingTracking: -0.025, headingCase: "none" },
    imageryBrief: "Evening stillness: the last blue light in a calm room, glass and water, slow reflections. Unmistakably dental, never a result.",
    tone: "calm, unhurried, adult",
    signature: "a literary serif glowing on blue-black, with periwinkle reserved for the call to action",
    scene: {
      wide: "Interior photograph of a calm dental treatment room at blue hour: a pale dental chair under a softly glowing overhead examination light, smooth plaster walls, a tall window showing deep blue dusk, minimal and premium, 28mm lens.",
      close: "Close photograph: a dental mirror and probe on a stainless tray beside a glass of water, blue evening light and the warm glow of the examination light, 50mm lens, shallow depth of field.",
      section: "Wide photograph of a quiet dental clinic waiting room at dusk: low lamps, pale upholstered seating, a doorway through to a treatment room with a dental chair, blue light at the windows, empty.",
      detail: "Macro still-life photograph: a toothbrush and a coil of floss on a pale stone ledge in deep blue evening light with a warm lamp glow.",
      move: "Slow push-in toward the dental chair as the examination light glows softly; the dusk light at the window stays constant.",
    },
  },
  {
    id: "dental-linen",
    shape: { button: "14px", media: "24px", arch: true },
    name: "Fresh Linen",
    palette: { name: "Linen and navy", mode: "light", ink: "#10243a", paper: "#fafaf7", accent: "#ff6a3d", accentSoft: "#ffe4da", surface: "#f0f1ee", muted: "#4d5b6b", line: "#d9dcd8", accentInk: "#10243a" },
    typePairing: { heading: "Familjen Grotesk", body: "Instrument Sans", note: "a sturdy Scandinavian grotesk for display, a crisp neutral body", googleFamilies: ["Familjen+Grotesk:wght@500..700", "Instrument+Sans:wght@400;500;600"], headingWeight: 600, headingTracking: -0.03, headingCase: "none" },
    imageryBrief: "Bright and airy: white linen, clean water, fresh daylight, a sense of a cared-for morning.",
    tone: "bright, friendly, direct",
    signature: "bright linen whites with a single coral action colour and navy type",
    scene: {
      wide: "Bright, airy interior photograph of a modern dental treatment room: a white dental chair under an overhead examination light, white linen curtains lifting gently at tall windows, pale timber floor, a potted olive tree, 28mm lens, deep focus.",
      close: "Close photograph: a neat stainless instrument tray with a dental mirror on white linen, bright morning light, the white dental chair softly out of focus, 50mm lens.",
      section: "Wide photograph of a bright dental clinic reception: a white reception desk, pale timber benches, olive trees in pots, sunlit linen curtains, a treatment room with a dental chair visible through a doorway, empty.",
      detail: "Macro still-life photograph: a white toothbrush, floss and a sprig of mint on crisp folded linen in soft daylight.",
      move: "Slow dolly-in toward the white dental chair as the linen curtains lift and settle; light stays constant.",
    },
  },
  {
    id: "dental-sandstone",
    shape: { button: "6px", media: "10px", arch: true },
    name: "Sydney Sandstone",
    palette: { name: "Sandstone and oxblood", mode: "light", ink: "#2b2118", paper: "#ebe1d2", accent: "#7a2331", accentSoft: "#ecd3d3", surface: "#f4ede3", muted: "#5d5043", line: "#cdbfa9", accentInk: "#ffffff" },
    typePairing: { heading: "Young Serif", body: "Onest", note: "a sturdy old-style display serif with Sydney warmth, a modern humanist body", googleFamilies: ["Young+Serif", "Onest:wght@400;500;600"], headingWeight: 400, headingTracking: -0.02, headingCase: "none" },
    imageryBrief: "Local place: Sydney sandstone, afternoon sun, eucalypt shade. Warm, grounded, of Western Sydney rather than a showroom.",
    tone: "warm and local",
    signature: "warm sandstone ground with an oxblood action colour and an old-style serif voice",
    scene: {
      wide: "Interior photograph of a warm dental treatment room with a Sydney sandstone feature wall: a pale dental chair beneath an overhead examination light, eucalyptus trees outside a wide window, warm afternoon light, 28mm lens, deep focus.",
      close: "Close photograph: a stainless instrument tray with a dental mirror and probe beside the dental chair's headrest, warm afternoon light across sandstone behind, 50mm lens.",
      section: "Wide photograph of a dental clinic waiting area with a sandstone wall, timber bench seating and native plants, a treatment room with a dental chair through an open doorway, warm light, empty.",
      detail: "Macro still-life photograph: a bamboo toothbrush and dental floss on warm golden sandstone in raking afternoon light.",
      move: "Slow dolly toward the dental chair as eucalyptus leaf shadows sway on the sandstone wall; warm light constant.",
    },
  },
];

const LEGAL: Template[] = [
  {
    id: "legal-chambers",
    shape: { button: "2px", media: "2px", arch: false },
    name: "Chambers",
    palette: { name: "Bottle and brass", mode: "dark", ink: "#ebe6da", paper: "#0f1a16", accent: "#c8a96a", accentSoft: "#1d2a24", surface: "#15231e", muted: "#a9b0a6", line: "#2d3d36", accentInk: "#0f1a16" },
    typePairing: { heading: "Cormorant Garamond", body: "Source Sans 3", note: "a sharp Garamond display with courtroom gravity, a legible humanist body", googleFamilies: ["Cormorant+Garamond:wght@500;600", "Source+Sans+3:wght@400;500;600"], headingWeight: 500, headingTracking: -0.015, headingCase: "none" },
    imageryBrief: "A modern law firm: the meeting room, documents, a pen, the keys handed over at settlement. Unmistakably legal work; no scales, no gavels.",
    tone: "measured and confident, no legalese",
    signature: "a sharp Garamond on bottle green with brass reserved for the one action",
    scene: {
      wide: "Wide interior photograph of a quiet, modern law firm meeting room high in a city tower at golden hour: a long dark timber table with leather chairs; on the table a neat stack of contract documents with coloured sign-here flags, a fountain pen and a set of house keys on a brass ring; behind, a low credenza lined with plain archive boxes and bound legal folders, floor-to-ceiling windows looking out over the leafy treetops of a low-rise Australian suburb with no landmark buildings, a deep green feature wall, warm late light, 24mm lens, deep focus.",
      close: "Close photograph on a dark timber meeting table: a contract with blank signature lines and coloured sign-here flags, a fountain pen resting across it, a set of house keys on a brass ring beside it, a stack of bound legal folders behind, a shaft of warm late light, 50mm lens, shallow depth of field.",
      section: "Wide photograph of a law office desk seen from the visitor's chair: an open contract with blank signature lines and coloured sign-here flags, a fountain pen, a stack of bound legal folders tied with pink legal ribbon, a brass desk lamp, a deep green wall and soft daylight from a tall window, empty of people, 35mm lens.",
      detail: "Macro still-life photograph: a fountain pen resting on crisp blank contract paper beside a brass key ring, raking golden light, shallow depth of field.",
      move: "Slow, steady dolly-in along the meeting table toward the tall windows; the treetops outside stir very gently; the warm late light stays constant.",
    },
  },
  {
    id: "legal-paper",
    shape: { button: "0px", media: "0px", arch: false },
    name: "Paper Trail",
    palette: { name: "Paper and Oxford blue", mode: "light", ink: "#121417", paper: "#f3f2ee", accent: "#1c3faa", accentSoft: "#dde3f5", surface: "#fbfaf8", muted: "#4f535a", line: "#cfccc5", accentInk: "#ffffff" },
    typePairing: { heading: "Libre Caslon Display", body: "Instrument Sans", note: "a document-grade Caslon at display size, a clean contemporary body", googleFamilies: ["Libre+Caslon+Display", "Instrument+Sans:wght@400;500;600"], headingWeight: 400, headingTracking: -0.02, headingCase: "none" },
    imageryBrief: "Material honesty: heavy paper, light and shadow, a fountain-pen line. Abstract and tactile, no documents with readable text.",
    tone: "direct and reassuring",
    signature: "a document-grade Caslon with Oxford blue used only for actions",
    scene: {
      wide: "Photograph of a quiet law office: a pale oak desk by a tall window with neat stacks of blank documents in folders, a fountain pen, a desk lamp, blind-slat shadows across the desk, soft afternoon light, 28mm lens.",
      close: "Close photograph: a closed leather document folder, a fountain pen and a pair of house keys on a pale oak desk in blind-slat light, 50mm lens.",
      section: "Wide photograph of a light-filled law office meeting room: a round oak table, four chairs, neat blank document folders, a tall window, soft daylight, empty.",
      detail: "Macro photograph: a fountain pen nib resting on blank heavy contract paper, soft light, shallow depth of field.",
      move: "Slow push-in toward the desk and its documents as the blind-slat shadows drift very slightly.",
    },
  },
  {
    id: "legal-graphite",
    shape: { button: "0px", media: "0px", arch: false },
    name: "Graphite Grid",
    palette: { name: "Graphite and signal red", mode: "light", ink: "#0c0d0e", paper: "#e7e8e6", accent: "#c8281a", accentSoft: "#f1d6d2", surface: "#f2f3f1", muted: "#4a4d50", line: "#bfc2c0", accentInk: "#ffffff" },
    typePairing: { heading: "Archivo", body: "Archivo", note: "one family: Archivo condensed and heavy for display, regular width for reading", googleFamilies: ["Archivo:wdth,wght@62..100,400..800"], headingWeight: 800, headingTracking: -0.01, headingCase: "uppercase", headingStretch: 62 },
    imageryBrief: "Civic architecture: concrete, glass and shadow in strong geometry. Modern Parramatta-scale city, abstracted to planes.",
    tone: "plain-English and exact",
    signature: "condensed uppercase Archivo on a strict grid, with signal red used once per screen",
    scene: {
      wide: "Wide interior photograph of a modern law firm floor: a glass-walled meeting room with a long table and chairs, a concrete column, city light through tall windows, documents neatly stacked on the table, empty, crisp afternoon light, 24mm lens.",
      close: "Close photograph: a stack of blank document folders, a pen and a set of keys on a pale concrete table, crisp hard light, 50mm lens.",
      section: "Wide photograph of a minimal law office reception with a concrete desk, black chairs and plain archive shelving, hard afternoon light, empty.",
      detail: "Macro photograph: a black pen on crisp blank contract paper on concrete, raking light.",
      move: "Slow lateral glide past the glass meeting room toward the windows; light constant.",
    },
  },
  {
    id: "legal-harbour",
    shape: { button: "4px", media: "6px", arch: false },
    name: "Harbour Slate",
    palette: { name: "Slate and harbour blue", mode: "dark", ink: "#e9edf1", paper: "#1b2129", accent: "#8fb3d9", accentSoft: "#26303c", surface: "#222a34", muted: "#aab4bf", line: "#36414e", accentInk: "#1b2129" },
    typePairing: { heading: "Spectral", body: "IBM Plex Sans", note: "a screen-first serif at light weight, a rational body", googleFamilies: ["Spectral:wght@300;400", "IBM+Plex+Sans:wght@400;500;600"], headingWeight: 300, headingTracking: -0.02, headingCase: "none" },
    imageryBrief: "Water and weather: river light, slate, rain on glass. Steady and composed.",
    tone: "steady and composed",
    signature: "a light screen serif on slate, with harbour blue for actions only",
    scene: {
      wide: "Wide interior photograph of a calm law firm meeting room overlooking a river at dusk: a long timber table, leather chairs, closed document folders and a pen, slate-blue sky and city lights beyond tall windows, 24mm lens.",
      close: "Close photograph: a closed document folder, a fountain pen and a set of house keys on a timber table, blurred river lights beyond the window, 50mm lens.",
      section: "Wide photograph of a quiet law office reception at dusk, slate tones, low lamps, plain archive shelving, empty.",
      detail: "Macro photograph: a set of house keys resting on blank contract paper, soft blue evening light.",
      move: "Slow push-in along the table toward the window and the river lights; light constant.",
    },
  },
];

const REAL_ESTATE: Template[] = [
  {
    id: "re-golden",
    shape: { button: "999px", media: "18px", arch: true },
    name: "Golden Hour",
    palette: { name: "Warm plaster and bottle green", mode: "light", ink: "#1f1b17", paper: "#f2ede6", accent: "#22523b", accentSoft: "#d8e5dc", surface: "#faf7f3", muted: "#5a534b", line: "#d6cec3", accentInk: "#ffffff" },
    typePairing: { heading: "Gloock", body: "Figtree", note: "a high-contrast display serif with editorial weight, a friendly body", googleFamilies: ["Gloock", "Figtree:wght@400;500;600"], headingWeight: 400, headingTracking: -0.02, headingCase: "none" },
    imageryBrief: "Home, not a listing: late sun across timber floors and white walls in an empty room. Nothing that could be mistaken for a specific property.",
    tone: "warm and local",
    signature: "a high-contrast display serif over warm plaster, bottle green for actions",
    scene: {
      wide: "Wide interior photograph: an empty living room of a sunlit Australian home, warm timber floorboards, white walls, tall windows, golden late-afternoon light and leaf shadows, no furniture, 24mm lens, deep focus.",
      close: "Close photograph: golden sun across warm timber floorboards and a white skirting board, soft leaf shadows, 50mm lens.",
      section: "Photograph: frangipani shadows on a whitewashed brick courtyard wall at golden hour, 50mm lens.",
      detail: "Macro photograph: warm timber floorboard grain in golden light, 100mm macro lens.",
      move: "Slow dolly-in across the empty room toward the sunlit windows; sheer curtains drift; light constant.",
    },
  },
  {
    id: "re-jacaranda",
    shape: { button: "4px", media: "2px", arch: false },
    name: "Brick and Jacaranda",
    palette: { name: "Jacaranda and brick", mode: "light", ink: "#1d1a21", paper: "#f4f3f1", accent: "#6d4fc0", accentSoft: "#e4def0", surface: "#fbfbfa", muted: "#57535c", line: "#d8d5d1", accentInk: "#ffffff" },
    typePairing: { heading: "Bricolage Grotesque", body: "Albert Sans", note: "a bold suburban grotesk at its condensed width for a masthead, a plain body", googleFamilies: ["Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,600..800", "Albert+Sans:wght@400;500;600"], headingWeight: 800, headingTracking: -0.03, headingCase: "none", headingStretch: 75 },
    imageryBrief: "Western Sydney in spring: jacaranda blossom, red-brick walls, wide sky. Local texture, not a streetscape anyone could identify.",
    tone: "friendly, straight-talking",
    signature: "a bold suburban grotesk with jacaranda purple as the single action colour",
    scene: {
      wide: "Wide photograph of a quiet, leafy Western Sydney suburban street in late spring, crisp mid-morning sun: jacaranda trees in full violet bloom arching over the footpath, 1970s red-brick single-storey houses with terracotta tiled roofs and neat lawns, violet petals scattered on the grass verge, clear blue sky, no cars, deep focus, 28mm lens.",
      close: "Photograph of one red-brick house's front garden beneath a blooming jacaranda: violet petals on a clipped lawn and a brick path leading to a timber front door with a frosted glass panel, terracotta tiled roof edge, crisp morning sun, 50mm lens, no house number, no letterbox.",
      section: "Photograph of the open-plan living room of a renovated brick family home, styled for sale: a linen sofa, a timber dining table set for four, warm timber floorboards, sliding glass doors open to a green backyard lawn and a jacaranda beyond, late afternoon golden light, 28mm lens.",
      detail: "Macro detail photograph: fallen violet jacaranda flowers on warm red-brick paving, crisp sunlight, shallow depth of field, 100mm macro lens.",
      move: "Slow, smooth forward dolly along the footpath beneath the blooming jacaranda trees; a few petals drift down; leaves stir in a light breeze.",
    },
  },
  {
    id: "re-streetfront",
    shape: { button: "0px", media: "0px", arch: false },
    name: "Streetfront",
    palette: { name: "White, ink and signal yellow", mode: "light", ink: "#111111", paper: "#ffffff", accent: "#f2c230", accentSoft: "#fdf3cf", surface: "#f4f4f2", muted: "#555555", line: "#dddddd", accentInk: "#111111" },
    typePairing: { heading: "Big Shoulders Display", body: "Public Sans", note: "a tall condensed display for a confident agency masthead, a civic body", googleFamilies: ["Big+Shoulders+Display:wght@700;800", "Public+Sans:wght@400;500;600"], headingWeight: 800, headingTracking: 0, headingCase: "none" },
    imageryBrief: "Architecture as rhythm: rooflines, eaves and sky in clean geometry. Abstracted so no real house can be identified.",
    tone: "confident and low-pressure",
    signature: "a tall condensed masthead in black and white, signal yellow for one highlight per screen",
    scene: {
      wide: "Wide architectural photograph: a clean modern Australian house roofline and deep eaves against a bright blue sky, crisp midday shadows, abstracted, 24mm lens.",
      close: "Close architectural photograph: a white rendered wall and timber batten screen with strong midday shadows, 50mm lens.",
      section: "Photograph of a modern Australian family home's front garden and entry: a pale brick facade, a timber front door, a paved path through a clipped lawn, crisp daylight, 35mm lens, no house number.",
      detail: "Macro photograph: timber battens and crisp shadow lines, 100mm lens.",
      move: "Slow lateral glide along the roofline as clouds drift overhead.",
    },
  },
  {
    id: "re-evening",
    shape: { button: "4px", media: "8px", arch: true },
    name: "Evening Lamps",
    palette: { name: "Night amber", mode: "dark", ink: "#f1e9dc", paper: "#17140f", accent: "#e9a14b", accentSoft: "#2a231a", surface: "#201c16", muted: "#b9ad9b", line: "#3a3228", accentInk: "#17140f" },
    typePairing: { heading: "DM Serif Display", body: "DM Sans", note: "a warm display serif with a matching geometric body", googleFamilies: ["DM+Serif+Display", "DM+Sans:opsz,wght@9..40,400..600"], headingWeight: 400, headingTracking: -0.015, headingCase: "none" },
    imageryBrief: "Coming home: warm lamplight glowing through windows at dusk, a porch light, the blue hour. Intimate, never a listing photo.",
    tone: "warm and assured",
    signature: "a warm display serif on night brown, amber lamplight for actions",
    scene: {
      wide: "Wide photograph at blue hour: warm lamplight glowing through the sheer curtains of a brick house window, dark garden leaves in the foreground, deep blue sky, 28mm lens.",
      close: "Close photograph at dusk: a softly glowing porch light beside a timber front door, warm bokeh, 50mm lens, no house number.",
      section: "Photograph: warm interior lamplight spilling across a timber floor through an open doorway at night, 35mm lens.",
      detail: "Macro photograph: warm lamplight on a brass door handle and timber grain, 100mm lens.",
      move: "Slow push-in toward the glowing window as garden leaves sway gently.",
    },
  },
];

const TEMPLATES: Record<Lead["vertical"], Template[]> = { dental: DENTAL, legal: LEGAL, "real-estate": REAL_ESTATE };

// Which hero compositions fit each vertical's reference bar (critic rounds, 24 Sep 2026): the
// legal and real-estate bars are full-bleed place imagery and a masthead, so a boxed frame lost
// every time there; the dental bar (Tend) rewards the arch-masked frame.
export const HERO_POOLS: Record<Lead["vertical"], readonly HeroVariant[]> = {
  dental: ["frame", "cinema", "window"],
  legal: ["cinema", "window"],
  "real-estate": ["window", "cinema"],
};

const HEROES: Record<HeroVariant, { layout: string; motion: Direction["motion"]; moment: string }> = {
  cinema: {
    moment: "the full-bleed film settles from over-scale while the bottom-anchored headline lifts away faster than the image",
    layout: "Full-bleed film hero with the headline anchored bottom-left on a 12-column grid; content sections run in a 7/5 asymmetric split and ride up over the pinned hero on a rounded sheet.",
    motion: { id: "drift", description: "Hero film scales gently while the headline lifts faster (two-speed parallax); a pinned statement fills word by word; service rows draw their rules in sequence; Lenis smooth scroll." },
  },
  window: {
    moment: "the film opens from an inset window to full bleed as the page scrolls",
    layout: "Type-first hero: an oversized headline across the full measure, then a media window that starts inset and widens to full bleed; sections alternate a wide measure with a narrow reading column.",
    motion: { id: "curtain", description: "The media window's clip-path opens from inset to full bleed on scroll (scrubbed); a pinned statement fills word by word; a cursor-following preview on service rows; Lenis smooth scroll." },
  },
  frame: {
    moment: "a tall arch-topped frame holds the still beside the headline, then the film opens out of an inset card into a full-bleed band",
    layout: "Split hero: 7/5 type block against a tall frame that bleeds off the right edge; lower sections use an index-list layout, not cards.",
    motion: { id: "shutter", description: "The still drifts inside its frame (inner parallax) while the frame holds; a pinned statement fills word by word; the film band opens from an inset card to full bleed; Lenis smooth scroll." },
  },
};

export type DirectionHistory = {
  /** `${direction id}/${hero}` keys already used by drafts in the same vertical. */
  usedCombos?: string[];
  /** Hero compositions already used by drafts in any vertical, for spreading layouts. */
  usedHeroes?: HeroVariant[];
};

export function comboKey(direction: Pick<Direction, "id" | "hero">): string {
  return `${direction.id}/${direction.hero}`;
}

/**
 * Deterministic per-lead direction. With no history, the same name+suburb+vertical always
 * reproduces the same pick. With history (the orchestrator passes the directions of drafts that
 * already exist), the seeded order is kept but combinations another lead in the same vertical
 * already has are skipped, and the least-used hero composition is preferred, so ten leads get ten
 * different-feeling sites instead of the birthday-paradox collisions a bare hash gives.
 */
export function buildDirection(lead: Pick<Lead, "name" | "area" | "vertical">, history: DirectionHistory = {}): Direction {
  const seed = hashSeed(`${lead.name}|${lead.area}|${lead.vertical}`);
  const rand = mulberry32(seed);
  const templates = TEMPLATES[lead.vertical] ?? DENTAL;
  const heroes = HERO_POOLS[lead.vertical] ?? HERO_POOLS.dental;
  const firstTemplate = pick(rand, templates);
  const firstHero = pick(rand, heroes);
  rand(); // kept so existing seeds keep their direction/hero picks
  // Seeded order over every combination, starting at the bare-hash pick.
  const combos: { template: Template; hero: HeroVariant }[] = [];
  const t0 = templates.indexOf(firstTemplate);
  const h0 = heroes.indexOf(firstHero);
  for (let t = 0; t < templates.length; t++)
    for (let h = 0; h < heroes.length; h++)
      combos.push({ template: templates[(t0 + t) % templates.length], hero: heroes[(h0 + h) % heroes.length] });
  const used = new Set(history.usedCombos ?? []);
  const heroUse = (hero: HeroVariant) => (history.usedHeroes ?? []).filter((h) => h === hero).length;
  const fresh = combos.filter((c) => !used.has(`${c.template.id}/${c.hero}`));
  const pool = fresh.length ? fresh : combos;
  const minUse = Math.min(...pool.map((c) => heroUse(c.hero)));
  // Among the least-used compositions, prefer the one that best fits the vertical's reference bar
  // (HERO_POOLS order), then the seeded order.
  const rank = (h: HeroVariant) => heroes.indexOf(h);
  const chosen = pool.filter((c) => heroUse(c.hero) === minUse).sort((x, y) => rank(x.hero) - rank(y.hero))[0];
  const template = chosen.template;
  const hero = chosen.hero;
  const { scene, ...rest } = template;
  const heroAspect = hero === "frame" ? "3:4" : "16:9";
  const shot = (text: string, aspect: Shot["aspect"]): Shot => ({ prompt: `${text} ${STILL_TAIL}`, aspect });
  return {
    ...rest,
    seed,
    hero,
    layout: HEROES[hero].layout,
    motion: HEROES[hero].motion,
    signature: `${HEROES[hero].moment}; ${template.signature}`,
    shape: template.shape ?? { button: "999px", media: "22px", arch: false },
    imagePlan: {
      "hero-wide": shot(scene.wide, heroAspect),
      "hero-close": shot(scene.close, heroAspect),
      section: shot(scene.section, "16:9"),
      detail: shot(scene.detail, "3:4"),
      film: { prompt: `${scene.move} ${CAMERA} ${NEGATIVE_BLOCK}` },
    },
  };
}

function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(a, i) * t + ch(b, i) * (1 - t)).toString(16).padStart(2, "0")).join("")}`;
}

/** Brand-locks a seeded direction (mu-art-direction: existing client branding takes priority):
 *  the business's own primary colour replaces the seeded accent when it reads on the direction's
 *  paper (>= 3:1, WCAG non-text contrast) and a legible label colour exists for buttons (>= 4.5:1).
 *  Otherwise the seeded accent stays and the reason is recorded. Fonts and logo are recorded for
 *  the build prompt, never swapped in blind (the draft self-hosts its own licensed pairing). */
export function applyBrandTokens(direction: Direction, brand: BrandTokens | null | undefined): Direction {
  if (!hasBrand(brand)) return direction;
  if (direction.brand?.applied && direction.brand.colour === brand.primary) return direction; // a saved, already brand-locked direction
  const base = { sourceUrl: brand.sourceUrl, colour: brand.primary, fonts: brand.fonts, logoUrl: brand.logoUrl };
  const p = direction.palette;
  const c = brand.primary;
  if (!c) return { ...direction, brand: { ...base, applied: false, note: "No chromatic brand colour found on their site; the seeded accent stays." } };
  const onPaper = contrast(c, p.paper);
  const label = contrast(c, "#ffffff") >= contrast(c, "#111111") ? "#ffffff" : "#111111";
  if (onPaper < 3 || contrast(c, label) < 4.5) {
    return { ...direction, brand: { ...base, applied: false, note: `Their colour ${c} is only ${onPaper.toFixed(1)}:1 on this direction's paper ${p.paper}; the seeded accent stays and ${c} may be used for large marks only.` } };
  }
  return {
    ...direction,
    palette: { ...p, name: `${p.name}, with their brand colour`, accent: c, accentInk: label, accentSoft: mix(c, p.paper, 0.16) },
    brand: { ...base, applied: true, note: `Accent ${c} is the business's own colour (${onPaper.toFixed(1)}:1 on paper), replacing the seeded ${p.accent}.` },
  };
}

/** Every direction a vertical can produce, for docs, tests and the design-system page. */
export function directionsFor(vertical: Lead["vertical"]): { id: string; name: string; palette: string; type: string }[] {
  return (TEMPLATES[vertical] ?? []).map((t) => ({ id: t.id, name: t.name, palette: t.palette.name, type: `${t.typePairing.heading} / ${t.typePairing.body}` }));
}

export function renderDirectionMarkdown(lead: Pick<Lead, "name" | "area" | "vertical">, direction: Direction): string {
  const p = direction.palette;
  return `# Art direction: ${lead.name}

Direction **${direction.name}** (\`${direction.id}\`), hero composition **${direction.hero}**, motion language **${direction.motion.id}**.
Seed ${direction.seed} (from business name + suburb + vertical, stable across re-drafts).

## Palette: ${p.name} (${p.mode})
| Token | Value |
|---|---|
| paper | \`${p.paper}\` |
| ink | \`${p.ink}\` |
| accent (at most twice per screen) | \`${p.accent}\` |
| accentSoft | \`${p.accentSoft}\` |
| surface | \`${p.surface}\` |
| muted | \`${p.muted}\` |
| line | \`${p.line}\` |

${direction.brand ? `## Their brand (read from ${direction.brand.sourceUrl})
${direction.brand.note}${direction.brand.fonts.length ? ` Fonts on their site: ${direction.brand.fonts.join(", ")}.` : ""}${direction.brand.logoUrl ? ` Logo: ${direction.brand.logoUrl} (recorded for the founder; never redrawn or re-hosted).` : ""}

` : ""}## Type
${direction.typePairing.heading} (display, weight ${direction.typePairing.headingWeight}, tracking ${direction.typePairing.headingTracking}em${direction.typePairing.headingCase === "uppercase" ? ", uppercase" : ""}) / ${direction.typePairing.body} (body): ${direction.typePairing.note}.

## Layout
${direction.layout}

## Motion
${direction.motion.description} Everything is transform/opacity/clip-path only; \`prefers-reduced-motion: reduce\` gets a static page with the poster image and no smooth scroll.

## Signature moment
${direction.signature}.

## Imagery brief
${direction.imageryBrief}

Four stills (each used once): hero wide (${direction.imagePlan["hero-wide"].aspect}, the film's first frame), hero close (the match-dissolve), a section image and a detail. The film is generated FROM the hero-wide still and is only scroll-scrubbed on wide screens; phones and reduced motion get the still push-in.
No photography of people, real staff, real patients or real premises. Generated imagery is captioned
"Illustrative image, AI-generated for this concept."

## Tone
${direction.tone}
`;
}

/** A direction a previous run already wrote for this draft (v3 shape only), so re-drafts are stable. */
export function loadSavedDirection(dir: string): Direction | null {
  const path = join(dir, "direction.json");
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    return saved && typeof saved.id === "string" && typeof saved.hero === "string" && saved.palette?.surface && saved.imagePlan?.["hero-wide"] ? (saved as Direction) : null;
  } catch {
    return null;
  }
}

/** Directions already used by sibling drafts, for buildDirection's collision avoidance. */
export function historyFromDrafts(draftsRoot: string, vertical: Lead["vertical"], exceptSlug: string): DirectionHistory {
  const history: Required<DirectionHistory> = { usedCombos: [], usedHeroes: [] };
  if (!existsSync(draftsRoot)) return history;
  const ids = new Set((TEMPLATES[vertical] ?? []).map((t) => t.id));
  for (const entry of readdirSync(draftsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === exceptSlug) continue;
    const saved = loadSavedDirection(join(draftsRoot, entry.name));
    if (!saved) continue;
    history.usedHeroes.push(saved.hero);
    if (ids.has(saved.id)) history.usedCombos.push(comboKey(saved));
  }
  return history;
}

export function writeDirection(dir: string, lead: Pick<Lead, "name" | "area" | "vertical">, direction: Direction): { mdPath: string; jsonPath: string } {
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, "direction.md");
  const jsonPath = join(dir, "direction.json");
  writeFileSync(mdPath, renderDirectionMarkdown(lead, direction), "utf8");
  writeFileSync(jsonPath, JSON.stringify(direction, null, 2), "utf8");
  return { mdPath, jsonPath };
}
