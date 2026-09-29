/**
 * PREVIEW TEMPLATE (M&U lead previews, scripts/lead-sites/next-templates.ts). Every identity
 * value is a {{TOKEN}} that fill.ts replaces in the HTML, the RSC payload and the JS chunks
 * alike. The flagship's agents, listings, suburb guides, insights and "why us" claims are gone.
 * Services arrive at runtime from #mu-preview-data (lib/preview.ts).
 */
export const site = {
  name: "{{BUSINESS}}",
  legalLine: "",
  url: "https://muventures.com.au",
  tagline: "{{TAGLINE}}",
  description: "",
  phone: "{{PHONE}}",
  phoneHref: "{{PHONE_HREF}}",
  email: "{{EMAIL}}",
  emailHref: "{{EMAIL_HREF}}",
  suburb: "{{SUBURB}}",
  office: { street: "{{ADDRESS_LINE1}}", suburb: "{{ADDRESS_LINE2}}", postcode: "", map: { x: 0, y: 0 } },
  hoursNote: "{{HOURS}}",
  servicesLabel: "{{SERVICES_LABEL}}",
  servicesNote: "{{SERVICES_NOTE}}",
  servicesCount: "{{SERVICES_COUNT}}",
  servicesNoun: "{{SERVICES_NOUN}}",
  disclaimer: "{{DISCLAIMER}}",
  hours: [] as { days: string; time: string }[],
  serviceAreas: [] as string[],
  departments: [] as { key: string; label: string; blurb: string; email: string }[],
  responseExpectation: "",
  disclosure: { short: "", long: "", studio: { name: "M&U Ventures", url: "https://muventures.com.au" } },
  social: [] as { label: string; href: string; note: string }[],
};

export const nav = [
  { label: "Services", href: "#services" },
  { label: "Visit", href: "#visit" },
  { label: "Contact", href: "#contact" },
] as const;

export const footerColumns = [] as { heading: string; links: { label: string; href: string }[] }[];
export const homepage = { heroListingSlug: "", featuredListingSlugs: [] as string[], featuredAgentSlugs: [] as string[], featuredSuburbSlugs: [] as string[], featuredArticleSlugs: [] as string[] };
export const credibility = [] as { title: string; body: string }[];
