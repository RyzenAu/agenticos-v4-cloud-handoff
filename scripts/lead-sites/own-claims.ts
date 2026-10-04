// Text that reads as an award, a guarantee, a rating, a testimonial or a "number one" claim. Used to withhold a service name or a listing
// field the business wrote until a person has confirmed it (a claim needs evidence; a price in the business's own words does not).
const NUMBER_WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|[1-5](?:\.[0-9])?)`;
// "best <business word> in": a superlative about the business itself. "Best offers in excess of $1m" and "Best of both worlds in Balmain" are not.
const BEST_IN = String.raw`\bbest\s+(?:\w+\s+){0,2}?(?:agen\w*|real estate|team|broker\w*|service\w*|lawyer\w*|solicitor\w*|conveyanc\w*|dentist\w*|dental|practice|firm|company|business|manager\w*|clinic\w*|realtor\w*|propert\w*)\s+in\b`;
const CLAIM_PATTERNS: RegExp[] = [
  /award/, /guarant/, /★|☆|⭐/, /\b\d(?:\.\d)?\s*\/\s*5\b/,
  new RegExp(String.raw`\b${NUMBER_WORD}[\s-]*stars?\b`), /\bstar[- ]rated\b/, /\brated\s+\d/, /\brating\b/, /\b\d(?:\.\d)?\s*(?:\/|out of)\s*(?:5|10)\b/,
  /\b(?:top|highest|best)[- ](?:rated|reviewed)\b/, /\bhighly[- ]rated\b/, new RegExp(BEST_IN), /\btop\s*\d+\s*%/,
  /\bvoted\b/, /\bwinners?\b/, /\bnumber\s*(?:one|1)\b/, /\bno\.?\s*1\b/, /#\s*1\b/,
  /\b\d{2,3}\s*%\s*(?:satisf|guarant|success|happy)/, /\bsatisfaction\b/, /money[- ]?back/, /\bpromise\b/, /testimonial/, /before\s*(?:&|and)\s*after/,
];

/** Lower-case, compatibility-normalised (fullwidth letters become plain), accent-stripped, with zero-width characters and soft hyphens removed:
 *  "Awàrd", fullwidth "Ａward" and "Aw­ard" all read as "award". */
export function claimText(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[­​-‏⁠⁤﻿]/g, "").toLowerCase();
}

/** "Auction Sat 3/5 at 11am" and "open 3/5" are dates, not a 3 out of 5 rating. A d/d is a date only straight after auction, open, inspection or a weekday, or straight before a time,
 *  and never when stars, a rating, "rated" or reviews are close by ("Rated at 5/5 by our clients" stays a rating). */
const DATE_LIKE = [
  /\b(?:auction|open|inspection|inspect|sat(?:urday)?|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?)\s+\d{1,2}\s*\/\s*\d{1,2}\b/g,
  /\b\d{1,2}\s*\/\s*\d{1,2}\s*(?:at|@|,)?\s*\d{1,2}(?::\d\d)?\s*[ap]m\b/g,
];
const RATING_NEAR = /star|rating|rated|review|out of|clients?|customers?|patients?/;

function withoutDates(t: string): string {
  let out = t;
  for (const re of DATE_LIKE) out = out.replace(re, (m, offset: number, whole: string) => (RATING_NEAR.test(whole.slice(Math.max(0, offset - 25), offset + m.length + 25)) ? m : " "));
  return out;
}

export function readsAsClaim(text: string, opts: { priceLine?: boolean } = {}): boolean {
  const t = withoutDates(claimText(text));
  // A price or result line is a price: "best" there is about offers, not a ranking.
  return CLAIM_PATTERNS.some((re) => !(opts.priceLine && re.source === BEST_IN) && re.test(t));
}

/** A named practitioner ("Dr Jane Citizen") in free text is staff the evidence never named. */
export function namesStaff(text: string): boolean {
  return /\bDr\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(text);
}
