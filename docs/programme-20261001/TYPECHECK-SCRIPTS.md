# Type-checking scripts/, companion/ and deploy/ (lead, 1 Oct 2026)

`bun run typecheck` covers `src/` only (tsconfig `include`). Server, companion and deploy code had never been type-checked.
`bun run typecheck:scripts` (tsconfig.scripts.json) checks them with the **runtime's own settings**: `@types/bun@1.4.2`
(exactly the installed Bun 1.4.2) and `lib: ES2023` (what Bun implements). Tests are excluded (bun runs them untyped).

**Result:** the integration tree and the untouched baseline `bc4678a` (throwaway worktree, same settings) have the **same 15
errors**, and none are new. They are pre-existing in CLI/proof/bench scripts (`aggregate.ts` ×2, `leads/cli.ts` ×2,
`integration/pricing-evidence.ts` ×2, `screen-hands/teach-demo.ts` ×2 on one line pair, `capability-acceptance.ts`,
`finance/manual-preview.ts`, `nab/preview.ts`, `j2/live-check.ts`, `jarvis-e2e/suite.ts`, `review-e12/cmp-prices.ts`,
`src/lib/commands/page-answers.ts`). The command exits non-zero until they are fixed; treat a count above 15 as a regression.

## The 14 "new" errors seen with the wrong settings (types: node only, lib ES2022)

| # | Error | Files | Class | Resolution |
|---|---|---|---|---|
| 2 | TS2868 `Bun` not found | companion/build-exe.ts, scripts/devices/cua-compare.ts | config artifact (no Bun types) | resolved by @types/bun 1.4.2 |
| 5 | TS2550 `findLast` | scripts/devices/real-goal-proof.ts, real-local-proof.ts ×3, real-owners-proof.ts | config artifact (ES2022 lib; Bun runs ES2023) | resolved by lib ES2023 |
| 5 | TS7006 implicit any `e` | same proof scripts | knock-on of the untyped `findLast` callback | resolved with it |
| 1 | TS2339 `.command` on `{type:"observe"}` | scripts/devices/synthetic.ts | **real latent bug**: the synthetic PC would crash on an observe request | fixed 69cb84f (skips observe, so the hub settles it as unknown) |
| 1 | TS2339 `SourceRef.path` | scripts/memory/prog-d-journeys.ts | real type slip (runtime-safe; the value is only logged) | fixed 69cb84f |

## Round 3: fixed to 0 (Track D, 1 Oct 2026)

`bun run typecheck:scripts` now exits 0 (was 15 errors); `bun run typecheck` still passes. No `any`, `as unknown as`, `@ts-ignore`, exclusions or weakened options were added; two existing unchecked casts in the touched code were removed. Commit 1b91420.

| Site | Real cause | Fix | Latent runtime bug? |
|---|---|---|---|
| aggregate.ts:1931 | `noIndex` is emitted on workspace nodes and read by the memory graph UI, but the `MemNode` contract never declared it | declared `noIndex?: boolean` on `MemNode` | no (contract gap) |
| aggregate.ts:4186 | `sanitizeForEmission` returns `unknown`; the result was then written to as if it were an object | narrowed: throws if the sanitised data is not an object, then copies into a `Record<string, unknown>` | no |
| capability-acceptance.ts:298 | `parseOpenclawNodes` returned `any` (a map over `JSON.parse` output), so every caller's callback was untyped | explicit `OpenclawNode[]` return type (minimal change in capability-registry.ts) | no |
| finance/manual-preview.ts:46, nab/preview.ts:24 | Bun's `Response` body rejects a `Uint8Array` backed by `ArrayBufferLike` (build assets are `string \| Uint8Array`) | strings pass through; binary assets are copied into a plain `Uint8Array` | no |
| integration/pricing-evidence.ts:24 | the synthetic feed was force-cast (`as AgencyFeedState`) and lacked `goLive`, `qaFlags` and `readiness.goLive`, all required by the feed contract | added them as `null` (the contract's "feed didn't send it"; a synthetic feed makes no go-live claim) and dropped the cast | no, but the cast had been hiding an off-contract fixture |
| integration/pricing-evidence.ts:70 (and the follow-on at 129) | imported playwright-core by an absolute `file:///` URL into the C: checkout's node_modules, bypassing types and this worktree's install | `import("playwright-core")`; the route handler uses Playwright's `Route` type instead of a hand-written one; `(model as unknown as {clients})` became `model.clients` | yes: the script only ran where that one C: path existed |
| j2/live-check.ts:66 | a one-argument fake `fetch` cast to `typeof fetch`; Bun's `fetch` also has `preconnect` | a real function with `preconnect` attached via `Object.assign`, no cast | no |
| src/lib/commands/page-answers.ts:47 | the default parameter `(...a) => fetch(...a)` was typed `typeof fetch` (needs `preconnect`) | a `PageFetch` type describing only the call shape the module uses | no |
| jarvis-e2e/suite.ts:129 | read `.error` from the `/pc/act` reply, which only ever carries `{ok, said}` | removed the dead `.error` fallback | no (dead branch) |
| leads/cli.ts:389 (`draft`) | the CRM stores `pitch` as free text (default `''`) but `emailDraft` takes five values; the API path narrowed it, the CLI did not. The CLI also never passed the founder's contact note | shared `emailPitch()` in outreach.ts used by both paths; the CLI now passes `contactPref` | **yes**: `leads draft` ignored a "no email" contact note that the API enforces. Regression test: `emailPitch` in email-draft-claims.test.ts (the CLI is hard-wired to the real CRM, so parity is tested through the shared helper) |
| leads/cli.ts:408 (`care-plan --by`) | `buildCarePlanDraft` has no `by` option; the flag was silently dropped (the email is signed "M&U Ventures") | stopped passing it | no behaviour change; the flag was already inert |
| review-e12/cmp-prices.ts | imported `./old-prices`, a scratch snapshot never committed; the file was a one-off price diff whose repros became the e12 regression tests (a3c89eb) | deleted; nothing referenced it (only this doc) | no |
| screen-hands/teach-demo.ts:280,284 | `in` narrowing on `task.learner` is lost inside a closure | the learner is read into locals once; behaviour unchanged | no |

Tests run: scripts/leads, capability-registry, receptionist, screen-hands, finance, nab, src/lib/commands (1458 pass), then capability, t8, free-voice, integration, jarvis-e2e, j2, aggregate (438 pass).
