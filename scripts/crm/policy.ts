/** The existing receptionist work hold applies to combined offers and catalogue references too. */
export function receptionistOnHold(deal: {
  service: string;
  catalogueId?: string | null;
}): boolean {
  return (
    /receptionist|\bboth\b/i.test(deal.service) ||
    /^receptionist(?:[-_]|$)/i.test(deal.catalogueId ?? "")
  );
}
