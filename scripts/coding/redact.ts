/**
 * Redaction and secret scanning for the coding harness (CODING-HARNESS §3.6, §3.7 point 3, §6).
 *  - redactText / redactDeep: applied to every event payload and artefact before it is stored.
 *  - scanPatch / secretPath: the done gate's secret scan over a diff's ADDED lines and new paths.
 * Findings carry the rule, file and line only, never the matched value.
 */

/** Credential shapes with a recognisable prefix or structure. Order matters only for reporting. */
const PATTERNS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "private-key-block", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
  // Distinctive prefixes match even when glued to a preceding word character (`tEXtsk-ant-…`, review R2).
  { rule: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { rule: "openai-style-key", re: /\b(?:sk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}/ },
  { rule: "github-token", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/ },
  { rule: "slack-token", re: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { rule: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { rule: "stripe-key", re: /\b(?:sk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{16,}/ },
  { rule: "huggingface-token", re: /\bhf_[A-Za-z0-9]{20,}/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "bearer-token", re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { rule: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i },
  // Added after REVIEW-C1C2 M2.
  { rule: "npm-token", re: /npm_[A-Za-z0-9]{36}\b/ },
  { rule: "npmrc-auth", re: /(?:^|[\s:])_(?:authToken|auth|password)\s*=\s*\S{8,}/ },
  { rule: "twilio-sid-or-key", re: /\b(?:AC|SK)[0-9a-f]{32}\b/ },
  { rule: "hex-32-literal", re: /["'`][0-9a-f]{32}["'`]/ },
  { rule: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{50,}/ },
  { rule: "gitlab-token", re: /glpat-[A-Za-z0-9_-]{20,}/ },
  { rule: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { rule: "azure-storage-key", re: /\bAccountKey=[A-Za-z0-9+/=]{40,}/ },
  { rule: "telegram-bot-token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
];

/** `"sk-ant-" + "rest"` and Python's `"a" "b"`: join adjacent literals so a split key is still seen. */
export function joinSplitLiterals(line: string): string {
  return line.replace(/(["'`])\s*\+?\s*\1/g, "");
}

/**
 * `NAME = value` / `"name": "value"`. Linear-time on purpose: a cheap candidate match (the name is one
 * bounded word) and then `secretName` classifies the name by its words, so a long run of text can't
 * trigger catastrophic backtracking.
 */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_-]{0,80})(\s*["']?\s*[:=]\s*["'`]?)([^\s"'`,;}]{8,})/g;
const SECRET_WORDS = new Set(["secret", "secrets", "token", "password", "passwd", "pwd", "pass", "pw", "apikey", "auth", "authtoken", "credential", "credentials", "passphrase"]);
const SECRET_PAIRS = [["api", "key"], ["access", "key"], ["private", "key"], ["client", "secret"], ["access", "token"], ["refresh", "token"], ["secret", "key"]];

/** Does this identifier name a secret? `OPENROUTER_API_KEY`, `clientSecret`, `db_password` yes; `tokenizer`, `author`, `sortKey` no. */
export function secretName(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_-]+/).filter(Boolean);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  if (words.length > 1 && words[words.length - 1] === "key" && words.length <= 6 && /^[A-Z0-9_]+$/.test(name)) return true; // ENV_STYLE_KEY
  return SECRET_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

/** Values that are placeholders, not secrets: the scanner must not fail a gate on documentation. */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}?|\$[A-Z_][A-Z0-9_]*|process\.env\.[A-Za-z0-9_]+|env\.[A-Za-z0-9_]+|(?:your|my|example|dummy|fake|test|sample|placeholder|changeme|redacted)[\w-]*|\[redacted\]|null|undefined|true|false)$/i;

const STRING_LITERAL = /["'`]([A-Za-z0-9+/=_-]{32,})["'`]/g;

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long literal that looks random: mixed case with several digits, no long lower-case word runs,
 * high entropy. A git sha or hex digest (lower-case hex) is not flagged; neither are identifiers. */
export function looksHighEntropy(value: string): boolean {
  if (value.length < 32) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  if ((value.match(/[0-9]/g) ?? []).length < 2) return false;
  if (/[a-z]{7,}/.test(value)) return false; // words: "Identifier", "Component"
  return entropy(value) >= 4.3;
}

/** Strip terminal controls and every recognised credential; bound the length. */
export function redactText(value: unknown, limit = 32_000): string {
  let text = String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const { rule, re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    text = text.replace(global, (m: string) => (rule === "bearer-token" ? m.replace(/(\s+).*/, "$1[redacted]") : "[redacted]"));
  }
  text = text.replace(ASSIGNMENT, (whole, name: string, sep: string, secret: string) =>
    !secretName(name) || PLACEHOLDER.test(secret) ? whole : `${name}${sep}[redacted]`);
  text = text.replace(STRING_LITERAL, (whole, literal: string) => (looksHighEntropy(literal) ? whole.replace(literal, "[redacted]") : whole));
  return text.slice(0, limit);
}

/** Redact every string inside a JSON-like value (event payloads). Keys named like secrets are blanked. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return "[nested data]" as unknown as T;
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = /^(?:.*[_-])?(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential)s?$/i.test(key) && typeof item === "string"
        ? "[redacted]"
        : redactDeep(item, depth + 1);
    return out as T;
  }
  return value;
}

/** Paths that must never be added by an agent: env files, keys, credential stores, OS private data. */
export function secretPath(path: string): string | null {
  const normal = path.replace(/\\/g, "/");
  const base = normal.split("/").pop() ?? normal;
  if (/^\.env(?:\..+)?$/i.test(base) && !/^\.env\.(?:example|sample|template|dist)$/i.test(base)) return "env-file";
  if (/\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i.test(base)) return "key-file";
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(base)) return "ssh-private-key";
  if (/^credentials?(?:\..+)?$/i.test(base)) return "credentials-file";
  if (/^(?:\.envrc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.pypirc|\.htpasswd|\.dockercfg|kubeconfig)$/i.test(base)) return "credentials-file";
  if (/(?:^|[-_.])service[-_]?account.*\.json$/i.test(base) || /^secrets?\.(?:json|ya?ml|toml|ini)$/i.test(base)) return "credentials-file";
  if (/(?:^|\/)\.docker\/config\.json$/i.test(normal) || /(?:^|\/)\.kube\/config$/i.test(normal)) return "credentials-file";
  if (/(?:^|\/)\.operator-data\//.test(normal) || /^\.operator-data$/.test(normal)) return "operator-data";
  if (/(?:^|\/)\.(?:claude|codex)\/(?:\.credentials\.json|auth\.json)$/i.test(normal)) return "agent-credentials";
  return null;
}

export type SecretFinding = { file: string | null; line: number | null; rule: string };

/** Scan one line of text. Returns the rule names that matched (never the value). */
export function scanLine(raw: string): string[] {
  const line = joinSplitLiterals(raw);
  let rules = PATTERNS.filter(({ re }) => re.test(line)).map(({ rule }) => rule);
  for (const match of line.matchAll(ASSIGNMENT))
    if (secretName(match[1]) && !PLACEHOLDER.test(match[3]) && !looksLikeCode(match[3])) rules.push("secret-assignment");
  for (const match of line.matchAll(STRING_LITERAL)) if (looksHighEntropy(match[1])) rules.push("high-entropy-literal");
  // A 32-hex literal on a line about hashes, or a well-known MD5 test vector, is a digest, not a token.
  if (rules.includes("hex-32-literal") && (HASH_CONTEXT.test(line) || KNOWN_MD5.some((v) => line.includes(v))))
    rules = rules.filter((r) => r !== "hex-32-literal");
  return [...new Set(rules)];
}

const HASH_CONTEXT = /md5|sha-?1|hash|digest|checksum|etag|fingerprint|integrity/i;
/** RFC 1321 test-suite vectors and other MD5s that appear in tests. */
const KNOWN_MD5 = [
  "d41d8cd98f00b204e9800998ecf8427e", "0cc175b9c0f1b6a831c399e269772661", "900150983cd24fb0d6963f7d28e17f72",
  "f96b697d7cb7938d525a2f31aaf161d0", "c3fcd3d76192e4007dfb496cca67e13b", "d174ab98d277d9f5a5611c2c9f419d9f",
  "57edf4a22be3c955ac49da2e2107b67a", "9e107d9d372bb6826bd81d3542a419d6", "5eb63bbbe01eeed093cb22bb8f5acdc3",
];

/** `token = getToken()` or `password: form.password` are code, not literals. */
function looksLikeCode(value: string): boolean {
  return /[().[\]]/.test(value) || /^[a-z_$][\w$]*$/i.test(value) && !/\d/.test(value) && value.length < 24;
}

/**
 * Scan a unified diff (`git diff base..head`). Only ADDED lines and newly added paths count: removing a
 * secret is never a finding, and context lines are not the change under review.
 */
export function scanPatch(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file: string | null = null;
  let oldFile: string | null = null;
  let line = 0;
  // Lines left in the current hunk, from its @@ header. Inside a hunk EVERY line is content, so an
  // added line that itself starts with `++ ` is scanned, not mistaken for a `+++` header (review M2).
  let oldLeft = 0, newLeft = 0;
  let previous: { text: string; line: number; rules: string[] } | null = null;
  const unquote = (value: string, side: "a" | "b") => (value === "/dev/null" ? null : value.replace(/^"/, "").replace(/"$/, "").replace(new RegExp(`^${side}/`), ""));
  for (const raw of patch.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("\\")) continue; // "\ No newline at end of file"
      if (text.startsWith("+")) {
        const content = text.slice(1);
        const own = scanLine(content);
        for (const rule of own) findings.push({ file, line, rule });
        // A key split across two consecutive added lines ("sk-ant-" +⏎ "rest"): scan the pair joined,
        // and report what only the pair reveals at the first line (review R2).
        if (previous && previous.line === line - 1) {
          const alone = new Set([...previous.rules, ...own]);
          for (const rule of scanLine(`${previous.text}\n${content}`)) if (!alone.has(rule)) findings.push({ file, line: previous.line, rule });
        }
        previous = { text: content, line, rules: own };
        line++; newLeft--;
      } else if (text.startsWith("-")) { oldLeft--; previous = null; }
      else { line++; oldLeft--; newLeft--; previous = null; }
      continue;
    }
    previous = null;
    if (text.startsWith("diff --git ")) { file = null; oldFile = null; continue; }
    if (text.startsWith("--- ")) { oldFile = unquote(text.slice(4).trim(), "a"); continue; }
    if (text.startsWith("+++ ")) {
      file = unquote(text.slice(4).trim(), "b");
      if (file) { const kind = secretPath(file); if (kind) findings.push({ file, line: null, rule: kind }); }
      // Any added, changed or deleted .gitattributes can hide files from diffs or add filters: the
      // owner must accept it explicitly (review B3).
      const touched = file ?? oldFile;
      if (touched && /(?:^|\/)\.gitattributes$/.test(touched)) findings.push({ file: touched, line: null, rule: "gitattributes-changed" });
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      line = Number(hunk[2]);
    }
  }
  return findings;
}
