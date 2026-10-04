/**
 * Site-level content: identity, navigation, contact details, hours,
 * homepage selections and the demonstration disclosure.
 * All of it is fictional demonstration content.
 */

const referenceSite = {
  name: "Aldergate",
  legalLine: "Aldergate is a fictional agency created for demonstration purposes.",
  url: "https://muventures.com.au",
  tagline: "Real estate for the Inner West, read closely.",
  description:
    "Aldergate is a fictional Inner West Sydney real estate agency built as a flagship website demonstration by M&U Ventures. Buy, rent, sell and manage property across Balmain, Birchgrove, Rozelle, Lilyfield, Annandale and Leichhardt.",
  phone: "{{PHONE}}",
  phoneHref: "{{PHONE_HREF}}",
  email: "{{EMAIL}}",
  office: {
    street: "{{ADDRESS_LINE1}}",
    suburb: "Balmain",
    postcode: "2041",
    map: { x: 34, y: 42 },
  },
  hours: [
    { days: "Monday – Friday", time: "8:30am – 5:30pm" },
    { days: "Saturday", time: "8:30am – 1:00pm, then at inspections" },
    { days: "Sunday", time: "Closed" },
  ],
  serviceAreas: ["Balmain", "Birchgrove", "Rozelle", "Lilyfield", "Annandale", "Leichhardt"],
  departments: [
    { key: "sales", label: "Sales", blurb: "Buying, selling and appraisals", email: "{{EMAIL}}" },
    { key: "management", label: "Property management", blurb: "Landlords and existing tenants", email: "{{EMAIL}}" },
    { key: "leasing", label: "Leasing", blurb: "Rental enquiries and applications", email: "{{EMAIL}}" },
    { key: "general", label: "Everything else", blurb: "Careers, media, feedback", email: "{{EMAIL}}" },
  ],
  responseExpectation: "Preview only. No enquiry is sent.",
  disclosure: {
    short: "Fictional demonstration website by M&U Ventures.",
    long: "Aldergate is a fictional real estate agency. This website, its agents, listings, suburb figures and contact details were created by M&U Ventures to demonstrate the design and technical capabilities of a bespoke real estate platform. No property shown is for sale or rent, and no enquiry will be answered by a licensed agent.",
    studio: { name: "M&U Ventures", url: "https://muventures.com.au" },
  },
  social: [
    { label: "Instagram", href: "#", note: "Demonstration link" },
    { label: "LinkedIn", href: "#", note: "Demonstration link" },
  ],
} as const;

export const site = { ...referenceSite,
  name: "{{BUSINESS}}", legalLine: "Preview concept. Not the official agency website.",
  url: "https://muventures.com.au", tagline: "{{TAGLINE}}", description: "Preview concept by M&U Ventures.",
  phone: "{{PHONE}}", phoneHref: "{{PHONE_HREF}}", email: "{{EMAIL}}", emailHref: "{{EMAIL_HREF}}", suburb: "{{SUBURB}}",
  office: { street: "{{ADDRESS_LINE1}}", suburb: "{{ADDRESS_LINE2}}", postcode: "", map: { x: 34, y: 42 } },
  hours: [] as { days: string; time: string }[], hoursNote: "{{HOURS}}", servicesLabel: "{{SERVICES_LABEL}}", servicesNote: "{{SERVICES_NOTE}}", serviceAreas: [] as string[],
  // Generic choices for the contact form's "Who should this go to?" (and the contact page's list). They are kinds of enquiry, not people:
  // the example agents are never offered as the business's staff, and the form sends nothing anywhere.
  departments: [
    { key: "sales", label: "Sales", blurb: "Buying, selling and appraisals", email: "{{EMAIL}}" },
    { key: "management", label: "Property management", blurb: "Landlords and existing tenants", email: "{{EMAIL}}" },
    { key: "leasing", label: "Leasing", blurb: "Rental enquiries and applications", email: "{{EMAIL}}" },
    { key: "general", label: "General enquiry", blurb: "Anything else", email: "{{EMAIL}}" },
  ] as { key:string; label:string; blurb:string; email:string }[],
  responseExpectation: "Preview only. No enquiry is sent or inspection booked.",
  disclosure: { short: "Example listings, profiles and editorial content.", long: "The agency identity and evidenced contact details belong to the selected business. Properties, agents, suburb figures, articles, history and service processes are fictional demonstration content, not this agency’s inventory, staff, sales or commitments. Forms only demonstrate validation; nothing is submitted, stored or emailed. The walkthrough answers locally from example data.", studio:{name:"M&U Ventures",url:"https://muventures.com.au"}},
};

export const nav = [
  { label: "Buy", href: "/buy" },
  { label: "Rent", href: "/rent" },
  { label: "Sold", href: "/sold" },
  { label: "Sell", href: "/sell" },
  { label: "Manage", href: "/property-management" },
  { label: "Suburbs", href: "/suburbs" },
  { label: "Agents", href: "/agents" },
  { label: "Insights", href: "/insights" },
  { label: "About", href: "/about" },
] as const;

export const footerColumns = [
  {
    heading: "Property",
    links: [
      { label: "Buy", href: "/buy" },
      { label: "Rent", href: "/rent" },
      { label: "Sold results", href: "/sold" },
      { label: "Saved properties", href: "/saved" },
      { label: "Suburb guides", href: "/suburbs" },
    ],
  },
  {
    heading: "Services",
    links: [
      { label: "Sell with Aldergate", href: "/sell" },
      { label: "Request an appraisal", href: "/sell#appraisal" },
      { label: "Property management", href: "/property-management" },
      { label: "Tenants", href: "/rent/tenants" },
      { label: "Maintenance request", href: "/rent/tenants#maintenance" },
    ],
  },
  {
    heading: "Agency",
    links: [
      { label: "About", href: "/about" },
      { label: "Our agents", href: "/agents" },
      { label: "Insights", href: "/insights" },
      { label: "Contact", href: "/contact" },
      { label: "Demonstration disclosure", href: "/demonstration" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy policy", href: "/privacy" },
      { label: "Terms of use", href: "/terms" },
      { label: "Accessibility", href: "/accessibility" },
    ],
  },
] as const;

/** Homepage selections. Edit here, not in components. */
export const homepage = {
  heroListingSlug: "3-glover-street-lilyfield",
  featuredListingSlugs: ["27-darling-street-balmain", "14-louisa-road-birchgrove", "8-42-wellington-street-rozelle", "5-nelson-street-annandale"],
  featuredAgentSlugs: ["imogen-sallis", "theo-marchetti", "priya-raman"],
  featuredSuburbSlugs: ["balmain", "birchgrove", "rozelle", "annandale"],
  featuredArticleSlugs: ["preparing-a-terrace-for-auction", "reading-a-price-guide", "warehouse-conversions-what-to-check"],
} as const;

export const credibility = [
 { title:"Search, save and compare",body:"Explore the browsing tools with the demonstration property data." },
 { title:"Every detail in one place",body:"Photographs, floor plans and features share one readable listing." },
 { title:"Direct contact",body:"Use the evidenced agency contact details for a real enquiry." },
 { title:"Ready for your content",body:"Actual listings, staff and services are confirmed before launch." },
] as const;
