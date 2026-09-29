// Fake pages for the J6 task-loop tests (scripts/j2/browser-task.test.ts and the typed-path test): a search engine, a video
// site, a small business site with a contact form, a news site, Gmail (signed in and not) and the pages that make it stop.
import { createFakeWeb, type FakeNode, type FakePage } from "./fake-web";

export const SMILE = "https://smiledental.com.au/";
export const HARBOUR = "https://harbourdentists.com.au/";

const link = (name: string, url: string, extra: Partial<FakeNode> = {}): FakeNode => ({ role: "link", name, url, ...extra });
const titled = (name: string, url: string): FakeNode[] => [link(name, url, { depth: 1 }), { role: "heading", name, level: 3, depth: 2, nested: true }];

/** A Google-like results page: navigation links first, then the real results (each title a heading inside its link). */
export function googleResults(query: string): FakePage {
  return {
    title: `${query} - Google Search`,
    text: `Results for ${query}`,
    nodes: [
      { role: "searchbox", name: "Search", attrs: { type: "search", name: "q" }, search: true },
      link("Images", "https://www.google.com/imghp"),
      link("Maps", "https://www.google.com/maps"),
      link("Sign in", "https://accounts.google.com/ServiceLogin"),
      ...titled("Smile Dental - Best Dentist in Sydney", SMILE),
      ...titled("Harbour Dentists | Family Dental Care", HARBOUR),
      ...titled("Dental Care Guide | Health.gov.au", "https://health.gov.au/dental"),
      link("Next", "https://www.google.com/search?q=next"),
    ],
  };
}

/** A YouTube-like results page: each video's thumbnail and title are two links to the same watch page. */
export function youtubeResults(query: string): FakePage {
  return {
    title: `${query} - YouTube`,
    text: `Results for ${query}`,
    nodes: [
      { role: "searchbox", name: "Search", attrs: { type: "search", name: "search_query" }, search: true },
      link("Sponsored: Buy a mattress", "https://www.youtube.com/watch?v=adad0001"),
      link("12 minutes, 3 seconds", "https://www.youtube.com/watch?v=lofi0001"),
      link("lofi hip hop radio - beats to relax/study to", "https://www.youtube.com/watch?v=lofi0001"),
      link("Chill lofi beats 2 hours", "https://www.youtube.com/watch?v=lofi0002"),
      link("Late night lo-fi mix", "https://www.youtube.com/watch?v=lofi0003"),
    ],
  };
}

export type Site = { pages: Record<string, FakePage>; watch: Map<string, FakePage> };

/** The whole fake web. `paused` is the state the videos start in (autoplay off = paused). */
export function fakeWeb(options: { paused?: boolean; gmailSignedIn?: boolean; overrides?: Record<string, FakePage> } = {}) {
  const cache = new Map<string, FakePage>();
  const paused = options.paused ?? true;
  const once = (url: string, make: () => FakePage) => {
    if (!cache.has(url)) cache.set(url, make());
    return cache.get(url)!;
  };
  const site = (host: string, name: string, phone = "02 9999 1234"): Record<string, FakePage> => ({
    [`https://${host}/`]: {
      title: name,
      text: `${name}. Family dentistry in the heart of Sydney. Book a check-up.`,
      footer: `${name}. 12 Example St, Sydney NSW 2000. ABN 12 345 678 901. Privacy. Terms.`,
      nodes: [
        link("Home", `https://${host}/`),
        link("About", `https://${host}/about`),
        link("Pricing", `https://${host}/pricing`),
        link("Contact", `https://${host}/contact`),
        link("Blog", `https://${host}/blog`),
        { role: "heading", name: name, level: 1 },
      ],
    },
    [`https://${host}/about`]: { title: `About | ${name}`, text: "About us.", nodes: [link("Home", `https://${host}/`)] },
    [`https://${host}/pricing`]: { title: `Pricing | ${name}`, text: "Check-up from $99. Clean and scale from $180.", nodes: [link("Home", `https://${host}/`)] },
    [`https://${host}/contact`]: {
      title: `Contact | ${name}`,
      text: `Contact ${name}. Call us on ${phone}. Email hello@${host}. 12 Example St, Sydney NSW 2000.`,
      nodes: [
        link("Home", `https://${host}/`),
        link(phone, `tel:${phone.replace(/\s/g, "")}`),
        { role: "textbox", name: "Name", form: "contact", attrs: { name: "name", type: "text" } },
        { role: "textbox", name: "Email", form: "contact", attrs: { name: "email", type: "email", autocomplete: "email" } },
        { role: "textbox", name: "Message", form: "contact", attrs: { name: "message" } },
        { role: "button", name: "Send message" },
      ],
    },
  });
  const contactNoTel = (host: string, name: string): FakePage => ({
    title: `Contact | ${name}`,
    text: `Contact ${name}. Phone: (02) 9555 0100. Email hello@${host}.`,
    nodes: [link("Home", `https://${host}/`)],
  });
  const base: Record<string, FakePage> = {
    ...site("smiledental.com.au", "Smile Dental"),
    ...site("harbourdentists.com.au", "Harbour Dentists", "02 9555 0100"),
    "https://www.abc.net.au/news": {
      title: "ABC News",
      text: "Top stories",
      nodes: [
        link("Skip to main content", "#main"),
        { role: "heading", name: "Top Stories", level: 2 },
        ...titled("Reserve Bank holds interest rates steady as inflation eases", "https://www.abc.net.au/news/2026-09-29/rba-holds-rates/1"),
        ...titled("Storm warning for Sydney's west", "https://www.abc.net.au/news/2026-09-29/storm/2"),
      ],
      footer: "ABC News. Privacy policy. Terms of use.",
    },
    "https://www.abc.net.au/news/2026-09-29/rba-holds-rates/1": { title: "RBA holds rates", text: "The Reserve Bank...", nodes: [] },
    "https://health.gov.au/dental": { title: "Dental care guide", text: "Guide.", nodes: [] },
    "https://accounts.google.com/ServiceLogin": { title: "Sign in - Google Accounts", text: "Sign in Email or phone Next", password: true, nodes: [{ role: "textbox", name: "Email or phone" }] },
    "https://www.google.com/sorry/index": { title: "https://www.google.com/sorry/index", text: "Our systems have detected unusual traffic from your computer network. I'm not a robot", nodes: [] },
    "https://consent.youtube.com/m?continue=x": { title: "Before you continue to YouTube", text: "We use cookies. Accept all. Reject all.", nodes: [{ role: "button", name: "Accept all" }, { role: "button", name: "Reject all" }] },
    "https://news.paywalled.com.au/": { title: "The Paywalled Times", text: "Subscribe to continue reading. Already a subscriber? Sign in.", nodes: [link("Subscribe", "https://news.paywalled.com.au/subscribe")] },
    "https://shop.example.com.au/details": { title: "Checkout", text: "Card number Expiry CVV Pay now", card: true, nodes: [{ role: "textbox", name: "Card number", attrs: { autocomplete: "cc-number" } }] },
    "https://elsewhere.example.net/": { title: "Parked domain", text: "This domain is for sale.", nodes: [] },
    "https://mail.google.com/": options.gmailSignedIn === false
      ? { title: "Gmail: Email from Google", text: "Sign in to Gmail", nodes: [link("Sign in", "https://accounts.google.com/ServiceLogin")] }
      : { title: "Inbox (3) - me@example.com - Gmail", text: "Inbox", nodes: [{ role: "searchbox", name: "Search mail", attrs: { type: "search", name: "q" }, search: true, onEnter: (v) => `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(v)}` }, link("Inbox", "https://mail.google.com/mail/u/0/#inbox")] },
    "https://workspace.google.com/products/gmail/": { title: "Gmail: Private and secure email", text: "Sign in. Create an account.", nodes: [link("Sign in", "https://accounts.google.com/ServiceLogin")] },
    "https://noform.example.com.au/": { title: "No form here", text: "Just words.", nodes: [link("Home", "https://noform.example.com.au/")] },
    "https://phoneless.example.com.au/": { title: "Phoneless", text: "Home", nodes: [link("Contact", "https://phoneless.example.com.au/contact")] },
    "https://phoneless.example.com.au/contact": contactNoTel("phoneless.example.com.au", "Phoneless"),
    ...options.overrides,
  };
  return createFakeWeb((url) => {
    if (base[url]) return base[url];
    if (base[url.replace(/\/$/, "")]) return base[url.replace(/\/$/, "")];
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.hostname === "www.google.com" && u.pathname === "/search") return once(url, () => googleResults(u.searchParams.get("q") ?? ""));
    if (u.hostname === "www.youtube.com" && u.pathname === "/results") return once(url, () => youtubeResults(u.searchParams.get("search_query") ?? ""));
    if (u.hostname === "www.youtube.com" && u.pathname === "/watch") {
      return once(url, () => {
        const page: FakePage = {
          title: `${u.searchParams.get("v") === "lofi0001" ? "lofi hip hop radio - beats to relax/study to" : `Video ${u.searchParams.get("v")}`} - YouTube`,
          text: "Watch",
          video: { paused },
          nodes: [
            {
              role: "button",
              name: "Play (k)",
              onClick: () => {
                page.video!.paused = false;
              },
            },
            link("Subscribe", "https://www.youtube.com/subscribe"),
          ],
        };
        return page;
      });
    }
    if (u.hostname === "www.google.com" && u.pathname === "/") return once(url, () => ({ title: "Google", text: "Google", nodes: [] }));
    return null;
  });
}
