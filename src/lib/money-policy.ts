/**
 * THE money policy (27 Sep 2026 night; REVIEW-JEV finding 1, Stage 0 F4, REVIEW-SAFETY round 2).
 *
 * The owner's hard rule: never a payment, trade, bet, transfer, top-up, bank or broker login, new
 * payee or crypto send, WHATEVER the approval. This file is the ONE list every execution path uses:
 *   - control_pc (control-risk.ts controlTaskRefusal; the server executor policy),
 *   - screen-hands /screen/act, /screen/command and lessons (scripts/screen-hands/refusals.ts), on the
 *     goal, on the window title and URL before every step, and on every button (MONEY_BUTTON: refused,
 *     never "ask"),
 *   - the app browser's host fence (scripts/browser/app-browser.ts),
 *   - away mode (scripts/away-mode/policy.ts).
 *
 * Text is normalised before matching (NFKC, Cyrillic/Greek confusables, zero-width and soft hyphens,
 * Arabic-Indic digits, accents, spaced or dotted single letters "N.A.B" / "c o m m s e c", "dot com",
 * and digits-for-letters "C0MMSEC" / "tr@nsfer"), and every variant is checked.
 *
 * ONE institution table: every bank, broker, exchange, wallet, payment app, gambling site and money
 * government service lists its names and its hosts together, and a host's brand label ("sportsbet" in
 * m.sportsbet.com.au, "nab" in nab-com-au.translate.goog) matches too, so the text guard and the URL
 * guard can't drift apart.
 *
 * Pure; no I/O. Tests: scripts/money-policy.test.ts (both reviewers' probes, on every entry path).
 */

// --- normalisation -------------------------------------------------------------------------------
const CONFUSABLE: Record<string, string> = {
  а: "a", б: "b", в: "b", г: "r", е: "e", ё: "e", з: "3", и: "u", к: "k", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t", у: "y", х: "x",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ѵ: "v",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "＄": "$",
  // Small capitals and Latin look-alikes NFKC leaves alone (REVIEW-SAFETY-R3 §1: "ᴘᴀʏ", "pɑy").
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n", ᴏ: "o", ᴘ: "p", ǫ: "q", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  ɑ: "a", ɒ: "a", ı: "i", ȷ: "j", ɩ: "i", ʋ: "v", ɛ: "e", ǝ: "e", ɾ: "r", ʂ: "s", ɦ: "h", ɱ: "m", ɲ: "n", ƅ: "b", ɓ: "b", ɗ: "d", ƒ: "f", ɠ: "g", ƙ: "k", ƥ: "p", ƭ: "t", ʐ: "z", ʑ: "z",
  "·": ".", "•": ".", "∙": ".", "・": ".",
  // Letters NFD doesn't take apart (R5: "Zapłać", "Plaćanje") and Armenian look-alikes (R5: "ѕеոd").
  ł: "l", Ł: "L", đ: "d", Đ: "D", ø: "o", Ø: "O", ħ: "h", ŧ: "t",
  ո: "n", ռ: "n", ս: "u", օ: "o", հ: "h", ց: "g", զ: "q", Օ: "O", Ս: "U", Ց: "G",
};
const ZERO_WIDTH = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
/**
 * Enclosed and squared letters NFKC leaves alone (REVIEW-SAFETY-R4: "🅿🅰🆈 Sam 50"): negative circled
 * (U+1F150-1F169), negative squared (U+1F170-1F189) and regional indicators (U+1F1E6-1F1FF) → a-z.
 */
/** Cherokee capitals that look like Latin letters (R5: "ꮪend"); the small forms U+AB70-ABBF map onto them. */
const CHEROKEE: Record<number, string> = {
  0x13a0: "d", 0x13a1: "r", 0x13a2: "t", 0x13a5: "i", 0x13aa: "a", 0x13ab: "j", 0x13ac: "e", 0x13b3: "w", 0x13b7: "m", 0x13bb: "h", 0x13bd: "y",
  0x13c0: "g", 0x13c2: "h", 0x13c3: "z", 0x13ce: "b", 0x13d2: "r", 0x13d4: "w", 0x13d5: "s", 0x13d9: "v", 0x13da: "s", 0x13de: "l", 0x13df: "c",
  0x13e2: "p", 0x13e6: "k", 0x13e7: "d", 0x13f4: "b",
};
const enclosed = (c: string) => {
  const cp = c.codePointAt(0)!;
  for (const start of [0x1f130, 0x1f150, 0x1f170, 0x1f1e6]) if (cp >= start && cp < start + 26) return String.fromCharCode(97 + cp - start);
  const cherokee = cp >= 0xab70 && cp <= 0xabbf ? cp - 0xab70 + 0x13a0 : cp;
  return CHEROKEE[cherokee] ?? c;
};
const fold = (s: string) => [...s].map((c) => CONFUSABLE[c] ?? enclosed(c)).join("");

/** NFKC, zero-width removed, confusables folded, accents stripped, whitespace collapsed. Pure. */
export function normaliseText(text: string): string {
  return spaced(text).replace(/\s+/g, " ").trim();
}
/** normaliseText, but runs of whitespace kept (so "p a y  s a m" still has its word gaps). */
function spaced(text: string): string {
  return fold(String(text ?? "").normalize("NFKC").replace(ZERO_WIDTH, ""))
    .normalize("NFD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .normalize("NFC");
}
/** "p a y  s a m  f i f t y": spelled letters inside each double-spaced word joined, words kept apart. */
function joinSpelledWords(text: string) {
  const chunks = spaced(text).trim().split(/\s{2,}/);
  if (chunks.length < 2) return "";
  return chunks.map((c) => (/^(?:\p{L}\s)+\p{L}$/u.test(c) ? c.replace(/\s/g, "") : c)).join(" ");
}
/**
 * Speech-to-text typos of the money verbs (R4: "sendd", "tranfser"): a doubled letter, two neighbours
 * swapped, or one letter missing from a long verb. Only these words, never substitutions ("seed" stays).
 */
const TYPO_TARGETS = ["send", "transfer", "payment", "deposit", "withdraw", "purchase", "bitcoin"];
/** Sound-alikes STT and people write (R5: "peigh Sam fifty bucks"). */
const SOUNDS_LIKE: Record<string, string> = { peigh: "pay", pey: "pay", paie: "pay", sennd: "send", sendt: "send", wyre: "wire", wier: "wire" };
const unvowel = (s: string) => s.replace(/[aeiou]/g, "");
function typoOf(word: string): string | null {
  const w = word.toLowerCase();
  if (SOUNDS_LIKE[w]) return SOUNDS_LIKE[w];
  if (w.length < 3 || TYPO_TARGETS.includes(w)) return null;
  // Vowels dropped, as in texting (R5: "trnsfr", "pymnt", "dpst", "wthdrw"): the consonant skeleton of a long verb.
  if (!/[aeiou]/.test(w)) for (const c of TYPO_TARGETS) if (c.length >= 6 && unvowel(c) === w) return c;
  if (w.length < 4) return null;
  for (const c of TYPO_TARGETS) {
    if (w.replace(/(\p{L})\1+/gu, "$1") === c && w !== c) return c;
    if (w.length === c.length) {
      const diff = [...w].map((ch, i) => (ch === c[i] ? -1 : i)).filter((i) => i >= 0);
      if (diff.length === 2 && diff[1] === diff[0] + 1 && w[diff[0]] === c[diff[1]] && w[diff[1]] === c[diff[0]]) return c;
    }
    if (c.length >= 6 && w.length === c.length - 1) for (let i = 0; i < c.length; i++) if (c.slice(0, i) + c.slice(i + 1) === w) return c;
  }
  return null;
}
const fixTypos = (text: string) => text.replace(/\p{L}+/gu, (w) => typoOf(w) ?? w);
/** "N.A.B", "N A B", "b a n k", "s e n d", "p-a-y", "p_a_y", "p·a·y": runs of single letters joined; "nab dot com" → "nab.com". */
function joinLetters(text: string) {
  return text
    .replace(/(?<![\p{L}\p{N}])(?:\p{L}[ .\-_*/]\s*){1,}\p{L}(?![\p{L}\p{N}])\.?/gu, (m) => m.replace(/[ .\-_*/]/g, ""))
    .replace(/\s+dot\s+/gi, ".");
}
/** "C0MMSEC", "tr@nsfer", "p4y": leet digits in a word that has letters too (never in "$500" or "4k"). */
function unleet(text: string, one: "i" | "l") {
  const map: Record<string, string> = { "0": "o", "1": one, "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "|": "l" };
  return text.replace(/[\p{L}\d@$!|]+/gu, (w) => ((w.match(/\p{L}/gu)?.length ?? 0) >= 2 && /[\d@$!|]/.test(w) ? w.replace(/[\d@$!|]/g, (c) => map[c]) : w));
}
/**
 * "Coin base", "West pac", "Sports bet", "trans fer": two neighbouring words that together make a money
 * brand or a money verb are read joined too (whitespace-collapsed matching against the institution
 * table). Only whole-word pairs, so "unable" never becomes "nab". Filled in below the table.
 */
const JOINABLE = new Set<string>();
function joinPairs(text: string) {
  const words = text.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? `${words[i]}${words[i + 1]}` : "";
    if (pair && JOINABLE.has(pair.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))) {
      out.push(pair);
      i++;
    } else out.push(words[i]);
  }
  return out.join(" ");
}
/** Every reading of his words the checks look at (the plain text first). Pure. */
export function textVariants(text: string): string[] {
  const base = normaliseText(text);
  const joined = joinLetters(base);
  const out = new Set([base, joined, unleet(joined, "i"), unleet(joined, "l"), joined.replace(/[.\-_]/g, " ").replace(/\s+/g, " "), joinSpelledWords(text)]);
  for (const v of [...out]) out.add(joinPairs(v));
  for (const v of [...out]) out.add(fixTypos(v));
  return [...out].filter(Boolean);
}

// --- ONE institution table: names and hosts together ---------------------------------------------
/**
 * `names`: regex fragments (lower case) matched as whole words in text and window titles.
 * `hosts`: their sites; a host's own brand label counts on any subdomain or proxy.
 * `exact`: hosts whose label is an everyday word (stake, up, ing, wise, tab, chase, gemini, zip…):
 * only these exact hosts (and subdomains) count, never the bare label elsewhere.
 * `segment`: an everyday-word brand that counts in a window title only as a whole title segment
 * ("Buy Bitcoin | Kraken", "Stake | Wall St"), and in text only as "open/log into/use <word>".
 */
/**
 * `kind` (REVIEW-SAFETY-R3, away.payment): what the institution is. Brokers, exchanges and gambling are
 * never approvable anywhere; banks, payment apps, billers and money government services can only ever
 * be driven by away mode's approved-payment flow (paying a SAVED payee, a bill, a purchase).
 */
export type InstitutionKind = "bank" | "payment" | "broker" | "crypto" | "gambling" | "gov";
type Institution = { kind: InstitutionKind; names?: string[]; hosts?: string[]; exact?: string[]; segment?: string[] };
const INSTITUTIONS: Institution[] = [
  // --- Australian banks (and Islamic finance) ---
  { kind: "bank", names: ["nab", "national australia bank", "nabtrade", "nab connect"], hosts: ["nab.com.au", "nabtrade.com.au"] },
  { kind: "bank", names: ["commbank", "comm bank", "commonwealth bank", "cba", "netbank"], hosts: ["commbank.com.au", "netbank.com.au", "cba.com.au"] },
  { kind: "bank", names: ["westpac"], hosts: ["westpac.com.au", "westpac.co.nz"] },
  { kind: "bank", names: ["anz", "anz plus"], hosts: ["anz.com", "anz.com.au", "anz.co.nz"] },
  { kind: "bank", names: ["st\\.? ?george(?: bank)?", "bank ?sa", "bank of melbourne"], hosts: ["stgeorge.com.au", "banksa.com.au", "bankofmelbourne.com.au"] },
  { kind: "bank", names: ["bankwest"], hosts: ["bankwest.com.au"] },
  { kind: "bank", names: ["macquarie (?:bank|account|cash|wrap|transaction account)"], hosts: ["macquarie.com.au"], exact: ["macquarie.com"] },
  { kind: "bank", names: ["ubank"], hosts: ["ubank.com.au"] },
  { kind: "bank", names: ["ing (?:direct|bank|australia|app|orange everyday|savings maximiser)", "my ing"], exact: ["ing.com.au", "ing.com"] },
  { kind: "bank", names: ["up bank(?:ing)?", "(?:my|the) up (?:app|account|card|balance)"], exact: ["up.com.au"] },
  { kind: "bank", names: ["bendigo(?: bank)?"], hosts: ["bendigobank.com.au"] },
  { kind: "bank", names: ["suncorp(?: bank)?"], hosts: ["suncorp.com.au", "suncorpbank.com.au"] },
  { kind: "bank", names: ["boq", "bank of queensland"], hosts: ["boq.com.au"] },
  { kind: "bank", names: ["great southern bank", "bank australia", "me bank", "heritage bank", "newcastle permanent", "beyond bank", "teachers mutual", "people'?s choice credit union", "amp (?:bank|super)", "rabobank", "judo bank", "bank first", "police bank", "defence bank"], hosts: ["greatsouthernbank.com.au", "bankaust.com.au", "mebank.com.au", "newcastlepermanent.com.au", "beyondbank.com.au", "tmbank.com.au", "peopleschoice.com.au", "rabobank.com.au"], exact: ["gsb.com.au", "heritage.com.au", "amp.com.au", "judo.bank"] },
  { kind: "bank", names: ["islamic bank australia", "mcca", "hejaz (?:financial|invest(?:ing)?|super|app)", "crescent wealth", "amanah (?:finance|super|invest(?:ing)?)"], hosts: ["islamicbank.au", "mcca.com.au", "hejazfs.com.au", "hejaz.com.au", "crescentwealth.com.au"] },
  // --- US and international banks ---
  { kind: "bank", names: ["chase (?:bank|app|online|sapphire|freedom|card|account)", "jp ?morgan"], hosts: ["jpmorgan.com"], exact: ["chase.com"], segment: ["chase"] },
  { kind: "bank", names: ["bank of america", "bofa", "wells fargo", "citibank", "citi (?:bank|card|account)", "capital one", "us bank", "u\\.s\\. bank", "pnc bank", "truist", "td bank", "ally bank", "discover (?:bank|card)", "sofi", "chime (?:app|bank|account)", "hsbc", "barclays", "lloyds bank", "natwest", "monzo", "starling bank", "revolut", "n26"], hosts: ["bankofamerica.com", "wellsfargo.com", "citibank.com", "citi.com", "capitalone.com", "usbank.com", "pnc.com", "truist.com", "tdbank.com", "sofi.com", "chime.com", "hsbc.com", "hsbc.com.au", "barclays.co.uk", "lloydsbank.com", "natwest.com", "monzo.com", "starlingbank.com", "revolut.com", "n26.com", "citibank.com.au"], exact: ["ally.com", "discover.com"] },
  // --- cards, payments, BNPL, remittance ---
  { kind: "payment", names: ["amex", "american express"], hosts: ["americanexpress.com", "amex.com.au"] },
  { kind: "payment", names: ["pay ?pal"], hosts: ["paypal.com", "paypal.me"] },
  { kind: "payment", names: ["wise\\.com", "wise (?:app|account|transfer|card)", "transferwise"], hosts: ["transferwise.com"], exact: ["wise.com"], segment: ["wise"] },
  { kind: "payment", names: ["afterpay", "zip ?pay", "zip money", "klarna", "humm", "latitude (?:pay|financial)", "openpay", "laybuy"], hosts: ["afterpay.com", "klarna.com", "latitudefinancial.com.au", "openpay.com.au", "laybuy.com"], exact: ["zip.co", "humm.com.au"], segment: ["zip"] },
  { kind: "payment", names: ["stripe(?:\\.com| checkout| dashboard| payments?| payouts?| account| balance)"], hosts: ["stripe.com"] },
  { kind: "payment", names: ["venmo", "zelle", "cash ?app", "interac(?: e-?transfer)?", "e-?transfer", "western union", "moneygram", "remitly", "ofx", "beem ?it", "apple pay", "google pay", "g ?pay", "samsung pay", "square cash", "tyro", "bpay", "osko", "pay ?id", "paywave", "tap (?:to|and|&|n) pay"], hosts: ["venmo.com", "zellepay.com", "westernunion.com", "moneygram.com", "remitly.com", "ofx.com", "beem.com.au", "tyro.com", "bpay.com.au", "osko.com.au", "payid.com.au"], exact: ["cash.app", "pay.google.com", "wallet.google.com"] },
  // --- brokers and investing apps ---
  { kind: "broker", names: ["commsec", "commsec pocket", "selfwealth", "pearler", "moomoo", "etoro", "tiger brokers", "webull", "cmc markets", "bell direct", "saxo(?: markets| bank)?", "raiz(?: invest)?", "stockspot", "spaceship (?:voyager|super|app|invest(?:ing)?)", "vanguard(?: personal investor)?", "sharesies", "robinhood", "alpaca (?:markets|trading)", "ig markets", "plus500", "openmarkets", "interactive brokers", "ibkr", "superhero (?:app|invest(?:ing)?|account)", "charles schwab", "schwab", "fidelity (?:investments|account|brokerage)", "e\\*?trade", "td ameritrade", "merrill (?:edge|lynch)", "public\\.com", "stake (?:app|account|trading|broker(?:age)?|wall st(?:reet)?|aus)", "hellostake"], hosts: ["commsec.com.au", "selfwealth.com.au", "pearler.com", "moomoo.com", "etoro.com", "tigerbrokers.com.au", "webull.com", "webull.com.au", "cmcmarkets.com", "belldirect.com.au", "saxo.com", "raiz.com.au", "raizinvest.com.au", "stockspot.com.au", "spaceship.com.au", "vanguard.com.au", "vanguard.com", "sharesies.com.au", "robinhood.com", "alpaca.markets", "plus500.com", "openmarkets.com.au", "interactivebrokers.com", "interactivebrokers.com.au", "ibkr.com", "superhero.com.au", "schwab.com", "fidelity.com", "etrade.com", "tdameritrade.com", "merrilledge.com", "hellostake.com"], exact: ["ig.com", "home.saxo", "public.com", "stake.com", "stake.com.au", "stake.us"], segment: ["stake"] },
  // --- crypto exchanges, wallets, DeFi, prediction markets ---
  { kind: "crypto", names: ["coinspot", "binance", "swyftx", "coinbase", "kraken(?:\\.com| exchange| app| pro| account)", "crypto\\.com", "independent reserve", "btc markets", "digital surge", "coinjar", "bybit", "okx", "kucoin", "metamask", "trust wallet", "ledger live", "exodus wallet", "phantom wallet", "coinstash", "uphold", "bitstamp", "bitfinex", "gemini (?:exchange|app|account)", "uniswap", "pancakeswap", "sushiswap", "opensea", "polymarket", "kalshi", "predictit", "nexo", "blockfi"], hosts: ["coinspot.com.au", "binance.com", "binance.us", "swyftx.com", "swyftx.com.au", "coinbase.com", "independentreserve.com", "btcmarkets.net", "digitalsurge.com.au", "coinjar.com", "bybit.com", "okx.com", "kucoin.com", "metamask.io", "trustwallet.com", "ledger.com", "exodus.com", "phantom.app", "coinstash.com.au", "uphold.com", "bitstamp.net", "bitfinex.com", "uniswap.org", "pancakeswap.finance", "sushi.com", "opensea.io", "polymarket.com", "kalshi.com", "predictit.org", "nexo.com", "blockfi.com"], exact: ["kraken.com", "crypto.com", "gemini.com", "bitcoin.com", "app.uniswap.org"], segment: ["kraken"] },
  { kind: "crypto", names: ["luno", "bitget", "coinmama", "mexc", "huobi", "htx", "bitmart", "bitpanda", "easy ?crypto", "gate\.io", "blockchain\.com", "coinbase wallet", "wealthsimple crypto"], hosts: ["luno.com", "bitget.com", "coinmama.com", "mexc.com", "huobi.com", "bitmart.com", "bitpanda.com", "easycrypto.com", "blockchain.com"], exact: ["gate.io", "htx.com"] },
  { kind: "broker", names: ["trading ?212", "wealthsimple", "freetrade", "questrade", "degiro", "tastytrade", "firstrade"], hosts: ["trading212.com", "wealthsimple.com", "freetrade.io", "questrade.com", "degiro.com", "tastytrade.com", "firstrade.com"] },
  // REVIEW-SAFETY-R4: unlisted exchanges, DEXs and brokers the review drove, and the AU CFD/forex brokers the
  // B2 approvals builder kept locally (scripts/approvals/policy.ts SUPPLEMENT_BROKERS): ONE table for both.
  { kind: "crypto", names: ["bitaroo", "hyperliquid", "dydx", "independent reserve", "coinstash", "elbaite", "cointree", "digital surge", "okcoin", "bitstamp", "phemex", "gate ?io", "pionex", "bingx"], hosts: ["bitaroo.com.au", "hyperliquid.xyz", "dydx.exchange", "dydx.trade", "cointree.com", "elbaite.com", "okcoin.com", "phemex.com", "pionex.com", "bingx.com"] },
  { kind: "broker", names: ["swissquote", "kalkine", "pepperstone", "ic ?markets", "fp ?markets", "eightcap", "think ?markets", "fusion ?markets", "city ?index", "oanda", "ava ?trade", "fx ?pro", "axi ?trader", "blackbull ?markets", "vantage ?markets", "tickmill", "xtb", "spaceship (?:voyager|super|app|invest(?:ing)?)"], hosts: ["swissquote.com", "swissquote.ch", "pepperstone.com", "icmarkets.com", "icmarkets.com.au", "fpmarkets.com", "eightcap.com", "thinkmarkets.com", "fusionmarkets.com", "cityindex.com", "cityindex.com.au", "oanda.com", "avatrade.com", "avatrade.com.au", "fxpro.com", "axi.com", "axitrader.com", "blackbull.com", "vantagemarkets.com", "tickmill.com", "xtb.com"], segment: ["spaceship"] },
  // Wallets and money apps in other countries (R4: "Bilal ko 2000 easypaisa se bhejo", "kirim … lewat GoPay").
  { kind: "payment", names: ["easy ?paisa", "jazz ?cash", "gopay", "shopee ?pay", "gcash", "paymaya", "mercado ?pago", "bkash", "paytm", "phone ?pe", "google pay upi", "bhim upi", "alipay", "we ?chat ?pay", "paypay", "kakao ?pay", "toss pay", "line pay", "beem", "splitwise", "kickstarter", "indiegogo", "patreon", "go ?fund ?me", "launchgood", "buy me a coffee", "ko-fi"], hosts: ["easypaisa.com.pk", "jazzcash.com.pk", "gojek.com", "gcash.com", "mercadopago.com", "bkash.com", "paytm.com", "phonepe.com", "alipay.com", "splitwise.com", "kickstarter.com", "indiegogo.com", "launchgood.com"] },
  // R5: mobile money and instant-payment apps (Nordics, Poland, East Africa, South Asia, SE Asia), BNPL and gift-card sellers.
  { kind: "payment", names: ["swish", "vipps", "mobile ?pay", "blik", "twint", "bizum", "satispay", "m-?pesa", "airtel money", "orange money", "mtn momo", "telebirr", "opay", "palmpay", "raast", "naya ?pay", "sada ?pay", "nagad", "e-?sewa", "khalti", "upi", "grab ?pay", "touch ?n ?go", "duit ?now", "promptpay", "qris", "ovo", "gcash", "prezzee", "openpay", "gift ?pay"], hosts: ["swish.nu", "vipps.no", "mobilepay.dk", "blik.com", "twint.ch", "bizum.es", "safaricom.co.ke", "nayapay.com", "sadapay.pk", "nagad.com.bd", "esewa.com.np", "khalti.com", "prezzee.com.au", "latitudepay.com"] },
  // Pay pages on creator-shop hosts (a buy page, not a brand he'd ever name to drive).
  { kind: "payment", hosts: ["gumroad.com", "lemonsqueezy.com", "paddle.com", "buymeacoffee.com", "ko-fi.com", "patreon.com", "gofundme.com"] },
  // --- gambling ---
  { kind: "gambling", names: ["picklebet", "the ?lotter", "oddschecker", "lottery ?west", "tatts", "jackpotjoy", "stake ?casino"], hosts: ["picklebet.com", "thelotter.com", "oddschecker.com", "tatts.com", "jackpotjoy.com"] },
  { kind: "gambling", names: ["1 ?x ?bet", "lottoland", "betway", "melbet", "22bet", "tabcorp", "bet ?online", "moneyline"], hosts: ["1xbet.com", "lottoland.com.au", "lottoland.com", "betway.com", "melbet.com", "22bet.com", "tabcorp.com.au", "betonline.ag"] },
  { kind: "gambling", names: ["sportsbet", "ladbrokes", "neds", "pointsbet", "bet ?365", "betfair", "unibet", "bluebet", "palmerbet", "betr", "dabble", "playup", "betright", "topsport", "tabtouch", "tab\\.com\\.au", "the lott", "lotterywest", "oz ?lotteries", "draftkings", "fanduel", "betmgm", "caesars sportsbook", "pokerstars", "roobet", "stake\\.com", "stake casino", "stake\\.us", "crown (?:bet|casino)", "star casino"], hosts: ["sportsbet.com.au", "ladbrokes.com.au", "ladbrokes.com", "neds.com.au", "pointsbet.com.au", "pointsbet.com", "bet365.com", "bet365.com.au", "betfair.com.au", "betfair.com", "unibet.com.au", "unibet.com", "bluebet.com.au", "palmerbet.com", "betr.com.au", "dabble.com.au", "playup.com.au", "betright.com.au", "topsport.com.au", "tabtouch.com.au", "thelott.com", "lotterywest.wa.gov.au", "ozlotteries.com", "draftkings.com", "fanduel.com", "betmgm.com", "pokerstars.com", "roobet.com"], exact: ["tab.com.au"] },
  // --- money and tax government services, super funds, bank-data aggregators ---
  { kind: "gov", names: ["mygov", "my gov", "ato", "australian taxation office", "centrelink", "basiq", "australiansuper", "australian super", "hostplus", "unisuper", "aware super", "hesta", "cbus", "australian retirement trust", "colonial first state"], hosts: ["ato.gov.au", "servicesaustralia.gov.au", "basiq.io", "australiansuper.com", "hostplus.com.au", "unisuper.com.au", "hesta.com.au", "cbussuper.com.au", "cfs.com.au"], exact: ["my.gov.au", "aware.com.au", "art.com.au"] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALL_HOSTS = INSTITUTIONS.flatMap((i) => i.hosts ?? []);
const EXACT_HOSTS = INSTITUTIONS.flatMap((i) => i.exact ?? []);
const SEGMENT_WORDS = INSTITUTIONS.flatMap((i) => i.segment ?? []);
/** The brand label of a host: "sportsbet" for sportsbet.com.au, "nabtrade" for nabtrade.com.au. */
const brandOf = (host: string) => host.replace(/\.(?:com|net|org|co|gov|edu|wa\.gov|io|app|finance|markets|bank|me|us|uk|nz|au|ag)(?:\.[a-z]{2})?$/i, "").split(".").pop()!;
const BRAND_LABELS = new Map<string, InstitutionKind>();
for (const i of INSTITUTIONS) for (const h of i.hosts ?? []) if (brandOf(h).length >= 3 && !BRAND_LABELS.has(brandOf(h))) BRAND_LABELS.set(brandOf(h), i.kind);
const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$|^\[/.test(h);
/** A raw IP, or an IP spelt as a DNS name (R4: 1.2.3.4.nip.io, 10-0-0-1.sslip.io). Pure. */
export const ipLike = (h: string) => isIp(h) || /(?:^|\.)(?:\d{1,3}[.-]){3}\d{1,3}\.(?:nip|sslip|xip|traefik)\.(?:io|me)$/i.test(h);
/** Link shorteners: nobody can tell where they go before opening them. */
export const SHORTENER = /^(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|t\.ly|lnkd\.in|tiny\.cc|s\.id|v\.gd)$/i;

// Split brand names ("Coin base", "West pac", "Sports bet") and split money verbs ("trans fer") join.
for (const i of INSTITUTIONS) for (const n of i.names ?? []) if (/^[a-z0-9]{5,}$/.test(n)) JOINABLE.add(n);
for (const b of BRAND_LABELS.keys()) if (/^[a-z0-9]{5,}$/.test(b)) JOINABLE.add(b);
for (const w of ["transfer", "transfers", "payment", "payments", "deposit", "withdraw", "purchase", "bitcoin", "tabtouch"]) JOINABLE.add(w);
JOINABLE.delete("playup"); // "play up" is English ("check out" too, so "checkout" is never joined)

// --- punycode (RFC 3492 decode; pure, no node:url so the browser bundle can use it) --------------------
function adapt(delta: number, points: number, first: boolean) {
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / points);
  let k = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    k += 36;
  }
  return k + Math.floor((36 * delta) / (delta + 38));
}
function punyDecode(input: string): string {
  const out: number[] = [];
  let basic = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) out.push(input.charCodeAt(j));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = 36; ; k += 36) {
      if (index >= input.length) throw new Error("bad punycode");
      const cp = input.charCodeAt(index++);
      const digit = cp >= 48 && cp <= 57 ? cp - 22 : cp >= 65 && cp <= 90 ? cp - 65 : cp >= 97 && cp <= 122 ? cp - 97 : 36;
      if (digit >= 36) throw new Error("bad punycode");
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) throw new Error("bad punycode");
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
/** A host with its xn-- labels decoded ("xn--pypal-4ve.com" → "pаypal.com", Cyrillic а). Pure. */
export function decodeHost(host: string): string {
  return host
    .split(".")
    .map((l) => {
      if (!/^xn--/i.test(l)) return l;
      try {
        return punyDecode(l.slice(4).toLowerCase());
      } catch {
        return l;
      }
    })
    .join(".");
}

/** Price and data sites whose names carry a money word but that only show information. */
const DATA_SITES = new Set(["coinmarketcap", "coingecko", "tradingview", "tradingeconomics", "investopedia", "investing", "payscale", "stackexchange", "morningstar", "moneysmart", "canstar", "finder"]);
/**
 * An UNLISTED host whose own labels say money (REVIEW-SAFETY-R3 §6 item 8): 1xbet, 22bet, lottoland,
 * coinmama, trading212, somewallet, cryptoswap, netbank-login… Refuse-by-default. Pure.
 */
export function moneyLabelKind(label: string): InstitutionKind | null {
  const l = label.toLowerCase();
  if (DATA_SITES.has(l)) return null;
  const words = [l, l.replace(/[-\d]+/g, ""), ...l.split(/[-\d]+/).filter(Boolean)];
  for (const t of words) {
    if (/^(?:x|sports?|points|blue|palmer|mel|top|win|go|my|uni)?bets?(?:ting|way|win|now|online|fair|victor|rivers|mgm|slip|s)?$/.test(t) || /casino|lotto|lotter(?:y|ies)|pokies|poker|sportsbook|jackpot|bingo|roulette|blackjack|baccarat|wager/.test(t)) return "gambling";
    if (/crypto|wallet|^coins?(?:[a-z]{2,})?$|[a-z]{2,}coins?$|^swap|swap$|^nfts?|defi|^dex$|blockchain/.test(t)) return "crypto";
    if (/broker|forex|^trad(?:ing|er)s?|trad(?:ing|er)s?$|^invest(?!igat)|invest(?:ing|or|ors|ment|ments)?$|^shares?trad/.test(t)) return "broker";
    if (/^bank|bank(?:ing)?$|^netbank/.test(t)) return "bank";
    if (/^pay(?!load|scale|wall|ette)|pay$|^cash(?!mere)|cash$|^loans?|loans?$|^remit/.test(t)) return "payment";
    // A payment subdomain on any site (R4: checkout.shopify.com, donate.islamic-relief.org.au).
    if (/^(?:checkout|donate|donations?|pledge|billing|giving|payments?)$/.test(t)) return "payment";
  }
  return null;
}

/** What kind of money host this is (listed, a subdomain/proxy carrying a listed brand, a punycode look-alike, or an unlisted money label), or null. Pure. */
export function moneyHostKind(hostOrUrl: string): InstitutionKind | null {
  let host = String(hostOrUrl ?? "").trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  if (isIp(host)) return null;
  const decoded = decodeHost(host);
  // The Cyrillic or Greek look-alike folded to Latin: xn--nb-7kc.com.au → nаb.com.au → nab.com.au.
  const folded = normaliseText(decoded).toLowerCase().replace(/^www\./, "");
  for (const h of new Set([host, decoded, folded])) {
    for (const i of INSTITUTIONS) if ([...(i.hosts ?? []), ...(i.exact ?? [])].some((x) => h === x || h.endsWith(`.${x}`))) return i.kind;
    // A brand label anywhere in the host, split on dots and dashes: m.sportsbet.com.au, nab-com-au.translate.goog.
    for (const label of h.split(/[.-]/)) {
      const kind = BRAND_LABELS.get(label);
      if (kind) return kind;
    }
    // An unlisted host whose labels say money (not the public suffix: "com", "au", "bank" TLD aside).
    const labels = h.split(".");
    for (const label of labels.slice(0, Math.max(1, labels.length - 1))) {
      const kind = moneyLabelKind(label);
      if (kind) return kind;
    }
    // Money top-level domains (R4: dydx.exchange): .bet .casino .poker .exchange .trading .loans…
    const tld = labels[labels.length - 1];
    if (/^(?:bet|casino|poker|bingo|lotto)$/.test(tld)) return "gambling";
    if (/^(?:exchange|crypto)$/.test(tld)) return "crypto";
    if (/^(?:trading|markets|broker|investments|forex)$/.test(tld)) return "broker";
    if (/^(?:loans|credit|creditcard|cash|money)$/.test(tld)) return "payment";
  }
  return null;
}
/** Is this hostname (or URL) a money site (see moneyHostKind)? Pure. */
export function moneyHost(hostOrUrl: string): boolean {
  return moneyHostKind(hostOrUrl) !== null;
}

const HOST_WORDS = [...ALL_HOSTS, ...EXACT_HOSTS].map(escapeRe);
/** "switch to Wise", "send it with Wise", "open Stake", "log into Kraken": an everyday-word brand as the object. */
const SEGMENT_LEAD = "(?:open|launch|start|log ?in(?:to)?|login to|sign ?in(?:to)?|go to|using|use|via|my|with|through|switch (?:over )?to|over to|move (?:it )?to)";
/** The institutions by name (and their hosts written out), as whole words. */
export const MONEY_NAMES = new RegExp(
  [...INSTITUTIONS.flatMap((i) => i.names ?? []), ...HOST_WORDS]
    .map((p) => `(?<![\\w-])(?:${p})(?![\\w-])`)
    .concat([
      // ING as a bare word (it is never an English word on its own).
      "(?<![\\w-])ing(?![\\w-])",
      // Everyday-word brands, only as a command's object: "open Stake", "log into Kraken", "use Chase".
      `\\b${SEGMENT_LEAD}\\s+(?:${SEGMENT_WORDS.join("|")})\\b(?=\\s*(?:$|[|:,.!?]|\\s+(?:and|then|app|account|to|for)\\b))`,
      // Stake as the broker in "chuck 20 on Stake", "load up my Stake account".
      "\\b(?:on|in|into|at|with)\\s+stake\\b(?=\\s*(?:$|[|:,.!?]|\\s+(?:and|then|app|account)\\b))",
      // TAB (the betting app) in words: "the TAB app", "TAB account", "tabtouch".
      "\\btab\\s?(?:app|account|touch|online\\s+betting|betting|racing|website)\\b",
    ])
    .join("|"),
  "i",
);
/** TAB, the betting brand, in capitals as a command's object ("open the TAB app", "log into TAB"), never the Tab key. */
const TAB_BRAND = /\b(?:[Oo]pen|[Ll]aunch|[Ss]tart|[Ll]og ?[Ii]n(?:to)?|[Ss]ign ?[Ii]n(?:to)?|[Gg]o to|[Oo]n|[Aa]t|[Mm]y)\s+(?:the\s+|my\s+)?TAB\b(?!\s*(?:key|keys|button|stop|stops|character|char|index|width|size|order|bar|group|groups|strip|page)\b)|\b(?:[Uu]se|[Uu]sing|[Vv]ia|[Ww]ith|[Tt]he)\s+TAB\s+(?:app|account|website|site)\b/;
/** A window title segment that IS an everyday-word brand ("Buy Bitcoin | Kraken", "Stake | Wall St"). */
const segmentBrand = (title: string) => title.split(/\s[|\-–—:]\s|\s*\|\s*/).some((seg) => SEGMENT_WORDS.includes(seg.trim().toLowerCase().replace(/\.(?:com|us)(?:\.au)?$/, "")));

// --- what he asks for ----------------------------------------------------------------------------
const NUM_WORD =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|a|an|couple(?:\\s+of)?|few|several|some)";
const COUNT_WORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|grand)";
const CARDINAL = `(?:\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+|${NUM_WORD}(?:[\\s-]+(?:and\\s+)?${NUM_WORD})*)`;
/**
 * CARDINAL with bounded runs, for the unanchored amount patterns (J5: MONEY_AMOUNT and LABEL_AMOUNT try every start in a long
 * run of digits or of "a a a", each scanning to the end: quadratic). A match may start mid-run (the character before it only
 * has to be a non-letter), so the last 40 digits or 10 number words of any longer run match exactly as the whole run did.
 */
const CARDINAL_B = `(?:\\d[\\d,]{0,40}(?:\\.\\d{1,40})?|\\.\\d{1,40}|${NUM_WORD}(?:[\\s-]+(?:and\\s+)?${NUM_WORD}){0,10})`;
/** A number with no unit: "30", "thirty", "two hundred", "1.5k". */
const BARE_NUMBER = `(?:\\d[\\d,]*(?:\\.\\d+)?k?|${COUNT_WORD}(?:[\\s-]+(?:and\\s+)?${COUNT_WORD})*)`;
const CURRENCY =
  "(?:dollars?|bucks|korun[ay]?|koruna|forint(?:ot)?|piso|pesos?|shilingi|shillings?|tomans?|taka|birr|ringgit|rupiah|cedis?|kwacha|leva|lei|kuna|dinars?|tenge|hryvnias?|kronor|kroner|krona|evro|aud|usd|nzd|cad|gbp|eur|chf|inr|pkr|cents?|quid|pounds?|euros?|grand|yen|yuan|kuai|won|rupees?|rupay|rupaye|rs|rupiah|rp|ribu|juta|lakhs?|crores?|dolares|dolar|pesos|reais|francs?|riyals?|dirhams?|lira|lire|tl|zl|zloty|zlotych|pln|brl|rubles?|roubles?|baht|shekels?|nis|dong|trieu|ringgit|rand|naira|taka|kroner|kronor|kr|balles|دولار|ريال|درهم|btc|bitcoins?|eth|ethers?|usdt|usdc|sats?|satoshis?|sol|doge|xrp|xlm)";
/** Currency symbols, including ₿ ₩ ₽ ₱ ฿ ₺ ₦ ₫ ₴ ₪ (REVIEW-SAFETY-R3 §1: "send Sam ₿0.01", "₩10000"). */
const CUR_SYMBOL = "[$€£¥₹₿₩₽₱฿₺₦₫₴₪₣₡₲₵₭₮₸₼₾]";
/** Prefixed dollar signs: A$ AU$ US$ NZ$ C$ HK$ S$ R$ (reais). */
const CUR_DOLLAR = "\\b(?:a|au|us|nz|c|hk|s|r)\\$";
/** ISO codes and tickers written BEFORE the number: "Order total AUD 49.99", "USD 200". */
const CUR_CODE = "(?:aud|usd|nzd|cad|gbp|eur|chf|jpy|cny|rmb|inr|pkr|sgd|hkd|aed|sar|brl|pln|try|idr|vnd|thb|ils|krw|rub|sek|nok|dkk|czk|huf|php|myr|mxn|ars|zar|ngn|btc|eth|usdt|usdc)";
/** A number in any grouping ("1.234,56", "1 234,56", "1,00,000", "49.99"). */
const NUMBER = "\\d(?:[\\d,.\\u00a0\\u202f ']{0,40}\\d)?";
/** Symbols and words written AFTER the number (R4: "1.234,56 €", "50 zł", "200 AED"). */
const CUR_AFTER = "(?:[€£¥₹₩₽₪₺฿₫]|zł|zl|kr|kč|ft|lei|r\\$|元|円|块|圆|万円|萬|만원|원)";
/** Money emoji count as an amount (and 💸 as a verb): "💸 $20 → Sam", "send Mehroz 💵💵". */
const MONEY_EMOJI = "[💵💴💶💷💰🪙💸💳🤑]";
/** An amount of money: "$50", "A$1.5k", "AUD 49.99", "1.234,56 €", "₿0.01", "50元", "fifty dollars", "0.1 BTC", "💵". */
export const MONEY_AMOUNT = new RegExp(
  [
    `(?:${CUR_SYMBOL}|${CUR_DOLLAR})\\s?\\d[\\d,.]{0,40}(?:\\s?(?:k|m|grand))?`,
    `\\b${CUR_CODE}\\s?\\d[\\d,.]{0,40}`,
    `${NUMBER}\\s?${CUR_AFTER}`,
    MONEY_EMOJI,
    `(?:^|[^\\p{L}])${CARDINAL_B}\\s*${CURRENCY}(?![\\p{L}])`,
  ].join("|"),
  "iu",
);
/** An amount inside a button label: digits with a symbol or code only ("Rent HD $5.99", "Send ₿0.01", "Pay AUD 20", "49,99 €"). */
const LABEL_AMOUNT = new RegExp(`(?:${CUR_SYMBOL}|${CUR_DOLLAR})\\s?\\d|\\b${CUR_CODE}\\s?\\d|${NUMBER}\\s?(?:${CUR_CODE}\\b|${CUR_AFTER})|${MONEY_EMOJI}`, "iu");
/** A quantity of securities: "10 shares", "fifty units", and with one name between ("10 Tesla shares", "5 BHP shares": round 10 review). */
const SECURITIES_QTY = new RegExp(`\\b(?:\\d[\\d,]*(?:\\.\\d+)?|${COUNT_WORD}(?:[\\s-]+(?:and\\s+)?${NUM_WORD})*)\\s+(?:[A-Za-z][\\w.&'-]*\\s+)?(?:shares?|units?|stocks?|contracts?|lots?|coins?|tokens?)\\b`, "i");
/** Verbs that move money when an amount is named (English, slang, and the main foreign ones). */
const MONEY_VERB =
  /(?:^|[^\p{L}])(?:send|sends|sending|sent|pay|pays|paying|paid|transfer(?:s|red|ring)?|wire|wiring|move|moving|give|giving|lend|loan|deposit|withdraw|put|invest|buy|buying|sell|selling|short|trade|trading|top\s?up|remit|tip|donate|spend|cash\s+out|swap|stake|bet|wager|punt|gamble|refund|order|add|load|fund|flick|bung|chuck|chip\s+in|shout|spot|front|owe|repay|reimburse|zelle|venmo|e-?transfer|interac|bid|zahle|zahlen|bezahle|bezahlen|uberweise|uberweisen|ueberweise|schick|schicke|schicken|sende|senden|envoie|envoyer|envoyez|paie|payer|payez|virement|transfiere|transferir|envia|enviar|paga|pagar|pagare|manda|mandar|mandare|invia|inviare|stuur|sturen|verstuur|betaal|betalen|overmaken|bhej|bhejo|bhejdo|de\s+do|uberweis\w*|gonder|kirim|pix|pledge|przelej|przelew|chuyen|posli|poslat|kuldj|kuldd|magpadala|padala|tuma|bhejna|skicka|swisha|vippse|ادفع|حول|ارسل|أرسل|ابعث|تحويل|دفع|💸)(?![\p{L}])/iu;
/** Money verbs followed by a number with no unit: "send Mehroz 30", "zelle Sam 20", "bid 300", "chip in 40". */
const NOT_MONEY_UNIT =
  "(?:files?|folders?|pages?|photos?|pics?|pictures?|images?|videos?|clips?|messages?|emails?|mails?|texts?|tabs?|windows?|times?|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?|people|persons?|users?|items?|lines?|words?|characters?|chars?|rows?|columns?|cells?|slides?|percent|px|pixels?|points?|pts?|stars?|copies|screenshots?|links?|notes?|tasks?|steps?|pm|am|o'?clock|leads?|contacts?|results?|%)";
/** "the top 5", "the first 3", "page 2": a rank or position, never an amount (R3 §2: "send Mehroz the top 5"). */
const NOT_AMOUNT_BEFORE = "(?<!\\b(?:top|first|last|next|best|bottom|latest|recent|previous|page|slide|line|step|chapter|version|option|item|number|no\\.?|#)\\s+)";
const BARE_AMOUNT = new RegExp(
  `(?:^|[^\\p{L}])(?:send|pay|give|flick|bung|chuck|chip\\s+in|transfer|wire|lend|loan|tip|zelle|venmo|e-?transfer|interac|bid|bet|wager|punt|donate|top\\s?up|deposit|withdraw|shout|spot|front|repay|pay\\s+back|reimburse|refund|remit|zahle|zahlen|uberweise|schick|schicke|sende|senden|envoie|envoyer|paie|payer|transfiere|transferir|envia|enviar|paga|pagar|pagare|manda|invia|inviare|stuur|betaal|betalen|bhej|bhejo|gonder|kirim|pix|pledge|przelej|posli|kuldj|magpadala|tuma|bhejna|skicka|swisha|ادفع|حول|ارسل|أرسل)(?:\\s+(?!${NOT_MONEY_UNIT}\\b)[\\p{L}'.-]+){0,3}\\s+${NOT_AMOUNT_BEFORE}${BARE_NUMBER}(?!\\s*(?:${NOT_MONEY_UNIT})\\b)(?![\\p{L}\\d])`,
  "iu",
);
/** Objects "on" that are a place in a document, not a bet ("put 2 on the next line"): only without a currency. */
const NOT_A_BET_OBJECT =
  "(?:the\\s+|a\\s+|this\\s+|that\\s+|each\\s+|every\\s+|my\\s+|our\\s+)?(?:(?:next|previous|prev|first|last|same|new|top|bottom|\\d+(?:st|nd|rd|th)?)\\s+)?(?:lines?|rows?|columns?|cells?|pages?|slides?|lists?|sheets?|screens?|desks?|tables?|shelf|shelves|stacks?|piles?|queue|agenda|calendar|to-?do|board|whiteboard|repeat|loop|hold|mute|speaker|timer|clock|oven|stove|heat)\\b";
/** Gambling: "put a hundred on the Swans", "chuck 20 on", "throw fifty on red" (a currency always counts). */
const BET = new RegExp(
  `\\b(?:put|chuck|throw|drop|lay|whack|stick|punt|bet|wager|slap|plonk|sling|bung|lob)\\s+(?:a\\s+|an\\s+)?(?:(?:lazy|cool|quick|cheeky|sneaky|solid|easy)\\s+)?(?:(?:${CARDINAL}\\s*${CURRENCY}|\\$\\s?\\d[\\d,.]*)\\s+(?:\\w+\\s+)?on\\b|${CARDINAL}\\s+(?:\\w+\\s+)?on\\b(?!\\s+${NOT_A_BET_OBJECT}))`,
  "i",
);
/** Where a command starts: the utterance, a clause, or after "and"/"then"/"can you"/"click"… */
const CMD =
  "(?:^\\s*|[,.;:!?]\\s*|\\b(?:and|then|also|now|please|pls|just|quickly|jarvis|so|can you|could you|would you|will you|want to|wanna|like to|need to|going to|gonna|help me|let'?s|go ahead and|try to|and then|hit|click|press|tap|smash|select|choose)\\s+" +
  // Round 10 review: a leading account or device phrase is still the start of the command ("on Claude Max 2 buy 5 BHP shares", "using opus
  // buy 10 Tesla shares", "on my laptop buy 10 Tesla shares").
  "|(?:^|[,.;:!?])\\s*(?:on|with|using|via|from)\\s+(?:my\\s+|the\\s+|our\\s+|his\\s+|her\\s+)?(?:[\\w.'-]+\\s+){1,3}?)";
const CRYPTO_TICKER = "(?:btc|eth|doge|sol|xrp|ada|bnb|usdt|usdc|shib|pepe|ltc|trx|avax|matic|wbtc|weth|xlm|sui|hbar|jup|bitcoin|ethereum|dogecoin|solana|stellar|hedera)";
/** Figurative objects: "sell the receptionist offer on this slide", "invest time in the proposal" (R3 §2 carve-out 5). */
const FIGURATIVE = "(?:(?:the|this|that|our|my|an?|him|her|them|it|us)\\s+)?(?:[\\w'-]+\\s+){0,2}?(?:idea|ideas|offer|offers|pitch|story|vision|concept|service|services|package|proposal|receptionist|product\\s+demo|demo|brand|value|benefits?|message|time|effort|energy|thought|attention|hours?|minutes?|days?|weeks?|quotes?|quotation|deck|slides?)\\b";
/** A trade, purchase, bet or payment as a command: "buy AAPL", "sell my Tesla", "pay Mehroz", "ape into DOGE". */
const COMMAND = new RegExp(
  `${CMD}(?:(?:buy|short|trade|purchase|acquire|liquidate|dump|offload|cash\\s+out|swap|stake|refund|reimburse|go\\s+(?:long|short)(?:\\s+on)?|average\\s+down(?:\\s+on)?|dca(?:\\s+into)?|bet|wager|punt|bid|donate|tip|afterpay|zelle|venmo|e-?transfer|flick|bung|top\\s?up|reload|fund|load\\s+up|ape(?:\\s+in(?:to)?)?|hodl|yolo)\\s+(?!button\\b)\\S|(?:sell|invest(?:\\s+in)?)\\s+(?!button\\b)(?!${FIGURATIVE})\\S|pay\\s+(?!attention\\b|heed\\b|a\\s+visit\\b|respects?\\b|tribute\\b|(?:close|no|more|less)\\s+attention\\b)\\S|long\\s+${CRYPTO_TICKER}\\b)`,
  "i",
);
/** Shops and delivery apps: acting on them ("go to amazon and click…", "order a pizza on Uber Eats") is a purchase. */
const SHOP = "(?:amazon(?:\\.com(?:\\.au)?)?|ebay|kogan|jb\\s?hi-?fi|officeworks|bunnings|catch\\.com\\.au|temu|shein|ali\\s?express|etsy|gumroad|uber\\s?eats|door\\s?dash|menulog|deliveroo|booking\\.com|expedia|airbnb|qantas|jetstar)";
const SHOP_ACTION_VERB = "(?:click|press|tap|hit|select|add|proceed|continue|confirm|buy|order|cart|basket|trolley|checkout|check\\s?out|pay|book|reserve|purchase|get\\s+me|grab|usual|finish|complete|reorder|order\\s+again|buy\\s+again)";
/** The R3 families the lists missed: bills, renewals, travel, charity, crypto slang, gift cards, split orders, amount boxes. */
const INDIRECT = new RegExp(
  [
    // "settle the invoice", "clear my card balance", "sort out the Telstra bill", "square away the Higgsfield charge"
    "\\b(?:settle|square\\s+away|clear|pay\\s+(?:down|off)|sort\\s+out|take\\s+care\\s+of|cough\\s+up\\s+for|cover)\\s+(?:the\\s+|my\\s+|our\\s+|this\\s+|that\\s+|his\\s+|her\\s+|an?\\s+)?(?:[\\w'.-]+\\s+){0,3}?(?:invoices?|bills?|balance|debts?|tab|fines?|charges?|rego|registration|premium|rent|dues|fees?|arrears|card)\\b(?!\\s+(?:folder|file|files|template|pdf|draft|spreadsheet|sheet|doc|document|number|layout|design))",
    // "cover Mehroz for lunch", "cover the bill"
    "\\bcover\\s+(?!(?:the|this|that|it|a|an|my|letter|page|image|photo|art|design|story|shift|song|version|slide|up)\\b)[\\p{L}'-]+\\s+for\\b|\\bcover\\s+(?:the\\s+|a\\s+)?(?:bill|tab|cost|costs|dinner|lunch|meal|drinks|fare|rent)\\b(?!\\s+(?:section|slide|page|part|chapter|heading|topic|paragraph|table))",
    // "renew my rego", "renew the muventures.com.au domain", "renew the Vercel Pro plan"
    "\\brenew(?:s|ed|ing|al)?\\s+(?:the\\s+|my\\s+|our\\s+|this\\s+|that\\s+|his\\s+|her\\s+)?(?:[\\w.'-]+\\s+){0,3}?(?:rego|registration|domains?|plan|subscriptions?|membership|licen[cs]es?|insurance|policy|passport|lease|hosting|pro|premium|plus)\\b|\\brenew\\s+[\\w-]+\\.(?:com|net|org|au|co|io|app|dev)\\b",
    "\\btransfer\\w*\\s+(?:the\\s+|my\\s+|our\\s+|a\\s+)?(?:[\\w.-]+\\s+)?domains?\\b",
    // travel and tickets
    "\\b(?:book|buy|purchase|reserve)\\s+(?:me\\s+|us\\s+|him\\s+|her\\s+)?(?:[\\w'-]+\\s+){0,4}?(?:flights?|airfares?|plane\\s+tickets?|(?<!support\\s|jira\\s|bug\\s|help\\s?desk\\s)tickets?|hotel(?:\\s+rooms?)?|accommodation|airbnb|seats?|cruise|tours?)\\b(?!\\s+(?:details|info|information|times|itinerary|numbers?|status|confirmation))",
    "\\b(?:get|grab)\\s+(?:me\\s+|us\\s+)?(?:a\\s+|the\\s+|some\\s+)?(?:\\w+\\s+){0,2}?(?:flights?|airfares?|plane\\s+tickets?|hotel\\s+rooms?)\\b",
    // charity and zakat
    "\\b(?:send|give|pay|donate|transfer|make|offer|distribute|chuck|flick)\\s+(?:my\\s+|the\\s+|our\\s+|some\\s+|a\\s+|his\\s+|her\\s+)?(?:\\w+\\s+)?(?:zakat|zakah|zakaat|sadaqah|sadaqa|sadqa|sadaka|fitrah|fitra|fidya|fidyah|kaffarah|qurbani|udhiyah|charity|donations?|tithes?|offering)\\b",
    // crypto slang and derivatives
    "\\bstack(?:ing)?\\s+sats\\b|\\byeet(?:ed|ing)?\\b|\\bfomo(?:'?d|ing)?\\s+(?:in|into)\\b|\\bmint(?:ing|ed)?\\s+(?:the\\s+|an?\\s+|my\\s+|some\\s+|this\\s+|that\\s+)?(?:\\w+\\s+)?(?:nfts?|tokens?|coins?|collection|drop)\\b|\\b(?:buy|sell|mint|flip|list)\\s+(?:\\w+\\s+){0,2}?nfts?\\b|\\blp\\s+(?:in|into)\\b|\\b(?:liquidity|staking|mining|yield)\\s+(?:pools?|farms?|farming)\\b|\\binto\\s+the\\s+\\w+\\/\\w+\\s+pool\\b",
    `\\b(?:${CRYPTO_TICKER}|tesla|tsla|apple|aapl|nvda|nvidia|spy|qqq|amzn|msft|meta|goog|googl|amd|pltr|coin|mstr|smci|arm|gme|amc)\\s+(?:calls|puts)\\b`,
    "\\b(?:throw|chuck|put|drop|dump|bung|whack|punt)\\s+(?:a|one|two|\\d+|some|half\\s+a)?\\s*(?:grand|k|thousand|hundred|large|bucks|mil)\\s+(?:at|into|in|on)\\b",
    // gift cards, BNPL checkout, paid plans, pay-as-you-go
    "\\bgift\\s?cards?\\b|\\be-?gift\\b|\\bcheck\\s?out\\s+(?:with|using|via|through)\\b|\\bpay[\\s-]+as[\\s-]+you[\\s-]+go\\b",
    "\\b(?:get|buy|start|grab|sign\\s+up\\s+for|go\\s+for|upgrade\\s+to|move\\s+to|switch\\s+to|join|subscribe\\s+to|choose|pick)\\s+(?:the\\s+|a\\s+|my\\s+|our\\s+)?(?:[\\w.'-]+\\s+){0,3}?(?:plan|tier|subscription|membership)\\b(?!\\s+(?:text|document|doc|file|page|slide|column|cell|section|outline|template))",
    "\\bupgrade\\s+(?:my\\s+|the\\s+|our\\s+)?(?:[\\w.'-]+\\s+){1,2}?to\\s+(?:the\\s+|a\\s+)?(?:pro|premium|plus|paid|max|business|team|enterprise|gold|platinum|pay)\\b",
    // "order a pizza", "order me a coffee" (never "order these files by date")
    "\\border\\s+(?!(?:these|those|them|it|this|that|by|of)\\b)(?!the\\s+(?:\\w+\\s+)?(?:files?|folders?|list|rows?|columns?|items?|results?|tabs?|slides?|photos?|names?|leads?)\\b)(?:me\\s+|us\\s+)?(?:a|an|some|two|three|four|\\d+|more|another|the|my|our|dinner|lunch|breakfast|food|takeaway|takeout|pizza|coffee|uber)\\b(?![^.;,]*\\bby\\b)",
    // shopping carts and split orders
    "\\badd\\s+(?:\\S+\\s+){0,4}?to\\s+(?:the\\s+|my\\s+|your\\s+)?(?:cart|basket|bag|trolley)\\b|\\bproceed\\b[^.;]{0,20}\\b(?:checkout|payment|pay|purchase)\\b",
    "\\bplace\\b[^.;]{0,60}?(?<!\\bin\\s)\\border\\b",
    `\\b${SHOP}\\b[^.;]{0,80}\\b${SHOP_ACTION_VERB}\\b|\\b(?:click|press|tap|hit|select|add|proceed|continue|confirm|buy|order|book|reserve|purchase|reorder|re-order|order\\s+again|buy\\s+again|finish|complete|go\\s+through)\\b[^.;]{0,80}\\b(?:on|at|from|in|with|via)\\s+(?:the\\s+|my\\s+|our\\s+)?${SHOP}\\b`,
    // typing into money fields: "type 50 into the amount box", "enter 4111… in the card field"
    "\\b(?:type|enter|put|fill\\s+in|input|write|key\\s+in|pop)\\b[^.;]{0,40}?\\b(?:in|into|to|on)\\s+(?:the\\s+|this\\s+|that\\s+|my\\s+)?(?:amount|payment|card(?:\\s+number)?|cvv|cvc|security\\s+code|expiry|bsb|account\\s+number|payee|tip|donation|bid|stake|wager)\\s*(?:box|field|input|bar|section|area)?\\b",
  ].join("|"),
  "iu",
);
/** Money movement, checkouts, credits, bets and logins that no amount needs to name. */
const MOVEMENT = new RegExp(
  [
    "\\btransfer(?:s|red|ring)?\\s+(?:the\\s+|some\\s+|my\\s+|all\\s+(?:of\\s+)?my\\s+|more\\s+)?(?:money|funds|cash|balance|savings|super(?:annuation)?|crypto|coins?|tokens?|bitcoin|btc|eth|shares?|stocks?|units?|holdings?|portfolio)\\b",
    "\\btransfer(?:s|red|ring)?\\s+(?:it\\s+|them\\s+|that\\s+|this\\s+)?to\\s+(?!(?:the\\s+|my\\s+|a\\s+)?(?:usb|drive|folder|desktop|downloads|documents|onedrive|dropbox|google\\s+drive|icloud|laptop|phone|pc|computer|clipboard|d:|c:|next|other|new)\\b)\\S",
    "\\b(?:send|give|lend|wire|remit|pay|move|tip|donate|withdraw|deposit|swap|bridge|convert)\\s+(?:\\S+\\s+){0,3}?(?:money|funds|cash|bitcoin|btc|eth|ether|ethereum|crypto(?:currency)?|coins?|usdt|usdc|sats|satoshis?|payments?)\\b",
    "\\bremit(?:s|ted|ting|tance)?\\b",
    "\\b(?:pay\\s?id|bpay|osko|pay\\s+anyone|payees?|billers?|beneficiar(?:y|ies)|direct\\s+debit|standing\\s+order|(?:scheduled|recurring|future[- ]dated)\\s+(?:payment|transfer)s?|(?:international|bank|wire|money|interbank)\\s+transfers?|swift\\s+code|bsb|iban)\\b",
    // Withdraw/deposit money, not "withdraw the proposal we sent" (R3 §2 carve-out 5).
    "\\bwithdraw(?:s|al|als|ing|n)?\\b(?!\\s+(?:the\\s+|my\\s+|our\\s+|that\\s+|this\\s+|a\\s+|an\\s+|his\\s+|her\\s+)?(?:[\\w'-]+\\s+){0,3}?(?:proposal|quotes?|quotation|estimate|tender|application|submission|request|offer|complaint|comment|consent|invitation|nomination|candidacy|pull\\s+request|pr)\\b)|\\bdeposit(?:s|ing)?\\b",
    "\\b(?:market|limit|stop(?:[- ]loss)?|stop[- ]limit|trailing(?:[- ]stop)?|buy|sell|trade|share|stock|crypto|conditional)\\s+orders?\\b|\\border\\s+ticket\\b",
    "\\bplace\\s+(?:a|an|the|my)?\\s*(?:\\w+\\s+)?(?:trade|bet|bid|wager)\\b",
    "\\b(?:share|stock|crypto|forex|fx|options?|futures|cfds?|margin|day)\\s+trad(?:e|es|ing)\\b|\\b(?:call|put)\\s+options?\\b|\\bcfds?\\b|\\bshort[- ]sell(?:ing)?\\b|\\b(?:open|close)\\s+(?:a\\s+|the\\s+|my\\s+)?(?:long\\s+|short\\s+)?positions?\\b|\\bleverage[ds]?\\b|\\b\\d+x\\s+(?:long|short)\\b",
    `\\b(?:buy|sell|swap|long|short|stake|ape|dump|trade|convert|send|move|yeet|fomo|throw|chuck)\\b[^.;]{0,30}\\b${CRYPTO_TICKER}\\b|\\bbuy\\s+the\\s+dip\\b`,
    "\\b0x[a-f0-9]{40}\\b|\\bbc1[a-z0-9]{25,59}\\b|\\b(?:wallet|btc|eth|bitcoin|crypto|deposit)\\s+address\\b",
    // checkouts, carts, cards, credits, paid plans, payment approvals
    "\\bcheckout\\b(?!\\s+(?:-b\\b|--|main\\b|master\\b|develop\\b|dev\\b|the\\s+(?:\\w+\\s+)?branch|(?:a\\s+|the\\s+|this\\s+|that\\s+|my\\s+|new\\s+)?(?:feature\\s+)?branch|head\\b|origin\\b|[\\w.-]+\\/[\\w./-]+))|\\bcheck\\s+out\\s+(?:my\\s+|the\\s+|this\\s+)?(?:cart|basket|order|bag|trolley)\\b|\\bto\\s+check\\s?out\\b|\\b(?:complete|finish|finalise|finalize|submit|confirm)\\s+(?:the\\s+|my\\s+|this\\s+)?(?:\\w+\\s+)?(?:checkout|purchase|order|payment|transaction|booking payment)\\b",
    "\\bsaved\\s+card\\b|\\b(?:credit|debit)\\s+card\\b|\\bcard\\s+(?:number|details)\\b|\\bplace\\s+(?:the\\s+|my\\s+|your\\s+|an?\\s+)?order\\b|\\border\\s+now\\b|\\bbuy\\s+now\\b",
    "\\b(?:premium|pro|paid|plus|gold|platinum|business|team)\\s+(?:plan|tier|subscription|membership|account)\\b|\\bupgrade\\s+(?:my\\s+|the\\s+|to\\s+(?:the\\s+)?)?(?:plan|subscription|premium|pro|paid)\\b|\\bsubscribe\\s+to\\s+(?:the\\s+|a\\s+)?(?:\\w+\\s+)?(?:plan|tier|subscription|membership|premium|pro)\\b",
    "\\b(?:add|buy|purchase|get|load|top\\s?up)\\s+(?:\\S+\\s+){0,2}?credits?\\b|\\badd\\s+(?:funds|money|balance|cash)\\b|\\btop[- ]?\\s?up\\b|\\breload\\s+(?:my\\s+)?(?:card|balance|wallet|account)\\b",
    "\\bpayment\\s+requests?\\b|\\b(?:confirm|approve|authori[sz]e|accept|release)\\s+(?:the\\s+|this\\s+|my\\s+)?(?:\\w+\\s+)?(?:transfer|payment|charge|purchase|transaction|trade|bet|order|withdrawal|payout|invoice)\\b",
    "\\b(?:settle|square)\\s+up\\b|\\bpay\\s+(?:him|her|them|me|us|back)\\b|\\bsplit\\s+the\\s+(?:bill|cost)\\b|\\bpay\\s+off\\b",
    // gambling
    "\\b(?:casino|pokies|sportsbook|bookies?|betting|gambl(?:e|ing)|lotto|lottery|keno|scratchies?|parlay|same\\s+game\\s+multi|each\\s+way)\\b",
    // bank / broker logins and apps
    "\\b(?:internet|online|net|mobile|phone)\\s?banking\\b|\\bmy\\s+(?:bank(?:ing)?|broker(?:age)?|superannuation|super\\s+(?:fund|account|balance)|crypto\\s+(?:wallet|account|exchange)|trading\\s+(?:account|app)|brokerage\\s+account|share\\s+trading)\\b|\\bbank\\s+(?:app|account|balance)\\b",
    "\\b(?:log(?:ging)?\\s?(?:in|on)(?:to)?|sign(?:ing)?\\s?(?:in|on)(?:to)?)\\s+(?:to\\s+)?(?:the\\s+|my\\s+|our\\s+)?(?:\\w+\\s+)?(?:bank(?:ing)?|broker(?:age)?|wallet|trading\\s+(?:account|app|platform)|super(?:annuation)?)\\b",
    "\\btax\\s+refund\\b|\\bpay\\s?wave\\b|\\btap\\s+(?:to|and|&|n)\\s+pay\\b",
  ].join("|"),
  "iu",
);
/** Foreign pay / transfer / buy verbs that are money on their own (send-like verbs need an amount). */
const FOREIGN_MONEY = /(?:^|[^\p{L}])(?:zahle|zahlen|bezahle|bezahlen|zahlung|zahlungspflichtig|uberweis\w*|ueberweis\w*|kaufe|kaufen|verkaufe|verkaufen|bestellen|payer|payez|paie|virement|acheter|achete|achetez|vendre|transfiere|transferir|transferencia|pagar|paga|pague|pagare|pago|bonifico|ricarica|acquista|acquistare|comprar|compra|vender|vende|betaal|betalen|overmaken|overboeken|koop|kopen|verkoop|verkopen|afrekenen|przelej|przelew|zaplac|zaplacic|oplac|kupuje\s+i\s+place|placanje|platiti|betala|betalning|maksa|maksaa|maksu|magbayad|bayaran|lipa|lipia|odeme|overfor|overfore|overforsel|bayar|beli|chuyen\s+khoan|chuyen\s+tien|thanh\s+toan|satin\s+al|ادفع|حول|حوّل|تحويل|دفع|اشتر|بيع|jama\s+karo|paise\s+(?:bhej|de)|rupay|rupaye)(?![\p{L}])/iu;
/** "maak 25 euro over naar Pieter" (Dutch: transfer), "faz um pix" (Brazil's instant transfer). */
const FOREIGN_PHRASE = /\bmaak\s+(?:\S+\s+){0,4}over\b|\bfaz(?:er)?\s+(?:um\s+)?pix\b|\bum\s+pix\b|\bpix\s+(?:de|para|pro)\b/iu;
/** Chinese, Japanese and Korean pay / transfer / buy words (no spaces between words, so no word boundaries). */
const CJK_MONEY = /付款|付钱|付錢|支付|转账|轉賬|轉帳|转帐|汇款|匯款|打钱|打錢|充值|买入|買入|卖出|賣出|下单|下單|购买|購買|结账|結帳|结算|红包|紅包|送金|振込|振り込|支払|払って|払い込|購入|買って|入金|出金|課金|決済|注文を確定|송금|결제|구매|이체|충전|입금/u;
/**
 * Pay / transfer / buy words in scripts the Latin fold would mangle, checked on the raw text (R4: Russian,
 * Hindi, Thai, Hebrew, Urdu, Turkish): переведи, купи, оплати, भुगतान, खरीद, ส่งเงิน, העבר, ادائیگی, öde…
 */
const RAW_SCRIPT_MONEY = /переве(?:ди|сти|д)|перевод|оплат|купи(?:ть)?|продай|заплати|भुगतान|खरीद|ट्रांसफर|पेमेंट|ส่งเงิน|โอนเงิน|จ่ายเงิน|ชำระเงิน|ซื้อ|העבר|תשלום|לשלם|שלם|קנה|ادائیگی|جاز\s?کیش|ایزی\s?پیسہ|(?:^|\s)öde(?:me|yin)?(?=\s|$)|satın\s+al|πληρ[ωώ]|πληρωμ|μεταφορ|αγορ[άα]|বিকাশ|পেমেন্ট|কিনুন|টাকা\s?পাঠা|பணம்\s?அனுப்ப|செலுத்த|வாங்க|ከፍለ|ክፍያ|ግዛ|پرداخت|خرید|انتقال\s?وجه|ادا\s?کر|ödeme/u;
/** Send words in those scripts: money only with an amount ("भेजो 2000", "שלח 200", "转5000", "보내 5만원"). */
const RAW_SCRIPT_SEND = /بھیج|भेज|שלח|ส่ง|보내|转(?=\s?[\d一二三四五六七八九十百千万])|发给|發給|gönder|στείλ|στειλ|στέλν|пошли|отправ|بفرست|ارسال|পাঠা|அனுப்ப|ላክ|שלחי|传给|轉給|振り込んで|보내줘/u;
const HAS_DIGITS = /\p{Nd}|[一二三四五六七八九十百千万萬]/u;

/**
 * The R4 families the lists still missed: bills in other words, keeping a plan going, paid plans and
 * trials, rentals, tips and shouts, sponsorships and pledges, religious giving, in-app purchases, crypto
 * and trading slang, punts, money-app logins and "move 5k". Each needs its money word, never a verb alone.
 * (LOTTERY_ENTRY, just below, is one of them: buying or entering a raffle, sweepstakes, art union, prize
 * home, draw entry or office sweep, R5 §6.)
 */
const LOTTERY_ENTRY =/\b(?:buy|get|grab|enter|purchase|order|pick\s+up|put|chuck|sign\s+(?:me\s+)?up\s+for)\b[^.;]{0,40}\b(?:raffles?|sweepstakes?|lotto|lottery|lotteries|powerball|keno|tombola|art\s+unions?|prize\s+homes?|(?:prize|lucky|charity|home|car)\s+draws?|draw\s+entr(?:y|ies)|(?:office|footy|work|cup)\s+sweeps?)\b|\benter\s+(?:the|a|this|our)\s+(?:[\w-]+\s+){0,2}draw\b|\bdraw\s+entr(?:y|ies)\b|\bsweepstakes?\s+entr(?:y|ies)\b/i;
const INDIRECT_R4: RegExp[] = [
  /\b(?:sort|handle|knock\s+off|deal\s+with|look\s+after|fix\s+up|cough\s+up\s+for|clear|settle|pay\s+off|take\s+care\s+of)\s+(?:out\s+)?(?:the\s+|my\s+|our\s+|this\s+|that\s+|an?\s+)?(?:[\w'.-]+\s+){0,3}?(?:bills?|invoices?|levy|levies|fines?|notices?|renewal|rego|registration|rates|fees?|dues|premiums?|rent|bond|subscription|membership)\b(?!\s+(?:folder|file|files|template|pdf|draft|spreadsheet|sheet|doc|document|by|into|alphabetically|section|page|layout|design|emails?))/i,
  /\bget\s+(?:the\s+|my\s+|our\s+)?(?:[\w'.-]+\s+){0,3}?(?:bills?|invoices?|fines?|rent|rego|levy|rates|fees?|notices?)\s+paid\b/i,
  /\bkeep\s+(?:my\s+|the\s+|our\s+)?(?:[\w.'+-]+\s+){0,2}?(?:going|running|active|alive|on)\s+(?:for\s+)?(?:another|one\s+more|a\s+few\s+more|\d+\s+more)\s+(?:months?|years?|weeks?)\b/i,
  /\bextend\s+(?:my\s+|the\s+|our\s+)?(?:[\w.'-]+\s+){0,3}?(?:plan|subscription|membership|licen[cs]e|hosting|domain|rego|lease|warranty|trial)\b/i,
  /\bsign\s+(?:me|us|him|her|them)\s+up\s+(?:for|to|with)\s+(?:[\w.'-]+\s+){0,3}?(?:pro|premium|plus|paid|plan|membership|subscription|max|trial|gold|vip)\b/i,
  // (Round 10: "on/using/via/with Claude Max 2" names an ACCOUNT the coding harness runs on, not a plan to buy; "Claude Max" alone, or
  // "buy/get/upgrade to Claude Max 2", is still a subscription.)
  /\b(?:youtube|spotify|apple\s+music|apple\s+tv|netflix|disney\+?|stan|binge|kayo|linkedin|canva|microsoft|office|adobe|duolingo|chatgpt|claude|notion|figma|dropbox|google\s+one|icloud|xbox|game\s+pass|playstation|audible|kindle|amazon\s+prime|prime\s+video|paramount\+?|foxtel|midjourney|cursor|github\s+copilot)\s+(?:premium|pro|plus|family|max|trial|membership|subscription|ultimate|unlimited|one|365|team|business|gold)\b(?<!\b(?:on|using|via|with)\s+(?:my\s+|the\s+|our\s+)?claude\s+max(?=\s*\d\b))/i,
  /\b(?:premium|pro|plus)\s+(?:trial|family\s+plan|membership)\b|\bgo\s+(?:premium|pro|plus)\b|\b(?:start|begin|activate|take)\s+(?:the\s+|a\s+|my\s+)?(?:free\s+)?(?:[\w.'-]+\s+){0,3}?trial\b(?!\s+(?:run|balloon|version\s+of\s+the\s+(?:doc|slide)))/i,
  /\b(?:rent|buy)\s+(?:the\s+|a\s+|this\s+)?(?:movie|film|show|episode|season|album|audiobook|ebook|game)\b|\b(?:and|then)\s+upgrade\b(?!\s+(?:node|npm|bun|python|pip|the\s+(?:app|driver|os|packages?)|dependencies|windows|chrome|vs\s?code))/i,
  /\bsuper\s?(?:thanks|chats?|stickers?)\b|\bchannel\s+membership\b|\bjoin\s+(?:the\s+|this\s+|my\s+)?(?:\w+\s+)?membership\b/i,
  /\bchip\s+in\s+(?:for|to|towards|on)\b|\bshout\s+(?:the\s+|my\s+|our\s+)?(?:\w+\s+)?(?:lunch|dinner|coffees?|drinks|breakfast|meals?|round)\b|\bon\s+my\s+(?:card|credit\s+card|debit\s+card|amex|visa|mastercard)\b/i,
  /\b(?:leave|add|give|include|put)\s+(?:a\s+|an\s+)?(?:\d+\s?%\s+|\$?\d+\s+|small\s+|big\s+|generous\s+|little\s+)?tip\b(?!\s+(?:section|sheet|box|jar|text|line|about|on\s+how|for\s+(?:writing|using|the\s+(?:blog|post|article|reader))))/i,
  /\bsponsor\b[^.;]{0,30}\b(?:fun\s+run|run|walk|ride|swim|charity|fundraiser|appeal|marathon|challenge|child|kid|orphan)\b|\bback\s+(?:the\s+|a\s+|this\s+|his\s+|her\s+)?(?:kickstarter|indiegogo|gofundme|campaign|project|patreon|crowdfund\w*)\b/i,
  /\b(?:send|give|pay|donate|transfer|make|offer|distribute|chuck|flick)\s+(?:my\s+|the\s+|our\s+|some\s+|a\s+|his\s+|her\s+)?(?:\w+\s+)?(?:fitrana|fitranah|fitr|khums|lillah|waqf|kaffara)\b|\bput\s+(?:some\s+)?(?:money|cash|funds)\s+(?:in|into|on|towards)\b|\blodge\s+(?:the\s+|my\s+|a\s+)?(?:bond|deposit|payment)\b/i,
  /\bbefore\s+(?:they|it|the\s+\w+)\s+(?:sell|sells|sold)\s+out\b/i,
  /\b(?:v-?bucks|robux|battle\s+pass|season\s+pass|in-?app\s+purchases?|minecoins|primogems|genesis\s+crystals|gem\s+pack|coin\s+pack)\b|\b(?:get|buy|add|purchase|grab|top\s+up)\s+(?:more\s+|some\s+|\d+\s+)?(?:gems|diamonds|crystals|lives)\b|\bunlock\s+(?:the\s+)?(?:full|pro|premium|paid|complete)\s+(?:version|app|game|access)\b|\brecharge\s+(?:my\s+|the\s+)?(?:\w+\s+)?(?:sim|phone|mobile|prepaid|card|credit|account|balance|data)\b/i,
  /\bsnipe\b[^.;]{0,30}\b(?:tokens?|coins?|launch|mint|nfts?|presale)\b|\bairdrops?\b|\brebalanc\w*\s+(?:my\s+|the\s+)?(?:portfolio|holdings|super|etfs?|allocation)\b|\btrim\s+(?:my\s+|the\s+)?(?:\w+\s+)?positions?\b|\bperps?\b|\bperpetuals?\b|\b(?:flip|rotate|farm)\b[^.;]{0,30}\b(?:into|on)\b/i,
  /\b(?:pick\s+up|scoop|grab|load\s+up\s+on|accumulate|top\s+up\s+on)\b[^.;]{0,25}\b(?:nvda|tsla|aapl|msft|amzn|googl?|meta|amd|nflx|pltr|bhp|cba|csl|vas|vgs|vdhg|ivv|ndq|a200|wbc|wes|wow|fmg|rio|tls|mqg|xro|spy|qqq|voo|vti|arkk|gme|amc|mstr)\b/i,
  /\bhave\s+a\s+punt\b|\bpunt\s+on\b|\bback\s+\w+\s+(?:at|with)\s+(?:the\s+)?(?:line|odds|handicap|spread|[+-]\d|\$?\d)/i,
  /\b(?:log|sign)\s?(?:in|on)?\s?(?:to|into)?\s+(?:my\s+)?macquarie\b(?!\s+uni)/i,
  /\bmove\s+\$?\d+(?:[.,]\d+)?\s?(?:k|grand|m)\b/i,
  // R5: finance it, vouchers and gift sellers, "top the X up", confirm a ride, tickets to a show, average into a fund
  /\bfinance\s+(?:the\s+|my\s+|a\s+|this\s+)?[\w-]+\s+(?:with|through|via|on|using)\b|\b(?:prezzee|gift\s?pay|e-?gifts?|vouchers?)\b/i,
  /\btop\s+(?:the\s+|my\s+|our\s+)?(?!(?:list|page|table|chart|ranking|leaderboard|section|story|post|thread)\b)(?:[\w-]+\s+){1,2}?up\b/i,
  /\bconfirm\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:uber|didi|ola|lyft|taxi|cab|ride|trip|pickup|booking|reservation)\b/i,
  /\b(?:get|grab|snag|score)\s+(?:me\s+|us\s+)?(?:a\s+|the\s+|some\s+|two|three|four|five|\d+)?\s*(?:[\w-]+\s+)?tickets?\s+(?:to|for)\b/i,
  /\baverage\s+(?:down\s+|up\s+)?(?:in|into|on)\b/i,
  // R5 §6: draws, raffles, art unions, prize homes and sweeps are lotteries ("get me 3 raffle tickets", "enter the prize home draw")
  LOTTERY_ENTRY,
  // "rent Dune", "Rent The Batman": a title after rent (case-sensitive, so "rent a room" isn't one)
  /\b[Rr]ent\s+(?:[Tt]he\s+)?[A-Z][\w']+/,
];
/** A link shortener whose path says money (R4: bit.ly/3payNow). */
const SHORT_MONEY = /(?:pay|buy|bet|coin|crypto|donate|checkout|bank|wallet|transfer|invest|trade)/i;

/** Money screens by what the title says. */
const MONEY_SCREEN =
  /\b(?:internet banking|online banking|net ?banking|pay anyone|transfer (?:funds|money)|(?:add|new|create) (?:a )?payee|bpay|osko|pay\s?id|order (?:pad|ticket|summary)|trade (?:ticket|confirmation)|place (?:a )?(?:trade|bet)|place your order|buy\s*\/\s*sell|crypto(?:currency)?|seed phrase|withdraw (?:funds|crypto)|check ?out|payments?|payment details|confirm (?:payment|purchase|order|transfer)|billing|top ?up|add funds|buy (?:bitcoin|crypto|credits)|bet ?slip|sportsbook|casino|betting|wagering|lotto\w*|lotter(?:y|ies)|pokies|wealth\w*|forex|wallets?|staking)\b|(?:^|[|\-–—:]\s*)credits(?:\s*(?:$|[|\-–—:]))/i;

/**
 * Plain finance words the STRICT tiers also refuse (control_pc, away mode: no final-button gate there).
 * Not "invoice" or "chase" (R3 §2 carve-out 5: "draft an invoice", "chase up the lead"); "pay/settle the
 * invoice" is still caught by the shared patterns above.
 */
export const FINANCE_WORDS =
  /\b(?:bank(?:s|ing)?|net ?bank|broker(?:s|age)?|bitcoin|btc|ethereum|crypto(?:currency)?|super(?:annuation| fund)|share ?trading|stocks?|stake|wise|superhero|stripe|kraken|trade|trading|tax return|bet|betting|casino|pokies|wallet|payments?)\b/i;

export type MoneyRefusal = { kind: "money-or-trading" | "bank-broker-or-exchange"; why: string };
/** Domain-like words in his request ("go to ing.com.au"). */
const DOMAIN_IN_TEXT = /(?:https?:\/\/)?(?:[\p{L}0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/giu;

/** Luhn: a card number check. */
export function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
/** A Luhn-valid 13-19 digit run, spaced or dashed ("4111 1111 1111 1111"): a card number. Pure. */
export function cardNumberIn(text: string): boolean {
  for (const m of String(text ?? "").matchAll(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** Editing a document that shows a price ("add the A$699 package to the proposal"): typing a price isn't paying (carve-out 6). */
const DOC_EDIT =
  /^\s*(?:please\s+)?(?:add|type|put|enter|write|insert|include|change|update|set|make|list|show|price)\b[^.;]*\b(?:to|into|in|on|as|at)\s+(?:the\s+|this\s+|that\s+|my\s+|our\s+|a\s+)?(?:[\w'-]+\s+){0,2}?(?:proposal|quote|quotation|estimate|price\s*(?:cell|list|table|column|sheet)?|pricing(?:\s+(?:page|table|slide|section|sheet))?|slide|deck|presentation|spreadsheet|sheet|cell|column|row|document|doc|template|draft|brochure|one-?pager|website\s+copy|landing\s+page|page\s+copy|a\$?\d)/i;
/**
 * Bookkeeping in his own records (R4 §4: "log the $825 deposit in the CRM", "record the client's A$825
 * payment in Finance", "mark INV-0042 as paid in the CRM", "reconcile the Stripe payouts in Finance"):
 * writing down money that already moved moves none. A send/transfer/buy/bet verb still refuses.
 */
const BOOKKEEPING =
  /^\s*(?:please\s+)?(?:log(?!\s?(?:in|on)\b)|record|mark|note|enter|add|update|reconcile|categori[sz]e|tag|file)\b[^;]*\b(?:in|into|to|on|as)\s+(?:the\s+|our\s+|my\s+)?(?:crm|finance|xero|myob|quickbooks|books|ledger|spreadsheet|sheet|agenticos|dashboard|tracker|leads?\s+(?:list|table))\b|^\s*(?:please\s+)?mark\s+(?:invoice\s+)?(?:inv-?\d+|the\s+invoice)\s+as\s+(?:paid|unpaid|sent)\b/i;
const BOOKKEEPING_SPENDS = /\b(?:send|transfer|wire|buy|sell|bet|wager|swap|stake|remit|top\s?up|withdraw\s+(?:money|cash|funds|\$)|log\s?(?:in|on)\s?(?:to)?|sign\s?in)\b/i;
/** Is this bookkeeping in his own CRM/Finance records (no money moves)? Pure. */
export function bookkeeping(text: string): boolean {
  const t = normaliseText(text);
  return BOOKKEEPING.test(t) && !BOOKKEEPING_SPENDS.test(t);
}
/**
 * Git work (R4 §4: "git checkout -b feature/pay-page", "checkout the payments branch in VS Code"): branch
 * names are not money. Returns the text with branch names and "<word> branch" removed when it is git work,
 * else null. Pure.
 */
export function stripGitRefs(text: string): string | null {
  const t = normaliseText(text);
  if (!/\bgit\b|\bbranch(?:es)?\b|\b(?:git\s+)?(?:checkout|switch)\s+(?:-b\s+)?(?:main|master|develop|dev|origin\/\S+|[\w.-]+\/[\w./-]+)\b/i.test(t)) return null;
  return t
    .replace(/(?:^|\s)-[bB]\s+\S+/g, " ")
    .replace(/\S*\/\S*/g, " ")
    .replace(/\b[\w.-]+(?=\s+branch(?:es)?\b)/gi, " ")
    .replace(/\b(?:check\s?out|switch|branch(?:es)?|origin|main|master|head|develop)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * Opening or reading a LOCAL document (carve-out 1): "open my bank statement PDF from Downloads", "open
 * D:\Finance\nab-2026-09.csv in Excel", "read D:\Finance\statements\cba-2026-08.csv", "import the NAB CSV
 * into Finance". Reading a file isn't a login or a payment; a money verb, an amount, a URL or a login word
 * still refuses. The file and its place may come in either order.
 */
const LOCAL_DOC =
  /^\s*(?:please\s+)?(?:open|read|show(?:\s+me)?|summari[sz]e|view|preview|look\s+(?:at|through)|go\s+through|import|load|analy[sz]e|categori[sz]e|find)\b(?=[^;]*(?:\.(?:pdf|csv|xlsx?|docx?|txt|ofx|qif)\b|\b(?:pdf|csv|xlsx|ofx|qif|spreadsheet|statements?)\b))(?=[^;]*(?:\b(?:from|in|on)\s+(?:my\s+|the\s+)?(?:downloads|documents|desktop|onedrive|dropbox)\b|\b[a-z]:\\|\binto\s+(?:the\s+)?finance\b|\bin\s+(?:excel|acrobat|adobe|word|notepad|the\s+finance\s+(?:tab|page|module))\b))/i;
/** Is this task only opening or reading a local document (statement PDF/CSV, a spreadsheet)? The strict tiers use it too. Pure. */
export function localDocument(text: string): boolean {
  const t = normaliseText(text);
  return LOCAL_DOC.test(t) && !HARD_MONEY_VERB.test(t) && !MONEY_AMOUNT.test(t) && !/\b(?:log\s?in|sign\s?in|login|password|https?:|www\.)/i.test(t);
}
const HARD_MONEY_VERB = /\b(?:send|pay|paid|transfer|wire|buy|sell|donate|tip|deposit|withdraw|invest|bet|wager|swap|stake|remit|refund|top\s?up|charge|checkout|order)\b/i;

function refusalOf(t: string): MoneyRefusal | null {
  if (localDocument(t) || bookkeeping(t)) return null;
  const git = stripGitRefs(t);
  if (git !== null) {
    if (!HARD_MONEY_VERB.test(git) && !MONEY_AMOUNT.test(git) && !MONEY_NAMES.test(git)) return null;
    t = git;
  }
  const docEdit = DOC_EDIT.test(t) && !HARD_MONEY_VERB.test(t);
  if (!docEdit && MONEY_AMOUNT.test(t) && MONEY_VERB.test(t)) return { kind: "money-or-trading", why: "an amount of money with a money verb" };
  if (SECURITIES_QTY.test(t) && /\b(?:buy|sell|short|trade|order|purchase|transfer|send|swap|stake)\b/i.test(t)) return { kind: "money-or-trading", why: "a quantity of securities" };
  if (!docEdit && BARE_AMOUNT.test(t)) return { kind: "money-or-trading", why: "a money verb with an amount" };
  if (BET.test(t)) return { kind: "money-or-trading", why: "a bet" };
  if (COMMAND.test(t)) return { kind: "money-or-trading", why: "a trade, purchase, bet or payment" };
  if (MOVEMENT.test(t)) return { kind: "money-or-trading", why: "money movement, a checkout, credits, a payee or a bank login" };
  if (INDIRECT.test(t) || INDIRECT_R4.some((re) => re.test(t))) return { kind: "money-or-trading", why: "a bill, renewal, purchase, donation or crypto move in other words" };
  if (cardNumberIn(t)) return { kind: "money-or-trading", why: "a card number" };
  if (FOREIGN_MONEY.test(t) || FOREIGN_PHRASE.test(t) || CJK_MONEY.test(t)) return { kind: "money-or-trading", why: "a payment or transfer (not in English)" };
  if (MONEY_NAMES.test(t) || TAB_BRAND.test(t)) return { kind: "bank-broker-or-exchange", why: "a bank, broker, exchange, gambling or payment service" };
  for (const m of t.match(DOMAIN_IN_TEXT) ?? []) {
    if (moneyHost(m)) return { kind: "bank-broker-or-exchange", why: "a bank, broker, exchange, gambling or payment website" };
    const u = m.replace(/^https?:\/\//i, "");
    const host = u.split(/[/?#:]/)[0].toLowerCase().replace(/^www\./, "");
    if (SHORTENER.test(host) && SHORT_MONEY.test(u.slice(host.length))) return { kind: "bank-broker-or-exchange", why: "a short link that looks like a payment page" };
    if (ipLike(host) && !isIp(host) && IP_MONEY_PATH.test(u.slice(host.length))) return { kind: "bank-broker-or-exchange", why: "an address that hides a bank or login page" };
  }
  return null;
}

/** Pay/transfer words in non-Latin scripts, on the raw text (before the Latin fold mangles them). Pure. */
/** The raw text in NFC and NFKC forms, zero-width removed, lower case (non-Latin checks). */
const rawForms = (text: string) => [...new Set(["NFC", "NFKC"].map((f) => String(text ?? "").normalize(f as "NFC").replace(ZERO_WIDTH, "").toLowerCase()))];
function rawScriptRefusal(text: string): MoneyRefusal | null {
  // NFC and NFKC both: NFKC splits some marks (Thai "ชำระ" loses its SARA AM), NFC keeps them.
  for (const raw of rawForms(text))
    if (RAW_SCRIPT_MONEY.test(raw) || CJK_MONEY.test(raw) || (RAW_SCRIPT_SEND.test(raw) && HAS_DIGITS.test(raw))) return { kind: "money-or-trading", why: "a payment or transfer (not in English)" };
  return null;
}

/** His request moves money, trades, pays, bets, logs into or names a money service: refused. Pure. */
export function moneyRefusal(text: string): MoneyRefusal | null {
  const raw = rawScriptRefusal(text);
  if (raw) return raw;
  for (const v of textVariants(text)) {
    const hit = refusalOf(v);
    if (hit) return hit;
  }
  return null;
}

/** A page path that is a checkout, payment, credits or wallet page on any site (amazon.com.au/gp/buy, openrouter.ai/credits). */
const MONEY_PATH = /\/(?:checkout|check-out|payments?|pay|buy|cart\/checkout|purchase|billing|credits?|top-?up|deposit|withdraw(?:al)?|wallet|transfer|send-money|bet-?slip|order\/confirm|gp\/buy|subscribe|upgrades?|pledge|donate|donation|trade|robux)(?:[/?#.]|$)/i;
/** On a raw-IP host, any sign of a bank, a login or money in the path is a money page (R3 §1c: 203.0.113.10/netbank). */
const IP_MONEY_PATH = /(?:^|[/._-])(?:net ?bank\w*|bank\w*|ib|login|log-?in|signin|sign-?in|logon|auth\w*|secure|account\w*|pay\w*|wallet|trade|trading|broker|invest\w*|crypto|bet\w*|casino|checkout|transfer|payee)(?:$|[/._?#-])/i;

/**
 * The owner's own dashboards (REVIEW-SAFETY-R3 §2 carve-out 7): the receptionist's Payments tab and
 * AgenticOS pages (never its /__ API) are his business screens, not a bank. Only the title/URL fence
 * steps aside; every money button there is still refused, and a page showing an amount still makes
 * final presses money presses (vetAction). Needs the URL: a title alone never qualifies.
 */
// Exactly his own dashboards (REVIEW-S2C R2 §2): the live receptionist dashboard, his own marketing site's
// apex (muventures.com.au / www., not any subdomain), and this AgenticOS server on loopback AT THE PORT IT
// RUNS ON. Client builds and preview subdomains (bianca.muventures.com.au, a stale preview) and any other
// local server (localhost:3000, a vite dev site on 5173) are ordinary sites again.
const OWN_REMOTE_HOST = /^(?:mu-receptionist\.vercel\.app|(?:www\.)?muventures\.com\.au)$/i;
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;
/** `bun run start` serves AgenticOS on 8081 (package.json); used only until the server registers its real port. */
const DEFAULT_SERVER_PORT = 8081;
let ownServerPort: number | null = null;
/** The AgenticOS server calls this once it is listening, with the port it actually got (scripts/operator-plugin.ts). */
export function setOwnServerPort(port: number | null | undefined) {
  ownServerPort = typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}
/** This server's real port: the one it registered, or, in the app's own page, the page's own origin; else the start port. */
function ownPort(): number {
  if (ownServerPort) return ownServerPort;
  const here = (globalThis as { location?: { hostname?: string; port?: string; protocol?: string } }).location;
  if (here && LOOPBACK_HOST.test(here.hostname ?? "")) return Number(here.port || (here.protocol === "https:" ? 443 : 80)) || DEFAULT_SERVER_PORT;
  return DEFAULT_SERVER_PORT;
}
export function ownDashboard(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    if (u.username || u.password || /^\/__/.test(u.pathname)) return false;
    if (OWN_REMOTE_HOST.test(u.hostname)) return u.protocol === "https:";
    if (!LOOPBACK_HOST.test(u.hostname)) return false;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80)) === ownPort();
  } catch {
    return false;
  }
}
/** A local document window: "<file>.pdf - Adobe Acrobat Reader", "nab-2026-09.csv - Excel" (carve-out 1). */
const LOCAL_DOC_TITLE =
  /^[^|\n]{1,200}\.(?:pdf|csv|xlsx?|docx?|txt|ofx|qif)\s+[-–—]\s+(?:Adobe Acrobat(?: Reader)?(?: DC)?(?: \(64-bit\))?|Acrobat Reader|(?:Microsoft )?Excel|(?:Microsoft )?Word|Notepad|Notepad\+\+|WordPad|LibreOffice (?:Calc|Writer)|Visual Studio Code)$/i;
/**
 * The window (title) or page (URL) he'd have Jarvis act in is a money screen: refused. Pure.
 * `process` (when known): a local document window is exempt only in its own app (Acrobat, Excel, Word,
 * Notepad, VS Code), never in a browser; a browser showing a file is exempt only on a file:// URL.
 */
export function moneySurfaceRefusal(surface: { title?: string | null; url?: string | null; process?: string | null }): MoneyRefusal | null {
  const title = String(surface.title ?? "");
  const proc = String(surface.process ?? "").replace(/\.exe$/i, "");
  const localDoc = !surface.url && LOCAL_DOC_TITLE.test(title.trim()) && (!proc || DOC_PROCESS.test(proc));
  const fileUrl = /^file:\/\//i.test(String(surface.url ?? ""));
  if (localDoc || fileUrl || ownDashboard(surface.url)) return null;
  if (title) {
    for (const v of textVariants(title))
      if (MONEY_NAMES.test(v) || TAB_BRAND.test(v) || MONEY_SCREEN.test(v) || segmentBrand(v)) return { kind: "bank-broker-or-exchange", why: "the window is a bank, broker, exchange, gambling, checkout or payment screen" };
    for (const m of normaliseText(title).match(DOMAIN_IN_TEXT) ?? []) if (moneyHost(m)) return { kind: "bank-broker-or-exchange", why: "the window shows a money website" };
  }
  const url = normaliseText(String(surface.url ?? ""));
  if (url) {
    if (moneyHost(url)) return { kind: "bank-broker-or-exchange", why: "the page is a bank, broker, exchange, gambling or payment site" };
    let path = "";
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
      path = u.pathname;
      if (ipLike(u.hostname.replace(/^\[|\]$/g, "")) || /^\[/.test(u.hostname)) {
        if (IP_MONEY_PATH.test(`${u.pathname}${u.search}`) || MONEY_NAMES.test(decodeURIComponent(`${u.pathname} ${u.search}`).replace(/[/_.-]+/g, " "))) return { kind: "bank-broker-or-exchange", why: "a raw-IP page that looks like a bank, login or payment page" };
      }
      // A redirect or proxy carrying a money site in its query (google.com/url?q=https://www.nab.com.au).
      const inner = decodeURIComponent(`${u.search}${u.hash}`);
      for (const m of inner.match(DOMAIN_IN_TEXT) ?? []) if (moneyHost(m)) return { kind: "bank-broker-or-exchange", why: "the page forwards to a money site" };
    } catch {
      /* not a URL: the host check above is all */
    }
    if (MONEY_PATH.test(path)) return { kind: "money-or-trading", why: "the page is a checkout, payment or credits page" };
  }
  return null;
}

/** The institution kind a window or page belongs to (for away.payment: brokers, exchanges and gambling are never approvable). Pure. */
export function moneySurfaceKind(surface: { title?: string | null; url?: string | null }): InstitutionKind | "money" | null {
  const url = normaliseText(String(surface.url ?? ""));
  if (url) {
    const k = moneyHostKind(url);
    if (k) return k;
  }
  const title = String(surface.title ?? "");
  for (const v of textVariants(title)) {
    for (const i of INSTITUTIONS) for (const n of i.names ?? []) if (new RegExp(`(?<![\\w-])(?:${n})(?![\\w-])`, "i").test(v)) return i.kind;
    if (/\b(?:betting|wagering|lotto\w*|lotter(?:y|ies)|pokies|casino|sportsbook|bet ?slip)\b/i.test(v) || TAB_BRAND.test(v)) return "gambling";
    if (/\b(?:crypto(?:currency)?|seed phrase|staking|withdraw crypto|buy bitcoin)\b/i.test(v)) return "crypto";
    if (/\b(?:order (?:pad|ticket)|trade (?:ticket|confirmation)|buy\s*\/\s*sell|forex|share trading)\b/i.test(v)) return "broker";
    if (/\b(?:internet banking|online banking|net ?banking|pay anyone)\b/i.test(v)) return "bank";
  }
  for (const m of normaliseText(title).match(DOMAIN_IN_TEXT) ?? []) {
    const k = moneyHostKind(m);
    if (k) return k;
  }
  return moneySurfaceRefusal(surface) ? "money" : null;
}

// --- buttons: ONE normalised money table (text, titles, sites and buttons read the same lists) -------
const TOKEN = "(?:usdc|usdt|dai|weth|wbtc|eth|btc|link|uni|arb|op|matic|shib|pepe|sol|bnb)";
/**
 * Button labels that spend, move, bet or trade money. On every screen path these are REFUSED, never
 * "ask": no spoken yes can press them (the owner's rule). Ordinary finals (Send email, Delete, Publish)
 * stay "ask". Matched on the normalised label and AutomationId; a label that carries an amount
 * ("Rent HD $5.99", "Send ₿0.01") is money too (moneyButton).
 */
export const MONEY_BUTTON_LABELS: readonly string[] = [
  // paying
  "pay(?:\\s+now|\\s+with\\b.*|\\s+(?:a\\$|\\$|aud|usd)?\\s?\\d.*|\\s+(?:bill|invoice|balance|securely|in\\s+full|later|over\\s+time))?",
  "payments?", "make\\s+(?:a\\s+)?payment", "submit\\s+(?:payment|order|purchase|bid)", "continue\\s+(?:to|with)\\s+(?:payment|checkout|pay|purchase|billing)",
  "proceed\\s+to\\s+(?:checkout|payment|pay|purchase|billing)", "review\\s+(?:and|&)\\s+pay", "authori[sz]e\\s+(?:payment|charge|transaction)",
  // buying and ordering
  "buy(?:\\s+\\w+)?", "purchase", "complete\\s+(?:purchase|order|payment|checkout)",
  "confirm\\s+(?:and\\s+pay|purchase|order|payment|transfer|trade|bet|swap|withdrawal|deposit|subscription|booking)",
  "place\\s+(?:my\\s+|your\\s+|an?\\s+|the\\s+)?(?:order|bet|bid|trade)", "order\\s+now",
  "(?<!sort\\s)(?<!in\\s)order(?!\\s+(?:history|details|status|summary|number|no\\b|id\\b|date|by|of|tracking|confirmation))",
  "check\\s?out", "express\\s+checkout", "add\\s+to\\s+(?:cart|basket|bag|trolley)",
  // subscriptions, renewals, rentals, trials, upgrades, unlocks
  "subscribe", "subscriptions?", "renew(?:al)?(?:\\s+now)?", "rent(?:\\s+(?:now|hd|sd|uhd|4k|it|this|movie|for))?",
  "(?:start|begin|activate|try|claim)\\s+(?:(?:your|my|a|the)\\s+)?(?:free\\s+)?(?:subscription|trial|membership|plan)", "free\\s+trial",
  // "Unlock for $2.99", "Unlock full access" (a bare "Unlock" opens a vault, a phone or a PDF: not money)
  "unlock\\s+(?:for|now|full|all|premium|pro|plus|access|article|story|episode|chapter|course|content|this\\s+(?:article|story|episode|chapter|video|course)|the\\s+(?:full|article|story|episode|chapter|course))",
  "(?:go|get|try|buy|join)\\s+(?:pro|premium|plus|gold|max|ultra|unlimited|vip)", "upgrade(?:\\s+(?:plan|now|to\\s+\\w+|subscription|account))?",
  // bets, trades, crypto
  "bet(?:\\s+now)?", "place\\s+bet", "wager", "sell(?:\\s+now|\\s+all|\\s+\\w+)?", "swap(?:\\s+now)?", "trade(?:\\s+now)?", "go\\s+(?:long|short)",
  "(?:open|close)\\s+position", "invest(?:\\s+now)?", "(?:un|re)?stake", "mint(?!\\s+(?:green|colou?r|leaf|theme|condition))(?:\\s+\\w+)?",
  "claim(?!\\s+(?:this|your|a|the)\\s+(?:business|listing|profile|page|account))(?:\\s+(?:rewards?|airdrop|tokens?|bonus|prize|now|offer|cashback|winnings|payout))?",
  `approve\\s+(?:${TOKEN}|tokens?|spend(?:ing)?|allowance|spending\\s+cap)`, "bridge(?:\\s+now)?", "place\\s+bid", "bid(?:\\s+now)?",
  // moving money
  "top\\s?-?up", "add\\s+(?:credits?|funds|money|balance|cash)", "buy\\s+credits", "transfer(?:\\s+(?:now|money|funds))?",
  "send\\s+(?:money|payment|funds|crypto|\\$|a\\$|\\d)", "withdraw", "deposit", "refund", "cash\\s+out", "settle(?:\\s+up|\\s+now|\\s+balance)?", "redeem",
  "convert(?!\\s+to\\s+(?:pdf|word|docx?|jpe?g|png|gif|mp[34]|text|table|shape|smartart|curves|outlines))",
  // giving
  "tip", "donate", "gift(?!\\s+(?:ideas?|guide))(?:\\s+\\w+)?",
  "give(?!\\s+(?:feedback|up|access|permission|it\\s+a\\s+try|us\\s+feedback|a\\s+rating|rating|kudos|thanks|a\\s+like))(?:\\s+(?:now|today|monthly|once|\\$|a\\$|\\d)\\w*)?",
  "contribute\\s+(?:now|today|\\$|a\\$|\\d)\\w*", "pledge", "sponsor", "back\\s+this\\s+project",
  // payment brands
  "apple\\s+pay", "google\\s+pay", "g\\s?pay", "pay\\s?pal", "afterpay", "zip\\s?pay", "klarna", "pay\\s+in\\s+4", "tap\\s+to\\s+pay",
  // REVIEW-SAFETY-R4 §1b: charges, tickets, reorders, recharges, signing, bet slips, spins, round-ups, support
  "charge(?:\\s+(?:card|my\\s+card|me|now|it|\\$|a\\$|\\d)\\w*)?", "(?:get|buy|book|reserve)\\s+(?:tickets?|seats?)", "reorder", "order\\s+again", "re-?order\\s+now",
  "recharge(?:\\s+now)?", "load\\s+(?:card|money|funds|wallet)", "sign\\s+(?:transaction|and\\s+send|&\\s+send|&\\s+submit|and\\s+submit)",
  "(?:add\\s+to\\s+)?bet\\s?slip", "place\\s+multi", "same\\s+game\\s+multi", "spin(?:\\s+(?:now|again|the\\s+wheel))?", "round\\s+up",
  "support\\s+(?:us|this|the\\s+creator|now)", "chip\\s+in", "enrol+(?:\\s+now)?", "get\\s+access", "get\\s+it\\s+now", "secure\\s+(?:my|your)\\s+(?:spot|place|seat|ticket)",
  "accept\\s+odds", "yes,?\\s+charge\\s+me", "confirm\\s+transaction", "execute\\s+trade", "lock\\s+in(?:\\s+bet)?",
  // other languages' pay/buy/order buttons (German, French, Spanish, Italian, Dutch, Portuguese, Turkish, Indonesian, Vietnamese)
  "jetzt\\s+kaufen", "zahlungspflichtig(?:\\s+bestellen)?", "bestellen", "kaufen", "bezahlen", "commander", "payer(?:\\s+maintenant)?", "acheter", "pagar(?:\\s+ahora)?",
  "comprar(?:\\s+ahora)?", "finalizar\\s+compra", "acquista(?:\\s+ora)?", "paga(?:\\s+ora)?", "(?:nu\\s+)?betalen", "afrekenen", "kopen", "satin\\s+al", "bayar(?:\\s+sekarang)?",
  "beli(?:\\s+sekarang)?", "thanh\\s+toan", "mua\\s+ngay", "przelej", "zaplac",
  // R5 §3b: Swedish, Finnish, Polish, Croatian, Tagalog, Swahili, Turkish pay labels and the mobile-money apps
  "betala(?:\\s+nu)?", "maksa(?:\\s+nyt)?", "kupuje\\s+i\\s+place", "placanje", "platiti", "magbayad", "lipa(?:\\s+sasa)?", "odeme(?:\\s+yap)?", "odemeyi\\s+tamamla",
  "swish", "vipps", "mobile\\s?pay", "blik", "twint", "gcash", "m-?pesa", "bkash", "raast", "naya\\s?pay", "upi", "promptpay", "qris", "duit\\s?now",
  "(?:hold|slide|swipe|tap)\\s+to\\s+(?:pay|buy|confirm\\s+payment|send)",
  // YouTube's paid buttons (memberships, Super Thanks/Chat/Stickers)
  "super\\s?(?:thanks|chat|stickers?)", "join\\s+(?:this\\s+)?channel", "channel\\s+membership",
];
export const MONEY_BUTTON = new RegExp(`\\b(?:${MONEY_BUTTON_LABELS.join("|")})\\b`, "i");
/** Other-script pay/buy/order button words, on the raw label (R4: 立即购买, 確認支付, 注文を確定する, 결제하기, Купить, अभी खरीदें…). */
const RAW_BUTTON = /购买|購買|支付|付款|付費|付费|结账|結帳|下单|下單|購入|注文|決済|支払|결제|구매|주문|송금|оплат|купить|купи|перевести|перевод|заказать|खरीद|भुगतान|ซื้อ|ชำระ|קנה|לתשלום|שלם|ادفع|اشتر|(?:^|\s)öde(?:\s|$)/iu;
/** Is this button (label, id) a money action, or does its label carry an amount? Normalised like the text checks. Pure. */
export function moneyButton(text: string): boolean {
  // Cart, card, money-bag, banknote and coin icons are pay buttons whatever the page (R5: an icon asks nothing).
  if (/[\u{1F6D2}\u{1F4B3}\u{1F4B0}\u{1F4B8}\u{1F4B5}\u{1F4B6}\u{1F4B7}\u{1F4B4}\u{1FA99}\u{1F3E7}]/u.test(text)) return true;
  if (rawForms(text).some((raw) => RAW_BUTTON.test(raw) || RAW_SCRIPT_MONEY.test(raw))) return true;
  return textVariants(text).some((v) => MONEY_BUTTON.test(v) || LABEL_AMOUNT.test(v) || FOREIGN_MONEY.test(v) || CJK_MONEY.test(v));
}

// --- money context: where a final or continue press is money (R3 §6 item 2) --------------------------
/** Word tokens of a control's id or name that say it pays, orders or subscribes (submit-payment, btnCheckout, renewPlan). */
const MONEY_ID_TOKEN = /(?:^|[\s_\-.:/#])(?:pay|paynow|payment|payments|checkout|purchase|order|orders|billing|wallet|subscribe|subscription|renew|renewal|buy|donate|donation|topup|deposit|withdraw|transfer)(?=$|[\s_\-.:/#\d])/i;
const CARD_ID_TOKEN = /(?:^|[\s_\-.:/#])(?:card|cc|credit|debit|cvv|cvc)(?=$|[\s_\-.:/#\d])/i;
/** Titles of pages that are about paying (not "invoice" or "bill": a draft invoice document is ordinary work). */
const MONEY_PAGE_TITLE = /\b(?:wallet|swap|vault|staking|checkout|check\s?out|cart|basket|trolley|billing|payments?|pay|donat(?:e|ion|ions)|fundrais(?:er|ing)|subscriptions?|order\s+summary|your\s+order|top\s?up|kassa|kassan|warenkorb|panier|carrito|carrello|winkelwagen|koszyk|kosik|keranjang|troli)\b/i;
/** Local document apps: a price in a spreadsheet or proposal isn't a payment page (carve-outs 1 and 6). */
const DOC_PROCESS = /^(?:excel|winword|powerpnt|onenote|notepad|notepad\+\+|code|devenv|wordpad|soffice(?:\.bin)?|scalc|swriter|acrord32|acrobat|explorer|obsidian)$/i;
export type MoneyContextInput = {
  title?: string | null;
  url?: string | null;
  /** The window's title and visible static text (dialogTextOf). */
  text?: string | null;
  process?: string | null;
  /** The control about to be pressed (or the focused one, for Enter/Space). */
  element?: { name?: string; aid?: string; help?: string } | null;
  /** The page's other controls and fields ("name aid" lines): a Pay button or a card field there makes it a checkout. */
  controls?: string | null;
  /**
   * The press commits a step (Continue, Confirm, Complete, Send, Next, OK…). Only then do an offer's signals
   * ("Due today", "$5/month", a sponsor tier, Super Thanks) and an embedded frame or canvas on a step count as
   * a checkout (R6): a Like or Share on a video whose description says "$5/month" stays ordinary.
   */
  commit?: boolean;
  /** The page embeds content the text can't show (an iframe, a canvas, an unnamed image) (R6 §3). */
  embeds?: boolean;
  /**
   * The short texts right beside the control (same row or box: a price tag, a radio "A$5.00", "2,00 €"), one per
   * line (R7 §2). An amount there with a committing press is a tip, gift, donation, membership or checkout box.
   */
  nearby?: string | null;
  /** The page has an amount picker: choosable controls named only by an amount ("$5", "A$10") (R8 §3). */
  picker?: boolean;
  /** The page shows a progress bar (a multi-step flow) (R8 §3). */
  progress?: boolean;
};
/**
 * The page asks for an amount (R8 §3): "Choose an amount", "Select amount", "Enter an amount", "Custom amount",
 * "How much would you like to give?", in the supported languages. With a committing press it's a payment step
 * even when no amount is readable (amount tiles drawn as unnamed images).
 */
const AMOUNT_PROMPT = /(?<!\p{L})(?:(?:choose|select|pick|enter|set|type)\s+(?:an?\s+|the\s+|your\s+)?(?:\w+\s+)?amount|(?:custom|other|tip|gift|donation|top-?up)\s+amount|how\s+much\s+(?:would\s+you\s+like|do\s+you\s+want)\s+to\s+(?:give|pay|send|tip|donate|gift)|(?:choisissez|choisir|s[ée]lectionnez|saisissez)\s+(?:un|le|votre)\s+montant|montant\s+(?:libre|personnalis[ée])|betrag\s+(?:w[äa]hlen|ausw[äa]hlen|eingeben)|(?:w[äa]hle|gib)\s+(?:einen|den)\s+betrag|(?:elige|elija|selecciona|ingresa|introduce)\s+(?:un|el|tu)\s+(?:monto|importe)|(?:scegli|seleziona|inserisci)\s+(?:un|l')\s*importo|kies\s+een\s+bedrag|v[äa]lj\s+belopp|wybierz\s+kwot[ęe]|pilih\s+(?:jumlah|nominal)|金額を(?:選択|入力)|选择金额|輸入金額|금액\s?(?:선택|입력))(?!\p{L})/iu;
const splitId = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2");
/** Order, basket, booking, plan and donation steps by path (a softer signal than MONEY_PATH: context, not a fence). */
const CONTEXT_PATH = /\/(?:order|orders|review|cart|basket|bag|confirm|confirmation|booking|book|tickets?|donate|donation|pledge|subscribe|subscription|upgrade|membership|premium|purchases?|rent|payment|pay|checkout|billing|wallet|deposit|top-?up|kassa|kassan|warenkorb|panier|carrito|koszyk|keranjang|sponsors?|sponsorships?|super_?(?:chat|thanks|stickers?))(?:[/?#._-]|$)/i;
/** Paid-plan paths that are ordinary words elsewhere ("/pro/"): a checkout only for a committing press (R6: canva.com/pro). */
const COMMIT_PATH = /\/(?:pricing|plans?|pro|plus|gold|max|teams?|business|go-?pro|join|members?|memberships?|tiers?|trial|start-?trial|free-?trial)(?:[/?#._-]|$)/i;
/** A step of a multi-step flow (R6 §3: "/s/3", "/step/2", "Step 2 of 3"). */
const STEP_PATH = /\/(?:s|step|steps|stage|stages|checkout-step|page)\/?\d+(?:[/?#.]|$)|[?&](?:step|stage)=\d/i;
const STEP_TEXT = /(?<!\p{L})(?:step|[ée]tape|schritt|paso|passo|stap|krok|steg|vaihe|l[ée]p[ée]s|langkah|hakbang|adım|adim|шаг|ステップ|步骤|步驟|단계)\s*\d+\s*(?:of|sur|von|de|di|van|z|ze|av|af|\/|из|\/)\s*\d+(?!\p{L})|\b\d\s*\/\s*\d\s+steps?\b|\b(?:almost\s+done|final\s+step|last\s+step|review\s+(?:and|&)\s+confirm|review\s+your\s+(?:details|order))\b/iu;
/**
 * A recurring price in any supported language, when it sits on a line with an amount (R7 §1): "A$14.99/month",
 * "9,99 € monatlich", "4,99 € par mois", "\$10 USD / month", "¥980/月".
 */
const RECURRING = /(?:\/\s?|per\s+|a\s+|an\s+|every\s+)(?:mo|mth|month|yr|year|wk|week)\b|(?<!\p{L})(?:monthly|yearly|annually|weekly|monatlich|j[äa]hrlich|w[öo]chentlich|pro\s+monat|im\s+monat|mensuel(?:le)?|par\s+mois|par\s+an|annuel(?:le)?|al\s+mes|mensual(?:es)?|por\s+mes|anual|al\s+mese|mensile|annuale|per\s+maand|maandelijks|per\s+jaar|per\s+m[åa]nad|m[åa]nadsvis|miesi[ęe]cznie|na\s+miesi[ąa]c|rocznie|aylık|aylik|yıllık|ежемесячно|в\s+месяц|в\s+год|kuukaudessa|havonta|per\s+bulan|sebulan|kwa\s+mwezi)(?!\p{L})|\/\s?(?:月|年|월)|月額|每月|매월/iu;
/**
 * An offer about to be taken, on ANY host (R6 §1): "Due today", a recurring price ("$5 a month", "A$17.99/month
 * after trial", "€9,99 pro Monat"), a sponsor tier or sponsorship, Super Chat / Super Thanks / Super Stickers,
 * a "subscribe to"/"upgrade to" plan. With a committing press it's a checkout.
 */
const OFFER = /\bdue\s+today\b|\b(?:today'?s|first)\s+(?:payment|charge)\b|(?:(?:[$€£¥₹₩₽₱]|\b(?:a|au|us|nz|c|hk|s|r)\$|\b(?:aud|usd|eur|gbp|nzd|cad|inr|pkr|rp|rm|kr)\.?\s?)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|£|kr|zł|aud|usd|eur|gbp)\b)\s*(?:\/\s?|per\s+|a\s+|an\s+|each\s+|every\s+|pro\s+|par\s+|al\s+|por\s+)(?:mo|mth|month|monat|mois|mes|maand|yr|year|jahr|año|annum|week|wk|woche|semaine)\b|\b(?:billed|charged|paid|payable)\s+(?:monthly|yearly|annually|weekly)\b|\b(?:monthly|yearly|annual)\s+(?:plan|subscription|membership|price|fee)\b|\bsponsor(?:ship|ships|ing)?\b|\b(?:one-?time|monthly)\s+sponsor|\bsuper\s?(?:chat|thanks|stickers?)\b|\b(?:subscribe|upgrade)\s+(?:to|now)\b|\bstart\s+(?:your\s+)?(?:free\s+)?trial\b|\bafter\s+(?:the\s+|your\s+)?(?:free\s+)?trial\b|\b(?:choose|select|pick)\s+(?:a\s+|your\s+)?(?:plan|tier)\b/i;
/** His documents on the web (Google Docs/Slides/Sheets, Office online, Canva, Figma, Notion) and in desktop apps. */
const DOC_WEB = /^(?:docs|slides|sheets)\.google\.com$|(?:^|\.)(?:onedrive\.live\.com|sharepoint\.com|office\.com|officeapps\.live\.com|figma\.com|notion\.so)$/i;
const DOC_TITLE = /\s[-–—]\s(?:Google (?:Docs|Slides|Sheets)|PowerPoint|Word|Excel|Keynote|Pages|Numbers|Canva|Figma|Notion)(?:\s[-–—]\s|$)/i;
function ownDocument(title: string, url: string | null | undefined): boolean {
  const host = urlHost(url);
  return DOC_WEB.test(host) || (!host && DOC_TITLE.test(title)) || (DOC_TITLE.test(title) && DOC_WEB.test(host));
}
const urlHost = (url: string | null | undefined) => {
  try {
    return url ? new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
};
/**
 * Content sites (REVIEW-SAFETY-R5 §6): a price in a video description, a PR title, a flyer design or an
 * article is words about money, like mail and chat. Only their money controls, money paths (youtube.com/
 * premium) and a checkout block count there.
 */
const CONTENT_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|github\.com|gitlab\.com|bitbucket\.org|canva\.com|figma\.com|wikipedia\.org|wikimedia\.org|notion\.so|reddit\.com|stackoverflow\.com|stackexchange\.com|medium\.com|linkedin\.com|x\.com|twitter\.com|loom\.com|vimeo\.com|substack\.com)$/i;
/**
 * Amounts in the currencies the general pattern lacks, for PAGE detection only (R5 §3a): Rp, RM, Kč, KSh,
 * R 199.00 (ZAR), S/ 50.00, ৳, ₨, TSh, USh, GH₵, E£, Br, Birr.
 */
const PAGE_AMOUNT = /(?:\b(?:rp|rm|ksh|kes|tsh|ush|ghs|gh₵|e£|egp|zar|bdt|tk|php|idr|myr|czk|huf|kc)\.?\s?\d|\bR\s?\d[\d,. ]*[.,]\d{2}\b|\bS\/\.?\s?\d|[৳₨₵]\s?\d|\d[\d.,\s]*\s?(?:kc|kč|ft|br|birr|tk)\b)/i;
/**
 * A checkout block (R5 §3): a total, amount-due, subtotal or order summary line next to a number, with or
 * without a currency ("Total 49.99", "Order summary", "Att betala 499", "Summe 12,00", "Jumlah 150.000").
 */
const TOTAL_BLOCK = /(?:^|\n)[\s\p{P}]*(?:(?:grand\s+|order\s+|basket\s+|cart\s+|estimated\s+)?total|sub-?\s?total|amount\s+(?:due|payable|to\s+pay)|balance\s+due|you(?:'ll)?\s+pay|to\s+pay|pay\s+now|att\s+betala|summa|zu\s+zahlen|summe|gesamt\p{L}*|endbetrag|rechnungsbetrag|due\s+today|total\s+due|totaal|te\s+betalen|totale|importe|a\s+pagar|à\s+payer|montant|razem|do\s+zapłaty|do\s+zaplaty|celkem|összesen|osszesen|jumlah|yhteensä|yhteensa|итого|к\s+оплате|合计|总计|合計|합계|toplam|kabuuan|jumla)(?!\p{L})[^\n]{0,40}?\d|\border\s+summary\b|\bpayment\s+summary\b|\breview\s+(?:and|&)\s+pay\b/iu;
/**
 * A control or field on the page that finishes a payment or takes card details (the page is a checkout).
 * Not a shop's everyday "Buy now", "Add to cart" or header "Checkout" link: a product page isn't a
 * checkout (its money BUTTONS are still refused by name).
 */
const CHECKOUT_CONTROL = /\b(?:payment\s+iframe|card\s*(?:number|no)|cvv2?|cvc2?|cid|csc|security\s+code|expiry\s+date|name\s+on\s+card|place\s+(?:my\s+|your\s+)?order|pay\s+now|complete\s+(?:purchase|order|payment)|proceed\s+to\s+payment|confirm\s+(?:and\s+pay|purchase|order|payment)|pay\s+(?:[$€£¥₹]|a\$|us\$|rp|rm)\s?\d)/i;
/**
 * Card fields in other languages (R6 §2): "Número de tarjeta", "Numéro de carte", "Kartennummer", "Numer karty",
 * "Nomor kartu", "Número do cartão", "Numero della carta", "Kaartnummer", "Kortnummer", an expiry "MM/AA"/"MM/JJ"/
 * "MM/ÅÅ", a security code "Código de seguridad", "Cryptogramme", "Prüfnummer". Tested on raw and folded text.
 */
const CARD_FIELD_INTL = /(?:n[uú]mero\s+de\s+(?:la\s+)?tarjeta|tarjeta\s+de\s+(?:cr[eé]dito|d[eé]bito)|num[eé]ro\s+de\s+(?:la\s+)?carte|carte\s+(?:bancaire|de\s+cr[eé]dit)|karten\s?nummer|kreditkart\w*|numer\s+karty|karta\s+(?:kredytow|płatnicz|platnicz)\w*|nomor\s+kartu|kartu\s+kredit|n[uú]mero\s+do\s+cart[aã]o|cart[aã]o\s+de\s+cr[eé]dito|numero\s+della\s+carta|carta\s+di\s+credito|kaart\s?nummer|kort\s?nummer|kortets\s+nummer|kortin\s+numero|číslo\s+karty|cislo\s+karty|kártyaszám|kartyaszam|номер\s+карты|رقم\s+البطاقة|卡号|卡號|カード番号|카드\s?번호|\bmm\s?\/\s?(?:aa|jj|åå|aa|rr|yy|yyyy|aaaa|jjjj|gg|ee|ьь|гг)\b|c[oó]digo\s+de\s+seguridad|c[oó]digo\s+de\s+seguran[cç]a|cryptogramme|pr[uü]fnummer|pr[uü]fziffer|kod\s+(?:cvv|cvc|bezpiecze\w+)|kode\s+keamanan|s[aä]kerhetskod|beveiligingscode)/iu;
/** Words that say the amount on screen is about to be paid, sent or charged. */
const PAYING_PHRASE = /\b(?:you(?:'re|\s+are|'ll|\s+will)?\s+(?:be\s+)?(?:sending|paying|send|buying|donating|transferring|charged|billed|debited)|will\s+be\s+(?:charged|debited|billed|deducted|taken|paid|sent|transferred)|(?:charge|bill|debit)\s+(?:your|my|the)\s+(?:card|account)|confirm\s+(?:the\s+|this\s+|your\s+)?(?:payment|purchase|transfer|order|donation)|authori[sz]e\s+(?:the\s+|this\s+)?(?:payment|charge|transfer)|(?:payment|purchase|transfer|donation|top-?up)\s+of)\b/i;
export type MoneyContextLevel = { reason: string; level: "transactional" | "incidental" };
/**
 * Is this press in a money context, and how strong is it? `transactional`: a pay/order/card control or
 * field, a checkout block (a total or amount due next to a number), a paying title or path, or a money site.
 * `incidental`: an amount merely appears in the page's text. Null: none, or his own documents and sites,
 * or an amount on a content site. Pure.
 */
export function moneyContextLevel(input: MoneyContextInput): MoneyContextLevel | null {
  const t = (reason: string): MoneyContextLevel => ({ reason, level: "transactional" });
  const e = input.element;
  if (e) {
    const aid = splitId(String(e.aid ?? ""));
    const name = String(e.name ?? "");
    // (On his own dashboards a control NAMED "Order" sorts his leads; its id, and every money button, still count.)
    if (MONEY_ID_TOKEN.test(` ${aid} `) || (!ownDashboard(input.url) && MONEY_ID_TOKEN.test(` ${splitId(name)} `)) || CARD_ID_TOKEN.test(` ${aid} `) || /\b(?:credit|debit)\s+card|card\s+(?:number|details)|pay\s+by\s+card\b/i.test(name)) return t("that control pays, orders or subscribes");
    // A money field (the Amount box on a transfer form, a payee, a card number).
    if (/\b(?:amount|payee|recipient|card\s*(?:number|no)|cvv|cvc|expiry|bsb|account\s*(?:number|no)|iban)\b/i.test(`${name} ${aid}`)) return t("that is a money field");
  }
  const title = String(input.title ?? "");
  const process = String(input.process ?? "").replace(/\.exe$/i, "");
  // His own documents and sites (R4 §4): a proposal deck showing "Setup fee A$1,650", his pricing page on
  // muventures.com.au, a spreadsheet of prices. Only the page-level signals step aside; a pay/order
  // control there (above) and every money BUTTON (vetAction) still refuse.
  if (DOC_PROCESS.test(process) || ownDashboard(input.url) || ownDocument(title, input.url)) return null;
  if (input.url) {
    if (moneyHost(input.url)) return t("the page is a money site");
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
      if (MONEY_PATH.test(u.pathname)) return t("the page is a checkout, payment or credits page");
      // The review, basket, booking or plans step (R4: /order/review with the total below the fold).
      if (CONTEXT_PATH.test(u.pathname + u.search)) return t("the page is an order, booking, plan or donation step");
      if (input.commit && COMMIT_PATH.test(u.pathname)) return t("the page is a paid plan's sign-up");
    } catch {
      /* not a URL */
    }
  }
  const content = CONTENT_HOST.test(urlHost(input.url));
  // Line by line: a total is a line of its own ("Total 49.99"), not "a total of 5 people" mid-sentence. A short
  // label in one cell and its value in the next ("Gesamtsumme" | "49,99 €") are joined into one line too (R6 §2).
  const rawLines = String(input.text ?? title).normalize("NFKC").split(/\s*\n\s*/).filter(Boolean);
  const joined = rawLines.flatMap((l, i) => (l.length <= 40 && i + 1 < rawLines.length ? [`${l} ${rawLines[i + 1]}`] : []));
  const raw = [...rawLines, ...joined].join("\n");
  const text = [...rawLines, ...joined].map(normaliseText).join("\n");
  const controlsRaw = String(input.controls ?? "").normalize("NFKC");
  const controls = normaliseText(controlsRaw);
  if (CHECKOUT_CONTROL.test(controls) || CARD_FIELD_INTL.test(controlsRaw) || CARD_FIELD_INTL.test(controls)) return t("the page has a pay or order control, or card fields");
  // (Raw too: the confusable fold turns "Итого" into Latin lookalikes.)
  if (TOTAL_BLOCK.test(text) || TOTAL_BLOCK.test(raw)) return t("the page shows a total or an amount due");
  // A committing press on an offer, on any host, content sites included (R6 §1): "Due today", "$5 a month",
  // a sponsor tier, Super Thanks, "upgrade to Pro".
  if (input.commit && (OFFER.test(text) || OFFER.test(raw) || OFFER.test(title))) return t("the page is taking up a paid offer");
  const amountIn = (line: string) => MONEY_AMOUNT.test(normaliseText(line)) || PAGE_AMOUNT.test(line) || MONEY_AMOUNT.test(line);
  // Any committing press where a line shows a recurring price, on any host (R7 §1: "A$14.99/month", "monatlich").
  if (input.commit && [...rawLines, title].some((l) => amountIn(l) && RECURRING.test(l))) return t("the page shows a recurring price");
  // A committing press with an amount right beside it: a tip, gift, donation, membership, support or checkout box,
  // recognised by shape, not by product names, in any language (R7 §2: "Merci" | "2,00 €" | "Envoyer").
  const beside = String(input.nearby ?? "").normalize("NFKC").split(/\s*\n\s*/).filter((l) => l && l.length <= 40);
  if (input.commit && beside.some(amountIn)) return t("an amount sits right beside that button (a tip, gift, donation, membership or checkout box)");
  // An amount picker or an amount prompt with a committing press (R8 §3): the next step takes that amount.
  if (input.commit && input.picker) return t("the page is an amount picker");
  if (input.commit && (AMOUNT_PROMPT.test(raw) || AMOUNT_PROMPT.test(text))) return t("the page asks for an amount");
  // A committing press on a step whose total the text can't show (an iframe, a canvas, an image with no
  // alt text) is a checkout when something else says checkout: a step path or "Step 2 of 3", or a checkout
  // title or a progress bar (R8; checkout paths refused above already). An iframe or canvas alone doesn't: embedded videos, maps
  // and charts are on ordinary pages everywhere, with "Continue reading" beside them (R6 §3).
  if (input.commit && input.embeds && (STEP_TEXT.test(raw) || STEP_PATH.test(String(input.url ?? "")) || MONEY_PAGE_TITLE.test(title) || input.progress))
    return t("the page's total may be inside a frame or picture on a checkout step");
  if (!content && MONEY_PAGE_TITLE.test(title)) return t("the page is about paying");
  const amount = MONEY_AMOUNT.test(text) || PAGE_AMOUNT.test(String(input.text ?? title));
  // A content site's amount is words about money, except under a committing press: that ASKS (R7 §1).
  if (content) return input.commit && amount ? { reason: "the page mentions an amount of money", level: "incidental" } : null;
  // An amount beside paying words ("You're sending $500.00 to Sam", "$20 will be charged", "Confirm payment of"): a checkout.
  if (amount && PAYING_PHRASE.test(text)) return t("the page is about to pay an amount");
  // A committing press on a step of a multi-step flow that shows any amount ("Shipping A$9.99" on /s/3, the total
  // below the fold): a checkout step (R6 §3).
  if (amount && input.commit && (STEP_TEXT.test(raw) || STEP_PATH.test(String(input.url ?? "")))) return t("the page is a paying step of a multi-step flow");
  if (amount) return { reason: "the page mentions an amount of money", level: "incidental" };
  return null;
}
/** Is this press in a money context at all (either level)? The reason, or null. Pure. */
export function moneyContext(input: MoneyContextInput): string | null {
  return moneyContextLevel(input)?.reason ?? null;
}

// --- away.payment: what the owner may approve with his one-time code (28 Sep policy) -------------------
export type PaymentKind = "bill" | "invoice" | "purchase" | "subscription" | "renewal" | "donation" | "zakat" | "sadaqah" | "saved-payee";
export type PaymentNever = "trade" | "crypto" | "betting" | "new-payee" | "bank-transfer" | "card-details";
const NEVER_TRADE = /\b(?:shares?|stocks?|etfs?|equit(?:y|ies)|options?|futures|cfds?|forex|fx|leverage[ds]?|margin|broker(?:age)?|portfolio|positions?|order\s+ticket|market\s+order|limit\s+order|short(?:[- ]sell)?|go\s+(?:long|short)|dca|average\s+down|rebalanc\w*|invest(?:ing|ment)?|trade|trading|sell|units)\b/i;
const NEVER_CRYPTO = /\b(?:crypto(?:currency)?|bitcoin|btc|eth(?:ereum)?|usdt|usdc|sol(?:ana)?|doge(?:coin)?|pepe|shib|xlm|stellar|xrp|ripple|ada|cardano|avax|matic|wbtc|weth|nfts?|mint(?:ing)?|stak(?:e|ing)|unstake|swap|bridge|defi|liquidity|lp|sats|satoshis?|seed\s+phrase|wallet\s+address|0x[a-f0-9]{8,}|yeet|ape|hodl|airdrops?|memecoin|perps?|token|hbar|hedera|jup|jupiter|buy\s+the\s+dip|btfd)\b|[₿]/i;
const NEVER_BET = /\b(?:bet|bets|betting|wager|punt|gambl(?:e|ing)|casino|pokies|lotto|lottery|lotteries|powerball|keno|raffles?|jackpot|scratchies|sweepstakes?|sweeps?|draw\s+entr(?:y|ies)|enter\s+(?:the|a|this|our)\s+(?:prize\s+)?draw|art\s+unions?|prize\s+homes?|prize\s+draws?|lucky\s+draws?|tombola|sportsbook|odds|parlay|multi)\b/i;
const NEVER_NEW_PAYEE = /\b(?:new|add(?:ing)?\s+(?:a\s+)?|create\s+(?:a\s+)?|save\s+(?:this\s+|a\s+)?)\s*(?:payee|biller|beneficiary|recipient)\b|\b(?:bsb|account\s+number|iban|swift|routing\s+number|pay\s+anyone\s+to\s+a\s+new)\b/i;
/** A transfer to a person (R4 finding 3: tested BEFORE invoice and bill, so "PayID Sam for the invoice" is a transfer). */
const NEVER_TRANSFER = /\b(?:transfer|wire|remit|e-?transfer|osko|pay\s?id|pay\s+(?:anyone|someone)|bank\s+transfer|move\s+(?:money|funds|cash)|pix|zelle|venmo|interac)\b/i;
/** "my saved payee", "existing biller" (R4: "my payee" alone doesn't mean saved). */
const SAVED_PAYEE = /\b(?:saved|existing|registered)\s+(?:payee|biller)\b|\bpayee\s+(?:i|we)\s+(?:already\s+)?(?:saved|have)\b/i;
/** A ticker after a buy/sell word (R4: "buy 5 NVDA", "buy 20 VAS", "buy XLM"), case-sensitive on his words; not a product code. */
const TICKER_BUY = /\b(?:[Bb]uy|[Ss]ell|[Pp]urchase|[Gg]rab|[Pp]ick\s+up|[Ss]coop|[Ss]hort|[Aa]dd)\s+(?:(?:\d[\d,.]*|some|more|a\s+few)\s+(?:more\s+)?(?:of\s+)?)?([A-Z][A-Z0-9]{1,4})\b/;
const NOT_TICKER = new Set(["USB", "TV", "TVS", "SSD", "HDD", "HDMI", "LED", "LCD", "PC", "GPU", "CPU", "RAM", "DVD", "NBN", "GST", "AUD", "USD", "SIM", "PDF", "VPN", "API", "AI", "UK", "US", "EU", "NSW", "VIC", "QLD"]);
/** Document work and his own records (R4 §4: "draft an invoice…", "create invoice INV-0043 in Word", "mark INV-0042 paid"). */
const DOC_WORK = /^\s*(?:please\s+)?(?:draft|create|write|prepare|make|generate|send|email|follow\s+up(?:\s+on)?|chase(?:\s+up)?|mark|log|record|update|edit|open|review|attach|export|print|file|save|rename|duplicate|copy)\b[^:;]*\b(?:invoices?|inv-?\d+|quotes?|quotations?|proposals?|receipts?|estimates?|statements?)\b/i;
/**
 * The owner's own task text, read for away.payment. `approvable`: a bill, invoice, purchase,
 * subscription, renewal, donation, zakat, sadaqah, or a payment to a payee ALREADY SAVED. `never`:
 * trades, crypto, betting, a new payee or bank-to-bank transfer, or typing card details. null: not money.
 * Pure. (Approval itself, binding and the press live in the away runner; nothing here approves. The page
 * is read again there: screen-hands' paymentFence refuses a trade, crypto, betting, transfer or new-payee
 * page whatever these words say.)
 */
export function paymentIntent(text: string): { approvable: PaymentKind } | { never: PaymentNever } | null {
  const variants = textVariants(text);
  const any = (re: RegExp) => variants.some((v) => re.test(v));
  const plain = normaliseText(text);
  // Document work, bookkeeping and git aren't payments (R4 §4 regression: "draft an invoice…" was refused as one).
  const PAYS = /\b(?:pay(?!\s+(?:attention|heed|respects?)\b)|settle|charge)\b/i;
  const pays = any(PAYS);
  const git = stripGitRefs(text);
  if (bookkeeping(text) || (DOC_WORK.test(plain) && !pays) || (git !== null && !PAYS.test(git))) return null;
  // Money only when the shared list says so, or a clear pay/bill/giving word does (not "order the slides",
  // "subscribe to the channel" or "pay attention").
  const money = !!moneyRefusal(text) || any(/\b(?:pay(?!\s+(?:attention|heed|respects?)\b)|bills?|zakat|zakah|sadaqah|sadaqa|donat\w*|renew\w*|purchase|buy|checkout|rego|charity)\b/i);
  if (!money) return null;
  if (variants.some((v) => cardNumberIn(v)) || any(/\b(?:card\s+(?:number|details)|cvv|cvc|security\s+code|expiry|one[- ]time\s+(?:code|password)|otp|bank\s+password|netbank\s+password)\b/i)) return { never: "card-details" };
  if (any(NEVER_BET) || any(LOTTERY_ENTRY) || variants.some((v) => BET.test(v) || TAB_BRAND.test(v)) || institutionKindIn(variants) === "gambling") return { never: "betting" };
  if (any(NEVER_CRYPTO) || institutionKindIn(variants) === "crypto") return { never: "crypto" };
  const ticker = TICKER_BUY.exec(String(text ?? ""))?.[1];
  const tickerWord = /\b(?:nvda|tsla|aapl|msft|amzn|googl?|nflx|pltr|bhp|csl|vas|vgs|vdhg|ivv|ndq|a200|wbc|fmg|mqg|xro|spy|qqq|voo|vti|arkk|gme|mstr|asml)\b/i.test(plain);
  if (any(NEVER_TRADE) || variants.some((v) => SECURITIES_QTY.test(v)) || institutionKindIn(variants) === "broker" || (ticker && !NOT_TICKER.has(ticker)) || tickerWord) return { never: "trade" };
  if (any(NEVER_NEW_PAYEE)) return { never: "new-payee" };
  if (any(NEVER_TRANSFER)) return { never: "bank-transfer" };
  if (any(SAVED_PAYEE)) return { approvable: "saved-payee" };
  if (any(/\b(?:zakat|zakah|zakaat|fitrah|fitra|fitrana|fitranah|khums)\b/i)) return { approvable: "zakat" };
  if (any(/\b(?:sadaqah|sadaqa|sadqa|sadaka|lillah)\b/i)) return { approvable: "sadaqah" };
  if (any(/\b(?:donat\w*|charity|fundraiser|tithes?|give\s+to|sponsor|pledge|masjid\s+box)\b/i)) return { approvable: "donation" };
  if (any(/\binvoices?\b/i)) return { approvable: "invoice" };
  if (any(/\b(?:renew\w*|extend|keep\s+\w+\s+going)\b/i)) return { approvable: "renewal" };
  if (any(/\b(?:subscri\w*|plan|membership|trial|premium|pro|plus)\b/i)) return { approvable: "subscription" };
  if (any(/\b(?:bills?|rego|registration|rates|fines?|charges?|fees?|levy|notice|electricity|gas|water|internet|phone|telstra|optus|vodafone|agl|origin|energyaustralia|council|toll|tolls|linkt|e-?tag|rent|bond)\b/i)) return { approvable: "bill" };
  if (any(/\b(?:buy|purchase|order|reorder|checkout|check\s?out|cart|basket|bag|gift\s?card|top\s?up|recharge|reload|credits?|book|flights?|tickets?|hotel|accommodation|shout|tip|vouchers?|e-?gifts?|prezzee|gift\s?pay|rides?|uber|didi|taxi)\b/i)) return { approvable: "purchase" };
  // (Gift cards and vouchers stay "purchase", as before R5: an open owner decision.)
  // "pay Bianca 1.5k", "send Sam $50": money to a person with no bill or saved payee is a bank transfer.
  return { never: "bank-transfer" };
}
function institutionKindIn(variants: string[]): InstitutionKind | null {
  for (const v of variants) {
    for (const i of INSTITUTIONS) for (const n of i.names ?? []) if (new RegExp(`(?<![\\w-])(?:${n})(?![\\w-])`, "i").test(v)) return i.kind;
    for (const m of v.match(DOMAIN_IN_TEXT) ?? []) {
      const k = moneyHostKind(m);
      if (k) return k;
    }
  }
  return null;
}

// --- registrable domains (REVIEW-SAFETY-R5 §5: paymentHosts are exact registrable domains) --------------
/**
 * Public suffixes that take more than one label (country second levels), plus shared hosting where anyone
 * can get a subdomain (from the public suffix list's private section). Anything else: the last label is
 * the suffix. An entry equal to one of these (com.au, vercel.app, github.io) is never a payment host.
 */
const MULTI_SUFFIX = new Set([
  // country second levels
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au", "csiro.au", "nsw.gov.au", "vic.gov.au", "qld.gov.au", "wa.gov.au", "sa.gov.au", "tas.gov.au", "act.gov.au", "nt.gov.au",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "nhs.uk",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz", "geek.nz", "kiwi.nz",
  "co.za", "org.za", "gov.za", "ac.za", "web.za", "net.za",
  "com.br", "net.br", "org.br", "gov.br", "com.ar", "com.mx", "com.co", "com.pe", "com.uy", "com.ve", "com.ec", "com.bo", "com.py",
  "com.sg", "edu.sg", "gov.sg", "com.my", "gov.my", "co.id", "or.id", "go.id", "ac.id", "web.id", "my.id",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "firm.in", "gen.in", "ind.in",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "org.hk", "gov.hk", "com.tw", "org.tw", "gov.tw", "co.kr", "or.kr", "go.kr",
  "com.tr", "gov.tr", "org.tr", "com.pk", "gov.pk", "org.pk", "com.bd", "gov.bd", "com.lk", "com.np", "com.ph", "gov.ph", "co.th", "go.th", "in.th", "com.vn", "gov.vn",
  "co.ke", "or.ke", "go.ke", "com.ng", "gov.ng", "com.eg", "gov.eg", "com.sa", "gov.sa", "co.il", "org.il", "gov.il", "ac.il", "com.qa", "co.ae", "gov.ae", "com.kw", "com.om", "com.bh", "com.jo", "com.lb",
  "co.at", "or.at", "com.pl", "net.pl", "org.pl", "com.ua", "com.ru", "com.gr", "com.cy", "com.mt", "co.hu", "com.es", "com.pt", "co.it",
  // shared hosting and platform subdomains (anyone can make one)
  "vercel.app", "now.sh", "netlify.app", "netlify.com", "github.io", "githubusercontent.com", "gitlab.io", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
  "herokuapp.com", "herokussl.com", "blogspot.com", "myshopify.com", "wixsite.com", "wix.com", "squarespace.com", "weebly.com", "wordpress.com", "webflow.io", "framer.app", "framer.website",
  "carrd.co", "square.site", "business.site", "azurewebsites.net", "azurestaticapps.net", "cloudapp.net", "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "elasticbeanstalk.com",
  "onrender.com", "fly.dev", "surge.sh", "glitch.me", "repl.co", "replit.app", "replit.dev", "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "loca.lt",
  "deno.dev", "railway.app", "up.railway.app", "koyeb.app", "cyclic.app", "bubbleapps.io", "webnode.page", "site123.me", "jimdosite.com", "godaddysites.com", "mystrikingly.com",
  "notion.site", "gitbook.io", "readthedocs.io", "substack.com", "medium.com", "tumblr.com", "neocities.org", "codeberg.page", "sourceforge.io", "stackblitz.io", "codesandbox.io", "csb.app",
  "digitaloceanspaces.com", "ondigitalocean.app", "translate.goog", "sites.google.com", "withgoogle.com", "ts.net", "duckdns.org", "no-ip.org", "ddns.net", "dyndns.org",
]);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** The host's registrable domain ("checkout.stripe.com" → "stripe.com", "shop.example.com.au" → "example.com.au"), or null for a public suffix, an IP, punycode or junk. Pure. */
export function registrableDomain(host: string | null | undefined): string | null {
  const h = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || ipLike(h) || /(?:^|\.)xn--/.test(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,}$/.test(labels.at(-1)!)) return null;
  // The longest listed suffix the host ends with (else the last label).
  let suffixLen = 1;
  for (let n = labels.length; n >= 2; n--) if (MULTI_SUFFIX.has(labels.slice(-n).join("."))) { suffixLen = Math.max(suffixLen, n); break; }
  if (labels.length <= suffixLen) return null;
  return labels.slice(-(suffixLen + 1)).join(".");
}
/** A paymentHosts entry, accepted only when it IS an exact registrable domain (not com.au, vercel.app, a subdomain, an IP or punycode). The normalised domain, or null. Pure. */
export function exactRegistrableDomain(entry: string | null | undefined): string | null {
  const e = String(entry ?? "").trim().toLowerCase().replace(/^www\./, "");
  const r = registrableDomain(e);
  return r && r === e ? r : null;
}
