import { describe, expect, test } from "bun:test";
import { entropy, looksHighEntropy, redactDeep, redactText, scanLine, scanPatch, secretName, secretPath } from "./redact";

// Every "secret" below is a synthetic fixture shaped like a credential; none is real.
const FAKE = {
  anthropic: "sk-ant-" + "api03-FAKEfakeFAKEfake1234567890",
  openai: "sk-proj-" + "FAKEfakeFAKEfake12345678",
  github: "ghp_" + "FAKEfakeFAKEfakeFAKEfakeFAKEfake1234",
  aws: "AKIA" + "FAKEFAKEFAKEFAKE",
  literal: "Zq8" + "vN3xLp7Rt2WmK9sYb4HcJ6dF1gTe5uQa",
};

describe("redaction", () => {
  test("known credential shapes, bearer tokens and secret assignments are redacted; placeholders stay", () => {
    const text = redactText(`a ${FAKE.anthropic} b ${FAKE.openai} c ${FAKE.github} d ${FAKE.aws} Authorization: Bearer abcdefghijklmnop0123 password=hunter2hunter2 API_KEY=\${API_KEY} token: process.env.TOKEN`);
    for (const value of [FAKE.anthropic, FAKE.openai, FAKE.github, FAKE.aws, "abcdefghijklmnop0123", "hunter2hunter2"]) expect(text).not.toContain(value);
    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("API_KEY=${API_KEY}");
    expect(text).toContain("process.env.TOKEN");
  });
  test("secret names are classified by their words", () => {
    for (const name of ["OPENROUTER_API_KEY", "clientSecret", "db_password", "accessToken", "GITHUB_TOKEN", "NV_BRIDGE_KEY", "auth"]) expect(secretName(name)).toBe(true);
    for (const name of ["tokenizer", "author", "sortKey", "keyboard", "primaryKey", "monkey"]) expect(secretName(name)).toBe(false);
  });
  test("redaction is linear-time: a megabyte of text is fast", () => {
    const started = Date.now();
    redactText("x".repeat(1_000_000) + " password=hunter2hunter2 " + "a_b-".repeat(100_000), Number.MAX_SAFE_INTEGER);
    scanLine("y".repeat(200_000) + "=" + "z".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(3000);
  });
  test("terminal escapes are stripped and output is bounded", () => {
    expect(redactText("\x1b[31mred\x1b[0m\x00")).toBe("red");
    expect(redactText("x".repeat(100), 10)).toHaveLength(10);
  });
  test("deep redaction covers nested strings and secret-named keys", () => {
    const out = redactDeep({ a: [{ note: `key ${FAKE.github}` }], password: "plain", nested: { apiKey: "abc" }, count: 3 });
    expect(JSON.stringify(out)).not.toContain(FAKE.github);
    expect(out.password).toBe("[redacted]");
    expect(out.nested.apiKey).toBe("[redacted]");
    expect(out.count).toBe(3);
  });
  test("high entropy: random mixed literals are flagged; shas, hex digests and words are not", () => {
    expect(looksHighEntropy(FAKE.literal)).toBe(true);
    expect(looksHighEntropy("9c1e2ab4f0d1c2b3a4958677e6f5d4c3b2a19087")).toBe(false);
    expect(looksHighEntropy("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(false);
    expect(looksHighEntropy("ThisIsAVeryLongIdentifierNameForAComponent1")).toBe(false);
    expect(entropy("aaaa")).toBe(0);
  });
});

describe("secret scan over a diff", () => {
  test("only added lines count; removed secrets and context are ignored; findings carry no value", () => {
    const patch = [
      "diff --git a/src/config.ts b/src/config.ts",
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1,2 +1,4 @@",
      ` const a = "${FAKE.openai}";`,
      `-const old = "${FAKE.github}";`,
      `+const key = "${FAKE.anthropic}";`,
      "+const ok = 1;",
      `+const blob = "${FAKE.literal}";`,
    ].join("\n");
    const findings = scanPatch(patch);
    expect(new Set(findings.map((f) => f.file))).toEqual(new Set(["src/config.ts"]));
    expect([...new Set(findings.map((f) => f.line))]).toEqual([2, 4]);
    expect(findings.map((f) => f.rule)).toContain("anthropic-key");
    expect(findings.map((f) => f.rule)).toContain("high-entropy-literal");
    expect(JSON.stringify(findings)).not.toMatch(/sk-|ghp_|Zq8/);
  });
  test("new secret paths are findings; templates are not", () => {
    const patch = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x=1\n`;
    expect(scanPatch(patch(".env")).map((f) => f.rule)).toEqual(["env-file"]);
    expect(scanPatch(patch("config/.env.production")).map((f) => f.rule)).toEqual(["env-file"]);
    expect(scanPatch(patch(".env.example"))).toEqual([]);
    expect(secretPath("keys/server.pem")).toBe("key-file");
    expect(secretPath("home/.ssh/id_ed25519")).toBe("ssh-private-key");
    expect(secretPath("id_ed25519.pub")).toBeNull();
    expect(secretPath(".operator-data/people.json")).toBe("operator-data");
    expect(secretPath("src/credentials.json")).toBe("credentials-file");
    expect(secretPath("src/app.ts")).toBeNull();
  });
  test("review M2 repros: npmrc tokens, db_pass, Twilio-style hex, split literals and credential files are found", () => {
    const npm = "npm_" + "FAKEfakeFAKEfake1234567890abcdefABCD";
    expect(scanLine(`//registry.npmjs.org/:_authToken=${npm}`)).toEqual(expect.arrayContaining(["npm-token"]));
    expect(scanLine("//registry.example.com/:_authToken=abcdef0123456789xyz")).toEqual(expect.arrayContaining(["npmrc-auth"]));
    expect(scanLine(`"db_pass": "hunter2hunter2"`)).toContain("secret-assignment");
    expect(scanLine(`const twilio = "0123456789abcdef0123456789abcdef";`)).toContain("hex-32-literal");
    expect(scanLine(`const sid = "AC0123456789abcdef0123456789abcdef";`)).toContain("twilio-sid-or-key");
    expect(scanLine(`const k = "sk-ant-" + "api03-FAKEfakeFAKEfake1234567890";`)).toContain("anthropic-key");
    expect(scanLine(`k = "sk-ant-" "api03-FAKEfakeFAKEfake1234567890"`)).toContain("anthropic-key");
    for (const path of [".envrc", ".netrc", "_netrc", ".git-credentials", ".pgpass", ".pypirc", "gcp/service-account.json", "my-service_account-prod.json", ".docker/config.json", "secrets.yaml"])
      expect([path, secretPath(path)]).toEqual([path, "credentials-file"]);
  });
  test("review M2 repro: an added line that itself starts with `++ ` is scanned, not taken for a header", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", "@@ -1,0 +1,2 @@",
      `+++ token: "sk-ant-api03-FAKEfakeFAKEfake1234567890"`, "+plain",
    ].join("\n");
    const findings = scanPatch(patch);
    expect(findings.map((f) => [f.file, f.line, f.rule])).toContainEqual(["notes.md", 1, "anthropic-key"]);
    expect(findings.some((f) => f.file === "+ token")).toBe(false);
  });
  test("review R2: MD5 test vectors and digests on hash lines aren't tokens; a bare 32-hex literal still is", () => {
    expect(scanLine(`expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");`)).toEqual([]);
    expect(scanLine(`const emptyDigest = "d41d8cd98f00b204e9800998ecf8427e";`)).toEqual([]);
    expect(scanLine(`const etag = "0123456789abcdef0123456789abcdef";`)).toEqual([]);
    expect(scanLine(`const token = "0123456789abcdef0123456789abcdef";`)).toContain("hex-32-literal");
  });
  test("review R2: a key glued to a preceding word, or split across two added lines, is found", () => {
    expect(scanLine(`const blob = "tEXtsk-ant-api03-FAKEfakeFAKEfake1234567890";`)).toContain("anthropic-key");
    expect(scanLine(`xghp_${"FAKEfakeFAKEfakeFAKEfakeFAKEfake1234"}`)).toContain("github-token");
    const patch = (a: string, b: string) => ["diff --git a/k.ts b/k.ts", "--- a/k.ts", "+++ b/k.ts", "@@ -0,0 +1,2 @@", `+${a}`, `+${b}`].join("\n");
    const found = scanPatch(patch(`const key = "sk-ant-" +`, `  "api03-FAKEfakeFAKEfake1234567890";`));
    expect(found.map((f) => [f.file, f.line, f.rule])).toContainEqual(["k.ts", 1, "anthropic-key"]);
    expect(scanPatch(patch(`const key = "sk-ant-"`, `  + "api03-FAKEfakeFAKEfake1234567890";`)).map((f) => f.rule)).toContain("anthropic-key");
    // Two unrelated added lines don't invent findings.
    expect(scanPatch(patch(`const a = "hello";`, `const b = "world";`))).toEqual([]);
  });
  test("a changed or deleted .gitattributes is always a finding for the owner", () => {
    const changed = "diff --git a/.gitattributes b/.gitattributes\n--- a/.gitattributes\n+++ b/.gitattributes\n@@ -1 +1 @@\n-*.png binary\n+*.ts -diff\n";
    const deleted = "diff --git a/sub/.gitattributes b/sub/.gitattributes\ndeleted file mode 100644\n--- a/sub/.gitattributes\n+++ /dev/null\n@@ -1 +0,0 @@\n-*.ts -diff\n";
    expect(scanPatch(changed).map((f) => f.rule)).toEqual(["gitattributes-changed"]);
    expect(scanPatch(deleted).map((f) => [f.file, f.rule])).toEqual([["sub/.gitattributes", "gitattributes-changed"]]);
  });
  test("ordinary code is not a secret", () => {
    for (const line of [
      "const token = getToken();",
      "password: form.password,",
      "type Props = { apiKey: string };",
      "if (secret === undefined) return;",
      "const sha = '9c1e2ab4f0d1c2b3a4958677e6f5d4c3b2a19087';",
      "// set OPENAI_API_KEY in your shell",
    ]) expect(scanLine(line)).toEqual([]);
    expect(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private-key-block"]);
  });
});
