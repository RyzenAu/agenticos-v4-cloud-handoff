# Memory connector: Obsidian ⇄ Hindsight (28 Sep 2026, V5 §2)

Supersedes `docs/memory-20260927/` (the per-person wiki-only vault). Same file layout under
`scripts/memory/` and `src/components/memory/`, plus the connector files listed below.

## Roles
- **Obsidian** (the M&U wiki vault) is authoritative for curated notes and "save to the vault" facts.
- **Hindsight** does contextual memory and retrieval: an index of permitted vault notes, plus Hindsight-only memories captured through Jarvis ("remember this", ids `mem-…`).
- **AgenticOS** is the interface, permission, sync and provenance layer. There is **one shared business-memory pool**; who saved or changed something is recorded (`actor`), never used to hide it.

## The one switch (Stage D, 28 Sep 2026)

`MU_MEMORY_WRITES` is the ONLY memory switch in AgenticOS. It replaced both the OS's old gate and the
connector's two switches (`MEMORY_WRITES`, `HINDSIGHT_ENABLED`), which are no longer read: if either
is still set somewhere, the Memory page says so.

| `MU_MEMORY_WRITES` | Effect |
|---|---|
| unset / `off` (default) | Read-only. Browse and recall from the local index. **No call to Hindsight at all**; nothing is saved, corrected or forgotten. |
| `read` | As off, plus recall from Hindsight (read-only through the proxy). |
| `on` | Everything: "remember this", "save this to the vault", correct, forget, and the Obsidian -> Hindsight sync. |

Only exactly `on` / `read` count; anything else is off. It is read from the process environment
first, then `~/.config/agentic-os.env`. A preview or quiet copy (`ARGENTIC_PREVIEW=1`,
`AGENTIC_OS_NO_BACKGROUND=1`) never reads it from that file, and without its own `MU_WIKI_ROOT` it is
read-only whatever the switch says (its own state dir would give the real vault's notes new ids and
duplicate them in the shared pool).

The Hindsight side has its own gate, on the proxy: `hindsightctl writes -State on -Profile pilot`
(docs/HINDSIGHT-OPS.md). Both must be on for a save to land. If the OS is on and the proxy is off, saves
wait in the queue and the Memory page shows "Hindsight proxy writes off"; nothing is lost.

Connection settings (not switches):

| Setting | Default and meaning |
|---|---|
| `HINDSIGHT_URL` | `http://127.0.0.1:8878`, the client proxy (it holds the key and checks this process's Windows account). Loopback only. `off` keeps Hindsight out entirely (vault + local index). |
| `HINDSIGHT_BANK` | `mu-shared`, the one shared pool (never the pilot bank by default). |
| `HINDSIGHT_APPROVAL_SECRET_FILE` | The proxy's document-delete secret. Default: `D:\hindsight\service\secrets\pilot-docdelete.key` (rev 3), then `pilot-approval.key` (rev 2). Read at delete time only; never copied, logged or returned. |
| `HINDSIGHT_API_KEY` | **Not needed** through the proxy and should stay unset (the status panel shows whether one is set). Only a direct, non-proxy test instance uses it. |
| `MU_WIKI_ROOT`, `MU_WIKI_VAULT_NAME`, `MEMORY_STATE_DIR` | Vault root; app-owned store (default `.operator-data/memory/`, git-ignored, refused if inside the vault, junction-aware). |
| `MEMORY_SYNC_ALLOW` / `MEMORY_SYNC_DENY` | Extra globs. Always denied: `raw/**`, templates, `.obsidian`, schema/readme files, credential/secret/password/env/transcript/bank-statement file names. |

**Switch-on (lead):** see docs/stage-d/ACCEPTANCE.md, "Switch-on steps".

## Code
| File | Role |
|---|---|
| `scripts/memory/types.ts` | Contract types (no Node imports; the UI and Jev track import these) |
| `scripts/memory/settings.ts` | Env → settings; loopback check; hard deny list |
| `scripts/memory/vault.ts` | Read-only vault scan: allow/deny globs, frontmatter opt-out, guard, stable note ids (frontmatter `id` → `n-<id>`, else persisted path→id map with rename detection by content hash), documents per note/fact block |
| `scripts/memory/connector.ts` | Desired vs confirmed state → durable outbox → Hindsight; write-ahead `inflight`; retract-first; backoff; status |
| `scripts/memory/hindsight-client.ts` | The only Hindsight caller: retain (document_id upsert, `update_mode: replace`), tag-filtered recall, document get/delete, health. No bank clear, bulk delete or reflect. One usage receipt per call. |
| `scripts/memory/api.ts` | remember / saveToVault / recall / correct / forget (3 kinds) / reindex / list / item / usage |
| `scripts/memory/approvals.ts` | `MemoryApprovals.require({action:"memory.forget", target, digest})` interface for Stage B, plus the server-side implementation (durable in `approvals.json` since Stage D) |
| `scripts/memory/store.ts` | App-owned JSON store (atomic writes; a corrupt file fails loudly) |
| `scripts/memory/wiki-store.ts` | Vault fact blocks; compare-and-swap note writes (`VaultConflictError`) |
| `scripts/memory/guard.ts` | Fact screen, note screen (credential/transcript/bank/audio shapes), vault-sensitivity screen |
| `scripts/memory/voice-intents.ts` | Phrase routing + 5 tools; voice approvals held server-side per person |
| `scripts/memory/voice-turn.ts` | Stage D: Jarvis's voice turn asks memory first (rules, no model); a forget's yes must be the voice pipeline's own spoken-yes event |
| `scripts/memory/plugin.ts` | `/__memory` routes; identity only from the injected `principalFor`; 401 without it |
| `scripts/memory/testing/` | Fake Hindsight server (loopback, in-process) and the synthetic test harness |
| `src/components/memory/` | `<MemoryVault />`: sync status, capture with destinations, browse by destination, detail with source + history, correct, the three forget kinds with the approval step. `<FactsUsedPanel />` |

## Sync connector
- Documents: one per current fact block (`document_id` = `mf-…`), one for the rest of a note (`document_id` = note id), one per current Hindsight-only memory (`mem-…`). Superseded blocks are never indexed.
- Retain carries tags `src:agenticos`, `bucket:*`, `kind:*`, `origin:*` and metadata `source_path`, `obsidian_link`, `obsidian_uri`, `note_id`, `version`, `version_hash`, `synced_at`, `actor`, `origin`.
- Recall asks Hindsight only for `src:agenticos` documents, and uses a hit only when the document is still wanted **and** its confirmed index entry matches the current version. Forgotten, superseded, unindexed, stale or foreign hits are counted as `suppressed`, never shown.
- A rename keeps the note id, so the same document is re-sent with the new path (no duplicate, no delete).
- An outage: everything queues in `outbox.json` (attempts, last error, next attempt with backoff). Desired and confirmed state are on disk, so a restart loses nothing; upserts replace by `document_id` and a retract of an absent document counts as done, so replay can't duplicate.
- No circular writes: the connector never writes to the vault.

## Capture
- **"Remember this"** → a `mem-…` memory in Hindsight with a local provenance record (text, actor, channel, version, chain). Never written to the vault. The reply says so.
- **"Save this to the vault"** → a fact block in `wiki/topics/<bucket>/memory-<bucket>-shared.md` (compare-and-swap: if the note changed since it was read, nothing is overwritten and a conflict is returned), then indexed. Personal/sensitive details (phone, email, address, date of birth, health, pay) are refused for the Git-backed vault and can be remembered instead. "Save that to the vault" moves the memory just used into the vault and retracts the Hindsight-only copy.

## Correction
Memories: a new `mem-` version in the same chain; the old one is retracted from Hindsight and kept locally marked superseded. Vault facts: the old block stays in the note marked superseded (vault rule) and leaves the index; the new block is indexed. Whole notes are corrected by editing them in Obsidian.

## Forgetting (three kinds)
| Kind | What happens | Approval |
|---|---|---|
| `unindex` | Retract from Hindsight and the local index; the note stays in the vault; sync won't re-add it until re-included. | No (reversible) |
| `memory` | Delete a Hindsight-only memory (all versions): tombstone (id + hash, never text), local record removed, Hindsight documents deleted. | Yes |
| `full` | Identify the source (vault note, fact block with its versions, or one heading section) and derived copies (Hindsight documents, memory copies, local index); tombstone; remove the block/section/note with compare-and-swap; delete or purge-and-resend in Hindsight. | Yes |

Approvals are server-held, single use, expire in 10 minutes, and are bound to action + target + a digest of the plan (source section, note hash, content hashes, memory ids). If the note changes after approval, the digest no longer matches and nothing is removed. A client can only quote an approval id; there is no "confirm" flag. The stub grants only for a person on the Memory page (with the page token, when configured) or by their spoken yes (the voice approval id never leaves the server); `system` callers can't grant. **Residual risk until Stage B:** any local process that can pass as the loopback owner and fetch the page token can still grant; Stage B's durable approvals should bind grants to the owner-approval channel.

Tombstones stop resurrection: a sync or a restored file (e.g. a Git revert) never re-indexes forgotten ids, content or sections, and "remember" of forgotten text needs an explicit reaffirm. Honest limits returned with every full forget: the wiki's Git history, other clones, Obsidian Sync/cloud copies and backups, and Hindsight's database backups/WAL (and LLM request traces, if tracing is on) are not touched by this app.

## Security
- Identity from the verified OS request context only (`principalFor`); no principal → 401 on every route. Host headers and body names are ignored.
- No bulk delete, clear-bank or "forget everything" anywhere (API, routes or Hindsight client); forget takes exactly one target.
- CSRF: cross-site fetches and non-JSON posts are refused.

## Usage receipts
`receipts.jsonl`: `{at, op: retain|recall|delete|get|health, bank, doc_id, latency_ms, outcome, http_status, tokens|null, cost:{basis:"subscription-backed", cash_usd:null}}`. Tokens come from Hindsight's synchronous retain `usage`; recall and delete report none, so tokens are `null` (unknown, not zero). `GET /__memory/usage` summarises per operation.

## Tests
`bun --no-env-file test ./scripts/memory/`: synthetic vault + fake Hindsight, covering V5 acceptance items 1–9 and 11 (`connector.test.ts`), plus units, voice and the UI client. `connector.live.test.ts` runs the same flow against a real local Hindsight when `MEMORY_LIVE_HINDSIGHT_URL` (loopback) is set, on a fresh `syn-connector-live-*` bank, and deletes what it created. Item 10 (credential copies at startup) belongs to the Hindsight repair.

## Patch for lead (`vite.config.ts` is not this track's file)
`vite-memory.patch` in this folder (`git apply --check` passes against 3e95666). It registers `memoryPlugin` after `workspacePlugin` with `principalFor` built from the existing `isLoopback` + `tailnetPerson` contract. Optionally also pass `grantToken: () => REFRESH_TOKEN` so the approval button needs the per-run page token.

Screenshots (synthetic client): `memory-connector-1440.png`, `memory-connector-390.png`, `memory-capture-result-1440.png`, `memory-forget-approval-1440.png`, `memory-delete-memory-approval-390.png`, `memory-writes-off-1440.png`.
