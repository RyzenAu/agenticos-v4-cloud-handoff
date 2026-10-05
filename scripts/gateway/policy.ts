/**
 * Dot gateway: capabilities and the route/method allowlist. DEFAULT DENY.
 *
 * ONE table, used twice: the gateway refuses a request before it leaves, and the hub's identity gate refuses it again
 * (scripts/gateway/hub.ts) for the principal the assertion names. A route that is not listed here does not exist for Dot.
 *
 * Built from the hub's real classification (scripts/identity/routes.ts): a /__* rule may only name a route whose class for
 * that method is "shared" there. policy.test.ts fails when a rule names a local-owner or self route, so console-only routes,
 * identity and pairing administration, key and account routes and the founders' own desktops can never be added by mistake.
 *
 * Paths are matched exactly and case-sensitively (connect mounts case-insensitively; a case or "." variant simply matches
 * no rule and is denied). Segment patterns: a literal, "*" (one plain segment), a trailing "**" (anything below).
 */

export const CAPABILITIES = ["view", "crm.read", "crm.write", "finance.read", "finance.write", "mail.read", "mail.draft", "files.read", "files.write", "tasks.run", "memory.read", "memory.write", "coding.start", "bots.operate", "bots.terminal", "ops.read", "release.request", "ops.logs", "ops.restart"] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Every valid session has `view`. The rest need a founder's grant, which always expires. */
export const BASE_CAPABILITIES: readonly Capability[] = ["view"];
export const GRANTABLE: readonly Capability[] = CAPABILITIES.filter((c) => c !== "view");
/**
 * What `grant operate` gives in one go: the working set for Dot as the backend's operator. NOT in it, on purpose:
 * `bots.terminal` (a shell on a shared bot computer: R9-OPS says bot computers on one host are not isolated from each other,
 * so a founder grants it separately, knowingly).
 */
export const OPERATE_SET: readonly Capability[] = ["crm.read", "crm.write", "finance.read", "finance.write", "mail.read", "mail.draft", "files.read", "files.write", "tasks.run", "memory.read", "memory.write", "coding.start", "bots.operate", "ops.read", "release.request"];
/**
 * r12: what `grant debug` gives: the hub's logs (redacted) and restarts of the hub, Hermes or SearXNG. NOT part of
 * `grant operate`: a founder grants it on its own, when Dot is debugging the OS.
 */
export const DEBUG_SET: readonly Capability[] = ["ops.logs", "ops.restart"];
/** One line per capability, for the CLI, the capability matrix and Devices and people. */
export const CAPABILITY_SUMMARY: Record<Capability, string> = {
  view: "open the OS (read-only pages), coding job reads, health and version",
  "crm.read": "read CRM companies, contacts, deals, tasks, projects and documents",
  "crm.write": "create and update those records through the CRM's typed operations, and draft proposals, invoices and quotes (drafts stay drafts; nothing is issued, sent or charged)",
  "finance.read": "business finance: the ledger's business rows and summary, receivables, invoice-match suggestions, the Stripe snapshot",
  "finance.write": "categorise a business ledger row (category, kind) and link a refund to its business charge",
  "mail.read": "list and read threads in mailboxes a founder authorised for the gateway",
  "mail.draft": "save a reply draft (a CRM draft-reply record) for a message in an authorised mailbox; nothing is sent",
  "release.request": "ask for a production release (a bundle and a commit); the owner approves; the hub's release script runs",
  "files.read": "list and read files inside the approved gateway file roots",
  "files.write": "write files inside those roots (no delete)",
  "tasks.run": "start a Jarvis task through the Jev-led command path, read its own jobs, stop its own jobs",
  "memory.read": "recall from shared memory (business, research and general facts)",
  "memory.write": "remember a fact, recorded as Dot's (only while the hub's memory writes are on)",
  "coding.start": "draft a coding job, start its own draft, resume, rerun tests, stop its own job",
  "bots.operate": "shared bot computers: list, start a job, screenshots, take and return the control lease, input",
  "bots.terminal": "a terminal on a shared bot computer while holding its control lease",
  "ops.read": "diagnostics: the job log (founders' jobs as shape only), release receipts, the gateway's own audit",
  // r12 debugging (grant debug)
  "ops.logs": "the hub's logs (hub, supervisor, gateway, release, health): the last 500 lines at most, every line redacted; never an env file",
  "ops.restart": "restart the hub (through its supervisor), Hermes or SearXNG; 3 an hour, recorded in both audits",
};

export const isCapability = (value: unknown): value is Capability => typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
const READ: readonly Method[] = ["GET", "HEAD"];

export type RouteKind = "http" | "ws";
export type PolicyRule = {
  capability: Capability;
  methods: readonly Method[];
  /** Also the audit's route template. */
  pattern: string;
  kind?: RouteKind;
  why: string;
};

/** Hub (/__*) routes. Order does not matter: a request needs exactly one matching rule for its method. */
export const HUB_RULES: readonly PolicyRule[] = [
  // ── view: read APIs and the streams the UI opens ────────────────────────────────────────────────────────────
  { capability: "view", methods: READ, pattern: "/__events", why: "the live activity stream (SSE); shared-scope notifications only" },
  { capability: "view", methods: READ, pattern: "/__events/snapshot", why: "the stream's safety-poll snapshot" },
  { capability: "view", methods: READ, pattern: "/__version", why: "build metadata" },
  { capability: "view", methods: READ, pattern: "/__app_version", why: "build metadata" },
  { capability: "view", methods: READ, pattern: "/__health", why: "component status, no secrets" },
  // The Workspace panels, one by one (scripts/workspace/plugin.ts). ONLY the non-private business panels: the CRM pipeline
  // summary, the websites' uptime, and the saved workspace grouping. Not the bare /__workspace (every panel at once), not
  // today or needs-you (founders' approvals and decisions, receptionist gates, mail counts), and never the mail and call
  // panels (NEVER below).
  { capability: "view", methods: READ, pattern: "/__workspace/pipeline", why: "Workspace: the CRM pipeline summary" },
  { capability: "view", methods: READ, pattern: "/__workspace/websites", why: "Workspace: website uptime checks" },
  { capability: "view", methods: READ, pattern: "/__workspace/groups", why: "Workspace: the saved workspace grouping" },
  { capability: "view", methods: READ, pattern: "/__agents/**", why: "the Agents workspace: bots, tasks, files" },
  { capability: "view", methods: READ, pattern: "/__operator/leads/**", why: "CRM reads: leads, pipeline, follow-ups" },
  // Coding reads, one by one. NOT /__operator/coding/accounts: it runs a real sign-in check (spawns the CLIs) and returns account
  // slots, plans and usage (NEVER below).
  { capability: "view", methods: READ, pattern: "/__operator/coding/jobs", why: "coding jobs: the list" },
  { capability: "view", methods: READ, pattern: "/__operator/coding/jobs/*", why: "one coding job: plan and progress" },
  { capability: "view", methods: READ, pattern: "/__operator/coding/jobs/*/events", why: "one coding job: its events (SSE)" },
  { capability: "view", methods: READ, pattern: "/__operator/coding/repos", why: "the repositories coding jobs may use" },
  { capability: "view", methods: READ, pattern: "/__operator/coding/artefacts/*/*", why: "a coding job's saved output" },
  { capability: "view", methods: READ, pattern: "/__operator/capabilities", why: "which OS features are available" },
  // Dot's own surface on the hub (scripts/gateway/hub-ops.ts), route by route. NEVER /__gateway/** and never /__gateway/admin
  // (the founders' listing and revocation of Dot's identities).
  { capability: "view", methods: READ, pattern: "/__gateway/me", why: "who the hub thinks this request is" },
  { capability: "view", methods: READ, pattern: "/__gateway/capabilities", why: "the capability matrix as this hub sees it: working, not granted, unsupported, owner action" },
  { capability: "view", methods: READ, pattern: "/__gateway/crm/activity", why: "the clearly-marked test activities (the reversible test update)" },

  // ── crm.read / crm.write: the CRM's typed operations, the same validation founders get ──────────────────────────
  { capability: "crm.read", methods: ["POST"], pattern: "/__gateway/crm/read", why: "a CRM read operation by name (snapshot, record, queries, search)" },
  { capability: "crm.write", methods: ["POST"], pattern: "/__gateway/crm/ops", why: "a CRM write operation by name (companies, contacts, deals, tasks, activities, projects, documents as drafts)" },
  { capability: "crm.write", methods: ["POST"], pattern: "/__gateway/crm/activity", why: "crm.activity.add on the test store (idempotent on eventId)" },
  { capability: "crm.write", methods: ["DELETE"], pattern: "/__gateway/crm/activity/*", why: "undo a test activity Dot added" },

  // ── finance.read / finance.write: BUSINESS rows only (scripts/gateway/finance.ts) ──────────────────────────────────
  { capability: "finance.read", methods: READ, pattern: "/__gateway/finance/summary", why: "business income and spend by category for a period" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/finance/transactions", why: "the ledger's business rows" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/finance/receivables", why: "receivables, open invoices and match suggestions" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/finance/stripe", why: "the hub's last synced Stripe snapshot (read-only)" },
  { capability: "finance.write", methods: ["POST"], pattern: "/__gateway/finance/categorise", why: "categorise one business row, or link a refund to its business charge" },

  // ── mail.read / mail.draft: founder-authorised mailboxes only (scripts/gateway/mail.ts) ────────────────────────────
  { capability: "mail.read", methods: READ, pattern: "/__gateway/mail/mailboxes", why: "the mailboxes a founder authorised" },
  { capability: "mail.read", methods: READ, pattern: "/__gateway/mail/threads", why: "threads in an authorised mailbox (the hub's local archive)" },
  { capability: "mail.read", methods: READ, pattern: "/__gateway/mail/thread", why: "one thread in an authorised mailbox" },
  { capability: "mail.draft", methods: ["POST"], pattern: "/__gateway/mail/drafts", why: "save a reply draft as the CRM's draft-reply record; nothing is sent" },

  // ── release.request: the supported release workflow (scripts/gateway/release.ts) ───────────────────────────────────
  { capability: "release.request", methods: ["POST"], pattern: "/__gateway/release", why: "ask for a release: a commit (and a bundle holding it); the owner approves" },
  { capability: "release.request", methods: READ, pattern: "/__gateway/release", why: "release requests and their state" },
  { capability: "release.request", methods: READ, pattern: "/__gateway/release/*", why: "one release request, its receipt and run log" },
  { capability: "release.request", methods: ["POST"], pattern: "/__gateway/release/*/cancel", why: "withdraw a request still waiting for approval" },

  // ── the OS pages, answered in their founder routes' shape and filtered for Dot (scripts/gateway/ui-adapters.ts) ────
  //    The gateway's UI bundle sends a page's /__crm/snapshot (etc.) here instead (src/lib/dot-gateway.ts); the founder
  //    routes themselves stay closed. docs/gateway/DOT-UI-ROUTES.md has the page-by-page table.
  // A saved result's page and files ("Open the result" on Jarvis, Activity and company pages): the computers route serves Dot only its
  // OWN results and agent-bot results (the founders' shared-bot rule); a founder's own non-bot result is "no saved result" (scripts/computers/routes.ts).
  { capability: "tasks.run", methods: READ, pattern: "/__computers/artifacts/*", why: "a saved result's page: Dot's own, or an agent bot's" },
  { capability: "tasks.run", methods: READ, pattern: "/__computers/artifacts/*/f/*", why: "a file of a saved result Dot may open (served sandboxed, as for founders)" },
  { capability: "tasks.run", methods: READ, pattern: "/__gateway/ui/jarvis/thread", why: "the Jarvis page in Dot's browser: Dot's OWN Jarvis thread (its requests, replies and job lines); no founder thread" },
  { capability: "tasks.run", methods: ["POST"], pattern: "/__gateway/ui/jarvis/stop", why: "Stop on the Jarvis page: one of Dot's own jobs only (as POST /__gateway/jobs/<id>/stop)" },
  { capability: "crm.read", methods: READ, pattern: "/__gateway/ui/crm/snapshot", why: "the CRM page's snapshot (what /__gateway/crm/read crm.snapshot returns)" },
  { capability: "crm.read", methods: READ, pattern: "/__gateway/ui/crm/record", why: "a CRM record page" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/ui/crm/finance", why: "a company's Stripe invoice links on its CRM page (business finance)" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/ui/finance/summary", why: "the Finance page's summary over business rows only" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/ui/finance/status", why: "the Finance page's status over business rows only" },
  { capability: "finance.read", methods: READ, pattern: "/__gateway/ui/finance/transactions", why: "the Finance page's rows: business rows only" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/ui/jobs", why: "the Activity list: Dot's jobs in full, founders' jobs as shape only (B1)" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/ui/jobs/events", why: "job events for Dot's own jobs only" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/ui/jobs/*", why: "one job: Dot's in full, a founder's as shape only" },
  { capability: "bots.operate", methods: READ, pattern: "/__gateway/ui/computers", why: "the computers list: shared bot computers only, no targets" },
  { capability: "finance.read", methods: READ, pattern: "/__operator/business/finance/stripe/status", why: "whether Stripe is set up (no key value)" },
  { capability: "finance.read", methods: READ, pattern: "/__operator/business/finance/stripe/summary", why: "the hub's synced Stripe snapshot, read-only (the same data as /__gateway/finance/stripe)" },

  // ── files.read / files.write: the approved roots only (scripts/gateway/files.ts) ─────────────────────────────────
  { capability: "files.read", methods: READ, pattern: "/__gateway/files/roots", why: "the approved file roots and whether each is set up" },
  { capability: "files.read", methods: READ, pattern: "/__gateway/files/list", why: "list a folder inside an approved root" },
  { capability: "files.read", methods: READ, pattern: "/__gateway/files/read", why: "read one file inside an approved root" },
  { capability: "files.write", methods: ["POST"], pattern: "/__gateway/files/write", why: "write one file inside an approved root (atomic; no delete)" },

  // ── tasks.run: Jarvis tasks through the Jev-led command path; Dot's own jobs ─────────────────────────────────────
  { capability: "tasks.run", methods: ["POST"], pattern: "/__gateway/tasks", why: "start a Jarvis task (goes through Jev like any new task)" },
  { capability: "tasks.run", methods: READ, pattern: "/__gateway/jobs", why: "Dot's own jobs" },
  { capability: "tasks.run", methods: READ, pattern: "/__gateway/jobs/*", why: "one of Dot's own jobs: progress, steps, result" },
  { capability: "tasks.run", methods: ["POST"], pattern: "/__gateway/jobs/*/stop", why: "Stop one of Dot's own jobs" },

  // ── memory.read / memory.write: the memory API, Dot as provenance ────────────────────────────────────────────────
  { capability: "memory.read", methods: ["POST"], pattern: "/__gateway/memory/recall", why: "recall (business, research and general facts; never the raw vault)" },
  { capability: "memory.write", methods: ["POST"], pattern: "/__gateway/memory/remember", why: "remember, recorded as Dot's (honours MU_MEMORY_WRITES)" },

  // ── coding.start: Dot's own coding jobs. Credentials stay on the hub; merges keep the owner's approval ───────────
  { capability: "coding.start", methods: ["POST"], pattern: "/__gateway/coding/draft", why: "draft a coding request (runs nothing)" },
  { capability: "coding.start", methods: ["POST"], pattern: "/__gateway/coding/jobs/*/start", why: "start a draft Dot made" },
  { capability: "coding.start", methods: ["POST"], pattern: "/__gateway/coding/jobs/*/resume", why: "resume one of Dot's coding jobs" },
  { capability: "coding.start", methods: ["POST"], pattern: "/__gateway/coding/jobs/*/tests/rerun", why: "rerun one of the job's registered checks" },
  { capability: "coding.start", methods: ["POST"], pattern: "/__gateway/coding/jobs/*/cancel", why: "stop one of Dot's coding jobs" },

  // ── bots.operate: SHARED bot computers only (never a personal device, never the hub's desktop) ───────────────────
  { capability: "bots.operate", methods: READ, pattern: "/__gateway/bots", why: "the shared bot computers and their state" },
  { capability: "bots.operate", methods: READ, pattern: "/__gateway/bots/*", why: "one shared bot computer" },
  { capability: "bots.operate", methods: READ, pattern: "/__gateway/bots/*/screenshot", why: "watch: the bot computer's screen as a still image" },
  { capability: "bots.operate", methods: ["POST"], pattern: "/__gateway/bots/*/jobs", why: "start a bot job (typed steps or a workflow; risky steps are refused)" },
  { capability: "bots.operate", methods: ["POST"], pattern: "/__gateway/bots/*/takeover", why: "take the control lease" },
  { capability: "bots.operate", methods: ["POST"], pattern: "/__gateway/bots/*/lease/renew", why: "keep the control lease" },
  { capability: "bots.operate", methods: ["POST"], pattern: "/__gateway/bots/*/return", why: "hand the computer back" },
  { capability: "bots.operate", methods: ["POST"], pattern: "/__gateway/bots/*/input", why: "keys and clicks while holding the lease" },
  // ── bots.terminal: a shell as the bot's user, while holding the lease. Granted separately (see OPERATE_SET) ──────
  { capability: "bots.terminal", methods: ["POST"], pattern: "/__gateway/bots/*/terminal", why: "open (or re-attach to) Dot's terminal on a bot computer it holds" },
  { capability: "bots.terminal", methods: READ, pattern: "/__gateway/bots/*/terminal/*/events", why: "the terminal's output" },
  { capability: "bots.terminal", methods: ["POST"], pattern: "/__gateway/bots/*/terminal/*/input", why: "keystrokes" },
  { capability: "bots.terminal", methods: ["POST"], pattern: "/__gateway/bots/*/terminal/*/close", why: "close the terminal" },
  // No WebSocket rule: the live viewer (/__computers/<name>/vnc) is not available through the gateway; screenshots are.

  // ── ops.read: diagnostics for the backend's operator ─────────────────────────────────────────────────────────────
  { capability: "ops.read", methods: READ, pattern: "/__gateway/diagnostics/jobs", why: "the shared job log: Dot's own jobs in full, founders' jobs as id, kind, state and timing only (never their words)" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/diagnostics/jobs/*", why: "one job from that log, same rule" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/diagnostics", why: "sanitised health, versions and the gateway's state in one answer" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/diagnostics/releases", why: "release receipts (what was released, when, the rollback point)" },
  { capability: "ops.read", methods: READ, pattern: "/__gateway/diagnostics/actions", why: "the hub's log of what Dot did through the gateway" },

  // ── r12 debugging: ops.logs / ops.restart (scripts/gateway/debug-ops.ts; `grant debug`, never in `grant operate`) ──
  { capability: "ops.logs", methods: READ, pattern: "/__gateway/diagnostics/logs", why: "a fixed allow-list of the hub's log files by source (no path parameter), tail at most 500 lines and 256 KB, every line redacted" },
  { capability: "ops.restart", methods: ["POST"], pattern: "/__gateway/ops/restart", why: "restart the hub (its supervisor starts it again), Hermes or SearXNG: a fixed action per service, no command; 3 an hour" },
  { capability: "ops.restart", methods: READ, pattern: "/__gateway/ops/restart/*", why: "one restart request's state, and health once the hub is back" },
];

/**
 * NEVER, for any capability. This list grants nothing and denies nothing by itself (default deny already covers all of it);
 * it exists so the tests and the design doc name each promise and prove it stays denied with every capability granted.
 */
export const NEVER: ReadonlyArray<{ method: Method; path: string; why: string }> = [
  { method: "GET", path: "/__gateway/admin/access", why: "the founders' view of Dot's identities (Devices and people)" },
  { method: "POST", path: "/__gateway/admin/identities/0123456789abcdef/revoke", why: "revoking Dot's identity is a founder's action" },
  { method: "GET", path: "/__gateway/files", why: "only the listed file routes exist; never a bare tree" },
  { method: "POST", path: "/__operator/coding/jobs", why: "the founders' start route (a signed-in person only); Dot starts its own drafts at /__gateway/coding" },
  { method: "POST", path: "/__operator/coding/jobs/abc/apply", why: "merging or pushing to a protected branch: the owner asks and the owner approves" },
  { method: "POST", path: "/__gateway/coding/jobs/abc/apply", why: "no merge route exists for the gateway" },
  { method: "POST", path: "/__computers/bot-1/takeover", why: "the founders' computers routes; Dot's are /__gateway/bots" },
  { method: "POST", path: "/__computers/bot-1/terminal", why: "the founders' terminal route" },
  { method: "POST", path: "/__crm/ops", why: "the founders' CRM route (a confirmed founder session); Dot's is /__gateway/crm" },
  { method: "GET", path: "/__crm/snapshot", why: "the founders' CRM route" },
  { method: "GET", path: "/__crm/file", why: "CRM attachments (private files)" },
  { method: "POST", path: "/__memory/recall", why: "the founders' memory route; Dot's is /__gateway/memory" },
  { method: "POST", path: "/__memory/remember", why: "the founders' memory route" },
  { method: "POST", path: "/__memory/forget", why: "memory deletion" },
  { method: "POST", path: "/__memory/vault/save", why: "the vault is never written through the gateway" },
  { method: "GET", path: "/__jobs", why: "the raw job log carries founders' words and Jarvis's replies; Dot reads /__gateway/diagnostics/jobs" },
  { method: "GET", path: "/__jobs/events", why: "the raw job stream, same reason" },
  { method: "POST", path: "/__jobs/abc/cancel", why: "the founders' Stop for any job; Dot stops only its own, at /__gateway/jobs" },
  { method: "GET", path: "/__operator/coding/accounts", why: "account slots, plans and usage; runs a sign-in check that spawns the CLIs" },
  { method: "POST", path: "/__operator/connections/gmail/action", why: "the founders' Gmail action: one code path for draft AND send" },
  { method: "POST", path: "/__operator/inbox", why: "the founders' inbox draft field" },
  { method: "GET", path: "/__operator/mail-archive/message", why: "the founders' mail reader (every mailbox); Dot reads authorised mailboxes at /__gateway/mail" },
  { method: "POST", path: "/__finance_manual/import", why: "a bank statement import (it holds personal rows)" },
  { method: "POST", path: "/__finance_manual/vendor-rule", why: "a vendor rule applies to personal rows of that vendor too" },
  { method: "POST", path: "/__finance_manual/clear", why: "clearing the ledger" },
  { method: "POST", path: "/__operator/business/finance/stripe/sync", why: "Stripe and bank connections are the founders'" },
  { method: "POST", path: "/__operator/business/finance/connect", why: "bank connections are the founders'" },
  { method: "POST", path: "/__gateway/finance/import", why: "no statement import through the gateway" },
  { method: "POST", path: "/__gateway/release/abc/approve", why: "approving a release is the owner's (Telegram code or spoken yes)" },
  { method: "GET", path: "/__operator/coding", why: "only the listed coding reads are open, never the whole tree" },
  { method: "GET", path: "/__workspace/email", why: "the founders' mail (inbox triage, mailbox connections)" },
  { method: "GET", path: "/__workspace/receptionist", why: "customer calls" },
  { method: "GET", path: "/__workspace/enquiries", why: "customer enquiries" },
  { method: "GET", path: "/__workspace/call-queue", why: "the founders' call queue" },
  { method: "GET", path: "/__workspace", why: "every Workspace panel at once, the mail and call panels included" },
  { method: "GET", path: "/__workspace/today", why: "founders' approvals and decisions, receptionist gates" },
  { method: "GET", path: "/__workspace/needs-you", why: "derived from the founders' mail and approvals" },
  { method: "GET", path: "/__computers/bot-1/vnc", why: "the live viewer (no WebSocket is available to the gateway)" },
  { method: "GET", path: "/__computers", why: "bot computers are not readable by the gateway principal" },
  { method: "POST", path: "/__operator/screen/act", why: "a founder's personal desktop control" },
  { method: "POST", path: "/__operator/pc/act", why: "a founder's personal desktop control" },
  { method: "POST", path: "/__operator/browser/act", why: "a founder's personal desktop control" },
  { method: "POST", path: "/__operator/open-url", why: "a founder's personal desktop control" },
  { method: "POST", path: "/__operator/screen/command", why: "the Jarvis command path to a founder's device" },
  { method: "GET", path: "/__token", why: "the hub's page token (the gateway answers /__token itself with its own CSRF token)" },
  { method: "GET", path: "/__devices/me", why: "identity and pairing administration" },
  { method: "POST", path: "/__devices/pair/console-code", why: "identity and pairing administration" },
  { method: "POST", path: "/__devices/pair/redeem", why: "identity and pairing administration" },
  { method: "POST", path: "/__devices/sessions/revoke", why: "identity and pairing administration" },
  { method: "POST", path: "/__away", why: "the Hermes relay" },
  { method: "POST", path: "/__design_set_key", why: "console only: provider keys" },
  { method: "POST", path: "/__hermes_cmd", why: "console only: hub software" },
  { method: "POST", path: "/__dev_restart", why: "console only: restarts the hub" },
  { method: "GET", path: "/__openrouter_key", why: "account and credential routes" },
  { method: "GET", path: "/__design_providers", why: "account and credential routes" },
  { method: "POST", path: "/__operator/connections/sync", why: "account and credential routes" },
  { method: "GET", path: "/__operator/connections", why: "account and credential routes" },
  { method: "GET", path: "/__operator/setup/connections", why: "account and credential routes" },
  { method: "POST", path: "/__approvals/abc/decide", why: "approval decisions on behalf of founders" },
  { method: "POST", path: "/__approvals/abc/card", why: "approval decisions on behalf of founders" },
  { method: "POST", path: "/__jobs/abc/release", why: "releasing a held job is a founder's decision" },
  { method: "DELETE", path: "/__memory/item/abc", why: "memory deletion" },
  { method: "POST", path: "/__memory/save", why: "the shared memory pool is not Dot's to write" },
  { method: "POST", path: "/__operator/memory/hide-existing", why: "memory deletion" },
  { method: "POST", path: "/__design_publish", why: "publishing" },
  { method: "POST", path: "/__lead-sites/deploy", why: "publishing" },
  { method: "POST", path: "/__lead-sites/takedown", why: "publishing" },
  { method: "POST", path: "/__claude_chat", why: "runs an agent on the hub" },
  { method: "POST", path: "/__hermes_chat", why: "runs an agent on the hub" },
  { method: "GET", path: "/__claude_session", why: "the owner's private transcripts" },
  { method: "GET", path: "/__memory_note", why: "the founders' Obsidian vaults" },
  { method: "GET", path: "/__operator/inbox", why: "the founders' mail" },
  { method: "GET", path: "/__operator/mail-archive/search", why: "the founders' mail" },
  { method: "GET", path: "/__operator/calendar", why: "the founders' calendars" },
  { method: "GET", path: "/__finance_manual", why: "the founders' finance route returns personal rows too; Dot reads business rows at /__gateway/finance" },
  { method: "GET", path: "/__receptionist/dashboard", why: "customer call data (not granted; an owner decision)" },
  { method: "POST", path: "/__computers", why: "provisioning a computer is a founder's action" },
  { method: "POST", path: "/__computers/bot-1/action", why: "bot lifecycle (start, stop, destroy) is a founder's action" },
  { method: "POST", path: "/__agents/bot-1", why: "what a bot is set up to do is server work for a founder" },
  { method: "PATCH", path: "/__agents/bot-1", why: "what a bot is set up to do is server work for a founder" },
];

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,127}$/;

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const have = path.split("/");
  for (let i = 1; i < want.length; i++) {
    // "**": the route itself and anything below it, plain segments only (no empty, dotted-first or encoded segment).
    if (want[i] === "**") return have.slice(i).every((s) => SEGMENT.test(s));
    if (i >= have.length) return false;
    if (want[i] === "*") {
      if (!SEGMENT.test(have[i])) return false;
    } else if (want[i] !== have[i]) return false;
  }
  return have.length === want.length;
}

// ── the app itself ──────────────────────────────────────────────────────────────────────────────────────────────
//
// The gateway NEVER forwards a non-/__ path to the hub: the hub is a Vite dev server whose file serving (/@id, /@fs, /src,
// /node_modules, ?raw and friends) can read the whole checkout. The UI is served by the gateway itself from a BUILT client
// bundle, by exact manifest path (scripts/gateway/ui.ts). The only other non-/__ answer is the SPA shell for a page path.

/**
 * First segments that never get the shell (the gateway's own, the bundle's asset folder, dev-server and checkout folders),
 * so a mistyped file or a dev-server path is a plain 404 rather than an app page. The shell is a static file either way:
 * a page path never reads anything from disk but the shell. (Not "memory" or "skills": those are app routes.)
 */
const NOT_PAGES = new Set(["gw", "assets", "src", "scripts", "node_modules", "docs", "deploy", "public", "dist"]);
const PAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Is this a page path the SPA shell answers (a client-side route)? Plain segments only: letters, digits, "-" and "_", no
 * dot anywhere (so no file name ever looks like a page), not a checkout or dev-server folder. "/" is a page.
 */
export function isPagePath(path: string): boolean {
  if (path === "/") return true;
  if (!path.startsWith("/") || path.startsWith("/__")) return false;
  const segments = path.split("/").slice(1);
  if (segments[segments.length - 1] === "") segments.pop(); // one trailing slash
  if (!segments.length || NOT_PAGES.has(segments[0].toLowerCase())) return false;
  return segments.every((s) => PAGE_SEGMENT.test(s));
}

/** Vite's transform queries. Never meaningful for a built file or a page, so a request carrying one is refused. */
const DEV_QUERY = /(?:^|[?&])(?:raw|url|inline|import|worker|sharedworker|direct|html-proxy|t|v)(?:=|&|$)/i;
export const hasDevQuery = (search: string) => DEV_QUERY.test(search.replace(/^\?/, ""));

export type Decision =
  | { ok: true; capability: Capability; template: string; kind: RouteKind; why: string }
  | { ok: false; reason: "method" | "not-listed" };

/**
 * The decision for a method and a path (no query). Says which capability the route needs; the caller checks it is held.
 * A WebSocket upgrade is its own kind of request: only a "ws" rule can allow one, and a "ws" rule allows nothing else.
 */
export function decide(method: string, path: string, upgrade = false): Decision {
  const m = String(method).toUpperCase() as Method;
  if (!METHODS.includes(m)) return { ok: false, reason: "method" };
  if (upgrade && !path.startsWith("/__")) return { ok: false, reason: "not-listed" };
  if (path.startsWith("/__")) {
    const rule = HUB_RULES.find((r) => ((r.kind ?? "http") === "ws") === upgrade && r.methods.includes(m) && matches(r.pattern, path));
    return rule ? { ok: true, capability: rule.capability, template: rule.pattern, kind: rule.kind ?? "http", why: rule.why } : { ok: false, reason: "not-listed" };
  }
  // Everything else (the UI's files and pages) is the gateway's own business and never reaches the hub.
  return { ok: false, reason: "not-listed" };
}

/** Is this request allowed for this capability set? `upgrade` says the request is a WebSocket upgrade. */
export function permitted(
  method: string,
  path: string,
  caps: readonly string[],
  upgrade = false,
): { ok: true; decision: Extract<Decision, { ok: true }> } | { ok: false; reason: string; needs?: Capability; template?: string } {
  const d = decide(method, path, upgrade);
  if (!d.ok) return { ok: false, reason: d.reason };
  if (!caps.includes(d.capability)) return { ok: false, reason: "capability", needs: d.capability, template: d.template };
  return { ok: true, decision: d };
}

/**
 * Why a request target is refused before anything else, or null. Applied by the gateway to every request and by the hub to
 * every gateway request (scripts/gateway/hub.ts). Stricter than the hub's own nonCanonicalTarget (which founders' dev
 * tooling depends on): besides "//", dot segments, backslashes and encoded dots, slashes, backslashes and percents, it
 * refuses anything Windows would read differently from how it is written:
 *   - ":" anywhere in the path (NTFS alternate data streams such as "file::$DATA" or "file:stream", drive letters),
 *   - a NUL or %00 anywhere in the target,
 *   - a segment that ends in "." or a space once decoded (Windows strips them, so "x.json." IS "x.json"),
 *   - control characters, and a segment that does not decode.
 * The query may hold ":" (event ids look like "epoch:n"), but never a NUL.
 */
export function nonCanonical(target: string): string | null {
  if (!target.startsWith("/") || target.startsWith("//")) return "Use a plain path.";
  if (target.includes("\u0000") || /%00/i.test(target)) return "NUL is not allowed.";
  const q = target.search(/[?#]/);
  const path = q < 0 ? target : target.slice(0, q);
  if (path.includes("\\")) return "Backslashes aren't allowed in paths.";
  if (/%(2e|2f|5c|25|00|3a)/i.test(path)) return "Encoded dots, slashes, colons or percents aren't allowed in paths.";
  if (path.includes(":")) return "Colons aren't allowed in paths.";
  if (path.includes("//")) return "Empty path segments aren't allowed.";
  for (const raw of path.split("/").slice(1)) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return "A path segment does not decode.";
    }
    if (seg === "." || seg === "..") return "Dot segments aren't allowed in paths.";
    if (/[\u0000-\u001f\u007f:\/]/.test(seg)) return "Control characters, colons and slashes aren't allowed in a path segment.";
    if (seg !== "" && /[. ]$/.test(seg)) return "A path segment may not end in a dot or a space.";
  }
  return null;
}
