// Identity that belongs to the template's example agency and must never appear in a prospect's own listing text: its name, contact details,
// its example agents and its example properties. The example properties are matched by their full addresses and slugs, not by bare street
// names: a genuine Balmain agency really does sell on Darling Street.
export const STOCK_LEAK: RegExp[] = [
  /Aldergate/i, /9000 0000/, /aldergate\.demo/i, /0400[ -]?000[ -]?00\d/,
  /\b(?:27 Darling Street|14 Louisa Road|3 Glover Street|8\s*[\/-]\s*42 Wellington Street|5 Nelson Street|112 Norton Street|19\s*[\/-]\s*2 Booth Street|41 Cameron Street|66 Beattie Street|7 Foucart Street|12\s*[\/-]\s*88 Victoria Road|30 Piper Street|4\s*[\/-]\s*15 Johnston Street)\b/i,
  /\b(?:112-norton-street-leichhardt|12-88-victoria-road-rozelle|14-louisa-road-birchgrove|19-2-booth-street-annandale|27-darling-street-balmain|3-glover-street-lilyfield|30-piper-street-lilyfield|4-15-johnston-street-annandale|41-cameron-street-birchgrove|5-nelson-street-annandale|66-beattie-street-balmain|7-foucart-street-rozelle|8-42-wellington-street-rozelle)\b/i,
  /\b(?:Imogen Sallis|Theo Marchetti|Priya Raman|Callum Reid|Hana Okafor)\b/i,
];
