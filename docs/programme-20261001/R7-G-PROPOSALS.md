# R7 worker G: proposals for the lead (identity code is the lead's; nothing here is applied)

Worker G (Claude Sonnet 5.5, `claude-sonnet-5-5`), 3 Oct 2026. Branch `r7/g-ops-shell-20261003`.

## P1. The gate's own pairing page tells a server-hub founder to use a device he does not have

`scripts/identity/gate.ts`, `PAIRING_PAGE` (served to a verified Tailscale login with no principal: a revoked session, or "require a code").
On the Ryzen (server role) the label reads "Or a one-time code from one of your paired devices". A founder whose only browser was revoked has none;
the real route is the console command. The Profile panel now says this (R7-G, `ConsoleCodeHelp`); the gate page still does not.

Patch (the page is plain HTML in a template string; `me.hubRole` is now returned by `GET /__devices/me`):

```diff
-<form id="codeForm"><label>Or a one-time code from one of your paired devices<input id="code" ...
+<form id="codeForm"><label id="codeLabel">Or a one-time code from one of your paired devices<input id="code" ...
@@ script, after `$("self").hidden = !me.canSelfPair;`
+    if (me.hubRole === "server") {
+      $("codeLabel").firstChild.textContent = "A one-time code made on the hub PC (run: bun scripts/identity/pair-code.ts --for " + (me.person ? me.person.id : "usman") + " --port 8081)";
+    }
```

Test to add in `scripts/identity/s1-security.test.ts` (or beside the existing pairing-page test): serve the page for a server-role hub with a verified login and no
session, GET `/__devices/me` returns `hubRole: "server"`, and the page source contains `pair-code.ts --for`. (Worker G's `scripts/devices/pairing-webview.test.tsx`
already pins the `/me` fields and the panel text.)

## P2. A pending Tailscale session is invisible to `identifyRequest` (by design), so every client has to special-case it

`scripts/identity/principal.ts` (`identifyRequest`, the `rows.find(...)` block around line 312) returns `session: null` and a `tailnet-person` process principal for a
valid but pending cookie. That is the right security outcome (a bare Tailscale login stays unconfirmed) and G did not touch it. The cost: the page cannot tell
"never paired" from "paired, waiting for a code". G solved it client-side in `/__devices/me` (`waitingSession`, `scripts/devices/service.ts`) by re-reading the
presented cookies with `sessionCookieValues` + `store.verifySession`. If you would rather the identity layer expose it, the smallest change is one extra field on
`RequestIdentity` (`pendingSession: SessionRow | null`, set where `row.pending` is true) and replace `waitingSession()` in service.ts with it. Either keeps the
rule: a pending session never becomes a principal.

## P3. Observation, not a patch: a first browser can end up holding the pending hub session

On a fresh data folder (default PC role) the very first page load in a clean headless Edge profile left the browser with `hubSession: {pending: true}`
(`GET /__devices/me`), and the store held one confirmed hub session (trusted on first use) plus one pending one with `source: msedge.exe#...`. So two
document requests in one load each minted a session and the browser kept the later (pending) cookie. In the owner's real browser this shows as "Confirm this browser"
on the first run. It was seen with Vite's dev server (a full reload after dependency re-optimisation is a plausible second navigation); on Ryzen the hub is the same
dev server. Suggested fix in `scripts/identity/gate.ts` `mintHubSession`: do not mint when the request already presented a `mu_session` cookie that verifies for
the hub (confirmed or pending), and when two navigations race, mint the pending one only if no session was minted for that peer in the last few seconds. Evidence:
`docs/programme-20261001/evidence/r7-ops/memory-journey-result.json` (`observe` row) and `scripts/memory/r7-journey-h.ts`.

## Review round (3 Oct 2026): what changed after the independent review

- **Approve needs the new device's match code (finding 1).** Done entirely in `scripts/devices` plus the panel; no identity-layer patch is needed. `POST /__devices/sessions/approve`
  now requires `matchCode` for a pending Tailscale browser of the approver's own person: missing is 400, wrong is 403, and the code is `sha256("match|"+sessionId)` first six hex
  characters (`ABC-123`). The pending session's own page and the approver's row show the same code, its source (tailnet address and node) and created time.
  One edit lands in a lead-owned test, `scripts/identity/server-role-review.test.ts`: its two successful approvals now pass `matchCode` from the pairing response (the
  403/404/409 expectations are unchanged because those checks still run before the code check).
- If you want the check inside the identity layer instead, the equivalent is a `pendingSession` field on `RequestIdentity` (P2 above) plus the same comparison in the route.
