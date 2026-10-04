#!/usr/bin/env bun
/** R11 visual pass: seed REALISTIC SYNTHETIC records (long names, every quote/invoice state, several lead statuses, memory notes) on a synthetic hub. Usage: bun scripts/r11-visual-seed.ts [port] */
const port = Number(process.argv[2] ?? 8193);
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
const base = `http://127.0.0.1:${port}`;
const token = ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
const H = { "content-type": "application/json", "x-claude-os-token": token };
const crm = async (name: string, input: unknown) => {
  const r = await (await fetch(`${base}/__crm/ops`, { method: "POST", headers: H, body: JSON.stringify({ name, input }) })).json() as any;
  if (!r.ok) console.log("crm", name, "->", String(r.error ?? r.text).slice(0, 100));
  return r.data;
};
const op = async (path: string, body: unknown) => (await (await fetch(`${base}/__operator${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

const names = [
  "Synthetic Parramatta and Western Sydney Family Dental and Orthodontic Specialists Pty Ltd",
  "Synthetic Blacktown Conveyancing and Property Law Group",
  "Synthetic Orchard Hills Real Estate",
  "Synthetic Mount Druitt Physio",
  "Synthetic Penrith Plumbing and Gas",
  "Synthetic Castle Hill Smiles",
];
const out: any[] = [];
for (const [i, n] of names.entries()) {
  const c = await crm("crm.company.create", { name: n, emails: [`front${i}@example.test`], notes: "synthetic" });
  const ct = await crm("crm.contact.add", { companyId: c.id, name: ["Dana Orchard", "Priya Raman-Whitfield", "Sam Nguyen", "Alex Kowalczyk-Smith", "Jo Marsh", "Lee Chen"][i], email: `person${i}@example.test` });
  const d = await crm("crm.deal.create", { companyId: c.id, title: `${["Website rebuild", "Receptionist rollout", "Site plus SEO", "Booking receptionist", "Website", "Care plan renewal"][i]} for ${n.replace("Synthetic ", "")}`.slice(0, 120), service: i % 2 ? "receptionist" : "website", oneOffCents: i % 2 ? undefined : 150_000 + i * 20_000, recurringCents: i % 2 ? undefined : 10_000, gstTreatment: "exclusive", commercialBasis: i % 2 ? "pending" : "agreed", contactIds: [ct.id] });
  out.push({ c, ct, d });
  await crm("crm.task.create", { companyId: c.id, dealId: d.id, title: ["Send revised scope", "Confirm package with owner", "Book kickoff call", "Chase signed agreement", "Review homepage draft", "Renew care plan"][i] + " — long task title that should wrap cleanly on a phone", dueAt: day([-3, -1, 0, 2, 5, 9][i]), owner: i % 2 ? "mehroz" : "usman" });
}
// every quote / invoice state
for (const [i, kind] of (["quote-draft", "quote-issued", "quote-accepted", "invoice-draft", "invoice-issued", "quote-superseded"] as const).entries()) {
  const { c, d } = out[i];
  const doc = await crm("crm.document.create", { companyId: c.id, dealId: d.id, kind: kind.startsWith("quote") ? "proposal" : "invoice-reference", title: `${kind.startsWith("quote") ? "Quote" : "Invoice"} ${1000 + i} — ${c.name.replace("Synthetic ", "").slice(0, 40)}`, status: kind.endsWith("draft") ? "draft" : kind.endsWith("issued") ? "issued" : kind.endsWith("accepted") ? "accepted" : "superseded", content: `Subtotal ex GST: $${1500 + i * 200}.00\nGST (10%): $${150 + i * 20}.00\nTOTAL: $${1650 + i * 220}.00\nDraft. Nothing has been sent.` });
  if (!doc) console.log("document create failed for", kind);
}
// leads in several statuses (the six seeded ones)
const list = (await (await fetch(`${base}/__operator/leads/list`, { headers: H })).json()) as any;
const statuses = ["contacted", "replied", "meeting", "proposal", "new", "contacted"];
for (const [i, l] of (list.leads ?? []).slice(0, 6).entries()) {
  if (statuses[i] !== "new") await op("/leads/move", { lead: l.id, to: statuses[i] === "contacted" ? "contacted" : statuses[i], by: "usman", note: "synthetic" });
}
// memory notes
for (const [t, x] of [["Receptionist pricing, approved 28 Sep", "Essential 699, Professional 1099, Premium 1999, ex GST. Setup fee proposed, not approved."], ["How we price a website", "Quote from the approved range only. Pending prices stay pending."], ["Client onboarding checklist", "Brief, assets, domain access, preview due date, launch target."]] as const)
  await op("/memory", { title: t, text: x, collection: "business", kind: "note" });
console.log("seeded");

export {};
