# Dot gateway: the checklist Dot runs from its own cloud browser (staging)

For: Dot, against the STAGING URL a founder gives you (staging uses synthetic data only: "Synthetic Dental Co" and
friends). Design: `DOT-GATEWAY-DESIGN.md`. The lead sets staging up with `deploy/windows/gateway/README.md`.

Two stages. **Stage 1 is read-only** and is all you run first. **Stage 2 (writes)** happens later, separately, on
synthetic records only, after a founder grants `crm.write` and tells you so.

## Evidence for every step

For each step capture: the time (with time zone), the URL, the HTTP status, a screenshot, and the browser's network panel
row (status and response headers) where one is named. **Never capture or paste** a cookie value, a sign-in code, a
`X-Claude-OS-Token` value or a request body. If a step fails, stop, note what you saw, and tell a founder.

Staging settings to expect: a sign-in code works once and expires within 10 minutes; a session ends after **2 minutes idle**
or **10 minutes** in total (short on purpose, so you can see expiry happen).

Let `U` be the staging URL, e.g. `https://ryzen-pc.tailnet-name.ts.net`.

## Stage 1: read-only

1. **Anonymous is denied.** In a fresh browser session open `U/leads`. Expect the "Sign in to Agentic OS" page with HTTP
   401 (network panel), no OS content. Then open `U/__version` and `U/__events`: each is JSON `{"error":"Sign in first."...}`
   with 401. Capture: screenshot, the three statuses.
2. **A bad or used code is refused.** On `U/gw/enrol` enter `AAAAA-AAAAA-AAAAA-AAAAA`. Expect "That code is not valid".
   Capture: screenshot.
3. **Sign in.** Do this the moment the founder sends the link: a code is minted when you are ready, not in advance. If
   sign-in says the code is not valid although it is fresh and unused, tell the founder: someone's wrong guesses can burn
   an outstanding code (20 wrong codes, from anyone), and the founder simply mints a new one. Open the one-time link a founder sent (`U/gw/enrol#code=...`); the code fills in; press Sign in. Expect
   the OS to load. Network panel on the `POST /gw/enrol`: status 200 and a `Set-Cookie` for `__Host-mu_gw` with `Secure`,
   `HttpOnly`, `SameSite=Strict`, `Path=/` (capture the attributes, NOT the value). Open the same link again in another
   tab: expect it refused (single use). Capture: screenshots, the attribute list.
4. **Who am I.** Open `U/gw/me`. Expect `"person":"dot"` and `capabilities` = only `view`. Capture: screenshot.
5. **Reads work, and navigation.** The UI you get is a built copy served by the gateway itself. Using the OS's own
   navigation (not typed URLs), visit: the home page, Leads/CRM (expect the five synthetic leads), a lead's detail, the
   Agents workspace (Research and Builder bots), the job history, Coding. Reload one page, then open `U/leads` directly
   in a new tab (a deep link must load the same page). Use the browser's back and forward. Expect pages to render. Some
   panels will show an error or an empty state because their data is not shared with the gateway (for example the
   Business home, inbox, calendar, finance, memory, devices): note which, with a screenshot each. Voice and the wake word
   are not available through the gateway. Capture: one screenshot per page, plus the console errors.
5b. **Workspace panels.** Open `U/__workspace/pipeline`, `U/__workspace/websites`, `U/__workspace/groups`: expect JSON.
   Open `U/__workspace`, `U/__workspace/email`, `U/__workspace/receptionist`, `U/__workspace/enquiries`,
   `U/__workspace/call-queue`, `U/__workspace/today`, `U/__workspace/needs-you`: expect 403 each. Capture: the statuses.
5a. **Nothing but the app.** Open each and expect 404 (or 403/400), never file contents: `U/src/main.tsx`,
   `U/@vite/client`, `U/node_modules/.vite/deps/_metadata.json`, `U/package.json`, `U/docs/IDENTITY-ROUTES.md?raw`,
   `U/_shell.html::$DATA`, `U/leads.` Capture: the statuses.
6. **Every write is refused while read-only.** Try, through the UI where a button exists, and note the message:
   edit a lead's field and save; log a note on a lead; start a coding job; take over a bot computer; cancel a job; approve
   or decline anything in approvals if shown. Expect each to fail with a refusal (HTTP 403 in the network panel, e.g.
   "That needs the crm.write capability" or "That is not available through the gateway") and NOTHING to change (reload
   and check). Then open `U/gw/test-update` and press "1. Create": expect HTTP 403 mentioning `crm.write`. Capture: the
   403 rows, screenshots before and after a reload.
7. **Live updates, no duplicates.** Keep the OS open on the Coding page. The gateway's live stream carries coding job
   events only (no approvals, memory, trigger, bot or Jarvis notifications). Ask a founder to trigger one synthetic coding
   job event on staging. Expect it to appear once. Then switch the network off and on (or
   put the tab to sleep for a minute and return): the stream reconnects (network panel: a new `/__events` request whose
   request headers include `Last-Event-ID`) and no event appears twice. Capture: the `/__events` rows and request
   headers, a screenshot of the activity list.
8. **Idle expiry.** Leave the tab untouched for 3 minutes, then click anything that loads data. Expect the sign-in page
   or 401s and the live stream to have stopped (network panel: the `/__events` request ended). Capture: time of last
   action, time of the 401, screenshot.
9. **Absolute expiry.** Ask for a new code, sign in, and keep using the OS (a click every minute). About 10 minutes after
   signing in, expect 401 / the sign-in page even though you were active. Capture: sign-in time, time of the first 401.
10. **Immediate revocation.** Sign in with a new code and keep a page with live activity open. Tell a founder "ready to
    revoke" and the time. The founder runs `cli revoke-session <id>` (or `--all`). Expect within about a second: the
    `/__events` request ends, and the next click gives 401 or the sign-in page. Capture: the founder's revoke time, the
    time the stream ended, the 401.
11. **Logout.** Sign in with a new code; then in the browser console run
    `fetch("/__token").then(r => r.json()).then(t => fetch("/gw/logout", { method: "POST", headers: { "X-Claude-OS-Token": t.token } })).then(r => r.status)`
    (prints 200 without showing the token). Reload: expect the sign-in page. Capture: the status, the screenshot.
12. **The kill switch** (with a founder). Founder runs `cli kill on`. Expect every page and `U/gw/health` to answer 503
    "The gateway is switched off", including sign-in. Founder runs `cli kill off`. Capture: screenshots, statuses.

## Stage 2: writes (later, separately, synthetic records only)

Only after a founder grants `crm.write` (`cli grant crm.write --by <founder> --hours 1`) and tells you.

13. **The capability arrives.** Reload `U/gw/me`: `crm.write` is listed with `grantedBy` and an expiry. Network panel on
    that request: a NEW `Set-Cookie` for `__Host-mu_gw` (the session rotated because its privilege changed).
14. **The reversible test update.** Open `U/gw/test-update` and press the buttons in order, capturing the output box after
    each: 1. Create (expect 200, `created: true`, an `activityId`), 2. Verify (expect the activity, `"test":true`,
    `"by":{"agent":"dot",...,"delegatedBy":"<founder>"}`), 3. Create again (expect the SAME `activityId`,
    `created: false`), 4. Remove (expect 200), 5. Verify removed (expect `"activity":null`). The test store is clearly
    marked; it is not the CRM database.
15. **Still scoped.** With `crm.write`, try step 6's other writes again (start a coding job, take over a bot, approvals):
    each must still be refused with 403.
16. **Revoke the capability.** Founder runs `cli revoke-grant crm.write`. Press "1. Create" again: expect 403.
17. **Audit (founder).** Founder runs `cli audit --tail 40` and confirms every line from your session says `"person":"dot"`,
    each write shows `capability`, `route`, `recordIds` and `delegatedBy`, and no line contains a cookie, code, token or body.

## Report back

One message to the founders: pass or fail per step (1-12, and 13-17 when run), the evidence list, the pages from step 5
that showed errors, anything that surprised you, and the browser and version you used.
