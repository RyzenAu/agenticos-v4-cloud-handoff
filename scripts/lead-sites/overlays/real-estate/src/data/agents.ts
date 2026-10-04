import type { Agent } from "./types";
import { stock } from "./stock";

/** Fictional agents. Names, biographies and contact details are invented. */
const referenceAgents: Agent[] = [
  {
    slug: "imogen-sallis",
    name: "Imogen Sallis",
    role: "Director & Licensee in Charge",
    team: "sales",
    phone: "{{PHONE}}",
    email: "{{EMAIL}}",
    initials: "IS",
    tint: "#7b2d2a",
    patch: stock.harbour,
    bio: [
      "Imogen founded Aldergate after twelve years selling on the Balmain peninsula, most of them from a desk on Darling Street. She specialises in waterfront and heritage homes in Birchgrove and Balmain East, where the value of a property depends on details that don't show up in a floor plan.",
      "Vendors work with Imogen directly from appraisal to settlement. She writes every price guide herself and will tell you plainly when a campaign should change course.",
    ],
    expertise: ["Waterfront homes", "Heritage terraces", "Auction campaigns", "Downsizing"],
    suburbs: ["balmain", "birchgrove"],
    languages: ["English"],
  },
  {
    slug: "theo-marchetti",
    name: "Theo Marchetti",
    role: "Sales Agent",
    team: "sales",
    phone: "{{PHONE}}",
    email: "{{EMAIL}}",
    initials: "TM",
    tint: "#5f6c57",
    patch: stock.cafe,
    bio: [
      "Theo grew up in Rozelle and sells across Rozelle and Lilyfield, with a particular interest in warehouse conversions and the newer architect-designed homes around Callan Park.",
      "He is known for thorough buyer follow-up: every inspection attendee hears from him within a day, and vendors receive a written report after each open home.",
    ],
    expertise: ["Warehouse conversions", "Contemporary homes", "First-time vendors", "Buyer negotiation"],
    suburbs: ["rozelle", "lilyfield"],
    languages: ["English", "Italian"],
  },
  {
    slug: "priya-raman",
    name: "Priya Raman",
    role: "Sales Agent",
    team: "sales",
    phone: "{{PHONE}}",
    email: "{{EMAIL}}",
    initials: "PR",
    tint: "#3f4a63",
    patch: stock.park,
    bio: [
      "Priya sells in Annandale and Leichhardt, the terrace and federation belt between Johnston Street and Norton Street. She came to real estate from interior architecture and still reads a house as a set of rooms before a set of figures.",
      "She runs most of Aldergate's private-treaty campaigns and is the agent vendors ask for when a property needs styling advice before it goes to market.",
    ],
    expertise: ["Federation homes", "Private treaty sales", "Presentation and styling", "Semi-detached homes"],
    suburbs: ["annandale", "leichhardt"],
    languages: ["English", "Tamil"],
  },
  {
    slug: "callum-reid",
    name: "Callum Reid",
    role: "Head of Property Management",
    team: "property-management",
    phone: "{{PHONE}}",
    email: "{{EMAIL}}",
    initials: "CR",
    tint: "#8a6a3a",
    patch: stock.opera,
    bio: [
      "Callum leads Aldergate's property management team and looks after a portfolio of houses and apartments across all six suburbs. He came from strata management and brought a habit of documenting everything.",
      "Landlords get a single point of contact, a fixed inspection calendar and maintenance decisions explained before they are made.",
    ],
    expertise: ["Portfolio management", "Compliance", "Maintenance coordination", "Rent reviews"],
    suburbs: ["balmain", "rozelle", "leichhardt", "lilyfield", "annandale", "birchgrove"],
    languages: ["English"],
  },
  {
    slug: "hana-okafor",
    name: "Hana Okafor",
    role: "Leasing Consultant",
    team: "property-management",
    phone: "{{PHONE}}",
    email: "{{EMAIL}}",
    initials: "HO",
    tint: "#4e6b6a",
    patch: stock.garden,
    bio: [
      "Hana runs Aldergate's leasing. She schedules and hosts rental inspections, processes applications and keeps prospective tenants informed at every stage, including when the answer is no.",
      "Existing tenants contact Hana or Callum directly for maintenance and lease questions.",
    ],
    expertise: ["Leasing", "Tenant applications", "Rental inspections", "Tenant onboarding"],
    suburbs: ["balmain", "rozelle", "lilyfield", "annandale"],
    languages: ["English", "French"],
  },
];

export const agents: Agent[] = referenceAgents.map((a) => ({...a, name: `${a.name} (example)`, role: `${a.role} · Fictional profile`, phone: "{{PHONE}}", email: "{{EMAIL}}"}));

export const agentBySlug = (slug: string) => agents.find((a) => a.slug === slug);
