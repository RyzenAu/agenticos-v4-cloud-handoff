/**
 * control_pc risk tiers, computed in code from the task text alone (never from a model):
 *
 * - read-only: only looks, lists, finds or answers.
 * - local-reversible: changes something on this PC that he can trivially undo (open or close an
 *   app, type into a window, play or pause, create a file in a scratch folder).
 * - external-effect: reaches other people, spends money, publishes, installs, runs code, deletes,
 *   overwrites, changes system settings, writes outside a scratch folder, or anything the rules
 *   below don't recognise (fail closed).
 *
 * external-effect ALWAYS needs his spoken yes (gateControlTask in jarvis-control.ts). The unified
 * keyword list (action-keywords.ts) is one input; the other patterns here catch effects that no
 * outbound verb names ("empty the recycle bin", "run the script", "move my photos to OneDrive").
 * Pure: no I/O, safe in the browser bundle and in scripts.
 */
import { matchKeywords, TASK_GATE } from "./action-keywords";

export type RiskTier = "read-only" | "local-reversible" | "external-effect";
export const TIER_ORDER: readonly RiskTier[] = ["read-only", "local-reversible", "external-effect"];

export type RiskAssessment = { tier: RiskTier; reasons: string[]; keywords: string[] };
export type PlannedStep = { n: number; text: string; tier: RiskTier; reasons: string[] };
export type ControlPlan = {
  tier: RiskTier;
  reasons: string[];
  keywords: string[];
  steps: PlannedStep[];
  needsApproval: boolean;
  /** Always false: a plan is a preview and nothing has run. */
  executed: false;
};

/**
 * The longest control_pc task any check reads (J5, review "classifyControlTask is superlinear"). The text comes from the
 * model's control_pc argument, and the rules below are dozens of regular expressions: past this length nothing is
 * scanned. classifyControlTask asks (external-effect), controlTaskRefusal and the executor policy refuse, so a long
 * task is never run on the strength of a scan that was skipped.
 */
export const MAX_CONTROL_TASK_CHARS = 4000;
export const TOO_LONG_REASON = `task is over ${MAX_CONTROL_TASK_CHARS} characters, too long to check`;

/** Folders where writing a new file counts as local and reversible. Everything else is external. */
export const DEFAULT_SCRATCH_ROOTS: readonly string[] = ["D:\\tmp\\"];

/**
 * Secret-bearing paths and files (audit A-H2, 27 Sep 2026): env files, config.yaml, credential
 * stores, key material, and any path or file name carrying token/key/secret/password. A task
 * that names one is refused outright, never read-only or local-reversible.
 */
export const SECRET_BEARING =
  /(?:^|[\s"'`(=:\\/~])\.env(?:\.[\w-]+)?(?=$|[\s"'`),;:\\/])|\bagentic-os\.env\b|\bconfig\.ya?ml\b|\bcredentials?\b|\b(?:auth|oauth[\w-]*|tokens?|session[\w-]*)\.json\b|\bsecrets?\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.(?:pem|pfx|p12|kdbx|keychain)\b|(?:^|[\s"'`~\\/])\.(?:ssh|aws|gnupg|docker|npmrc|netrc|git-credentials)\b|(?<![^\s"'`])[^\\/.\s"'`]*[\\/.][^\s"'`]*?(?:token|key|secret|passw)|(?<![^\s"'`])(?=([^\s"'`]*?(?:token|key|secret|passw)))\1[^\s"'`]*\.(?:txt|json|ya?ml|env|ini|cfg|conf|toml|xml|csv|md|pem|key)\b|\b(?:api|access|secret|private|typesafe|openai|anthropic|claude|stripe|auth|bearer|session|refresh|github|gh|retell|twilio|elevenlabs|groq|gemini|openrouter|basiq|vercel|neon)[ _-]?(?:keys?|tokens?)\b|\b(?:keys?|tokens?) file\b/i;
/** Private data the owner never lets an agent extract (his standing rules). */
export const PRIVATE_DATA =
  /\b(?:passwords?|passcodes?|credentials?|api[ -]?keys?|otp|seed phrase|recovery (?:code|phrase)|private (?:audio|transcripts?|datasets?)|raw (?:transcripts?|traces))\b/i;
// === THE money policy lives in ./money-policy.ts (ONE list for every path; normalised matching). ====
// control_pc uses it first (controlTaskRefusal), then its own stricter verbs and plain finance words,
// because Hermes has no final-button gate to fall back on.
import { bookkeeping, FINANCE_WORDS, localDocument, MONEY_NAMES, moneyHost, moneyRefusal, normaliseText, ownDashboard, stripGitRefs, textVariants } from "./money-policy";
export { FINANCE_WORDS, MONEY_AMOUNT, MONEY_BUTTON, MONEY_NAMES, moneyButton, moneyHost, moneyRefusal, moneySurfaceRefusal, normaliseText, textVariants, type MoneyRefusal } from "./money-policy";
const DOMAIN_WORDS = /(?:https?:\/\/)?(?:[\p{L}0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/giu;

/** Money movement and trading verbs: control_pc only (it has no final-button gate), on top of moneyRefusal. */
export const MONEY_OR_TRADING =
  /\b(?:send|sends|sending|sent|pay(?!\s+(?:attention|heed|respects?|tribute|a\s+visit)\b)|pays|paying|paid|payments?|transfer(?:s|red|ring)?\b(?!\s+(?:the\s+|this\s+|that\s+|these\s+|those\s+|my\s+|our\s+|his\s+|her\s+|a\s+|an\s+)?(?:[\w'-]+\s+)?(?:calls?|caller|files?|folders?|documents?|docs?|photos?|pictures?|videos?|leads?|contacts?|tickets?|chats?|conversations?|meetings?|lines?|notes?|tasks?|projects?|repos?(?:itory)?)\b)|payid|bpay|osko|buy|buys|buying|(?:sell|sells|selling)\b(?!\s+(?:the\s+|this\s+|that\s+|our\s+|my\s+|an?\s+|him\s+|her\s+|them\s+|it\s+|us\s+)?(?:[\w'-]+\s+){0,2}?(?:idea|ideas|offer|offers|pitch|story|vision|concept|services?|package|proposal|receptionist|demo|brand|value|benefits?|message|website|site)\b)|trade|trades|traded|trading|(?<!\b(?:by|sort|in)\s)(?:orders?|ordering)\b(?!\s+(?:value|values|date|number|history|status|of)\b)(?![^.;,]*\bby\b)|withdraw(?:s|al|als|ing|n)?\b(?!\s+(?:the\s+|my\s+|our\s+|that\s+|this\s+|a\s+|an\s+)?(?:[\w'-]+\s+){0,3}?(?:proposal|quotes?|quotation|estimate|tender|application|submission|request|offer|complaint|comment|consent|invitation|nomination|pull\s+request|pr)\b)|deposit(?:s|ing)?)\b/i;
/** Banks, brokers and exchanges for the strict tiers: the shared names plus the plain finance words. */
export const FINANCIAL_INSTITUTION = {
  test: (text: string) => textVariants(text).some((v) => MONEY_NAMES.test(v) || FINANCE_WORDS.test(v) || [...v.matchAll(DOMAIN_WORDS)].some((m) => moneyHost(m[0]))),
};

export type ControlRefusal = "money-or-trading" | "bank-broker-or-exchange" | "secret-or-private-data" | "too-long";
/**
 * Hard refusals for desktop control (audit A-H2). No approval of any kind can lift these:
 * the owner's rule is "never execute a trade or transfer", and secrets are never read.
 * Pure. The server executor policy (scripts/jarvis-execution/control-policy.ts) refuses all
 * three; the client gate refuses them all before it ever asks for a yes.
 */
export function controlTaskRefusal(task: string): ControlRefusal | null {
  if (task.length > MAX_CONTROL_TASK_CHARS) return "too-long";
  if (SECRET_BEARING.test(task) || PRIVATE_DATA.test(task)) return "secret-or-private-data";
  const money = moneyRefusal(task);
  if (money) return money.kind;
  // Bookkeeping in his own records moves no money (R4 §4: "log the $825 deposit in the CRM").
  if (bookkeeping(task)) return null;
  // His own dashboards' addresses, and git branch names, aren't money words (R4 §4).
  const git = stripGitRefs(task);
  task = (git ?? task).replace(/(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, (u) => (ownDashboard(u) ? " " : u));
  if (textVariants(task).some((v) => MONEY_OR_TRADING.test(v))) return "money-or-trading";
  // Opening a local statement file ("open the NAB statement PDF in Downloads") names a bank but drives none
  // (REVIEW-SAFETY-R3 §2 carve-out 1); the money verbs above still refuse.
  if (FINANCIAL_INSTITUTION.test(task) && !localDocument(task)) return "bank-broker-or-exchange";
  return null;
}

/**
 * Anything that puts words into Obsidian, the vault, the wiki or a knowledge base (J3, audit "Telling it things" and
 * review F6). It is tested on the whole task as well as each clause, because "open Obsidian and type the summary"
 * splits into a launch and a typing step that look harmless alone. Obsidian's name is matched with the usual
 * misspellings and leetspeak ("obs1dian", "obsidan", "Obsidien"), full-width letters and spaced-out letters. It only
 * ever adds an ask: nothing here makes any other task weaker.
 */
const VAULT_TARGET = /\bo[b8]s[i1l!|]d[i1l!|e]?[ae]n\b|\bvault\b|\bwiki\b|\bknowledge ?base\b|\bsecond brain\b|\bdaily notes?\b|\bnotes app\b|\blogseq\b|\bzettelkasten\b|\bnote-?book\b|\bjournal\b/i;
const VAULT_VERB = /\b(?:clip(?:ping|s)?|save|add|put|store|write|jot|paste|copy|move|create|append|import|export|sync|file|log|record|note|capture|dump|type|typing|enter|insert|edit|update|fill|draft|dictate)\b/i;

/** Damerau-Levenshtein distance (adjacent swaps count as one edit), for short words only. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}
/**
 * Speech-to-text and typo spellings of the vault's names (J5, review F6 residual: "absidian", "obsedian", "opsidian",
 * "obisidian", "obsidain", "Obsdian", "obsidians", "ob sidian", "vaullt"): a word within one or two edits of "obsidian" or
 * one edit of "vault", alone or as two neighbouring words joined. Only words of a plausible length are compared (at
 * most 12 letters, so the work is linear in the text). Fuzzy matching only ever adds an ask, never removes one.
 */
function fuzzyVaultName(text: string): boolean {
  const words = (text.toLowerCase().match(/\p{L}{1,12}(?![\p{L}])/gu) ?? []).slice(0, 2000);
  const near = (w: string) => (w.length >= 6 && w.length <= 10 && editDistance(w, "obsidian") <= (w.length >= 7 ? 2 : 1)) || (w.length >= 4 && w.length <= 6 && w[0] === "v" && editDistance(w, "vault") <= 1);
  for (let i = 0; i < words.length; i++) {
    if (near(words[i])) return true;
    if (i + 1 < words.length && words[i].length <= 6 && words[i + 1].length <= 8 && near(words[i] + words[i + 1])) return true;
  }
  return false;
}
export function writesToVault(text: string): boolean {
  if (text.length > MAX_CONTROL_TASK_CHARS) return true; // too long to read: ask, never assume it is harmless
  const plain = text.normalize("NFKC").replace(/\p{Cf}/gu, "");
  // "V a u l t", "o b s i d i a n": four or more single letters spaced out are one word.
  const joined = plain.replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (m) => m.replace(/ /g, ""));
  if ([plain, joined].some((v) => VAULT_TARGET.test(v) && VAULT_VERB.test(v))) return true;
  // Look-alike letters and accents folded ("оbsidian" with a Cyrillic о, "Obsídian"), then the fuzzy spellings.
  const folded = normaliseText(plain);
  const foldedJoined = folded.replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (m) => m.replace(/ /g, ""));
  return [folded, foldedJoined].some((v) => (VAULT_TARGET.test(v) || fuzzyVaultName(v)) && VAULT_VERB.test(v));
}

/** Effects no outbound verb names. Each is [reason, pattern]. */
const HIGH_RISK: ReadonlyArray<[string, { test(text: string): boolean }]> = [
  ["secret-bearing path", SECRET_BEARING],
  ["overwrites data", /\b(?:overwrite|overwriting|replace (?:the |this |that |my )?(?:file|folder|contents?|document))\b/i],
  ["empties or clears data", /\b(?:empty (?:the |my )?(?:recycle bin|trash|bin)|clear (?:the |my )?(?:recycle bin|trash|history|cache|cookies|folder|downloads|desktop))\b/i],
  ["power or session change", /\b(?:shut ?down|restart|reboot|log ?off|sign ?out|hibernate)\b/i],
  ["ends processes or services", /\b(?:kill|end task|terminate|taskkill|stop (?:the )?(?:process|service))\b/i],
  ["system or security setting", /\b(?:registry|regedit|firewall|defender|antivirus|execution policy|uac|user account control|group policy|bios|permissions?|icacls|chmod|take ownership|as admin(?:istrator)?|elevated|run as|sudo)\b/i],
  ["runs code", /\b(?:run|execute|launch|start) (?:a |the |this |that |my )?(?:\w+ )?(?:script|command|installer|program from|batch file|macro)\b|\b(?:powershell|cmd\.exe|command prompt|terminal command)\b|\.(?:ps1|psm1|bat|cmd|vbs|js|msi|reg|hta|scr)\b/i],
  ["shell command", /\b(?:rm|rmdir|rd|del|Remove-Item|Clear-Content|Set-Content|Out-File|Add-Content|Move-Item|Rename-Item|Stop-Process|reg\s+(?:add|delete|import)|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|iex|Invoke-Expression|curl|wget|Set-ExecutionPolicy|schtasks|winget|choco|msiexec)\b|>{1,2}\s*\S/i],
  ["network transfer", /\b(?:download|git\s+(?:commit|push|reset|clean|rebase)|commit (?:the |my |this )?(?:changes|code|repo)|pull request|npm publish|sync (?:it |them |this |these )?(?:to|with)|back ?up (?:\w+ )?to|copy (?:\w+ ){0,3}to (?:onedrive|dropbox|google drive|icloud|the cloud|a usb|the usb|usb))\b/i],
  ["moves or renames files", /\b(?:rename|move)\b(?![^.,;]*\b(?:window|tab|cursor|mouse|pointer|screen|monitor|display)\b)[^.,;]*\b(?:files?|folders?|documents?|photos?|pictures?|videos?|downloads|desktop|drive)\b/i],
  ["credentials", /\b(?:password|passcode|credentials?|api ?key|token|secret|2fa|otp|verification code|seed phrase|recovery (?:code|phrase))\b/i],
  // J3: Hermes writes the vault directly, with none of the memory guard's screening, so anything that writes into Obsidian
  // or the vault waits for his spoken yes, however sure Jev is (see writesToVault).
  ["writes to the Obsidian vault", { test: (clause: string) => writesToVault(clause) }],
  ["paid generation", /\bgenerate (?:an? |some |the )?(?:\w+ )?(?:image|images|video|videos|picture|pictures|photo|photos|voice ?over|audio|song|music)\b/i],
  ["system settings", /\b(?:disable|turn off|switch off|uninstall|remove) (?:the |my )?(?:firewall|defender|antivirus|windows update|updates|backup|backups)\b/i],
  ["addressed to the assistant", /\b(?:ignore (?:all |any |the )?(?:previous|prior|above|earlier|your) (?:instructions|rules)|disregard (?:the|all|your|previous)|system prompt|new instructions)\b/i],
];

/**
 * A website the task opens (REVIEW-SAFETY-R3 §6 item 7): anything off this short list needs his yes, so an
 * unlisted shop, exchange or betting site is never opened on control_pc's say-so (money hosts are refused
 * outright by controlTaskRefusal before this).
 */
const WEB_HOST = /(?:https?:\/\/)?(?:[\w-]+\.)+(?:com|net|org|io|dev|app|au|co|gov|edu|ai|me|us|uk|nz|xyz|info|biz|shop|store|site|online|tech|bet|casino|finance|money|bank|exchange|trade|pro|club|live|games?|win|vip|cc|tv|gg|ly|to|so|sh|is|ag)(?:\.[a-z]{2})?\b(?:\/\S*)?/gi;
const SAFE_WEB = /^(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|google\.com(?:\.au)?|github\.com|muventures\.com\.au|wikipedia\.org|vercel\.app)$/i;
const hostOfWeb = (m: string) => m.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].toLowerCase().replace(/^www\./, "");
const opensUnlistedSite = (clause: string) => [...clause.matchAll(WEB_HOST)].some((m) => !SAFE_WEB.test(hostOfWeb(m[0])));

/** Clauses that only look. */
const READ_ONLY =
  /^(?:what|what's|whats|which|who|whose|when|where|why|how|is|are|was|were|does|do|did|has|have|can you (?:tell|see|find|check)|tell me|show(?: me)?|list|find|search(?: for)?|look ?up|look (?:for|at)|check(?!\s?out\b)(?: if| whether| what| my| the)?|count|read(?: me)?|describe|summari[sz]e|explain|get me|see (?:if|what)|how many|how much)\b/i;
/** Verbs that change something: a clause with one of these is not read-only. */
const MUTATES =
  /\b(?:open|launch|start|close|type|write|save|create|make|move|copy|rename|set|change|turn|switch|enable|disable|install|run|play|add|edit|update|fill|click|press|drag|put|paste|generate|download|delete|send|clear|empty|kill|stop)\b/i;
/** Clauses whose effect is local and easy to undo. */
const LOCAL_REVERSIBLE =
  /^(?:(?:and|then|also|now)\s+)*(?:open|launch|start(?: up)?|bring up|pull up|go to|navigate to|visit|browse to|switch to|focus|close|minimi[sz]e|maximi[sz]e|restore|snap|move (?:the |this |that |my )?(?:window|tab|app)|play|pause|resume|stop (?:the )?(?:music|song|track|video|playback)|skip|next (?:song|track)|previous (?:song|track)|mute|unmute|volume|turn (?:the )?volume|turn (?:it )?(?:up|down)|set (?:a |an )?(?:timer|reminder|alarm)|take (?:a )?screenshot|screenshot|type|write (?:a |the |this )?(?:note|line|sentence|paragraph|reply draft|draft)|paste|copy (?:the |this |that )?(?:text|link|url|line|selection)|select|scroll|zoom|create (?:a |an )?(?:new )?(?:folder|file|note|document|doc|text file|tab)|make (?:a |an )?(?:new )?(?:folder|note|file|tab)|new (?:tab|window|note|folder)|save (?:it|this|that|the (?:note|file|document))|clip|bookmark|pin|unpin|sort|order (?:these|them|the|my)(?: \w+)? by|arrange|resize|show (?:the )?desktop|lock (?:the |my )?(?:pc|computer|screen))\b/i;

const PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>|]*[^\s"'<>|.,;]|~[\\/][^\s"'<>|]*[^\s"'<>|.,;]/g;
const WRITES = /\b(?:save|write|create|make|export|copy|put|download|move|store|output)\b/i;

const normPath = (p: string) => p.replace(/\//g, "\\").toLowerCase();
/** Is `path` inside one of the scratch roots (and free of ".." tricks)? */
export function inScratch(path: string, roots: readonly string[] = DEFAULT_SCRATCH_ROOTS) {
  const p = normPath(path);
  if (/(?:^|\\)\.\.(?:\\|$)/.test(p)) return false;
  return roots.some((root) => {
    const r = normPath(root).replace(/\\?$/, "\\");
    return p.startsWith(r) && p.length > r.length;
  });
}

/** Split "Open Notepad, type X, then save it to D:\tmp\a.txt" into clauses. Pure. */
export function splitClauses(task: string): string[] {
  const VERBS = "open|launch|start|type|write|save|close|go|click|press|create|make|copy|move|rename|delete|send|play|pause|then|and then|email|text|post|search|find|show|tell|run|install|download";
  return task
    .split(new RegExp(`\\s*(?:;|\\.\\s+(?=[A-Z])|,?\\s+(?:and\\s+)?then\\s+|,\\s*(?=(?:${VERBS})\\b)|\\s+and\\s+(?=(?:${VERBS})\\b))\\s*`, "i"))
    .map((c) => c.trim().replace(/[.!?]+$/, ""))
    .filter(Boolean);
}

const worst = (a: RiskTier, b: RiskTier) => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

function assessClause(clause: string, roots: readonly string[]): RiskAssessment {
  const reasons: string[] = [];
  const keywords = matchKeywords(clause, "task").map((k) => k.id);
  if (keywords.length) reasons.push(`outbound or destructive: ${keywords.join(", ")}`);
  for (const [reason, re] of HIGH_RISK) if (re.test(clause)) reasons.push(reason);
  if (opensUnlistedSite(clause)) reasons.push("opens a website that isn't on the list");
  const paths = clause.match(PATH) ?? [];
  if (paths.length && WRITES.test(clause)) {
    const outside = paths.filter((p) => !inScratch(p, roots));
    if (outside.length) reasons.push("writes outside a scratch folder");
  }
  if (reasons.length) return { tier: "external-effect", reasons, keywords };
  if (READ_ONLY.test(clause) && !MUTATES.test(clause)) return { tier: "read-only", reasons: ["looks only"], keywords };
  if (LOCAL_REVERSIBLE.test(clause)) {
    const scratch = paths.length && paths.every((p) => inScratch(p, roots));
    return { tier: "local-reversible", reasons: [scratch ? "writes inside a scratch folder" : "local and undoable"], keywords };
  }
  // Unknown to the rules: treat as external (fail closed) so it needs his yes.
  return { tier: "external-effect", reasons: ["not recognised as local or read-only (fail closed)"], keywords };
}

/** The risk tier of a whole control_pc task: the worst of its clauses. Pure. */
export function classifyControlTask(task: string, options: { scratchRoots?: readonly string[] } = {}): RiskAssessment {
  const roots = options.scratchRoots ?? DEFAULT_SCRATCH_ROOTS;
  if (task.length > MAX_CONTROL_TASK_CHARS) return { tier: "external-effect", reasons: [TOO_LONG_REASON], keywords: [] };
  const text = task.trim();
  if (!text) return { tier: "external-effect", reasons: ["empty task"], keywords: [] };
  // The whole text first: a keyword split across clause boundaries still counts.
  const whole = TASK_GATE.test(text);
  const clauses = splitClauses(text);
  let tier: RiskTier = "read-only";
  const reasons = new Set<string>();
  const keywords = new Set<string>();
  for (const clause of clauses.length ? clauses : [text]) {
    const a = assessClause(clause, roots);
    tier = worst(tier, a.tier);
    for (const r of a.reasons) if (a.tier === "external-effect" || tier !== "external-effect") reasons.add(r);
    for (const k of a.keywords) keywords.add(k);
  }
  if (writesToVault(text) && tier !== "external-effect") {
    tier = "external-effect";
    reasons.add("writes to the Obsidian vault");
  }
  if (whole && tier !== "external-effect") {
    tier = "external-effect";
    for (const k of matchKeywords(text, "task")) keywords.add(k.id);
    reasons.add(`outbound or destructive: ${[...keywords].join(", ")}`);
  }
  // Keep only the reasons for the worst tier, so "looks only" never sits beside a delete.
  const list = [...reasons].filter((r) => tier !== "external-effect" || !/^(?:looks only|local and undoable|writes inside a scratch folder)$/.test(r));
  return { tier, reasons: list, keywords: [...keywords] };
}

/** Dry run: the planned steps and tiers, without running anything. Pure. */
export function planControlTask(task: string, options: { scratchRoots?: readonly string[] } = {}): ControlPlan {
  const roots = options.scratchRoots ?? DEFAULT_SCRATCH_ROOTS;
  const overall = classifyControlTask(task, { scratchRoots: roots });
  if (task.length > MAX_CONTROL_TASK_CHARS) return { ...overall, steps: [], needsApproval: true, executed: false };
  const steps = splitClauses(task.trim()).map((text, i) => {
    const a = assessClause(text, roots);
    return { n: i + 1, text, tier: a.tier, reasons: a.reasons };
  });
  return { ...overall, steps, needsApproval: overall.tier === "external-effect", executed: false };
}

/** One short spoken/logged preview of a plan. */
export function describePlan(plan: ControlPlan): string {
  const steps = plan.steps.map((s) => `${s.n}. ${s.text} [${s.tier}]`).join("; ");
  return `Preview only, nothing has run. Risk: ${plan.tier}${plan.reasons.length ? ` (${plan.reasons.join("; ")})` : ""}. Planned steps: ${steps || "none"}.${plan.needsApproval ? " Needs his spoken yes before it runs." : ""}`;
}
