/**
 * PREVIEW TEMPLATE (M&U lead previews, scripts/lead-sites/next-templates.ts). Every identity
 * value is a {{TOKEN}} that fill.ts replaces — in the HTML, the RSC payload and the JS chunks
 * alike, so hydration sees the same text the server rendered. The flagship's invented team,
 * fees and treatments are gone: nothing here may describe a real practice unless it came from
 * verified evidence. Lists (services) arrive at runtime from #mu-preview-data (lib/preview.ts).
 */
export const site = {
  name: "{{BUSINESS}}",
  namePossessive: "{{BUSINESS_POSS}}",
  tagline: "{{TAGLINE}}",
  suburb: "{{SUBURB}}",
  city: "",
  state: "",
  address: { line1: "{{ADDRESS_LINE1}}", suburb: "{{ADDRESS_LINE2}}", state: "", postcode: "" },
  phone: "{{PHONE}}",
  phoneHref: "{{PHONE_HREF}}",
  email: "{{EMAIL}}",
  emailHref: "{{EMAIL_HREF}}",
  hoursNote: "{{HOURS}}",
  servicesLabel: "{{SERVICES_LABEL}}",
  servicesCount: "{{SERVICES_COUNT}}",
  servicesNoun: "{{SERVICES_NOUN}}",
  hours: [] as { day: string; open: string | null; close: string | null }[],
  parking: "",
  transport: "",
  demoNotice: "{{DISCLAIMER}}",
  studio: { name: "M&U Ventures", url: "https://muventures.com.au" },
};

export const sampleFees = { currency: "AUD", note: "", items: [] as { code: string; name: string; from: number; to: number; includes: string }[], healthFunds: "", paymentPlans: "", cdbs: "" };

export const nav = [
  { href: "/treatments", label: "Treatments" },
  { href: "/#find-us", label: "Find us" },
] as const;

export const treatments = [] as { slug: string; group: string; name: string; short: string; duration: number; hero: string | null }[];
export type Treatment = (typeof treatments)[number];
export const team = [] as { slug: string; name: string; role: string; monogram: string; bio: string; focus: string[]; photo: string }[];
