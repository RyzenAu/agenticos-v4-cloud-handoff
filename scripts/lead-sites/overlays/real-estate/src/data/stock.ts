import type { StockImage } from "./types";
import { photosBySlug } from "./photos";

const credit = "Licensed stock photography via Unsplash";
const img = (file: string, alt: string, width: number, height: number): StockImage => ({ src: `/photos/stock/${file}.jpg`, alt, width, height, credit });

/**
 * Site-level photographs used outside listings: article leads, the
 * selling and management panels and the harbour image on suburb pages.
 * Listing photographs live in photos.ts.
 */
export const stock = {
  hero: img("hero-01", "A two-storey house lit at dusk, with full-height glazing to the garden", 2000, 1555),
  terraces: img("ext-06", "A row of two-storey brick terraces on a quiet Inner West street", 1600, 1067),
  skyline: img("hero-02", "Sydney apartment towers against a dusk sky", 1500, 2000),
  warehouse: photosBySlug["8-42-wellington-street-rozelle"][0] as StockImage,
  keys: img("life-01", "A set of house keys handed over at a front door", 1600, 1067),
  cottage: img("ext-03", "Weatherboard cottage with a bullnose verandah and a yellow front door", 1600, 1600),
  harbour: img("area-02", "Harbour foreshore parkland with palms and the city beyond", 1067, 1600),
  park: img("area-01", "Parkland with the city skyline behind the trees", 1600, 1067),
  cafe: img("life-02", "Cafe tables on a shaded footpath", 1600, 1066),
  garden: img("life-03", "Flower beds in a public garden in the Inner West", 1600, 1067),
  opera: img("area-04", "The Opera House seen between trees from the harbour", 1200, 1600),
} as const;
