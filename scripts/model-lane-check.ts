/**
 * Drives the lane/billing rules without a browser or a provider call.
 * `bun scripts/model-lane-check.ts`
 *
 * Same reasoning as turn-watchdog-check.ts: the branches here decide WHOSE
 * MONEY a turn spends, and the only way to be sure a rule holds is to run it
 * over the cases that can cost real money — one model listed twice with the
 * same id and two different bills, and an unrecognised lane reporting "Claude
 * subscription" under a chat Anthropic was not paying for.
 *
 * Model ids come from the router catalogue (scripts/model-router/pickers.ts),
 * the same source /__hermes_models and /__claude_models serve. The metered
 * twins below are built from those ids (a Codex plan model also offered under a
 * metered vendor) because the catalogue itself no longer lists a twin; the
 * rules must still hold if an external config (ccr, Hermes) adds one.
 */
import {
  claudeCodePickerModels,
  codexPickerModels,
  hermesPickerCatalog,
  routableChatModels,
} from "./model-router/pickers";
import {
  laneBillsPerTurn,
  laneFor,
  markMeteredDuplicates,
  modelIdentity,
  payerLabel,
  supersededNote,
  type LaneHealth,
} from "../src/lib/model-lane";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SOL = codexPickerModels()[0].name; // the Codex plan's first model (catalogue)
const ASTRA = codexPickerModels()[1]?.name ?? SOL;
const CLAUDE = claudeCodePickerModels()[0].name; // the Claude plan's first model (catalogue)
const OPENROUTER_ONLY = routableChatModels("openrouter").find((m) => m.route === "metered")!.providerModel;
// A synthetic OAuth vendor: the rule must dedupe for any OAuth lane, not only Codex.
const OAUTH_ONLY = "example-oauth-model";
// Local models are owner-selected (catalogue local/on-device), so any name stands in.
const LOCAL = "example-local-model";

/** A Hermes-shaped catalog with metered twins. Order matters: the metered
    `openai` group first is how a twin once became the default. */
const HERMES = [
  { name: SOL, provider: "openai" },
  { name: ASTRA, provider: "openai" },
  { name: CLAUDE, provider: "anthropic" },
  { name: `openai/${SOL}`, provider: "openrouter" },
  { name: OPENROUTER_ONLY, provider: "openrouter" },
  { name: SOL, provider: "openai-codex" },
  { name: ASTRA, provider: "openai-codex" },
  { name: OAUTH_ONLY, provider: "xai" },
  { name: OAUTH_ONLY, provider: "xai-oauth" },
  { name: LOCAL, provider: "ollama" },
];

const CODEX_UP: LaneHealth = { "openai-codex": { ok: true }, "xai-oauth": { ok: true } };
const CODEX_DOWN: LaneHealth = {
  "openai-codex": { ok: false, reason: "not signed in — run `codex login`" },
  "xai-oauth": { ok: true },
};

const hiddenNames = (rows: Array<{ name: string; provider?: string; supersededBy?: string }>) =>
  rows.filter((r) => r.supersededBy).map((r) => `${r.provider}/${r.name}`);

console.log("\n— the lane comes from the provider, not the name —");
check("the Codex plan model on the OAuth group is the codex lane", laneFor(SOL, "openai-codex") === "codex");
check(
  "the SAME id on the metered vendor is NOT the codex lane",
  laneFor(SOL, "openai") === "other",
  laneFor(SOL, "openai"),
);
check("openrouter is the metered ccr lane", laneFor(`openai/${SOL}`, "openrouter") === "ccr");
check(
  "no provider falls back to the name (headless callers, failover targets)",
  laneFor(SOL, "") === "codex" && laneFor("vendor/model", "") === "ccr",
);
check("an unknown model claims no lane", laneFor("some-new-thing", "") === "other");

console.log("\n— a payer is named only when it is known —");
check("codex lane says ChatGPT plan", payerLabel("codex", "openai-codex") === "ChatGPT plan");
check("ccr lane says OpenRouter credit", payerLabel("ccr", "openrouter") === "OpenRouter credit");
check(
  "someone else's OAuth is NOT reported as the Claude subscription",
  !/Claude subscription/.test(payerLabel("other", "xai-oauth")),
  payerLabel("other", "xai-oauth"),
);
check(
  "a local model says nothing is billed",
  /nothing billed/.test(payerLabel("other", "ollama")),
  payerLabel("other", "ollama"),
);
check(
  "an unrecognised lane admits it does not know",
  /unknown/.test(payerLabel("other", "")),
  payerLabel("other", ""),
);

console.log("\n— the metered duplicate is hidden while the paid lane is up —");
{
  const rows = markMeteredDuplicates(HERMES, CODEX_UP);
  const hidden = hiddenNames(rows);
  check(
    "the metered twin of the Codex model is hidden",
    hidden.includes(`openai/${SOL}`),
    hidden.join(", "),
  );
  check(
    "so is the OpenRouter-prefixed copy of the same model",
    hidden.includes(`openrouter/openai/${SOL}`),
    hidden.join(", "),
  );
  check("the second Codex model too", hidden.includes(`openai/${ASTRA}`), hidden.join(", "));
  check("and the metered twin of another OAuth lane", hidden.includes(`xai/${OAUTH_ONLY}`), hidden.join(", "));
  check(
    "the OAuth entries themselves are never hidden",
    !hidden.some((h) => h.startsWith("openai-codex/") || h.startsWith("xai-oauth/")),
    hidden.join(", "),
  );
  check(
    "a model with no paid twin is untouched",
    !hidden.includes(`openrouter/${OPENROUTER_ONLY}`) && !hidden.includes(`anthropic/${CLAUDE}`),
    hidden.join(", "),
  );
  check("a local model is never called a metered duplicate", !hidden.includes(`ollama/${LOCAL}`));
  check("nothing is dropped from the list", rows.length === HERMES.length, `${rows.length}`);
}

console.log("\n— …and comes back the moment that lane cannot be used —");
{
  const rows = markMeteredDuplicates(HERMES, CODEX_DOWN);
  const hidden = hiddenNames(rows);
  check(
    "an unhealthy codex lane hides nothing of its own",
    !hidden.some((h) => h.includes(SOL) || h.includes(ASTRA)),
    hidden.join(", "),
  );
  check(
    "a different lane that IS healthy still de-duplicates",
    hidden.includes(`xai/${OAUTH_ONLY}`),
    hidden.join(", "),
  );
}
{
  // An older server, or one that could not check: no report at all.
  const hidden = hiddenNames(markMeteredDuplicates(HERMES, undefined));
  check("no health report hides nothing at all", hidden.length === 0, hidden.join(", "));
}
{
  const hidden = hiddenNames(markMeteredDuplicates(HERMES, { "openai-codex": { ok: false } }));
  check("an explicit not-ok hides nothing", hidden.length === 0, hidden.join(", "));
}

console.log("\n— the claude backend's own duplicate —");
{
  const FABLE = claudeCodePickerModels().find((m) => /fable/.test(m.name))?.name ?? CLAUDE;
  const ROWS = [
    ...claudeCodePickerModels().map((m) => ({ name: m.name, provider: "claude-code" })),
    { name: `anthropic/${FABLE}`, provider: "openrouter · via claude code" },
    { name: OPENROUTER_ONLY, provider: "openrouter · via claude code" },
    ...codexPickerModels().map((m) => ({ name: m.name, provider: "openai · via codex" })),
  ];
  const hidden = hiddenNames(
    markMeteredDuplicates(ROWS, {
      "claude-code": { ok: true },
      "openai · via codex": { ok: true },
    }),
  );
  check(
    "Fable through OpenRouter is hidden while the subscription covers it",
    hidden.includes(`openrouter · via claude code/anthropic/${FABLE}`),
    hidden.join(", "),
  );
  check(
    "a model the subscription does NOT cover stays listed",
    !hidden.includes(`openrouter · via claude code/${OPENROUTER_ONLY}`),
    hidden.join(", "),
  );
}

console.log("\n— the line that explains the absence —");
{
  const note = supersededNote(3, "openai-codex");
  check("says the count", /3/.test(note), note);
  check("names the payer", /openai-codex/.test(note), note);
  check("says hidden, never removed", /hidden/.test(note) && !/removed|deleted/.test(note), note);
  check("nothing hidden means nothing said", supersededNote(0, "openai-codex") === "");
}

console.log("\n— identity —");
check("a vendor prefix is not a different model", modelIdentity(`openai/${SOL}`) === SOL);
check("case and padding do not make a new model", modelIdentity(`  ${SOL.toUpperCase()} `) === SOL);

console.log("\n— the real picker catalog is billed honestly —");
for (const g of hermesPickerCatalog()) {
  for (const m of g.models) {
    const bills = laneBillsPerTurn(laneFor(m.name, g.provider), g.provider);
    if (m.route === "metered") check(`${g.provider}/${m.name} (metered) bills per turn`, bills);
    if (m.route === "subscription") check(`${g.provider}/${m.name} (plan) is not billed per turn`, !bills);
    if (m.route === "free" && (g.provider === "groq-free" || g.provider === "cline-free"))
      check(`${g.provider}/${m.name} (free plan) is not billed per turn`, !bills, payerLabel(laneFor(m.name, g.provider), g.provider));
  }
}

console.log(failures === 0 ? "\nall lane rules hold\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
