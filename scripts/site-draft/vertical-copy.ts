// Generic, vertical-level copy for a first-draft website. Nothing here is a claim about any one
// business — it names the standard categories of work a business in this vertical typically does,
// so a draft never invents a specific practice's services, staff, reviews or awards. Real per-lead
// facts (name, suburb, phone, address) are filled in separately by generate.ts from the CRM.
import type { Vertical } from "../leads/places";

export type VerticalCopy = {
  /** What we call the vertical in the draft, e.g. "dental practice". */
  label: string;
  tagline: string;
  intro: string;
  services: string[];
  ctaLabel: string;
  accent: string;
};

export const VERTICAL_COPY: Record<Vertical, VerticalCopy> = {
  dental: {
    label: "dental practice",
    tagline: "Modern dental care, close to home",
    intro:
      "A local dental practice offering general and preventive care for the whole family. Call to check current availability and ask about the treatments below.",
    services: [
      "General & preventive check-ups",
      "Fillings & restorations",
      "Cosmetic dentistry",
      "Emergency appointments",
      "Children's dentistry",
    ],
    ctaLabel: "Book an appointment",
    accent: "#2f6f5e",
  },
  legal: {
    label: "law firm",
    tagline: "Straightforward legal advice you can trust",
    intro:
      "A local firm handling everyday legal work for individuals and small businesses. Call for an initial discussion about your matter.",
    services: [
      "Conveyancing & property law",
      "Wills & estates",
      "Family law",
      "Small business & contracts",
      "General advice",
    ],
    ctaLabel: "Request a consultation",
    accent: "#2c3e5c",
  },
  "real-estate": {
    label: "real estate agency",
    tagline: "Local knowledge, honest advice",
    intro:
      "A local agency helping people buy, sell and rent in the area. Call to talk through your property, whatever stage you're at.",
    services: [
      "Selling your home",
      "Property management",
      "Buying & appraisals",
      "Rental listings",
      "Local market updates",
    ],
    ctaLabel: "Get a free appraisal",
    accent: "#8a5a2b",
  },
};
