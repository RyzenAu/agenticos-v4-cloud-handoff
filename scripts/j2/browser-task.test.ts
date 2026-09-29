// J6: `browser.task`, the multi-step browser loop. Every goal shape, the drift stops, the gates and the audit utterances, with a
// fake web (the CDP stub over fake pages) in place of Chrome: no model, no network, no real window or browser.
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentBrowserHands, parseSnapshot } from "./agent-browser";
import { forgetSearch, pageProblem, pickResults, runBrowserTask, TASK_STEP_CAP, validateAction, wrongSite, type TaskDeps } from "./browser-task";
import { fakeWeb, SMILE } from "./task-fixtures";
import { parseTaskGoal, resolveSite } from "./task-intents";
import { forgetReferent, rememberReferent } from "../jarvis-skills/referent";
import { typedBrowserRequest, typedBrowserTarget } from "./typed";
import { runBrowserSkill } from "./browser-skill";

afterEach(() => {
  forgetSearch();
  forgetReferent();
});

/** The loop on a fake web. `open` is the skill's opener: a new tab, its window "brought forward" on the main screen. */
function rig(web = fakeWeb(), extra: Partial<TaskDeps> = {}) {
  const hands = createAgentBrowserHands({ run: web.run, port: 9222 });
  const deps: TaskDeps = {
    hands,
    open: async (url, label) => {
      const r = await hands.open(url, "new-tab");
      if (!r.ok) return { ok: false, said: r.said };
      if (r.targetId) await hands.activate(r.targetId);
      return { ok: true, said: "Opened.", where: "your main screen", ...(r.targetId ? { targetId: r.targetId } : {}), ...(label ? {} : {}) };
    },
    present: async () => "Chrome is up on your main screen, sir.",
    sleep: async () => undefined,
    details: () => [
      { key: "full_name", about: "", value: "Mohammad Usman Ahmad Khan" },
      { key: "first_name", about: "", value: "Usman" },
      { key: "email", about: "", value: "usman@example.com" },
    ],
    ...extra,
  };
  const run = (goal: string) => runBrowserTask({ goal }, deps);
  return { web, hands, deps, run };
}
const nothingSubmitted = (web: ReturnType<typeof fakeWeb>) => {
  expect(web.submitted).toEqual([]);
  expect(web.clicked.filter((c) => /^(?:send|submit|pay|confirm|buy|post)/i.test(c))).toEqual([]);
};

describe("search and open a result", () => {
  test("search Google for X and open the first result: two steps, says what and where", async () => {
    const r = rig();
    const out = await r.run("search Google for dentists and open the first result");
    expect(out).toMatchObject({ ok: true, steps: 2 });
    expect(out.said).toBe('Searched Google for "dentists" and opened the first result: Smile Dental on your main screen.');
    expect(r.web.active().url).toBe(SMILE);
    expect(out.trace).toEqual(["open google.com", "click e5", "finish"]);
    nothingSubmitted(r.web);
  });
  test("the navigation links and ads are not results: the first REAL result is opened (its title is the heading)", async () => {
    const r = rig();
    await r.run("google best dentist in sydney and click the second link");
    expect(r.web.active().url).toBe("https://harbourdentists.com.au/");
  });
  test("search YouTube for X and play the first video: opens the video (not the ad), clicks Play once when paused", async () => {
    const r = rig(fakeWeb({ paused: true }));
    const out = await r.run("search YouTube for lo-fi beats and play the first video");
    expect(out.ok).toBe(true);
    expect(out.said).toBe('Searched YouTube for "lo-fi beats" and opened the first video: lofi hip hop radio - beats to relax/study to, playing, on your main screen.');
    expect(r.web.active().url).toBe("https://www.youtube.com/watch?v=lofi0001");
    expect(r.web.clicked.filter((c) => /^Play/.test(c))).toEqual(["Play (k)"]);
    expect(r.web.clicked).not.toContain("Subscribe");
  });
  test("a video that autoplays is not clicked at all", async () => {
    const r = rig(fakeWeb({ paused: false }));
    const out = await r.run("search YouTube for lo-fi beats and play the first video");
    expect(out.said).toContain("playing");
    expect(r.web.clicked.filter((c) => /^Play/.test(c))).toEqual([]);
  });
  test("a video that stays paused is said so plainly", async () => {
    const web = fakeWeb({ paused: true });
    const r = rig(web);
    // Play does nothing on this page.
    const w2 = fakeWeb({ paused: true, overrides: { "https://www.youtube.com/watch?v=lofi0001": { title: "Stuck video - YouTube", text: "x", video: { paused: true }, nodes: [{ role: "button", name: "Play (k)" }] } } });
    const out = await rig(w2).run("search YouTube for lo-fi beats and play the first video");
    expect(out.ok).toBe(true);
    expect(out.said).toContain("still paused");
    void r;
  });
  test('"open the first result" / "click the second result" act on the page in front (a search results page)', async () => {
    const r = rig();
    await r.hands.open("https://www.google.com/search?q=dentists", "new-tab");
    const one = await r.run("open the first result");
    expect(one.ok).toBe(true);
    expect(one.said).toBe("Opened the first result: Smile Dental on your main screen.");
    expect(r.web.active().url).toBe(SMILE);
    const r2 = rig();
    await r2.hands.open("https://www.google.com/search?q=dentists", "new-tab");
    const two = await r2.run("click the second result");
    expect(two.said).toBe("Opened the second result: Harbour Dentists on your main screen.");
  });
  test('"go back and open the next one" opens the result after the one it was on', async () => {
    const r = rig();
    await r.run("search Google for dentists and open the first result");
    expect(r.web.active().url).toBe(SMILE);
    const next = await r.run("go back and open the next one");
    expect(next.ok).toBe(true);
    expect(r.web.active().url).toBe("https://harbourdentists.com.au/");
    expect(next.said).toBe("Opened the second result: Harbour Dentists on your main screen.");
    const again = await r.run("go back and open the next one");
    expect(again.said).toContain("Opened the third result");
  });
  test('"open the next one" with no search to follow says so in one line', async () => {
    const r = rig();
    await r.hands.open("https://www.google.com/search?q=dentists", "new-tab");
    const out = await r.run("open the next one");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: I don't know which result you were on/);
  });
  test("a result that isn't there (only three) is a plain couldn't", async () => {
    const r = rig();
    await r.hands.open("https://www.google.com/search?q=dentists", "new-tab");
    const out = await r.run("open the 7th result");
    expect(out.said).toMatch(/^Couldn't finish: there's no seventh result on this page\. I got as far as /);
  });
  test("open the top result on YouTube from its results page plays it", async () => {
    const r = rig(fakeWeb({ paused: true }));
    await r.hands.open("https://www.youtube.com/results?search_query=lo-fi%20beats", "new-tab");
    const out = await r.run("open the top video");
    expect(out.said).toContain("Opened the first video: lofi hip hop radio");
    expect(out.said).toContain("playing");
  });
});

describe("a named site: click a link, find a page, read something", () => {
  test("go to <site> and click <link text>", async () => {
    const r = rig();
    const out = await r.run("go to smiledental.com.au and click Pricing");
    expect(out).toMatchObject({ ok: true, steps: 2 });
    expect(out.said).toBe('Went to smiledental.com.au and clicked "Pricing": Pricing | Smile Dental on your main screen.');
    expect(r.web.active().url).toBe("https://smiledental.com.au/pricing");
  });
  test("a click that does not reach the requested page cannot be reported as done", async () => {
    const web = fakeWeb({ overrides: { [SMILE]: { title: "Smile Dental", text: "Home", nodes: [{ role: "link", name: "Pricing", url: "https://smiledental.com.au/about" }] } } });
    const out = await rig(web).run("go to smiledental.com.au and click Pricing");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("couldn't verify");
  });
  test("a matching URL path that serves a 404 is not a completed page", async () => {
    const web = fakeWeb({ overrides: {
      [SMILE]: { title: "Smile Dental", text: "Home", nodes: [{ role: "link", name: "Pricing", url: "https://smiledental.com.au/pricing" }] },
      "https://smiledental.com.au/pricing": { title: "Page not found", text: "404 - Pricing is unavailable", nodes: [] },
    } });
    const out = await rig(web).run("go to smiledental.com.au and click Pricing");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("couldn't verify");
  });
  test("go to our website and click Contact (our own site is muventures.com.au)", async () => {
    const web = fakeWeb({ overrides: { "https://muventures.com.au/": { title: "M&U Ventures", text: "Websites", nodes: [{ role: "link", name: "Contact", url: "https://muventures.com.au/contact" }] }, "https://muventures.com.au/contact": { title: "Contact | M&U Ventures", text: "Contact", nodes: [] } } });
    const r = rig(web);
    const out = await r.run("go to our website and click Contact");
    expect(out.ok).toBe(true);
    expect(web.active().url).toBe("https://muventures.com.au/contact");
  });
  test("a link that isn't on the page is a plain couldn't with where it got to", async () => {
    const r = rig();
    const out = await r.run("go to smiledental.com.au and click Careers");
    expect(out.ok).toBe(false);
    expect(out.said).toBe('Couldn\'t finish: I can\'t see a "Careers" link on smiledental.com.au. I got as far as "Smile Dental" on smiledental.com.au.');
  });
  test("find the pricing page on <site>", async () => {
    const r = rig();
    const out = await r.run("find the pricing page on smiledental.com.au");
    expect(out.said).toBe("Found the Pricing page on smiledental.com.au: Pricing | Smile Dental on your main screen.");
    expect(r.web.active().url).toBe("https://smiledental.com.au/pricing");
  });
  test("findPage checks the landing page instead of trusting the Pricing link", async () => {
    const web = fakeWeb({ overrides: { [SMILE]: { title: "Smile Dental", text: "Home", nodes: [{ role: "link", name: "Pricing", url: "https://smiledental.com.au/about" }] } } });
    const out = await rig(web).run("find the pricing page on smiledental.com.au");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("couldn't verify");
  });
  test("read me the headline of the top story on the ABC", async () => {
    const r = rig();
    const out = await r.run("read me the headline of the top story on the ABC");
    expect(out.ok).toBe(true);
    expect(out.said).toBe('The top story on ABC News is "Reserve Bank holds interest rates steady as inflation eases".');
    expect(r.web.clicked).toEqual([]);
  });
  test("scroll to the bottom and read the footer (the page in front)", async () => {
    const r = rig();
    await r.hands.open("https://smiledental.com.au/", "new-tab");
    const out = await r.run("scroll to the bottom and read the footer");
    expect(out.ok).toBe(true);
    expect(out.said).toMatch(/^The footer says: Smile Dental\. 12 Example St, Sydney NSW 2000\./);
    expect(r.web.log).toContain("eval -b " + r.web.log.find((l) => l.startsWith("eval -b "))!.slice(8));
  });
  test("open the Contact page and read the phone number", async () => {
    const r = rig();
    const out = await r.run("open the contact page on smiledental.com.au and read me the phone number");
    expect(out.said).toBe("The phone number on the Contact page is 02 9999 1234.");
    expect(r.web.active().url).toBe("https://smiledental.com.au/contact");
  });
  test("the number in the words (no tel: link) is found on the page text", async () => {
    const r = rig();
    const out = await r.run("open the contact page on phoneless.example.com.au and read me the phone number");
    expect(out.said).toBe("The phone number on the Contact page is (02) 9555 0100.");
  });
  test("no number on the page is a plain couldn't", async () => {
    const r = rig(fakeWeb({ overrides: { "https://phoneless.example.com.au/contact": { title: "Contact", text: "Come and see us.", nodes: [] } } }));
    const out = await r.run("open the contact page on phoneless.example.com.au and read me the phone number");
    expect(out.said).toMatch(/^Couldn't finish: I couldn't find a phone number on the Contact page\./);
  });
});

describe("fill the contact form and stop before Send", () => {
  test("fills Name and Email from his saved details and says it's ready for him to press Send", async () => {
    const r = rig();
    const out = await r.run("fill the contact form on smiledental.com.au with my name and email but don't send it");
    expect(out.ok).toBe(true);
    expect(out.said).toBe("Filled Name and Email on smiledental.com.au on your main screen. I left Message blank: it isn't saved. Ready for you to press Send message.".replace(" I left Message blank: it isn't saved.", ""));
    expect(r.web.typed).toEqual([{ field: "Name", text: "Mohammad Usman Ahmad Khan" }, { field: "Email", text: "usman@example.com" }]);
    // NOTHING was pressed that submits: no Send, no Enter in the form.
    nothingSubmitted(r.web);
    expect(r.web.clicked).toEqual(["Contact"]);
    expect(r.web.log.filter((l) => l.startsWith("press"))).toEqual([]);
  });
  test('"with my details" fills every field it has a saved detail for, and names what it left blank', async () => {
    const r = rig(fakeWeb(), { details: () => [{ key: "full_name", about: "", value: "Mohammad Khan" }, { key: "email", about: "", value: "m@example.com" }, { key: "phone", about: "", value: "0400 000 000" }] });
    const out = await r.run("fill the contact form on smiledental.com.au with my details");
    expect(out.ok).toBe(true);
    expect(out.said).toMatch(/^Filled Name and Email on smiledental\.com\.au/);
    expect(out.said).toMatch(/Ready for you to press Send message\.$/);
    nothingSubmitted(r.web);
  });
  test("a detail that isn't saved is left blank and named (never guessed)", async () => {
    const r = rig(fakeWeb(), { details: () => [{ key: "email", about: "", value: "m@example.com" }] });
    const out = await r.run("fill the contact form on smiledental.com.au with my name and email");
    expect(out.said).toContain("Filled Email");
    expect(out.said).toContain("I left Name blank: it isn't saved.");
    expect(out.said).toMatch(/Ready for you to press Send message\.$/);
    expect(r.web.typed).toEqual([{ field: "Email", text: "m@example.com" }]);
  });
  test("nothing saved at all: it changes nothing and says why", async () => {
    const r = rig(fakeWeb(), { details: () => [] });
    const out = await r.run("fill the contact form on smiledental.com.au with my name and email");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: I don't have your name or email saved, so I left the form as it was\./);
    expect(r.web.typed).toEqual([]);
  });
  test("a password, card or code box in the form is never typed into (and the rest carries on)", async () => {
    const form: any = {
      title: "Sign up",
      text: "Sign up",
      nodes: [
        { role: "textbox", name: "Name", form: "f" },
        { role: "textbox", name: "Email", form: "f" },
        { role: "textbox", name: "Email", form: "f", attrs: { type: "password", name: "email_password" } },
        { role: "button", name: "Create account" },
      ],
    };
    const r = rig(fakeWeb({ overrides: { "https://smiledental.com.au/contact": form } }));
    const out = await r.run("fill the contact form on smiledental.com.au with my name and email");
    expect(out.ok).toBe(true);
    expect(r.web.typed.map((t) => t.field)).toEqual(["Name", "Email"]);
    nothingSubmitted(r.web);
  });
  test("no form on the page: it says so and touches nothing", async () => {
    const r = rig();
    const out = await r.run("fill the contact form on noform.example.com.au with my name and email");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: I can't see a form on this page\./);
    expect(r.web.typed).toEqual([]);
  });
});

describe("Gmail: the search box only", () => {
  test("open my Gmail and search for X (signed in)", async () => {
    const r = rig();
    const out = await r.run("open my Gmail and search for invoices");
    expect(out).toMatchObject({ ok: true });
    expect(out.said).toBe('Searched Gmail for "invoices" on your main screen.');
    expect(r.web.typed).toEqual([{ field: "Search mail", text: "invoices" }]);
    expect(r.web.active().url).toContain("#search/invoices");
    nothingSubmitted(r.web);
  });
  test("not signed in: 'your turn' in one line, nothing typed", async () => {
    // (Gmail's address lands on Google's marketing page: nobody is signed in on Jarvis Chrome.)
    const web = fakeWeb();
    const r = rig(web);
    r.deps.open = async () => {
      const o = await r.hands.open("https://workspace.google.com/products/gmail/", "new-tab");
      return { ok: o.ok, said: "Opened.", where: "your main screen" };
    };
    const out = await r.run("open my Gmail and search for invoices");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: Gmail isn't signed in on Jarvis Chrome \(it landed on workspace\.google\.com\), so it's your turn\. I got as far as /);
    expect(web.typed).toEqual([]);
  });
  test("Google's sign-in page itself is a 'your turn' stop", async () => {
    const web = fakeWeb({ overrides: { "https://mail.google.com/": { title: "Sign in - Google Accounts", text: "Sign in", password: true, nodes: [] } } });
    const r = rig(web);
    await r.hands.open("https://accounts.google.com/ServiceLogin", "new-tab");
    const out = await r.run("open my Gmail and search for invoices");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("your turn");
    expect(web.typed).toEqual([]);
  });
});

describe("drift: stop and say 'your turn' in one line", () => {
  /** The page the goal opens lands somewhere else (a redirect, a bot check, a sign-in wall…). */
  const stop = async (landing: string, goal = "search Google for dentists and open the first result") => {
    const r = rig();
    r.deps.open = async () => {
      const o = await r.hands.open(landing, "new-tab");
      return { ok: o.ok, said: "Opened.", where: "your main screen" };
    };
    return r.run(goal);
  };
  test("a captcha (never solved)", async () => {
    const out = await stop("https://www.google.com/sorry/index");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: google\.com is showing a captcha, so it's your turn\. I got as far as /);
  });
  test("a sign-in page", async () => {
    const out = await stop("https://accounts.google.com/ServiceLogin");
    expect(out.said).toMatch(/^Couldn't finish: accounts\.google\.com wants you to sign in, so it's your turn\./);
  });
  test("cookie consent (never accepted)", async () => {
    const out = await stop("https://consent.youtube.com/m?continue=x", "search YouTube for lo-fi beats and play the first video");
    expect(out.said).toMatch(/^Couldn't finish: consent\.youtube\.com asks you to accept cookies, so it's your turn\./);
  });
  test("a paywall", async () => {
    const out = await stop("https://news.paywalled.com.au/");
    expect(out.said).toMatch(/is behind a paywall, so it's your turn\./);
  });
  test("a payment page (card fields)", async () => {
    const out = await stop("https://shop.example.com.au/details");
    expect(out.said).toMatch(/is a payment page, so it's your turn\./);
  });
  test("a different site than the one named", async () => {
    const out = await stop("https://elsewhere.example.net/", "go to smiledental.com.au and click Pricing");
    expect(out.ok).toBe(false);
    expect(out.said).toBe("Couldn't finish: I landed on elsewhere.example.net instead of smiledental.com.au. I got as far as \"Parked domain\" on elsewhere.example.net.");
  });
  test("a named site's link that lands on another site stops before claiming completion", async () => {
    const web = fakeWeb({ overrides: {
      [SMILE]: { title: "Smile Dental", text: "Home", nodes: [{ role: "link", name: "Pricing", url: "https://elsewhere.example.net/" }] },
    } });
    const out = await rig(web).run("go to smiledental.com.au and click Pricing");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("I landed on elsewhere.example.net instead of smiledental.com.au");
    expect(web.clicked).toEqual(["Pricing"]);
  });
  test("username-first sign-in stops before the page is acted on", async () => {
    const login = "https://smiledental.com.au/login";
    const r = rig(fakeWeb({ overrides: { [login]: { title: "Sign in to Smile Dental", text: "Email address Continue", nodes: [{ role: "textbox", name: "Email address" }] } } }));
    await r.hands.open(login, "new-tab");
    const out = await r.run("open the first result");
    expect(out.ok).toBe(false);
    expect(out.said).toContain("wants you to sign in");
    expect(r.web.clicked).toEqual([]);
    expect(r.web.typed).toEqual([]);
  });
  test("pageProblem and wrongSite, on their own", () => {
    const v = (o: Partial<Parameters<typeof pageProblem>[0] & object>) => ({ url: "https://x.test/", title: "X", ready: true, text: "", password: false, card: false, video: null, ...o });
    expect(pageProblem(v({}))).toBeNull();
    expect(pageProblem(v({ title: "Log in", password: true }))?.kind).toBe("login");
    expect(pageProblem(v({ title: "Welcome", url: "https://x.test/login", password: false }))?.kind).toBe("login");
    expect(pageProblem(v({ title: "Sign in to your account", url: "https://x.test/", password: false }))?.kind).toBe("login");
    expect(pageProblem(v({ text: "Please verify you are a human" }))?.kind).toBe("captcha");
    // A pricing page (with prices) is a page to read, not a payment.
    expect(pageProblem(v({ url: "https://x.test/pricing", title: "Pricing", text: "Plans from $29/month. Start free." }))).toBeNull();
    expect(wrongSite("smiledental.com.au", "https://www.smiledental.com.au/x")).toBe(false);
    expect(wrongSite("smiledental.com.au", "https://elsewhere.example.net/")).toBe(true);
    expect(wrongSite("smiledental.com.au", "https://smiledental.evil/pricing")).toBe(true);
    expect(wrongSite("smiledental.com.au", "https://shop.smiledental.com.au/pricing")).toBe(false);
    expect(wrongSite("google.com", "https://www.google.com.au/search?q=x")).toBe(true);
  });
});

describe("typed browser entry", () => {
  test("typed YouTube search and compound search use the browser skill, including its task loop", async () => {
    expect(await typedBrowserRequest("youtube lo-fi beats")).toMatchObject({ skill: "browser", action: "search", engine: "youtube", query: "lo-fi beats" });
    expect(await typedBrowserRequest("search YouTube for lo-fi beats and play the first video")).toMatchObject({ skill: "browser", action: "task", goal: "search YouTube for lo-fi beats and play the first video" });
  });
  test("page actions follow the frontmost Jarvis Chrome check used by voice", async () => {
    expect(await typedBrowserRequest("open the first result", async () => false)).toBeNull();
    expect(await typedBrowserTarget("open the first result", async () => false)).toEqual({ kind: "screen", goal: "open the first result" });
    rememberReferent({ app: "chrome", jarvisChrome: true, title: "Search results", targetId: "synthetic-tab" });
    expect(await typedBrowserRequest("open the first result", async () => false)).toBeNull();
    forgetReferent();
    expect(await typedBrowserRequest("open the first result", async () => true)).toMatchObject({ action: "task_here" });
    expect(await typedBrowserTarget("open the first result", async () => true)).toMatchObject({ kind: "browser", request: { action: "task_here" } });
  });
  test("task_here uses Chrome's active tab instead of a stale remembered target", async () => {
    const r = rig();
    const stale = await r.hands.open(SMILE, "new-tab");
    rememberReferent({ app: "chrome", jarvisChrome: true, title: "Smile Dental", targetId: stale.targetId });
    await r.hands.open("https://www.google.com/search?q=dentists", "new-tab");
    const said = await runBrowserSkill({ skill: "browser", action: "task_here", goal: "open the first result" }, { hands: r.hands, present: r.deps.present! });
    expect(said).toContain("Opened the first result: Smile Dental");
    expect(r.web.clicked).toContain("Smile Dental - Best Dentist in Sydney");
  });
});

describe("the gates hold inside the loop", () => {
  test("the brain choosing to click Send is refused by the S2c gate: nothing pressed, one plain couldn't", async () => {
    const r = rig(fakeWeb(), {
      decide: async (input) => {
        const send = input.nodes.find((n) => /send/i.test(n.name));
        return send ? { do: "click", ref: send.ref } : { do: "open_url", url: "https://smiledental.com.au/contact" };
      },
    });
    const out = await runBrowserTask({ goal: "get me in touch on smiledental.com.au", shape: { kind: "free" } }, r.deps);
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: That's the final "send message" button, and I only press those after your spoken yes/i);
    nothingSubmitted(r.web);
  });
  test("the brain typing into a password box is refused; typing a card number anywhere is refused", async () => {
    const web = fakeWeb({ overrides: { "https://smiledental.com.au/contact": { title: "Login", text: "x", nodes: [{ role: "textbox", name: "Password", attrs: { type: "password" } }, { role: "textbox", name: "Name" }] } } });
    const r = rig(web);
    await r.hands.open("https://smiledental.com.au/contact", "new-tab");
    const tree = await r.hands.tree();
    expect((await r.hands.typeInto(tree[0].ref, "hunter2")).ok).toBe(false);
    expect((await r.hands.typeInto(tree[1].ref, "4111 1111 1111 1111")).said).toMatch(/card number/);
    expect(web.typed).toEqual([]);
  });
  test("Enter is pressed in a lone search box, never in a form with other fields", async () => {
    const web = fakeWeb();
    const r = rig(web);
    await r.hands.open("https://smiledental.com.au/contact", "new-tab");
    const tree = await r.hands.tree();
    const name = tree.find((n) => n.name === "Name")!;
    expect((await r.hands.typeInto(name.ref, "Usman")).ok).toBe(true);
    const press = await r.hands.pressEnterInSearch();
    expect(press.ok).toBe(false);
    expect(web.submitted).toEqual([]);
    expect(web.log.filter((l) => l.startsWith("press"))).toEqual([]);
  });
  test("a money page refuses typing and Enter (S2e verdict), through the same hands", async () => {
    const web = fakeWeb({ overrides: { "https://portal.example.com.au/": { title: "Online Banking - Transfer", text: "Transfer money. Amount due $500. Total $500", nodes: [{ role: "searchbox", name: "Search", search: true }] } } });
    const r = rig(web);
    await r.hands.open("https://portal.example.com.au/", "new-tab");
    const tree = await r.hands.tree();
    const t = await r.hands.typeInto(tree[0].ref, "hello");
    expect(t.ok).toBe(false);
    expect(t.said).toMatch(/^Not done:/);
  });
  test("the loop never sends a final press even when the shape is a form fill and the button is the only control", async () => {
    const r = rig();
    await r.run("fill the contact form on smiledental.com.au with my details");
    expect(r.web.submitted).toEqual([]);
    expect(r.web.clicked).not.toContain("Send message");
  });
  test("a bank opens nothing: the S2e navigate verdict still refuses inside a search-and-open", async () => {
    const r = rig();
    const out = await r.run("go to commbank.com.au and click Login");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/Couldn't finish: Not done:/);
    expect(r.web.count).toBe(1);
  });
});

describe("the brain's steps (a goal the rules don't know)", () => {
  test("a model URL stays on the site named in this request", async () => {
    const r = rig(fakeWeb(), { decide: async () => ({ do: "open_url", url: "https://smiledental.evil/pricing" }) });
    const out = await runBrowserTask({ goal: "show me pricing on smiledental.com.au", shape: { kind: "free" } }, r.deps);
    expect(out.ok).toBe(false);
    expect(out.said).toContain("outside smiledental.com.au");
    expect(r.web.count).toBe(1);
  });
  test("a model URL cannot leave the current site without a new user request", async () => {
    const r = rig(fakeWeb(), { decide: async () => ({ do: "open_url", url: "https://elsewhere.example.net/" }) });
    await r.hands.open(SMILE, "new-tab");
    const out = await runBrowserTask({ goal: "show me pricing", shape: { kind: "free" } }, r.deps);
    expect(out.ok).toBe(false);
    expect(out.said).toContain("outside smiledental.com.au");
    expect(r.web.active().url).toBe(SMILE);
  });
  test("a model cannot choose a new site from a blank tab when none was named", async () => {
    const r = rig(fakeWeb(), { decide: async () => ({ do: "open_url", url: SMILE }) });
    const out = await runBrowserTask({ goal: "show me the prices", shape: { kind: "free" } }, r.deps);
    expect(out.ok).toBe(false);
    expect(out.said).toContain("need a website named");
    expect(r.web.count).toBe(1);
  });
  test("a short script of valid actions runs to a finish", async () => {
    const script = [
      { do: "open_url", url: "https://smiledental.com.au/" },
      { do: "click", ref: "e3" },
      { do: "finish", said: "Opened the Pricing page." },
    ];
    let i = 0;
    const r = rig(fakeWeb(), { decide: async () => script[i++] });
    const out = await r.run("show me what smiledental.com.au charges");
    expect(out).toMatchObject({ ok: true, steps: 2, said: "Opened the Pricing page." });
    expect(r.web.active().url).toBe("https://smiledental.com.au/pricing");
  });
  test("the cap is 8 steps: an agent that never finishes is stopped with where it got to", async () => {
    let flip = 0;
    const r = rig(fakeWeb(), { decide: async () => ({ do: "scroll", dir: flip++ % 2 ? "up" : "down" }) });
    await r.hands.open("https://smiledental.com.au/", "new-tab");
    const out = await r.run("keep scrolling forever");
    expect(TASK_STEP_CAP).toBe(8);
    expect(out.ok).toBe(false);
    expect(out.steps).toBe(8);
    expect(out.said).toMatch(/^Couldn't finish: that took more than 8 steps\. I got as far as /);
  });
  test("an action that isn't in the schema, a ref that isn't on the page, or nothing at all, is a plain couldn't", async () => {
    for (const bad of [{ do: "eval", js: "document.cookie" }, { do: "click", ref: "e999" }, { do: "type", ref: "e1", text: "" }, null, "click e1"]) {
      const r = rig(fakeWeb(), { decide: async () => bad });
      await r.hands.open("https://smiledental.com.au/", "new-tab");
      const out = await r.run("do something odd");
      expect(out.ok).toBe(false);
      expect(out.said).toMatch(/^Couldn't finish: I couldn't work out the next step\./);
    }
  });
  test("with no brain and no rule it says so instead of guessing", async () => {
    const r = rig();
    const out = await r.run("do a backflip");
    expect(out.ok).toBe(false);
    expect(out.said).toMatch(/^Couldn't finish: I don't know how to do that one on my own yet/);
  });
  test("validateAction accepts only the schema", () => {
    const tree = parseSnapshot('- link "Home" [ref=e1, url=https://a.test/]\n- textbox "Name" [ref=e2]');
    expect(validateAction({ do: "click", ref: "e1" }, { tree })).toEqual({ do: "click", ref: "e1" });
    expect(validateAction({ do: "type", ref: "e2", text: "Usman" }, { tree })).toEqual({ do: "type", ref: "e2", text: "Usman" });
    expect(validateAction({ do: "open_url", url: "javascript:alert(1)" }, { tree })).toBeNull();
    expect(validateAction({ do: "open_url", url: "file:///C:/secrets.txt" }, { tree })).toBeNull();
    expect(validateAction({ do: "press", key: "Delete" }, { tree })).toBeNull();
    expect(validateAction({ do: "finish", said: "Done. Password is hunter2 and card 4111 1111 1111 1111" }, { tree })).toMatchObject({ do: "finish" });
    expect(JSON.stringify(validateAction({ do: "finish", said: "card 4111 1111 1111 1111" }, { tree }))).not.toContain("4111 1111");
  });
});

describe("speed and progress", () => {
  test("a slow step says 'Still working.' once, and only once", async () => {
    const slow = rig(fakeWeb(), {});
    const said: string[] = [];
    const inner = slow.deps.open;
    slow.deps.open = async (u, l) => {
      await new Promise((r) => setTimeout(r, 40));
      return inner(u, l);
    };
    slow.deps.progress = (line) => void said.push(line);
    slow.deps.slowMs = 10;
    const out = await slow.run("search Google for dentists and open the first result");
    expect(out.ok).toBe(true);
    expect(said).toEqual(["Still working."]);
  });
  test("a fast run says nothing on the way (one answer at the end)", async () => {
    const said: string[] = [];
    const r = rig(fakeWeb(), { progress: (l) => void said.push(l), slowMs: 5_000 });
    await r.run("search Google for dentists and open the first result");
    expect(said).toEqual([]);
  });
});

describe("the snapshot parser and the result picker", () => {
  test("snapshot text keeps document order, urls, levels and escaped quotes", () => {
    const nodes = parseSnapshot(['- textbox "Name" [ref=e5]', '- link "Say \\"hi\\"" [ref=e3, url=https://a.test/x?a=1,b=2]', '  - heading "Say hi" [level=3, ref=e7]', '- button "Send" [ref=e2]'].join("\n"));
    expect(nodes.map((n) => n.ref)).toEqual(["e5", "e3", "e7", "e2"]);
    expect(nodes[1]).toMatchObject({ role: "link", name: 'Say "hi"', url: "https://a.test/x?a=1,b=2", depth: 0 });
    expect(nodes[2]).toMatchObject({ role: "heading", level: 3, depth: 1 });
  });
  test("YouTube: dedupes a video's two links, skips ads; Google: skips the engine's own links", () => {
    const yt = parseSnapshot('- link "Sponsored: x" [ref=e1, url=https://www.youtube.com/watch?v=ad1]\n- link "3:21" [ref=e2, url=https://www.youtube.com/watch?v=aaa1]\n- link "First video" [ref=e3, url=https://www.youtube.com/watch?v=aaa1]\n- link "Second" [ref=e4, url=https://www.youtube.com/watch?v=bbb2]');
    expect(pickResults("youtube", yt).map((r) => r.ref)).toEqual(["e2", "e4"]);
    const g = parseSnapshot('- link "Images" [ref=e1, url=https://www.google.com/imghp]\n- link "Result A" [ref=e2, url=https://a.test/]\n  - heading "Result A" [level=3, ref=e3]\n- link "Ad here" [ref=e4, url=https://www.googleadservices.com/aclk?x]');
    expect(pickResults("google", g).map((r) => r.ref)).toEqual(["e2"]);
  });
});

describe("the rules: goal shapes and the audit's paraphrase families", () => {
  const shape = (u: string) => parseTaskGoal(u);
  test("search families", () => {
    for (const u of ["search Google for dentists and open the first result", "google dentists and open the first result", "look up dentists on Google and click the first link", "find dentists on google and open the top result", "do a google search for dentists and open the first one", "search for dentists and open the first result", "can you look up dentists on google and open the first result"])
      expect({ u, s: shape(u) }).toMatchObject({ s: { kind: "search_open", engine: "google", query: "dentists", nth: 1 } });
    expect(shape("search Google for dentists and open the second result")).toMatchObject({ kind: "search_open", nth: 2 });
    for (const u of ["search YouTube for lo-fi beats and play the first video", "youtube lo-fi beats and play the first one", "find lo-fi beats on YouTube and play the top video", "open YouTube and search lo-fi beats, then play the first video", "look up lo-fi beats on youtube and open the first video", "play lo-fi beats on YouTube"])
      expect({ u, s: shape(u) }).toMatchObject({ s: { kind: "search_open", engine: "youtube", query: "lo-fi beats", play: true } });
  });
  test("follow-ups on the results in front", () => {
    for (const [u, nth] of [["open the first result", 1], ["open the top result", 1], ["click the second result", 2], ["open the second one", 2], ["click on the third link", 3], ["play the first video", 1], ["open result number 4", 4], ["open the last one", "last"], ["open the next one", "next"]] as const)
      expect({ u, s: shape(u) }).toMatchObject({ s: { kind: "open_nth", nth, back: false } });
    for (const u of ["go back and open the next one", "go back and open another one", "back, then open the next result"]) expect({ u, s: shape(u) }).toMatchObject({ s: { kind: "open_nth", nth: "next", back: true } });
    // A plain "open one" / "click it" / "open the page" is not a result.
    for (const u of ["open one", "click it", "open the page", "open Notepad", "go back", "click Contact"]) expect(shape(u)).toBeNull();
  });
  test("sites, pages, reading, forms and Gmail", () => {
    expect(shape("go to smiledental.com.au and click Pricing")).toMatchObject({ kind: "site_click", label: "Pricing", site: { name: "smiledental.com.au" } });
    expect(shape("go to our website and click Contact")).toMatchObject({ kind: "site_click", site: { url: "https://muventures.com.au/" } });
    expect(shape("find the pricing page on smiledental.com.au")).toMatchObject({ kind: "find_page", page: "pricing", site: { name: "smiledental.com.au" } });
    expect(shape("find the pricing page")).toMatchObject({ kind: "find_page", page: "pricing", site: null });
    expect(shape("open pricing")).toBeNull(); // the OS's own Pricing page, not a website's
    expect(shape("read me the headline of the top story on the ABC")).toMatchObject({ kind: "read_headline", site: { name: "ABC News" } });
    expect(shape("what's the top story on BBC news")).toMatchObject({ kind: "read_headline", site: { name: "BBC News" } });
    expect(shape("scroll to the bottom and read the footer")).toMatchObject({ kind: "read_footer", site: null });
    expect(shape("open the contact page and read the phone number")).toMatchObject({ kind: "contact_read", what: "phone", site: null });
    expect(shape("open the Contact page on smiledental.com.au and read me the phone number")).toMatchObject({ kind: "contact_read", what: "phone", site: { name: "smiledental.com.au" } });
    expect(shape("fill the contact form on smiledental.com.au with my name and email but don't send it")).toMatchObject({ kind: "fill_form", wants: ["first_name", "full_name", "last_name", "email"], site: { name: "smiledental.com.au" } });
    expect(shape("fill the contact form with my details")).toMatchObject({ kind: "fill_form", wants: "all", site: null });
    expect(shape("open my Gmail and search for invoices")).toMatchObject({ kind: "gmail_search", query: "invoices" });
    expect(shape("go to Gmail and search for the quote from Sam")).toMatchObject({ kind: "gmail_search", query: "the quote from Sam" });
  });
  test("a final button named in a go-to-and-click is not a task (the gated path asks first)", () => {
    expect(shape("go to smiledental.com.au and click Send")).toBeNull();
    expect(shape("go to smiledental.com.au and press Pay now")).toBeNull();
  });
  test("resolveSite never guesses", () => {
    expect(resolveSite("the abc")).toMatchObject({ url: "https://www.abc.net.au/news" });
    expect(resolveSite("smiledental dot com dot au")).toMatchObject({ name: "smiledental.com.au" });
    expect(resolveSite("youtube")).toMatchObject({ name: "YouTube" });
    expect(resolveSite("my landlord")).toBeNull();
    expect(resolveSite("Mehroz")).toBeNull();
  });
});
