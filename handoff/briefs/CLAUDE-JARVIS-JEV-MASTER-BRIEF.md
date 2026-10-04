# AgenticOS: finish the product around Jarvis and Jev

> **Sanitised copy, 4 Oct 2026.** Local absolute paths to private files, the tailnet hostname and personal identifiers beyond the founders' first names have been removed; removed items are marked `<... removed>`. Content is otherwise unchanged. Revisions named here are historical checkpoints, not the current baseline (see `handoff/README.md`).

Owner brief for the main Claude integration chat. Prepared 3 October 2026 from the owner's instructions, a source review of Agentic OS V4.5, public reference repositories, and read-only inspection of existing migration code. This is an implementation brief, not a claim that the current live OS has been independently accepted.

## 1. The product I want

Build and finish my everyday M&U Ventures operating system. I need to run my business, manage clients and leads, find documents and invoices, build websites and software, research, and use my own PC through one assistant.

**Jarvis is the name, personality and voice I speak to. Jev is the central decision model that directs the work.** Other models are workers Jev delegates to. A worker finishing a task must return its progress and result to the same Jarvis conversation.

Examples:

- “Hey Jarvis, open YouTube on my PC.” Jev routes this to the paired PC executor and verifies that the tab opened.
- “Open Google and search for this.” Jev routes the browser action, preserving my search text and target device.
- “Research these companies.” Jev chooses the research tools and, when needed, an appropriate model or Research bot computer.
- “Fix this software bug using Opus on Claude Max 2.” Jev delegates a coding job with that account/model pinned. It stays pinned through retries and unrelated role edits.
- “Build a website for this lead.” Jev uses the lead's verified information, appropriate generator/design worker and isolated workspace; I can follow the work, take over, and open the actual result.
- “Show me this client's quote and prepare a follow-up.” Jarvis shows the real CRM/finance records and creates a draft linked to them.

The Grok/Open Grok, Rakazo, Open Dot and OpenMaus experience belongs inside this product. I should not need to understand separate agent frameworks or configure several competing assistants.

This brief supersedes older assumptions that Hermes or a general language model is the primary router. Reuse those runtimes as tools or workers beneath the Jev-led controller where they are useful.

## 2. Establish the real baseline, then continue the current work

You are the main integrator. Verify the current production revision on Ryzen, the running build, candidate branch, existing agents, ownership map and pending changes before editing. Preserve all owner files and dirty worktrees. Do not treat the old original checkout as the current production baseline.

The owner's latest report said production was `664c0c91` at `https://<ryzen-hub>.<tailnet>.ts.net:8443` (hostname removed), with new templates active. A later corrective batch included `b9707021` and was waiting for the real-estate `/contact` repair and two wording changes. These are historical checkpoints to locate; re-verify them rather than assuming they are still current.

Continue and finish that corrective batch as appropriate. In particular, check whether the live contact form, Jarvis routing repair, release-script repair, prospect-stage correction and stale browser cleanup have actually landed. Avoid replaying releases or CRM imports that are already complete.

The original V4.5 reference archive is:

`<owner's local copy of the Agentic OS V4.5 archive; path removed>`

Archive SHA-256: `81DDA732BE29E1A68BCF97A74D500C2821987AF81A550A3265B1C799F925D653`.

Inspect it as a design/source reference. Do not install it over the newer OS. Its relevant files are `scripts/jev.ts`, `scripts/jev-router.ts`, `scripts/jev-voice.ts`, `src/lib/jev-models.ts` and `docs/JARVIS-AGENT-TASKS.md`.

Research notes and selected inspected source are in `<local research folder; path removed>`. Read `REFERENCE-RESEARCH.md` alongside this brief.

An important source finding: V4.5 routes once per chat and saves that model for later turns. Compare the current code with this. My requirement is task-based Auto routing, with stable context inside each delegated job, not one model locked to every unrelated task in a conversation.

The current migration already has a central TypeSafe client, Jev routing, companion actions, computer leases/viewers, native coding jobs, business stores, an event stream and memory. Find and complete these paths. Create one implementation for each responsibility.

## 3. Implement this architecture

```text
Voice / text / current page context
             ↓
Identity + conversation + target-device context
             ↓
Jev makes typed intent, capability and delegation decisions
             ↓
AgenticOS controller owns permissions, durable state and execution
             ↓
Business tools / paired PC / bot computer / model worker
             ↓
Observed outcome + saved result + linked business records
             ↓
The same Jarvis conversation, interface and chosen voice
```

Jev is a TypeSafe System One decision model. It answers typed Choice, Score and Noul questions. It does not generate long explanations, website code or arbitrary execution plans. Honour my architecture by giving Jev control of the meaningful routing decisions and using language models to write answers, plans and code under that controller.

Exact arithmetic, state transitions, permissions and idempotency remain ordinary deterministic code. Do not send every minor state update or click to an LLM. Do not have a language model make all the routing decisions first and call Jev afterwards merely to label them.

Use one bounded decision pass where practical; batch related judgments. Provide Jev finite, validated options from the actual capability catalogue. Preserve the original request and relevant record/context identifiers as data; do not expect Jev to invent free-form tool arguments. Workers may propose arguments, but validate them before execution.

Keep these entities distinct:

- **Assistant:** Jarvis, the continuing user-facing identity.
- **Decision model:** Jev, directing the task.
- **Worker:** a role such as Research or Builder, with instructions, task history and scoped access.
- **Model/account:** the actual available native or API route assigned to a task.
- **Computer:** an execution environment with its own resources, files and control lease.

A worker need not own a permanently running desktop. A coding task may execute through native Claude/Codex without needing a GUI. A computer may be reused sequentially under a fenced lease. Model choice must not silently change computer ownership or permissions.

## 4. Routing and execution contract

Make the existing controller consistently resolve:

- acting principal and originating confirmed session;
- conversation, task/job and parent-request identifiers;
- current page/selected lead/client/job context;
- intended device or shared bot computer;
- direct tool versus generative worker versus coding job;
- actual provider, account, model and effort when applicable;
- explicit user constraints and model/account pins;
- required permission or a genuinely missing detail;
- durable progress, observed outcome and where the result returns.

Implement the following behaviour:

1. **Routine actions are fast.** Opening a URL, navigating a known page, looking up a record and performing simple supported browser actions use the Jev-led action path and existing executors. They do not launch an Opus coding job.
2. **The target is correct.** “On my PC” means my paired device. “On Research” means that shared bot computer. A lead's website comes from that lead's verified URL. A missing/ambiguous target should produce one useful clarification or a visible actionable error, not an invented device.
3. **Compound requests work as a sequence.** “Open Google, search for X, then open YouTube” has linked steps, reports partial failure truthfully and does not lose the original search wording.
4. **Auto is selected per task.** Consider task type, capability, availability, quota, effort, context and existing configuration. Keep a delegated job's context stable. Do not bounce models repeatedly just because Auto exists.
5. **Explicit choice wins.** If I request a specific model/account, pin it for the whole job. If unavailable, explain and offer an alternative; do not silently swap accounts or use a paid API.
6. **Use real catalogues.** Verify current Claude/Codex/model identifiers and actual account availability. Do not carry obsolete V4.5 model names into production or hardcode imagined access. Distinguish subscription logins from billable API routes.
7. **Meaningful results are observed.** A successful planner response or ended model turn is not proof that a tab opened, a file exists or a website was built. Verify the postcondition and attach the actual artefact or record.
8. **Retries are safe.** Stable request/job IDs prevent duplicated tasks, invoices, messages and results. Resume or query existing work before creating another run. Never replay an uncertain external effect automatically.
9. **Progress is durable.** Closing a panel or reconnecting does not discard work. A hub restart recovers status and resumable work honestly; interrupted non-resumable work is marked interrupted and can be resumed explicitly.
10. **Stop reaches execution.** Chat Stop cancels the actual child job/tool run, not just speech or a UI card. Report the confirmed cancellation outcome.
11. **Failures lead somewhere.** A blocker has the appropriate control: open job, retry review, pair this browser, reconnect companion, grant an already-requested permission, or take over. Preserve an existing approval's scope across authorised continuation; do not repeatedly ask for the same approval.
12. **Jev outages are explicit.** Use the existing bounded timeout policy. A previously authorised exact tool action may use a documented deterministic recovery path if that is safe. Do not substitute an unannounced language-model router or invent a successful decision.

Measure decision latency, dispatch latency and observable completion separately. TypeSafe's advertised decision speed is not a promise about total browser or coding time. Establish a baseline and improve it without changing successful semantics.

## 5. Voice and conversation continuity

Keep my chosen Jarvis name and voice. Worker/model changes must not change who I am talking to. Creative narration voices and receptionist voices are separate configurations.

Use the existing voice system wherever it is functioning. Ensure speech, typing and the same relevant UI actions reach the same routing/controller path. Fix gaps where only one voice engine can delegate or cancel work.

- Accept a task, give a short truthful acknowledgement, then execute.
- For a quick action, confirm once after observing it.
- For a long task, show progress and let me keep talking or leave.
- Return one completion event to the original conversation. Avoid duplicate cards and repeated spoken completions on refresh/reconnect.
- Speak the result when the appropriate voice session is active; otherwise retain it as an unread result. Do not claim an ended session received speech.
- Handle interruptions, self-echo, reconnects and cancellation correctly.
- Preserve references such as “that lead”, “that job”, “continue it” and “send it to Builder” using explicit conversation/page context.

Physical microphone acceptance remains a separate proof. If no microphone is available, complete typed and audio-fixture checks and clearly record the physical test still needed.

## 6. Finish a coherent interface

Use Rakazo's computer workspace and bot panel as the principal code/design reference, Open Dot's voice/background-task behaviour as a reference, and OpenMausBot's setup, routines and leases where useful. Grok Build/Open Grok mainly contribute coding/session patterns; their TUI is not a finished graphical bot-computer workspace.

Keep the existing M&U visual language, with readable type, calm spacing, accessible contrast and reduced motion. Make the interface attractive through hierarchy and real interactions, not extra decorative status boxes.

Deliver:

- A persistent Jarvis conversation accessible from the existing business pages.
- A compact worker selector with actual status, recent work and result links.
- A main conversation area and optional resizable live computer beside it.
- Browser, terminal and files available where the selected environment supports them.
- Tasks/results accessible without losing the conversation.
- Simple worker setup: purpose, available model/account, computer choice and scoped permissions; advanced technical settings collapsed.
- In-context takeover, stop, approvals and retry controls tied to actual backend state.
- Working mobile layouts with a usable full-screen viewer and accessible keyboard/focus behaviour.
- A visible way to complete browser pairing when required. An unpaired browser must not see sensitive content, but the UI should explain and offer the genuine next step.

Research and Builder are initial roles. Add Designer/business roles only when supported and useful. Do not start four permanent desktops just to populate tabs. New, edit, duplicate and archive must preserve appropriate task history without duplicating credentials or ownership.

Reuse the existing navigation. Keep one obvious Agents/workers home beneath Jarvis and keep diagnostic computer/device pages available without creating competing assistant products. Preserve old job/result links.

Remove repetitive descriptions, contradictory ready/disconnected states, exposed environment-variable names, huge empty panels and developer jargon. A blocked task must not look successful. A connected host with no desktop stream must not be labelled as a working screen.

## 7. Connect the business OS

Use the existing CRM, Leads, Finance/deal desk, projects/tasks, documents, generated websites, Design and memory stores as the source of truth. Reconcile cloud work against current history before applying it. Do not introduce parallel customer databases or import Dot's deliveries twice.

Make these usable from the UI and Jarvis:

- Search companies, contacts, deals, projects, invoices, quotes, tasks and linked files.
- Open the correct record from a spoken/typed reference.
- Save a verified note, create a task and link work to the correct client/deal.
- Prepare quotes/invoices using approved pricing, exact arithmetic and existing Australian tax rules/configuration. Missing pricing stays pending; never fabricate a discount or tax treatment.
- Generate a website for a selected lead from verified business details, returning a working multi-page preview with listings when supplied.
- View existing draft outreach and meeting packs, with recipient and identity gaps still flagged.
- Save coding/design/research outputs to Tasks & Files and the appropriate business record.
- Show the next real action, with useful ownership and dependencies.

Respect the existing Aldergate requirement: preserve the complete real-estate structure and experience, changing the business information appropriately. Check nested assets, listings/detail pages, enquiry forms, published contact details, expiry and mobile menus. Do not invent listings, testimonials, claims or client permission.

Outreach remains unsent unless I explicitly authorise sending. The known recipient-identity gap between two real-estate prospects, one dental prospect's identity/bounce/demo issues (names removed) and unverified prices must retain their actual restrictions.

The separately owned client website work (names removed) remains with Dot. Receptionist live launch remains on hold. Preserve the separate website redesign concepts; do not deploy an unselected concept or expand this task into a competing marketing-site project.

## 8. Remote computers and operations

Ryzen is the always-on self-hosted hub accessed privately through Tailscale. It is not a newly purchased public cloud service. Use the existing Windows/WSL, SSH, companion, supervisor and viewer infrastructure. I have not approved a new paid cloud host.

- Execute owner desktop requests on the owner's paired companion.
- Execute shared bot tasks on the designated isolated bot environments.
- Never drive the hub's physical desktop through server-role/away-mode bypasses.
- Keep personal desktops scoped to their owners; shared business records/bot computers follow the existing two-founder policy.
- Keep bot browsers unprivileged with their sandbox enabled.
- Separate profiles/cookies/files and use the existing fenced control lease. Profile folders alone are not a security boundary for mutually untrusted workloads; strengthen isolation where the threat model requires it.
- Do not copy native account credentials or founder cookies between machines/bots. Use supported native sign-in and approved session delegation.
- Viewer control, bot execution and task cancellation must agree on who holds the lease.
- Takeover pauses at a safe step boundary, blocks competing input and resumes only under a valid lease. Stop cancels work promptly and observably.
- Launch desktops lazily and measure capacity on Ryzen's actual 16 GB hardware. Report active desktops separately from stored bot profiles. Do not imply unlimited concurrent computers.
- Persist files and task records across restarts; detect missing packages, unavailable providers and disconnected screens clearly.

Do not widen public exposure as part of this UI/routing work. Preserve the separate Dot gateway track and its actual staging/production approvals. A successful local shell probe is not proof that Dot's managed cloud browser can use the service.

Finish operational recovery on the real host with backups, rollback and a planned reboot when authorised and coordinated. Do not shut down my main PC to prove independence while other work is running. Verify that the hub does not depend on the old local hub; coordinate any disruptive test.

## 9. Memory, background work and integrations

Keep Hindsight, the existing vault/Obsidian sync, useful Hermes/OpenClaw integrations and current activity stream beneath the same controller. Retrieve relevant context rather than loading every historical conversation into each request.

Separate saved facts, task history, documents, credentials and ephemeral screen observations. Preserve provenance, corrections and ownership. Do not import private recordings, credentials, raw traces or datasets from reference archives.

Background tasks, routines and triggers must use the existing durable job/scheduler system. Show their history and results in the relevant conversation. Catch-up after downtime must not silently duplicate external actions. Keep notifications concise and meaningful.

Evaluate context-mode in one isolated coding profile before broader use. Demonstrate a benefit in context/cost while retaining task correctness and approval controls. Do not install global hooks across all native accounts as an experiment.

Select Agent-Reach tools for useful public research, using existing SearXNG/browser tools first. Cookie-dependent or paid/proxy paths need their actual prerequisites; never clone personal sessions or assume every advertised source works.

## 10. Reuse the reference code intelligently

Review current licences at the exact revision/component before copying. Preserve attribution and required notices. A public GitHub repository or an author saying “open source” is not sufficient by itself.

| Reference | Intended use |
| --- | --- |
| `elie222/rakazo` | Apache-2.0 computer workspace, bot setup, runtime/provider separation and persistent-profile patterns. Adapt selected components to our APIs/auth/design system. |
| `milind-soni/OpenMausBot` | Apache-2.0 community setup, routines, memory and fenced-lease patterns; exclude separately licensed enterprise code. |
| `composio-community/open-dot` | Independently implement voice-to-background-job and conversation continuity. No licence was found in the reviewed tree: do not copy its code without a verified grant. Do not adopt its process-memory queue as our durable queue. |
| `xai-org/grok-build` | Apache-2.0 worker harness/headless sessions, checkpoints and tool policy. Optional adapter where it adds value; not a mandatory provider. |
| `mweinbach/open-grok` | Provider/session continuity, live catalogue and native-account adapter patterns. Avoid replacing already-working native login flows. |
| `nightly-labs/openbot` | Newly found reference for persistent workspaces and crash-safe queues. Current code is PolyForm Noncommercial; independently implement patterns or verify an appropriately licensed older revision before commercial reuse. |
| `NVIDIA/OpenShell` | Apache-2.0 sandbox/network policy candidate. Windows WSL support is experimental; evaluate separately, not a prerequisite for making everyday tasks work. |
| `mksglu/context-mode` | Elastic-2.0 context management trial in an isolated profile, subject to its actual terms. |
| `mattpocock/skills` | Select a few useful implementation/debugging/interface skills. Avoid layers of procedural prompts that delay execution. |
| `Panniantong/Agent-Reach` | MIT public-research adapters with honest platform/account prerequisites. |
| `anthropics/financial-services` | Source/assumption discipline and selected financial-document workflows. Not a replacement for our CRM, invoicing or accounting. |
| `tashfeenahmed/freellmapi` | Noncritical, opt-in experimentation only; the README limits intended use to personal experimentation. Do not base business-critical routing on advertised free quotas. |
| LiveKit Agents | Voice turn-taking, interruptions and transport patterns; reuse already adopted behaviour before introducing a new voice stack. |
| `vercel-labs/agent-browser` | Exact browser/session targeting and persistent profiles; preserve fail-closed guards against acting on a neighbouring tab. |
| Cua | A measured optional executor. Keep the faster existing native companion path when it already works. |
| noVNC | Existing browser viewer through our authenticated proxy and control lease. |
| E2B / Kasm | Optional future execution environments, not mandatory new cloud purchases or replacements for the working Ryzen stack. |
| OSWorld | Outcome-based computer-task evaluation ideas, converted into our concrete user journeys. |
| V4.5 and the earlier Jarvis install skill | Jev/native delegation and intake-to-worker handoff reference. Do not install a parallel Base44/Retell product or override our voice. |

Keep a short adoption ledger: component, pinned revision, licence, existing equivalent, chosen change and evidence. Make decisions once and proceed. This ledger supports implementation; it is not another large research phase.

## 11. Work in parallel without creating contention

Use available agent capacity for necessary independent work. Coordinate up to eight active workers total when the platform supports it, including the reviewer. Count already-running workers; do not launch eight more over them. Usage availability does not justify competing full suites or GPU/browser load on this machine.

Suggested ownership, adjusted to current active assignments:

1. Main integrator: baseline, shared contracts/navigation, merge order and release.
2. Jev/controller owner: per-task routing, context, explicit pins and compound actions.
3. Voice/conversation owner: one Jarvis identity, task events, interruption and completion continuity.
4. Agents UI owner: Rakazo-informed layout and actionable task/computer states.
5. Computer/native-job owner: execution, leases, takeover, Stop, recovery and real results.
6. Business integration owner: CRM/Finance/files/generator paths and cloud-delivery reconciliation.
7. Operations/acceptance owner: targeted real-host journeys, performance and recovery evidence.
8. Independent reviewer: combined code/security/behaviour review and re-test of concrete findings.

Give each shared file one resolver. Owners add focused regression tests for real bugs. Maintain small reviewable commits on isolated branches/worktrees. Route findings back to the owner instead of starting overlapping fixers.

Do not run multiple full gates concurrently or mutate a frozen candidate mid-run. A full gate is a release requirement; repeated broad gates are not a substitute for connecting a feature. Run focused checks during development, then the required serial gate on the final candidate.

## 12. Delivery order

**First: finish the current corrective release and demonstrate the basic loop.** Give priority to a real typed task opening a tab on my PC, a task on Research, and a pinned coding task returning a file/result. Use available confirmed sessions and existing tools. Do not wait for a complete visual redesign to make these work.

**Second: complete the unified conversation/workspace.** Integrate the layout, live computer, task history, files, setup and controls around those working paths.

**Third: complete connected business journeys.** CRM notes/tasks, quote drafts, website generation and linked outputs must be usable from the same assistant.

**Fourth: verify recovery and release the coherent result.** Review the final diff, run the required gate, take a verified backup, release on Ryzen and demonstrate the live UI at the deployed revision. Rebuild/activate affected template caches with recorded provenance when the generator requires it.

Release useful completed batches with rollback. Do not hold the entire product indefinitely for optional framework adoption, cosmetic experiments or unavailable external services. Track genuinely deferred features explicitly; never label them working.

## 13. End-to-end acceptance

Build an acceptance table with request, entry point, principal/device, exact revision, expected effect, observed effect, saved evidence and PASS/FAIL/BLOCKED/NOT RUN. Use synthetic records for destructive/mutation tests. Test the actual deployed UI and executors, not only mocked adapters.

Required journeys:

1. Type “open YouTube on my PC”; observe the correct tab on the correct paired PC.
2. Repeat through the actual voice path when a microphone/session is available.
3. “Open Google and search for [a unique phrase]”; observe the exact query.
4. A compound PC request completes its ordered steps and truthfully reports an induced failure.
5. An ambiguous device/lead reference produces one useful clarification and no wrong-device action.
6. A routine task uses the direct action path without launching a coding worker.
7. A research task delegates, produces sourced output and returns it to the original conversation.
8. A coding task uses an explicitly chosen real account/model, produces a changed file and a usable diff/result link.
9. Unavailable pinned model/account refuses honestly; no hidden paid fallback or account switch.
10. A second unrelated task in the same conversation can receive a different suitable Auto worker while the first job retains its context.
11. A website task produces the complete expected multi-page site; listings and form inputs behave correctly when supplied.
12. A shared bot displays its actual screen; takeover prevents competing input and Stop cancels actual execution.
13. Switching tabs, closing/reopening the page and reconnecting retains task history and files without duplicate execution/completions.
14. A completed job has a terminal status and opens its actual result; failed/blocked jobs show the correct action.
15. Find a synthetic client, save a note and create a linked task; refresh and confirm persistence.
16. Create a quote/invoice draft from approved inputs; verify exact totals and links, with nothing sent.
17. Both founders access the intended shared business record from their own confirmed sessions; conflicting edits are handled truthfully.
18. An unpaired or revoked browser cannot read sensitive conversations/accounts or start jobs through any alternate command path.
19. Another founder cannot control the first founder's personal desktop; authorised shared bots remain usable.
20. Server/away mode cannot drive the hub's physical desktop.
21. A bot/companion disconnect presents the correct recovery action and does not fabricate readiness.
22. The hub survives the authorised restart/reboot test, restores expected services/data and does not duplicate pending external effects.
23. Desktop and phone layouts work: pairing, chat, results, drawer/forms, viewer and controls. Check keyboard navigation, contrast and reduced motion.
24. Existing coding jobs, CRM/Leads, Finance, Memory, Design/files and generated previews remain accessible. Every visible main workflow is either exercised or explicitly recorded as blocked/not run; extend this table from the actual route inventory.

Speech playback, a shell probe, a static screenshot and a synthetic test each prove different things. Do not collapse them into “everything works”. If an acceptance item genuinely requires my physical microphone, Mehroz's own session or a disruptive reboot decision, prepare it completely and name that remaining action. Continue independent authorised work meanwhile.

Fix actual acceptance failures and re-test them. Do not merely document a broken visible feature and call the release complete.

## 14. Autonomy and completion

You have my instruction to implement and integrate this work into my existing private OS through its normal reviewed, backed-up release process. Continue authorised implementation without asking me to approve the same routine step repeatedly.

Do not purchase services, increase external exposure, copy credentials, send client outreach, launch the receptionist, deploy the separately owned client work or replace the marketing website under this brief. Those have separate owners/approvals. Name a real blocking permission or missing input precisely; do not invent a blanket prohibition on ordinary authorised administration.

Keep updates short and concrete: what now works, what is being fixed, the next meaningful result. Test counts are supporting evidence, not the headline product outcome.

Your final report must show:

- the live URL and exact running revision;
- demonstrated tasks with observable results;
- worker/model routing and preserved explicit pins;
- where business records and saved artefacts are accessible;
- backup/rollback point and changed template versions;
- remaining failed, blocked, unverified or deferred journeys;
- only the smallest genuinely necessary owner actions.

**Start by verifying the current state and assigning ownership. Then make the three basic task loops work and prove them. Finish the connected product.**
