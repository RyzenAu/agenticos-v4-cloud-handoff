import * as nodePath from "node:path";
import { commandRefusal, expandPathText, insidePath, LINK_REFUSAL, realResolve, type LiveCheckoutGuard } from "../../agent-jobs-guard";
import type { OwnershipSpec, PolicyDecision, RegistryCommand, RoleKind } from "../contracts";
import { redactText, secretPath } from "../redact";
import { AGENT_CONFIG, globToRegExp, isAgentConfig, ownsPath, windowsName } from "../registry";
export { AGENT_CONFIG, isAgentConfig, windowsName };
import type { PolicyFn, PolicyRequest, PolicyVerdict } from "./types";

/**
 * The in-worktree policy engine (CODING-HARNESS §3.4, task C3). Every native approval a coding agent
 * asks for (Claude `can_use_tool`, Codex command/file-change/permission/MCP requests) is decided HERE
 * before any human sees it:
 *
 *   auto-allow  reads inside the role's worktree; edits to the role's owned paths; the spec's registry
 *               commands; local, non-consequential git (status/diff/log/show, `git add <owned>`, commit)
 *   auto-deny   edits outside ownership; secrets and credential paths; reads outside the worktree;
 *               consequential git (push/merge/rebase/reset/checkout/…); git config/worktree; package
 *               installs in a junctioned tree; deploy tools; network; MCP tools; recursive deletes and
 *               links; commands that build paths or code at run time; anything reaching the live checkout
 *   escalate    everything else (a question card plus a spoken prompt; the owner decides)
 *
 * It closes C1C2's carried limits where text can be checked at all:
 *  - run-time-built paths: `$(…)`, backticks, `${…}`, `$VAR`, `%VAR%`, `$env:`, -EncodedCommand, iex/eval,
 *    `bash -c`/`python -c`/`node -e` and friends are DENIED rather than guessed at;
 *  - MCP write tools (and every other MCP tool) are denied for coding roles;
 *  - reads are confined to the worktree (node_modules through its junction is readable, never writable).
 * What text can't prove, the orchestrator proves after the turn: the role's diff must be inside its
 * ownership and the canonical/live checkouts must be byte-identical before and after (orchestrator.ts).
 *
 * The engine never grants anything the role binding forbids: a read-only role (reviewer, planner) can
 * read and run read-only git, and nothing else.
 */

export type PolicyContext = {
  role: RoleKind;
  access: "write" | "read-only" | "none";
  /** The role's worktree root. */
  worktree: string;
  owns: OwnershipSpec;
  /** Registry commands this spec may run (checks + baseline). Argv prefixes, never free text. */
  commands: readonly RegistryCommand[];
  nodeModules: "junction" | "none" | "real-install-only";
  mayChangeDependencies: boolean;
  allowWeb: boolean;
  /** Registry `denyRead` globs (repo-relative), on top of the global secret paths. */
  denyRead?: readonly string[];
  /** The canonical checkout(s) and the live OS checkout: never touched by an agent. */
  protectedRoots: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected for tests; defaults to realpath of the longest existing ancestor. */
  realpath?: (path: string) => string;
};

type Rule = PolicyDecision["rule"];
const allow = (rule: Rule, target: string, message = "Allowed by the coding policy."): PolicyVerdict => ({ decision: "auto-allow", rule, target: short(target), message });
const deny = (rule: Rule, target: string, message: string): PolicyVerdict => ({ decision: "auto-deny", rule, target: short(target), message });
const escalate = (rule: Rule, target: string, message: string): PolicyVerdict => ({ decision: "escalate", rule, target: short(target), message });
const short = (value: string) => redactText(value, 200).replace(/\s+/g, " ").trim().slice(0, 160);

export const MESSAGES = {
  notOwned: "That file is outside your owned files. Don't change it; report what you'd change in your summary instead.",
  readOnly: "You are a read-only role. Don't change files or run commands that do; report your findings instead.",
  secret: "That path holds secrets or credentials and is off limits. Continue without it.",
  outside: "Reads and writes are confined to your worktree. Work with the files in it.",
  gitConsequential: "Pushing, merging, rebasing, resetting, switching branches and similar git actions belong to the orchestrator, not to agents. Commit your owned files and stop.",
  gitConfig: "Changing git config or worktrees is not allowed for agents.",
  dependency: "Installing or changing packages is not allowed here (node_modules is shared). Report the dependency you need instead.",
  deploy: "Deploying, publishing and production commands are never agent actions. Report what should ship instead.",
  network: "Network access is off for coding roles.",
  mcp: "MCP tools are not available to coding roles.",
  destructive: "Recursive deletes, links and system changes are not allowed. Delete only single owned files.",
  runtime: "Commands that build paths or code at run time can't be checked, so they're refused. Use plain commands with literal paths inside your worktree.",
  live: "That reaches outside your worktree (the live checkout or another folder). Stay inside your worktree.",
  unclassified: "The coding policy can't decide this one, so the owner is being asked.",
  question: "The agent is asking the owner a question.",
  agentConfig: "Agent and tool configuration (.claude, .codex, hooks, MCP config, CLAUDE.md/AGENTS.md, git attributes, package-manager config) is never changed by a coding role. Report the change you'd make instead.",
  monitor: "Background monitors and WebSockets aren't available to coding roles. Run the command with Bash, where the policy checks it.",
  readerRuns: "That form of the command can run programs or write files, so it isn't auto-allowed. Use a plain read (cat, head, grep, rg without --pre, sed -n with a simple print).",
  pathless: "A file change must say which files it touches.",
  testsByOrchestrator: "The orchestrator runs the tests for read-only roles; read its results instead.",
};

// ─────────────────────────── paths ───────────────────────────

type Place =
  | { kind: "worktree"; rel: string; dependency: boolean }
  | { kind: "outside"; resolved: string };

function placer(ctx: PolicyContext) {
  const platform = ctx.platform ?? process.platform;
  const p = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const real = ctx.realpath ?? ((x: string) => realResolve(x, platform));
  const wtLexical = p.resolve(ctx.worktree);
  const wtReal = real(wtLexical);
  const guard: LiveCheckoutGuard = { protectedRoot: ctx.protectedRoots[0] ?? wtLexical, cwd: wtLexical, platform, env: ctx.env, home: ctx.home, realpath: ctx.realpath };
  const rel = (from: string, to: string) => p.relative(from, to).split(p.sep).join("/");
  return (raw: string): Place => {
    const expanded = expandPathText(String(raw), guard);
    // R3: "C:secret" is relative to that DRIVE's current folder, which isn't necessarily the worktree:
    // a drive-relative path is never treated as inside.
    if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(expanded)) return { kind: "outside", resolved: expanded };
    const lexical = p.resolve(wtLexical, expanded);
    // node_modules is a junction to the canonical checkout's: its lexical path is inside the worktree,
    // its real path is not. Reading dependencies is fine; writing them never is.
    if (ctx.nodeModules === "junction" && insidePath(lexical, p.join(wtLexical, "node_modules"), platform))
      return { kind: "worktree", rel: rel(wtLexical, lexical), dependency: true };
    const resolved = real(lexical);
    if (!insidePath(resolved, wtReal, platform)) return { kind: "outside", resolved };
    return { kind: "worktree", rel: rel(wtReal, resolved), dependency: false };
  };
}


function secretOrDenied(ctx: PolicyContext, rawRel: string): string | null {
  const rel = windowsName(rawRel);
  const kind = secretPath(rel);
  if (kind) return kind;
  if ((ctx.denyRead ?? []).some((g) => globToRegExp(g).test(rel))) return "registry-deny-read";
  return null;
}

const isGitInternal = (rel: string) => rel === ".git" || rel.startsWith(".git/");

/** Decide a read of one path. */
function readVerdict(ctx: PolicyContext, place: (raw: string) => Place, raw: unknown, target: string): PolicyVerdict {
  if (raw === undefined || raw === null || raw === "") return allow("read-in-worktree", target);
  if (typeof raw !== "string") return deny("unclassified", target, MESSAGES.outside);
  const where = place(raw);
  if (where.kind === "outside") return deny("read-outside-worktree", target, MESSAGES.outside);
  if (secretOrDenied(ctx, where.rel)) return deny("secret-path", target, MESSAGES.secret);
  return allow("read-in-worktree", target);
}

/** Decide a write of one path. */
function writeVerdict(ctx: PolicyContext, place: (raw: string) => Place, raw: unknown, target: string): PolicyVerdict {
  if (ctx.access !== "write") return deny("edit-not-owned", target, MESSAGES.readOnly);
  if (typeof raw !== "string" || !raw) return deny("unclassified", target, MESSAGES.pathless);
  const where = place(raw);
  if (where.kind === "outside") return deny("live-checkout", target, MESSAGES.live);
  if (where.dependency) return deny("dependency-install", target, MESSAGES.dependency);
  if (secretOrDenied(ctx, where.rel)) return deny("secret-path", target, MESSAGES.secret);
  if (isGitInternal(windowsName(where.rel))) return deny("git-config", target, MESSAGES.gitConfig);
  if (isAgentConfig(where.rel)) return deny("agent-config", target, MESSAGES.agentConfig);
  if (!ownsPath(ctx.owns, where.rel) || windowsName(where.rel) !== where.rel) return deny("edit-not-owned", target, MESSAGES.notOwned);
  return allow("edit-owned", target);
}

// ─────────────────────────── shell text ───────────────────────────

/** Things only run time knows: never guessed at. */
const RUNTIME = [
  /\$\(/, /`/, /\$\{/, /\$[A-Za-z_][A-Za-z0-9_]*/, /%[A-Za-z_][A-Za-z0-9_()]*%/, /\$env:/i,
  /(?:^|\s)-(?:EncodedCommand|enc|ec)(?:\s|$)/i, /\bInvoke-Expression\b|\biex\b/i, /\beval\b/, /\bsource\b\s/,
  /\[Environment\]::/i, /\bGetFolderPath\b/i, /\bPush-Location\s+\$/i,
];
/** Interpreters given code inline (`python -c`, `node -e` …): the code can do anything. */
const INLINE_CODE = /^(?:python|python3|py|node|bun|deno|perl|ruby|php|lua)$/i;
const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-r", "--exec"]);
const SHELLS = /^(?:bash|sh|zsh|dash|fish|cmd|powershell|pwsh|wsl)$/i;

/** Split on unquoted &&, ||, ;, |, newlines. Returns null when quotes don't balance. */
export function splitSegments(text: string): string[] | null {
  const out: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\n" || c === "\r" || c === ";") { out.push(cur); cur = ""; continue; }
    if ((c === "&" && text[i + 1] === "&") || (c === "|" && text[i + 1] === "|")) { out.push(cur); cur = ""; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    if (c === "&" && !/[0-9>]/.test(text[i - 1] ?? "") && text[i + 1] !== ">") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (quote) return null;
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words with quotes removed, plus the redirect targets found in one segment. */
export function tokenize(segment: string): { words: string[]; redirects: string[] } {
  const words: string[] = [];
  const redirects: string[] = [];
  const re = /(\d?>>?|<)\s*("[^"]*"|'[^']*'|[^\s"'<>]+)|"([^"]*)"|'([^']*)'|([^\s"'<>]+)/g;
  for (const m of segment.matchAll(re)) {
    if (m[1]) {
      const target = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "<") words.push(target);
      else if (!/^&\d$/.test(target)) redirects.push(target);
      continue;
    }
    words.push(m[3] ?? m[4] ?? m[5]);
  }
  return { words, redirects };
}

const NULL_SINKS = /^(?:\/dev\/null|nul|\$null|NUL)$/i;
const prog = (word: string) => nodePath.win32.basename(nodePath.posix.basename(word)).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();

/** `bash -lc "<inner>"`, `pwsh -NoProfile -Command "<inner>"`, `cmd /c <inner>`: the command Codex wraps. */
export function unwrapShell(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^\s*(?:"([^"]+)"|(\S+))\s+(.*)$/s.exec(t);
    if (!m) return t;
    const program = prog(m[1] ?? m[2]);
    if (!SHELLS.test(program)) return t;
    const rest = m[3];
    const flag = /^((?:-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\S+|l|i)\s+)*)(-lc|-c|-Command|\/c|\/d\s+\/s\s+\/c|\/s\s+\/c)\s+(.*)$/is.exec(rest);
    if (!flag) return t;
    let inner = flag[3].trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) inner = inner.slice(1, -1);
    t = inner;
  }
  return t;
}

const READ_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "find", "pwd", "echo", "printf", "stat", "file",
  "diff", "which", "where", "cut", "less", "more", "get-content", "gc", "get-childitem", "gci",
  "select-string", "sls", "test-path", "get-item", "gi", "get-location", "resolve-path", "measure-object", "write-output", "write-host",
  "findstr", "true", "false", "basename", "dirname", "realpath", "tr", "jq", "cd", "chdir", "set-location", "sl",
]);
const NETWORK = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "telnet", "rsync", "start-bitstransfer", "bitsadmin", "certutil", "http", "httpie", "aria2c"]);
const DEPLOY = new Set(["vercel", "netlify", "wrangler", "flyctl", "fly", "firebase", "supabase", "heroku", "railway", "gh", "kubectl", "helm", "terraform", "pulumi", "twilio", "retell", "aws", "gcloud", "az", "doctl"]);
const SYSTEM = new Set(["format", "diskpart", "shutdown", "reg", "regedit", "schtasks", "sc", "bcdedit", "takeown", "icacls", "cacls", "attrib", "net", "netsh", "setx", "mklink", "ln", "fsutil", "junction", "new-psdrive", "subst", "runas", "sudo", "su", "chown", "chmod", "start-process", "saps", "start", "taskkill", "stop-process", "kill", "wmic", "reg.exe"]);
const DELETE = new Set(["rm", "del", "erase", "remove-item", "ri", "rmdir", "rd", "unlink"]);
const CREATE = new Set(["touch", "new-item", "ni", "mkdir", "md"]);
const MOVE = new Set(["mv", "cp", "move", "copy", "move-item", "mi", "copy-item", "cpi", "xcopy", "robocopy"]);
const PKG = new Set(["bun", "npm", "pnpm", "yarn", "pip", "pip3", "uv", "cargo", "go", "gem", "composer", "npx", "bunx", "pnpx"]);
const PKG_INSTALL = /^(?:install|i|add|remove|rm|uninstall|un|update|up|upgrade|link|unlink|ci|dedupe|prune|pm|patch|get)$/i;
const RECURSIVE = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|\/s|-recurse|-force)$/i;
const LOCAL_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "cat-file", "ls-tree", "rev-list", "name-rev", "merge-base", "whatchanged", "annotate", "count-objects", "check-ignore", "check-attr", "var", "help", "version"]);
const GIT_CONFIG = new Set(["config", "worktree", "hooks", "submodule", "lfs"]);
const GIT_CONSEQUENTIAL = new Set(["push", "merge", "rebase", "reset", "stash", "checkout", "switch", "restore", "clean", "cherry-pick", "revert", "tag", "fetch", "pull", "remote", "filter-branch", "filter-repo", "update-ref", "update-index", "gc", "prune", "am", "apply", "notes", "replace", "bisect", "symbolic-ref", "clone", "init", "reflog", "read-tree", "write-tree", "commit-tree", "pack-refs", "repack", "fsck", "maintenance", "sparse-checkout", "archive", "bundle", "send-email", "request-pull", "format-patch", "credential", "daemon", "http-backend", "instaweb", "svn", "p4"]);

type SegmentVerdict = PolicyVerdict;

/** Packages and binaries that deploy or publish (REVIEW-T3 F5): never asked about, always refused. */
const DEPLOY_PKG = /^(?:@[\w.-]+\/)?(?:vercel|now|netlify|netlify-cli|wrangler|firebase|firebase-tools|flyctl|fly|surge|gh-pages|railway|heroku|supabase|serverless|sls|aws-cdk|cdk|pulumi|terraform|eas|eas-cli|expo|gh|np|release-it|semantic-release|changeset|lerna)(?:@[^/\s]*)?$/i;
const DEPLOY_BIN = /(?:^|[\\/])(?:vercel|netlify|wrangler|firebase|flyctl|fly|surge|gh-pages|heroku|railway|release-it|semantic-release)(?:\.(?:c?js|mjs|cmd|exe|ps1|bat))?$/i;
const DEPLOY_SCRIPT = /(?:^|[:_-])(?:deploy|release|publish|ship|promote|prod|production)(?:$|[:_-])/i;

/** npx/bunx/pnpx/pnpm dlx/npm exec/yarn dlx/bun x of a deploy tool, a deploy-ish run script, or a deploy binary by path. */
export function deploysSomething(program: string, args: readonly string[]): boolean {
  const positional = args.filter((a) => !a.startsWith("-"));
  if (args.some((a) => DEPLOY_BIN.test(a))) return true;
  if (["npx", "bunx", "pnpx"].includes(program)) return !!positional[0] && DEPLOY_PKG.test(positional[0]);
  if (!["npm", "pnpm", "yarn", "bun"].includes(program)) return false;
  const [verb, next] = positional;
  if (!verb) return false;
  if (/^(?:publish|deploy|release)$/i.test(verb)) return true;
  if (/^(?:dlx|exec|x)$/i.test(verb)) return !!next && DEPLOY_PKG.test(next);
  if (/^(?:run|run-script|rum|urn)$/i.test(verb)) return !!next && DEPLOY_SCRIPT.test(next);
  // pnpm/yarn/bun run a package script by bare name ("yarn deploy", "bun deploy:prod").
  if (program !== "npm") return DEPLOY_SCRIPT.test(verb);
  return false;
}

/** A sed script that only prints (p), or substitutes with plain flags: no e/r/R/w/W commands. */
const SED_PRINT = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?|\/(?:[^/\\\n]|\\.)*\/)?\s*p\s*$/;
const SED_SUBST = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*)?s([/|#,])(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1[gI0-9]*\s*$/;

/** sed: a proven read-only print (or an in-place plain substitution of OWNED files). Anything else escalates. */
function sedVerdict(ctx: PolicyContext, place: (raw: string) => Place, args: string[], target: string): SegmentVerdict {
  const scripts: string[] = [];
  const files: string[] = [];
  let inPlace = false, quiet = false, explicit = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-e" || a === "--expression") { scripts.push(args[++k] ?? ""); explicit = true; continue; }
    if (/^--expression=/.test(a)) { scripts.push(a.slice(a.indexOf("=") + 1)); explicit = true; continue; }
    if (a === "-n" || a === "--quiet" || a === "--silent") { quiet = true; continue; }
    if (a === "-E" || a === "-r" || a === "--regexp-extended") continue;
    if (a === "-i" || a === "--in-place") { inPlace = true; continue; }
    if (a.startsWith("-")) return escalate("unclassified", target, MESSAGES.readerRuns);
    if (!explicit && !scripts.length) { scripts.push(a); continue; }
    files.push(a);
  }
  if (!scripts.length) return escalate("unclassified", target, MESSAGES.readerRuns);
  const parts = scripts.flatMap((sc) => sc.split(/[;\n]/)).filter((p) => p.trim());
  const safe = parts.length > 0 && parts.every((p) => (quiet && SED_PRINT.test(p)) || SED_SUBST.test(p));
  if (!safe) return escalate("unclassified", target, MESSAGES.readerRuns);
  if (inPlace && !files.length) return escalate("unclassified", target, MESSAGES.readerRuns);
  for (const file of files) {
    const v = inPlace ? writeVerdict(ctx, place, file, target) : readVerdict(ctx, place, file, target);
    if (v.decision !== "auto-allow") return v;
  }
  return inPlace ? allow("edit-owned", target) : allow("read-in-worktree", target);
}

/** ripgrep flags proven not to run a program or write a file (REVIEW-T3 F2: --pre and --hostname-bin run one). */
const RG_FLAG = /^-(?:[nilcwFvoSsuUxLHhNqz0.]+|[ABCmegtTMdf])$|^--(?:line-number|ignore-case|smart-case|case-sensitive|files-with-matches|files-without-match|count|count-matches|word-regexp|line-regexp|fixed-strings|invert-match|only-matching|hidden|no-ignore|no-ignore-vcs|files|json|no-heading|heading|with-filename|no-filename|null|stats|vimgrep|column|sort|sortr|max-count|max-depth|max-filesize|glob|iglob|type|type-not|type-list|context|before-context|after-context|max-columns|multiline|pcre2|regexp|file|trim|color|colors|follow|unrestricted|search-zip|text|binary|quiet|replace|passthru|crlf|encoding|threads|no-mmap|one-file-system|path-separator)(?:=.*)?$/;
const RG_VALUE = new Set(["-A", "-B", "-C", "-m", "-e", "-g", "-t", "-T", "-M", "-d", "-f", "-r", "--max-count", "--max-depth", "--glob", "--iglob", "--type", "--type-not", "--context", "--before-context", "--after-context", "--max-columns", "--regexp", "--file", "--replace", "--sort", "--sortr", "--color", "--colors", "--encoding", "--threads", "--path-separator", "--max-filesize"]);

function rgVerdict(ctx: PolicyContext, place: (raw: string) => Place, args: string[], target: string): SegmentVerdict {
  let pattern = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") continue;
    if (a.startsWith("-")) {
      if (/^--(?:pre|hostname-bin)/.test(a)) return deny("runtime-path", target, MESSAGES.readerRuns);
      if (!RG_FLAG.test(a)) return escalate("unclassified", target, MESSAGES.readerRuns);
      if (a === "-e" || a === "--regexp" || a.startsWith("--regexp=")) pattern = true;
      if (a === "-f" || a === "--file") { const v = readVerdict(ctx, place, args[k + 1] ?? "", target); if (v.decision !== "auto-allow") return v; }
      if (RG_VALUE.has(a)) k++;
      continue;
    }
    if (!pattern) { pattern = true; continue; }
    const v = readVerdict(ctx, place, a, target);
    if (v.decision !== "auto-allow") return v;
  }
  return allow("read-in-worktree", target);
}

function registryMatch(ctx: PolicyContext, words: readonly string[]): RegistryCommand | null {
  for (const command of ctx.commands) {
    const argv = command.argv;
    if (words.length < argv.length) continue;
    if (prog(words[0]) !== prog(argv[0])) continue;
    if (argv.slice(1).every((a, i) => words[i + 1] === a)) return command;
  }
  return null;
}

function gitSegment(ctx: PolicyContext, place: (raw: string) => Place, words: string[], target: string): SegmentVerdict {
  let i = 1;
  // Global options: -c (config override: can run programs), -C / --git-dir / --work-tree (another repo).
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-c" || w.startsWith("--config-env") || w.startsWith("-c")) return deny("git-config", target, MESSAGES.gitConfig);
    if (w === "-C" || w.startsWith("--git-dir") || w.startsWith("--work-tree") || w.startsWith("--namespace") || w.startsWith("--exec-path")) {
      const dest = w.includes("=") ? w.split("=")[1] : words[i + 1];
      const where = dest ? place(dest) : null;
      if (!where || where.kind === "outside" || w !== "-C") return deny("live-checkout", target, MESSAGES.live);
      i += 2;
      continue;
    }
    i++;
  }
  const sub = (words[i] ?? "").toLowerCase();
  const args = words.slice(i + 1);
  if (!sub) return allow("git-local-safe", target);
  if (GIT_CONFIG.has(sub)) return deny("git-config", target, MESSAGES.gitConfig);
  if (GIT_CONSEQUENTIAL.has(sub)) return deny("git-consequential", target, MESSAGES.gitConsequential);
  if (GIT_READ.has(sub)) {
    if (args.some((a) => /^--(?:output|ext-diff|textconv|open-files-in-pager)/.test(a) || /^-O/.test(a))) return deny("git-config", target, MESSAGES.readerRuns);
    for (const a of args) {
      // Every path-like argument, including an option's value (--no-index a b, --file=x, -- paths).
      // R3: a drive-relative path ("C:secret") stays whole (placer refuses it); a rev or index-stage prefix
      // ("HEAD:", ":", ":0:".. ":3:") is stripped to the path it names.
      const raw = a.startsWith("-") ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : "") : a;
      const value = /^[A-Za-z]:(?![\\/])/.test(raw) ? raw : raw.replace(/^(?::[0-3]:|[^:]*:)(?=.)/, "");
      // A bare secret name ("git diff --no-index .env x", "git show HEAD:.env") is a path too (REVIEW-T3 R2).
      if (!value || (!/[\\/]|^\.{1,2}$|^~|^[A-Za-z]:/.test(value) && !secretOrDenied(ctx, value.replace(/^["']|["']$/g, "")))) continue;
      const v = readVerdict(ctx, place, value, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("git-local-safe", target);
  }
  if (sub === "branch") {
    const plain = args.every((a) => ["--show-current", "-a", "--all", "--list", "-l", "-v", "-vv", "-r", "--no-color", "--contains", "--merged"].includes(a));
    return plain ? allow("git-local-safe", target) : deny("git-consequential", target, MESSAGES.gitConsequential);
  }
  if (ctx.access !== "write") return deny("edit-not-owned", target, MESSAGES.readOnly);
  if (sub === "add" || sub === "rm" || sub === "mv") {
    const paths = args.filter((a) => a !== "--" && !a.startsWith("-"));
    if (args.some((a) => /^(?:-A|--all|-u|--update|--no-ignore-removal|-f|--force|--chmod.*|-p|--patch|-i|--interactive)$/.test(a))) return deny("git-consequential", target, MESSAGES.gitConsequential);
    if (!paths.length || paths.some((p) => p === "." || p === ":/" || p.includes("*") || p.startsWith(":"))) return deny("git-consequential", target, MESSAGES.gitConsequential);
    for (const p of paths) {
      const v = writeVerdict(ctx, place, p, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("git-local-safe", target);
  }
  if (sub === "commit") {
    if (args.some((a) => /^(?:-a|--all|-am|--amend|--fixup.*|--squash.*|-i|--include|-o|--only|--interactive|-p|--patch|--pathspec-from-file.*|-c|-C)$/.test(a) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && a !== "--allow-empty"))
      return deny("git-consequential", target, MESSAGES.gitConsequential);
    // `git commit <paths>` commits those paths: they must be owned. Message values after -m/-F are skipped.
    const rest: string[] = [];
    for (let k = 0; k < args.length; k++) {
      // -F/--file and -t/--template READ a file into the message (REVIEW-T3 F3): it must be a readable
      // worktree file, never a secret or anything outside.
      const fileOpt = /^(?:-F|--file|-t|--template)(?:=(.*))?$/.exec(args[k]) ?? /^-F(.+)$/.exec(args[k]) ?? /^-t(.+)$/.exec(args[k]);
      if (fileOpt) {
        const value = fileOpt[1] ?? args[k + 1];
        if (!fileOpt[1]) k++;
        if (!value) return deny("unclassified", target, MESSAGES.pathless);
        if (value !== "-") {
          const v = readVerdict(ctx, place, value, target);
          if (v.decision !== "auto-allow") return v;
        }
        continue;
      }
      if (["-m", "--message", "--author", "--date", "--cleanup", "--trailer"].includes(args[k])) { k++; continue; }
      if (args[k].startsWith("-") || args[k] === "--") continue;
      rest.push(args[k]);
    }
    for (const p of rest) {
      const v = writeVerdict(ctx, place, p, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("git-local-safe", target);
  }
  return escalate("unclassified", target, MESSAGES.unclassified);
}

function segmentVerdict(ctx: PolicyContext, place: (raw: string) => Place, segment: string): SegmentVerdict {
  const { words, redirects } = tokenize(segment);
  const target = words.slice(0, 3).join(" ") || segment;
  if (!words.length) return allow("read-in-worktree", target);
  for (const r of redirects) {
    if (NULL_SINKS.test(r)) continue;
    const v = writeVerdict(ctx, place, r, target);
    if (v.decision !== "auto-allow") return v;
  }
  const program = prog(words[0]);
  const args = words.slice(1);
  if (SHELLS.test(program)) return deny("runtime-path", target, MESSAGES.runtime);
  if (INLINE_CODE.test(program) && args.some((a) => INLINE_FLAGS.has(a))) return deny("runtime-path", target, MESSAGES.runtime);
  if (program === "git") return gitSegment(ctx, place, words, target);
  const registry = registryMatch(ctx, words);
  if (registry) {
    if (ctx.access !== "write") return deny("registry-command", target, MESSAGES.testsByOrchestrator);
    for (const a of words.slice(registry.argv.length)) if (!a.startsWith("-") && /[\\/.]/.test(a) && !/^\d/.test(a)) {
      const v = readVerdict(ctx, place, a, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("registry-command", target);
  }
  if (DEPLOY.has(program) || deploysSomething(program, args)) return deny("deploy-tool", target, MESSAGES.deploy);
  if ((program === "npx" || program === "bunx" || program === "pnpx") && /prisma/i.test(args.join(" ")) && /migrate|db\s+push|deploy/i.test(args.join(" ")))
    return deny("deploy-tool", target, MESSAGES.deploy);
  if (/^(?:prisma)$/.test(program) && /migrate|db/i.test(args.join(" "))) return deny("deploy-tool", target, MESSAGES.deploy);
  if (program === "docker" && /\b(?:push|login)\b/.test(args.join(" "))) return deny("deploy-tool", target, MESSAGES.deploy);
  if (NETWORK.has(program)) {
    const urls = args.filter((a) => /^[a-z]+:\/\//i.test(a) || /^(?:localhost|127\.|\[::1\])/.test(a) || /\.[a-z]{2,}(?:[/:]|$)/i.test(a));
    if (urls.length && urls.every((u) => LOCAL_URL.test(u))) return escalate("network", target, MESSAGES.unclassified);
    return deny("network", target, MESSAGES.network);
  }
  if (SYSTEM.has(program)) {
    if (program === "mklink" || program === "ln" || program === "junction" || program === "fsutil") return deny("destructive-fs", target, LINK_REFUSAL);
    return deny("destructive-fs", target, MESSAGES.destructive);
  }
  if (CREATE.has(program) && args.some((a) => /^(?:SymbolicLink|Junction|HardLink)$/i.test(a))) return deny("destructive-fs", target, LINK_REFUSAL);
  if (PKG.has(program)) {
    const verb = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
    if (program === "npm" && verb === "publish") return deny("deploy-tool", target, MESSAGES.deploy);
    if (PKG_INSTALL.test(verb) || ((program === "npx" || program === "bunx" || program === "pnpx") && args.some((a) => /^-(?:y|-yes|p|-package)$/.test(a)))) {
      if (ctx.nodeModules === "junction" || !ctx.mayChangeDependencies) return deny("dependency-install", target, MESSAGES.dependency);
      return escalate("dependency-install", target, MESSAGES.unclassified);
    }
    return escalate("unclassified", target, MESSAGES.unclassified);
  }
  if (DELETE.has(program)) {
    if (args.some((a) => RECURSIVE.test(a))) return deny("destructive-fs", target, MESSAGES.destructive);
    const paths = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));
    if (!paths.length || paths.some((p) => /[*?]/.test(p))) return deny("destructive-fs", target, MESSAGES.destructive);
    for (const p of paths) {
      const v = writeVerdict(ctx, place, p, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("edit-owned", target);
  }
  if (CREATE.has(program) || MOVE.has(program)) {
    const paths = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]+$/i.test(a) && !/^(?:File|Directory)$/i.test(a));
    if (!paths.length) return escalate("unclassified", target, MESSAGES.unclassified);
    const isDir = program === "mkdir" || program === "md" || (program === "new-item" || program === "ni") && args.some((a) => /^Directory$/i.test(a));
    const sources = MOVE.has(program) ? paths.slice(0, -1) : [];
    const dests = MOVE.has(program) ? paths.slice(-1) : paths;
    for (const s of sources) {
      const v = program.startsWith("cp") || program.startsWith("copy") || program === "xcopy" || program === "robocopy"
        ? readVerdict(ctx, place, s, target)
        : writeVerdict(ctx, place, s, target);
      if (v.decision !== "auto-allow") return v;
    }
    for (const d of dests) {
      if (isDir) {
        const where = place(d);
        if (where.kind === "outside") return deny("live-checkout", target, MESSAGES.live);
        if (ctx.access !== "write") return deny("edit-not-owned", target, MESSAGES.readOnly);
        continue;
      }
      const v = writeVerdict(ctx, place, d, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("edit-owned", target);
  }
  // Readers that can also run programs or write files (REVIEW-T3 F2): parsed precisely, else escalated.
  if (program === "sed") return sedVerdict(ctx, place, args, target);
  if (program === "rg") return rgVerdict(ctx, place, args, target);
  if (["awk", "gawk", "mawk", "nawk", "perl", "ruby", "xargs", "parallel", "watch", "env", "nohup", "timeout", "time", "command", "busybox"].includes(program)) return escalate("unclassified", target, MESSAGES.readerRuns);
  if (program === "tee") {
    const files = args.filter((a) => !a.startsWith("-"));
    for (const file of files) { const v = writeVerdict(ctx, place, file, target); if (v.decision !== "auto-allow") return v; }
    return files.length ? allow("edit-owned", target) : allow("read-in-worktree", target);
  }
  if (program === "sort" || program === "uniq" || program === "tree") {
    if (args.some((a) => /^(?:-o|--output)/.test(a))) return escalate("unclassified", target, MESSAGES.readerRuns);
    const positional = args.filter((a) => !a.startsWith("-"));
    if (program === "uniq" && positional.length > 1) return writeVerdict(ctx, place, positional[1], target);
    for (const p of positional) { const v = readVerdict(ctx, place, p, target); if (v.decision !== "auto-allow") return v; }
    return allow("read-in-worktree", target);
  }
  if (READ_COMMANDS.has(program)) {
    if (program === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|f(?:print\w*|ls))$/.test(a))) return deny("destructive-fs", target, MESSAGES.destructive);
    for (const a of args) {
      if (a.startsWith("-") && !/^-[^=]*=/.test(a)) continue;
      const value = a.replace(/^-[^=]*=/, "");
      // Printing commands take text, not paths; every other argument is checked as a path.
      if (["echo", "printf", "write-output", "write-host", "true", "false"].includes(program)) continue;
      if (!value) continue;
      const v = readVerdict(ctx, place, value, target);
      if (v.decision !== "auto-allow") return v;
    }
    return allow("read-in-worktree", target);
  }
  return escalate("unclassified", target, MESSAGES.unclassified);
}

/** Decide a whole shell command line (Claude's Bash/PowerShell input, or Codex's command). */
export function commandVerdict(ctx: PolicyContext, text: string): PolicyVerdict {
  const raw = String(text ?? "");
  const head = short(raw);
  if (!raw.trim()) return escalate("unclassified", head, MESSAGES.unclassified);
  const inner = unwrapShell(raw);
  const target = short(inner);
  // The live checkout and any other protected root: the C1 guard (paths expanded, 8.3 and Git Bash
  // spellings normalised, junctions followed), with the worktree as the task folder.
  for (const root of ctx.protectedRoots) {
    const refusal = commandRefusal(inner, { protectedRoot: root, cwd: ctx.worktree, platform: ctx.platform, env: ctx.env, home: ctx.home, realpath: ctx.realpath });
    if (refusal === LINK_REFUSAL) return deny("destructive-fs", target, LINK_REFUSAL);
    if (refusal) return deny("live-checkout", target, MESSAGES.live);
  }
  // Single-quoted text is literal in bash and PowerShell; PowerShell's constants aren't paths.
  const expandable = inner.replace(/'[^']*'/g, "''").replace(/\$(?:null|true|false|LASTEXITCODE)\b|\$\?/gi, "");
  if (RUNTIME.some((re) => re.test(expandable))) return deny("runtime-path", target, MESSAGES.runtime);
  const segments = splitSegments(inner);
  if (!segments) return deny("runtime-path", target, MESSAGES.runtime);
  const place = placer(ctx);
  const verdicts = segments.map((s) => segmentVerdict(ctx, place, s));
  const denied = verdicts.find((v) => v.decision === "auto-deny");
  if (denied) return { ...denied, target };
  const escalated = verdicts.find((v) => v.decision === "escalate");
  if (escalated) return { ...escalated, target };
  const order: Rule[] = ["registry-command", "edit-owned", "git-local-safe", "read-in-worktree"];
  const rule = order.find((r) => verdicts.some((v) => v.rule === r)) ?? verdicts[0].rule;
  return allow(rule, target);
}

// ─────────────────────────── tools ───────────────────────────

const READ_TOOLS: Record<string, string[]> = {
  Read: ["file_path"], Grep: ["path"], Glob: ["path"], LS: ["path"], NotebookRead: ["notebook_path"],
};
const WRITE_TOOLS: Record<string, string[]> = {
  Edit: ["file_path"], Write: ["file_path"], MultiEdit: ["file_path"], NotebookEdit: ["notebook_path"],
};
/** Bookkeeping tools that touch nothing outside the session (sub-agents' own tool calls come back here). */
/** Only bookkeeping that runs nothing (REVIEW-T3 F1: Monitor runs commands and WebSockets; Task/Agent start
 * sub-agents; ToolSearch loads tools). The Claude runner also passes an explicit --tools allowlist. */
const HARMLESS = new Set(["TodoWrite", "TodoRead", "ExitPlanMode", "StructuredOutput"]);
/** Claude Code 2.1.280 tools that act outside the role (verified in system/init, 28 Sep): worktrees are the
 * orchestrator's; schedules, remote triggers, notifications, workflows and design sync are never a role's. */
const NOT_FOR_ROLES = new Set(["Task", "Agent", "ToolSearch", "Skill", "BashOutput", "KillShell", "KillBash", "TaskOutput", "TaskStop", "EnterPlanMode", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList", "RemoteTrigger", "PushNotification", "ScheduleWakeup", "Workflow", "DesignSync", "SendMessage", "ListAgents", "ReportFindings"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

function toolVerdict(ctx: PolicyContext, tool: string, input: Record<string, unknown>): PolicyVerdict {
  const place = placer(ctx);
  if (/^mcp__/.test(tool) || tool === "ListMcpResourcesTool" || tool === "ReadMcpResourceTool") return deny("mcp-tool", tool, MESSAGES.mcp);
  if (READ_TOOLS[tool]) {
    const field = READ_TOOLS[tool].find((f) => input[f] !== undefined);
    const raw = field ? input[field] : undefined;
    const v = readVerdict(ctx, place, raw, `${tool} ${typeof raw === "string" ? nodePath.basename(raw) : ""}`);
    if (v.decision !== "auto-allow") return v;
    // Glob/Grep patterns can't climb out either.
    const pattern = typeof input.pattern === "string" && tool === "Glob" ? input.pattern : null;
    if (pattern && /(^|[\\/])\.\.([\\/]|$)/.test(pattern)) return deny("read-outside-worktree", `${tool} pattern`, MESSAGES.outside);
    if (pattern && (nodePath.isAbsolute(pattern) || nodePath.win32.isAbsolute(pattern))) {
      const pv = readVerdict(ctx, place, pattern.replace(/[*?].*$/, "") || ".", `${tool} pattern`);
      if (pv.decision !== "auto-allow") return pv;
    }
    return v;
  }
  if (WRITE_TOOLS[tool]) {
    const field = WRITE_TOOLS[tool].find((f) => input[f] !== undefined);
    const raw = field ? input[field] : undefined;
    return writeVerdict(ctx, place, raw, `${tool} ${typeof raw === "string" ? raw : ""}`);
  }
  if (SHELL_TOOLS.has(tool)) return commandVerdict(ctx, String(input.command ?? ""));
  if (WEB_TOOLS.has(tool)) return ctx.allowWeb ? allow("network", tool, "Public docs lookup allowed for this role.") : deny("network", tool, MESSAGES.network);
  if (HARMLESS.has(tool)) return allow("harmless-tool", tool);
  if (tool === "Monitor") return deny("runtime-path", tool, MESSAGES.monitor);
  if (NOT_FOR_ROLES.has(tool)) return deny(tool.includes("Worktree") ? "git-config" : "unclassified", tool, "That tool isn't available to coding roles (the orchestrator owns worktrees, sub-agents, schedules and notifications). Continue without it.");
  return escalate("unclassified", tool, MESSAGES.unclassified);
}

/** Build the role's policy function. Pure: no IO beyond realpath of the paths it is asked about. */
export function createPolicy(ctx: PolicyContext): PolicyFn {
  return (request: PolicyRequest): PolicyVerdict => {
    try {
      switch (request.kind) {
        case "tool":
          if (request.tool === "AskUserQuestion") return escalate("unclassified", "AskUserQuestion", MESSAGES.question);
          return toolVerdict(ctx, request.tool, request.input ?? {});
        case "command":
          if (request.cwd) {
            const where = placer(ctx)(request.cwd);
            if (where.kind === "outside") return deny("live-checkout", short(request.command), MESSAGES.live);
          }
          return commandVerdict(ctx, request.command);
        case "file-change": {
          if (!request.paths.length) return deny("unclassified", "file change", MESSAGES.pathless);
          const place = placer(ctx);
          if (request.grantRoot) {
            const g = place(request.grantRoot);
            if (g.kind === "outside") return deny("live-checkout", "grant root", MESSAGES.live);
          }
          for (const path of request.paths) {
            const v = writeVerdict(ctx, place, path, `change ${path}`);
            if (v.decision !== "auto-allow") return v;
          }
          return allow("edit-owned", request.paths.map((p) => nodePath.basename(p)).join(", "));
        }
        case "permissions": {
          const text = JSON.stringify(request.permissions ?? {});
          if (/network/i.test(text)) return deny("network", "permissions", MESSAGES.network);
          return deny("live-checkout", "permissions", MESSAGES.live);
        }
        case "mcp":
          return deny("mcp-tool", `${request.server ?? "mcp"} ${request.tool ?? ""}`.trim(), MESSAGES.mcp);
        case "question":
          return escalate("unclassified", "question", MESSAGES.question);
      }
    } catch {
      // A policy bug never becomes an allow.
      return escalate("unclassified", "policy error", MESSAGES.unclassified);
    }
    return escalate("unclassified", "unknown", MESSAGES.unclassified);
  };
}
