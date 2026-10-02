// "Make a site" (Websites, W-F 29 Sep 2026): who it's for, the vertical and the skills to apply become
// ONE clear coding request, which opens Track 3's coding DRAFT (/coding?request=…). The draft shows the
// plan, repo and agents and waits for a signed-in person's "Start it": nothing here starts, deploys,
// publishes or touches DNS. The same request is what "Jarvis, make a top-tier dental site for <lead>"
// opens (src/lib/commands/site-maker.ts), so the page and Jarvis land on the same draft.
//
// Pure: no fetch, no React, no DOM. Contact details (phone, email) never enter a request.

/** The longest request a coding draft takes. Equal to CODING_REQUEST_MAX (a test holds them together). */
export const SITE_REQUEST_MAX = 1000;
/** The owner's own words in the brief box. Room is left for the lead, repo and skills. */
export const SITE_BRIEF_MAX = 280;

export type SiteVertical = "dental" | "legal" | "real-estate" | "trades" | "other";

export type Flagship = { name: string; repo: string };

export const SITE_VERTICALS: readonly {
  id: SiteVertical;
  label: string;
  flagship: Flagship | null;
}[] = [
  { id: "dental", label: "Dental", flagship: { name: "Lantern Dental", repo: "muv-demo-dental" } },
  { id: "legal", label: "Legal", flagship: { name: "Marden & Rowe", repo: "muv-flagship-legal" } },
  { id: "real-estate", label: "Real estate", flagship: { name: "Aldergate", repo: "aldergate" } },
  { id: "trades", label: "Trades", flagship: null },
  { id: "other", label: "Another", flagship: null },
];

/** No flagship for this vertical yet: start from the strongest one (dental, the default flagship). */
export const FALLBACK_FLAGSHIP: Flagship = { name: "Lantern Dental", repo: "muv-demo-dental" };

export const verticalLabel = (v: SiteVertical) =>
  SITE_VERTICALS.find((x) => x.id === v)?.label ?? "Another";

const VERTICAL_WORDS: readonly [SiteVertical, RegExp][] = [
  ["dental", /\b(?:dental|dentists?|dentistry|orthodont\w*|smiles?)\b/i],
  [
    "legal",
    /\b(?:legal|law|lawyers?|solicitors?|conveyanc\w*|barristers?|attorneys?|family law)\b/i,
  ],
  ["real-estate", /\b(?:real[- ]?estate|realty|realtors?|property|properties|agents?|homes)\b/i],
  [
    "trades",
    /\b(?:trades?|tradies?|plumb\w*|electric\w*|roof\w*|build(?:er|ers|ing)|carpent\w*|landscap\w*|paint(?:er|ers|ing)|hvac|air[- ]?con\w*|tiling|tilers?|concret\w*|fencing|glaz\w*|locksmiths?|pest control)\b/i,
  ],
];

/** "Harbour Dental", "family law", "roofing" → the vertical, else null. Pure. */
export function verticalFromWords(text: string | null | undefined): SiteVertical | null {
  const t = String(text ?? "");
  for (const [id, re] of VERTICAL_WORDS) if (re.test(t)) return id;
  return null;
}

/** A CRM or catalogue vertical ("dental" | "legal" | "real-estate") → ours. */
export function verticalOf(value: string | null | undefined): SiteVertical | null {
  return value === "dental" || value === "legal" || value === "real-estate"
    ? value
    : verticalFromWords(value);
}

// ── skills ───────────────────────────────────────────────────────────────

export type SkillGroup = "craft" | "motion" | "words" | "assets";
export type SiteSkill = {
  /** The skill's folder name in ~/.claude/skills (or "motion-kit" for the Motion library's M&U kit). */
  id: string;
  label: string;
  /** One line: what it adds to the site. */
  does: string;
  /**
   * What the skill tells the builder, in one or two sentences. This is the brief the coding draft carries
   * (siteBrief below), so the job doesn't depend on the builder's own session having the skill installed.
   * Never mentions push, merge, deploy, publish or release: a role's instructions can't ask for those.
   */
  directive: string;
  group: SkillGroup;
  /** In the "top-tier" preset. */
  preset: boolean;
  /** Uses a paid provider: the request says it may run only after the owner approves the spend. */
  paid?: boolean;
};

export const SKILL_GROUPS: readonly { id: SkillGroup; label: string; note: string }[] = [
  {
    id: "craft",
    label: "Design and proof",
    note: "The look, the evidence behind every claim, and a check before handoff",
  },
  {
    id: "motion",
    label: "Motion",
    note: "Purposeful movement, always with a reduced-motion fallback",
  },
  { id: "words", label: "Words and reach", note: "Copy that converts, search and accessibility" },
  {
    id: "assets",
    label: "Generated imagery",
    note: "Paid providers: the draft asks you before any spend",
  },
];

export const SITE_SKILLS: readonly SiteSkill[] = [
  {
    id: "mu-business-evidence",
    label: "Business evidence",
    does: "Every claim from public evidence; unknowns stay marked placeholders",
    directive:
      "Every claim comes from public evidence about this business (its own site, its listing, public registers). Anything you cannot verify stays a clearly marked placeholder: never invent staff, reviews, awards, prices or opening hours.",
    group: "craft",
    preset: true,
  },
  {
    id: "mu-art-direction",
    label: "Art direction",
    does: "A distinctive direction, not the generic AI look",
    directive:
      "Choose one distinctive art direction for this business (a specific type pairing, palette and layout idea) and hold it on every page. Avoid the generic AI-site look: purple gradients, a stock hero, three identical cards.",
    group: "craft",
    preset: true,
  },
  {
    id: "frontend-design",
    label: "Frontend design",
    does: "Intentional type, layout and colour choices",
    directive:
      "Make intentional type, spacing and colour choices; no template defaults.",
    group: "craft",
    preset: true,
  },
  {
    id: "impeccable",
    label: "Impeccable",
    does: "Polish: hierarchy, spacing, states and edge cases",
    directive:
      "Polish hierarchy, spacing, states (hover, focus, empty, error) and edge cases before you finish.",
    group: "craft",
    preset: true,
  },
  {
    id: "ui-ux-pro-max",
    label: "UI/UX Pro Max",
    does: "Palettes, type pairings and UX rules by industry",
    directive:
      "Use palette, type pairing and UX rules that suit this industry.",
    group: "craft",
    preset: false,
  },
  {
    id: "mu-concept-qa",
    label: "Concept QA",
    does: "Checks the rendered site at desktop and phone before handoff",
    directive:
      "Check the rendered pages at 1440 px and 390 px wide: no sideways scroll, no clipped text, readable contrast. Describe what you checked in your summary.",
    group: "craft",
    preset: true,
  },
  {
    id: "motion-ui",
    label: "Motion UI",
    does: "Purposeful transitions and micro-interactions",
    directive:
      "Motion is purposeful: transitions and micro-interactions that explain state, and a prefers-reduced-motion fallback for every animation.",
    group: "motion",
    preset: true,
  },
  {
    id: "motion-kit",
    label: "M&U motion kit",
    does: "Stat ring, CTA pulse, map pin, before/after wipe from the Motion library",
    directive:
      "Use the M&U motion kit (stat ring, CTA pulse, map pin, before/after wipe) where it fits; if the repo has none, build small equivalents locally.",
    group: "motion",
    preset: false,
  },
  {
    id: "anim-clip",
    label: "Animated clip",
    does: "Branded motion graphics from an approved script",
    directive:
      "Branded motion graphics only from an approved script; without one, leave a clearly marked placeholder for the clip.",
    group: "motion",
    preset: false,
  },
  {
    id: "copywriting",
    label: "Copywriting",
    does: "Headlines and sections that say why to book",
    directive:
      "Write headlines and section copy that say why to book, in plain Australian English.",
    group: "words",
    preset: true,
  },
  {
    id: "cro",
    label: "Conversion",
    does: "A clear path from first screen to booking",
    directive:
      "Give one clear path from the first screen to booking or calling, with one primary action per section.",
    group: "words",
    preset: false,
  },
  {
    id: "seo",
    label: "SEO",
    does: "Local search basics: titles, schema, speed",
    directive:
      "Local search basics: a title and description per page, LocalBusiness schema from verified facts only, fast images.",
    group: "words",
    preset: false,
  },
  {
    id: "accessibility",
    label: "Accessibility",
    does: "WCAG 2.2 AA: contrast, keyboard, screen readers",
    directive:
      "WCAG 2.2 AA: contrast, keyboard use, visible focus, alt text and form labels.",
    group: "words",
    preset: true,
  },
  {
    id: "generate-asset",
    label: "Generate assets",
    does: "Images or short clips from a connected provider",
    directive:
      "Paid image or clip generation is not available in this job: leave clearly marked placeholders and list in your summary what would be generated.",
    group: "assets",
    preset: false,
    paid: true,
  },
  {
    id: "mu-killer-site",
    label: "Killer site",
    does: "Generated hero film and photography (Higgsfield, GPT Image)",
    directive:
      "Generated hero film and photography (paid providers) are not run in this job: place labelled placeholders and describe the intended shots in your summary.",
    group: "assets",
    preset: false,
    paid: true,
  },
];

export const PRESET_SKILLS: readonly string[] = SITE_SKILLS.filter((s) => s.preset).map(
  (s) => s.id,
);
const skillById = (id: string) => SITE_SKILLS.find((s) => s.id === id) ?? null;

/** The chosen skills in catalogue order, unknown ids dropped. Pure. */
export function orderedSkills(ids: readonly string[]): SiteSkill[] {
  const set = new Set(ids);
  return SITE_SKILLS.filter((s) => set.has(s.id));
}

/**
 * The brief a site draft gives its builder: one line per chosen skill (the skill's own directive), then the
 * fixed limits. Pure. This is what "pre-filled from the skills" means for a coding draft: the builder gets
 * the guidance in its instructions, not just the skill names.
 */
export function siteBrief(ids: readonly string[]): string {
  const skills = orderedSkills(ids);
  const lines = skills.map((s) => `- ${s.id}: ${s.directive}`);
  return [
    "Site brief, from the skills chosen for this job (apply every line):",
    ...lines,
    "Stay inside your owned files. Nothing goes live and nothing touches DNS.",
  ].join("\n");
}

/** The skill ids a site request names ("Apply these skills: a, b."), in catalogue order. Pure. */
export function skillsInRequest(request: string): string[] {
  const m = /Apply these skills:\s*([a-z0-9,\s-]+?)\./i.exec(request);
  if (!m) return [];
  const asked = new Set(m[1].split(",").map((x) => x.trim().toLowerCase()));
  return SITE_SKILLS.filter((s) => asked.has(s.id)).map((s) => s.id);
}

/**
 * Is this request one the site maker built (or its spoken twin)? "Make a top-tier dental website for X …",
 * "Make the Lantern Dental site top-tier …". The coding shaper then drafts it with the site plan. Pure.
 */
export function isSiteRequest(request: string): boolean {
  const t = String(request ?? "").trim();
  return /^Make (?:a top-tier .{1,60}? (?:website|site)\b|the .{1,90}? site top-tier\b)/.test(t) && /Stay local: nothing goes live, no DNS\./.test(t);
}

/** The first sentence of a site request: who it's for and where it's built. It becomes the job's objective. Pure. */
export function siteObjective(request: string): string {
  const t = String(request ?? "").replace(/\s+/g, " ").trim();
  const end = /\.\s+(?=[A-Z])/.exec(t);
  return (end ? t.slice(0, end.index) : t).replace(/[.\s]+$/, "").slice(0, 400);
}

// ── who it's for ─────────────────────────────────────────────────────────

export type SiteTarget =
  /** A CRM lead picked on the page (name, suburb and their site only: never phone or email). */
  | { kind: "lead"; leadId: number; name: string; area?: string | null; website?: string | null }
  /** A name heard or typed ("… for Harbour Dental"): not yet matched to a lead. */
  | { kind: "named"; name: string }
  /** One of M&U's own sites (client or flagship), made top-tier in its own repo. */
  | {
      kind: "site";
      siteId: string;
      name: string;
      repo: string;
      url?: string | null;
      client: boolean;
    }
  /** Just the brief. */
  | { kind: "brief" };

export type RepoChoice = { repo: string; startsFrom: Flagship | null; why: string };

/** Which repo the draft works in. Our own site → its repo; a new site → the vertical's flagship. Pure. */
export function repoFor(target: SiteTarget, vertical: SiteVertical): RepoChoice {
  if (target.kind === "site")
    return { repo: target.repo, startsFrom: null, why: `${target.name}'s own repo` };
  const own = SITE_VERTICALS.find((v) => v.id === vertical)?.flagship ?? null;
  const from = own ?? FALLBACK_FLAGSHIP;
  return {
    repo: from.repo,
    startsFrom: from,
    why: own
      ? `Starts from the ${verticalLabel(vertical).toLowerCase()} flagship, ${from.name}, on the job's own branch`
      : `No ${vertical === "trades" ? "trades" : "flagship for this vertical"} yet: starts from ${from.name}, the strongest flagship, on the job's own branch`,
  };
}

// ── the request ──────────────────────────────────────────────────────────

export type SiteRequestInput = {
  target: SiteTarget;
  vertical: SiteVertical;
  /** When vertical is "other": the kind of business ("physio clinic"). */
  otherVertical?: string;
  /** The owner's own words. */
  brief?: string;
  skills: readonly string[];
  /** Override the repo (a registered repo he picked). Defaults to repoFor(). */
  repo?: string;
};

export type SiteRequest =
  | { ok: true; request: string; repo: RepoChoice; length: number }
  | { ok: false; reason: string; request: string; repo: RepoChoice; length: number };

const clean = (s: string | null | undefined, max: number) =>
  String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
/** A site address without the scheme or a trailing slash. */
export const bareHost = (url: string | null | undefined) =>
  clean(url, 200)
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
/** Who and what, as the request's first sentence. */
function subject(input: SiteRequestInput): string {
  const kind =
    input.vertical === "other"
      ? clean(input.otherVertical, 40) || "small-business"
      : verticalLabel(input.vertical).toLowerCase();
  const t = input.target;
  if (t.kind === "site")
    return `Make the ${clean(t.name, 80)} site top-tier (M&U's ${t.client ? "client" : `${kind} flagship`}${t.url ? `, ${bareHost(t.url)}` : ""})`;
  if (t.kind === "lead") {
    const where = [
      clean(t.area, 60),
      t.website ? `their site today: ${bareHost(t.website)}` : "no site today",
    ]
      .filter(Boolean)
      .join("; ");
    return `Make a top-tier ${kind} website for ${clean(t.name, 80)} (CRM lead #${t.leadId}${where ? `, ${where}` : ""})`;
  }
  if (t.kind === "named")
    return `Make a top-tier ${kind} website for ${clean(t.name, 80)} (look them up in the CRM leads and their public sources)`;
  return `Make a top-tier ${kind} website from the brief below`;
}

/**
 * The coding request for this site. Never over SITE_REQUEST_MAX: when his brief makes it too long the
 * result says so and nothing is cut (the coding page refuses long requests the same way). Pure.
 */
export function buildSiteRequest(input: SiteRequestInput): SiteRequest {
  const choice = repoFor(input.target, input.vertical);
  const repo =
    input.repo && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(input.repo)
      ? {
          ...choice,
          repo: input.repo,
          why:
            input.repo === choice.repo
              ? choice.why
              : "The repo you picked, on the job's own branch",
        }
      : choice;
  const skills = orderedSkills(input.skills);
  const paid = skills.filter((s) => s.paid).map((s) => s.id);
  const brief = clean(input.brief, 10_000);
  const where =
    input.target.kind === "site"
      ? `in the ${repo.repo} repo, on this job's own branch`
      : repo.startsFrom && repo.repo === repo.startsFrom.repo
        ? `in the ${repo.repo} repo, starting from the ${repo.startsFrom.name} flagship on this job's own branch`
        : `in the ${repo.repo} repo, on this job's own branch`;
  const parts = [
    `${subject(input)}, ${where}.`,
    brief ? `Brief: ${brief.replace(/[.\s]+$/, "")}.` : "",
    skills.length ? `Apply these skills: ${skills.map((s) => s.id).join(", ")}.` : "",
    skills.some((s) => s.id === "motion-kit")
      ? "motion-kit means the M&U stat ring, CTA pulse, map pin and before/after wipe."
      : "",
    "Claims only from public evidence; unknowns stay marked placeholders.",
    skills.some((s) => s.group === "motion") ? "Reduced-motion fallbacks throughout." : "",
    paid.length
      ? `Paid generation (${paid.join(", ")}) only after the owner approves the exact spend.`
      : "No paid image or video generation.",
    "Stay local: nothing goes live, no DNS.",
    "Done when it builds, checks pass and the handoff has 1440 and 390 screenshots.",
  ].filter(Boolean);
  const request = parts.join(" ");
  const length = request.length;
  if (brief.length > SITE_BRIEF_MAX)
    return {
      ok: false,
      reason: `The brief is over ${SITE_BRIEF_MAX} characters. Shorten it; nothing is cut.`,
      request,
      repo,
      length,
    };
  if (length > SITE_REQUEST_MAX)
    return {
      ok: false,
      reason: `That makes a ${length}-character request; a coding draft takes ${SITE_REQUEST_MAX}. Shorten the brief or apply fewer skills; nothing is cut.`,
      request,
      repo,
      length,
    };
  if (input.target.kind === "brief" && !brief)
    return {
      ok: false,
      reason: "Add a line of brief, or pick a lead or one of our sites.",
      request,
      repo,
      length,
    };
  return { ok: true, request, repo, length };
}

/** The coding draft page for a request (Track 3's `/coding?request=`). Pure. */
export function siteDraftHref(request: string): string {
  return `/coding?${new URLSearchParams({ request }).toString()}`;
}

/** What to say to Jarvis for the same draft. Pure. */
export function jarvisPhrase(
  target: SiteTarget,
  vertical: SiteVertical,
  otherVertical?: string,
): string {
  const kind =
    vertical === "other" ? clean(otherVertical, 40) || "" : verticalLabel(vertical).toLowerCase();
  const name =
    target.kind === "lead" || target.kind === "named" || target.kind === "site"
      ? clean(target.name, 80)
      : "";
  return `Make a top-tier ${kind ? `${kind} ` : ""}site${name ? ` for ${name}` : ""}`;
}

// ── "Jarvis, make a top-tier dental site for Harbour Dental" ─────────────

const LEAD_IN =
  /^\s*(?:(?:hey|ok|okay)\s+)?(?:jarvis\b[,\s]*)?(?:(?:can|could|would|will) you\s+|please\s+|i want (?:you )?to\s+|i'd like (?:you )?to\s+|let's\s+|go\s+)?/i;
const QUALITY = String.raw`(?:top[- ]?tier|killer|premium|high[- ]?end|standout|world[- ]?class|stunning|great|beautiful|proper|flagship[- ]quality|best)`;
const ASK = new RegExp(
  String.raw`^(?:make|build|create|design|do)\s+(?:me\s+|us\s+)?(?:a|an)\s+(?:new\s+)?(?:(${QUALITY})\s+)?(?:new\s+)?(?:([a-z][a-z&' -]{1,40}?)\s+)?(?:web\s?site|site)(?:\s+for\s+(?:the\s+|our\s+)?(?:(?:lead|client|prospect|business)\s+)?(?:called\s+|named\s+)?["“']?(.{2,80}?)["”']?)?\s*(?:,?\s*please)?\s*[.!?]?$`,
  "i",
);
/** Words that make it something else ("make a site map", "build a site plan for the vertical"). */
const NOT_A_SITE = /^(?:map|plan|visit|survey|inspection|meeting|booking)\b/i;
/** Filler words in the kind-of-business slot that aren't a vertical. */
const FILLER = /^(?:new|good|nice|simple|quick|basic|modern|fresh|full|whole|proper|landing)$/i;

export type SiteAsk = {
  vertical: SiteVertical | null;
  otherVertical: string | null;
  name: string | null;
  quality: string | null;
};

/**
 * "make a top-tier dental site for Harbour Dental" → { vertical: "dental", name: "Harbour Dental" }.
 * Needs a vertical or a name: "make a website" alone isn't specific enough to draft. Pure.
 */
export function parseSiteAsk(text: string): SiteAsk | null {
  const t = String(text ?? "")
    .replace(LEAD_IN, "")
    .trim();
  if (!t || t.length > 200) return null;
  const m = ASK.exec(t);
  if (!m) return null;
  const quality = m[1] ?? null;
  const kind = (m[2] ?? "").trim();
  const name = (m[3] ?? "").trim().replace(/[.,!?]+$/, "") || null;
  if (NOT_A_SITE.test(name ?? "")) return null;
  const kindWords = kind
    .split(/\s+/)
    .filter((w) => w && !FILLER.test(w))
    .join(" ");
  let vertical = verticalFromWords(kindWords) ?? null;
  let otherVertical: string | null = null;
  if (!vertical && kindWords) {
    vertical = "other";
    otherVertical = kindWords.toLowerCase();
  }
  if (!vertical && name) vertical = verticalFromWords(name);
  if (!vertical && !name) return null;
  return { vertical, otherVertical, name, quality };
}
