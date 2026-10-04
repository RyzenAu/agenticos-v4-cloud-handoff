# Memory vault (Wave 2, 27 Sep 2026)

> **Superseded 28 Sep 2026** by `docs/memory-connector-20260928/README.md` (one shared pool, Obsidian ⇄ Hindsight connector). Kept as history.

The M&U wiki (`source/repos/mu-ventures-obsidian-wiki`) is the one canonical knowledge index.
AgenticOS saves, searches, recalls, corrects and forgets **curated facts** in it, scoped
`usman` / `mehroz` / `shared`. Map of where everything lives: wiki page `wiki/topics/general/canonical-map.md`.

## Where a fact lives
`wiki/topics/<bucket>/memory-<bucket>-<scope>.md` (a `topic` page, per the vault schema), one
section per fact with a stable `wiki_ref` (`mf-` + 10 hex) and an Obsidian block id, so
`[[memory-business-shared#^mf-…]]` opens the exact fact. Corrections keep the old section,
marked `**Superseded (date):**` with a link to the new one.

## Code
| File | Role |
|---|---|
| `scripts/memory/types.ts` | Contract types (no Node imports; the UI and Jev track import these) |
| `scripts/memory/api.ts` | `createMemoryApi({ wikiRoot, stateDir })` → `save / search / recall / get / history / list / buckets / correct / forget / factsUsed / guardExternal / processPendingDeletions` |
| `scripts/memory/guard.ts` | Refuses raw chats, call transcripts, audio, bank/card records, secrets, TFN/Medicare/passport, email bodies; 800 chars / 8 lines max |
| `scripts/memory/wiki-store.ts` | Parse/render fact sections; read-only index of canonical pages (never `raw/`, templates or schema) |
| `scripts/memory/derived.ts` | Keyword index, local hashed-term vectors (no model, no network), recall cache, tombstones, Pinecone/Hindsight deletion queue |
| `scripts/memory/voice-intents.ts` | Phrase routing + 4 tool definitions for Jev/Jarvis |
| `scripts/memory/plugin.ts` | `/__memory` routes; caller = Usman on local loopback, else the Tailscale person from `people.json` |
| `src/components/memory/` | `<MemoryVault />` (browse by bucket, search, detail with source + history, correct, confirmed forget) and `<FactsUsedPanel refs={reply.facts_used} />` |

## Rules the code enforces
- **Scope:** Usman reads usman + shared; Mehroz reads mehroz + shared. Nobody saves into the other's scope. Invisible facts answer "not found" (existence isn't leaked).
- **Conflicts:** a save that looks like it disagrees with a current fact is refused with the conflicting facts attached, until the caller corrects the old one or chooses keep-both. Correcting a superseded version returns the current one instead of forking.
- **Forget:** needs `confirm: true` (voice: a spoken yes on the next turn). Removes the whole correction chain from the wiki file, purges the index, vectors and recall cache, writes a tombstone (ref + sha256, never the text) and queues Pinecone + Hindsight deletions by `wiki_ref`. Every read filters tombstones, so a stale index, a cached recall, an external hit (`guardExternal`) or a restored wiki file cannot resurrect it. Re-saving the same text needs `reaffirm: true`.

## Voice phrases
- Save: "remember that …", "remember …", "make a note that …", "note that …", "save this: …", "keep in mind that …". Add "just for me" / "privately" for private, "for both of us" / "for the team" for shared. ("remember to …" is a reminder, not memory.)
- Recall: "what do we know about …", "what did we decide about …", "what's saved about …", "do we have anything on …", "recall …".
- Correct: "correct that: …" / "correct that to …" / "actually, …" (after a recall), "update the <topic> fact to …". A bare value ("it's A$1,999") replaces the one value in the old fact.
- Forget: "forget that", "forget about …", "forget what I said about …", "delete the memory about …", "remove … from memory". Then "yes" to confirm; anything else keeps it.

Tool calling: `MEMORY_VOICE_TOOLS` (`remember_fact`, `recall_memory`, `correct_fact`, `forget_fact`) + `runMemoryTool(api, caller, name, args)`. Every reply carries `facts_used`.

## Patch for lead (not applied — `vite.config.ts` is not this track's file)
```ts
import { memoryPlugin } from "./scripts/memory/plugin";          // with the other plugin imports
memoryPlugin({ root: __dirname, tailnetPerson }),                  // in plugins: [...] next to workspacePlugin
```
`tailnetPerson` is already imported in `vite.config.ts` from `./scripts/remote-access`. Wiki root defaults to
`MU_WIKI_ROOT` or `~/source/repos/mu-ventures-obsidian-wiki`; derived state goes to `.operator-data/memory-index/` (gitignored).
os-shell mounts `<MemoryVault />` at the Memory destination (optionally `initialRef` from a facts-used link).
Jev track: call `handleMemoryUtterance(api, caller, utterance, ctx)` before the brain, or `POST /__memory/voice`.

## Evidence
Screenshots (synthetic in-browser client, TEMP route not committed): `memory-1440.png`, `memory-search-1440.png`,
`memory-forget-confirm-1440.png`, `memory-390.png`, `memory-detail-390.png`.
Tests: `bun --no-env-file test ./scripts/memory/` — API on a temp copy of `scripts/memory/fixtures/mini-wiki`, the
`/__memory` middleware with fake sockets, and the UI's HTTP client driving the real middleware.

## Not done here
- Not registered in the live OS (needs the patch above). Not yet run against the real vault.
- Pinecone/Hindsight: deletions are **queued only**; nothing drains the queue until the owner wires a deleter.
- The OS's older local memory (`.operator-data/workspace.json` sources) is separate and still soft-delete only.
