/**
 * The gateway's own two pages. Self-contained (no app files, no external requests), served with a strict
 * Content-Security-Policy whose only script is the nonce'd one below.
 */
const STYLE = `:root{color-scheme:light dark;--bg:#0b0b0c;--fg:#f3f1ea;--muted:#a8a49a;--line:#2a2a2d;--accent:#c9a54a}
@media (prefers-color-scheme:light){:root{--bg:#f7f5ef;--fg:#141414;--muted:#5d5a52;--line:#d8d4c9;--accent:#8a6d1f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.5rem;margin:0 0 .5rem}p,li{color:var(--muted)}
label{display:grid;gap:.25rem;margin-top:1rem;font-size:.9rem}
input{min-height:2.75rem;padding:0 .75rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:inherit;font:inherit;letter-spacing:.05em}
button{margin:1rem .5rem 0 0;min-height:2.75rem;padding:0 1rem;border:0;border-radius:.5rem;background:var(--accent);color:#0b0b0c;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}[role=alert]{color:#e0735b}
pre{white-space:pre-wrap;border:1px solid var(--line);border-radius:.5rem;padding:.75rem;font-size:.85rem;min-height:6rem}`;

export const pageCsp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;

const shell = (title: string, nonce: string, body: string, script: string) => `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>${body}</main><script nonce="${nonce}">${script}</script></body></html>`;

/** Sign-in. A founder's one-time link carries the code after the "#", which never leaves the browser until Sign in is pressed. */
export function enrolPage(nonce: string): string {
  return shell(
    "Sign in · Agentic OS gateway",
    nonce,
    `<h1>Sign in to Agentic OS</h1>
<p>This is the collaborator gateway. Enter the one-time code a founder gave you. Each code works once and expires within minutes.</p>
<form id="f"><label>One-time code<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="ABCDE-FGHJK-MNPQR-STVWX" required></label>
<button id="go" type="submit">Sign in</button></form>
<form id="rf"><label>Or reconnect with your reconnect key<input id="rk" name="rk" type="password" autocomplete="off" spellcheck="false" maxlength="128" placeholder="mugw_rk_..."></label>
<button id="rgo" type="submit">Reconnect</button></form>
<p id="msg" role="alert" aria-live="polite"></p>
<section id="done" hidden><h1>Signed in</h1>
<p>Your reconnect key, shown this once. Keep it in your own secret store. It gets you new access in a new task or after access expires, until <span id="until"></span> or until a founder revokes it. It is not shown again.</p>
<pre id="key"></pre><button id="cont" type="button">Continue to Agentic OS</button></section>`,
    `(() => {
  const $ = (id) => document.getElementById(id);
  const m = /[#&]code=([A-Za-z0-9-]{8,40})/.exec(location.hash);
  if (m) { $("code").value = m[1]; history.replaceState(null, "", location.pathname); }
  $("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("go").disabled = true; $("msg").textContent = "";
    try {
      const r = await fetch("/gw/enrol", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-MU-Gateway-Enrol": "1" }, body: JSON.stringify({ code: $("code").value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "That did not work.");
      $("code").value = "";
      $("f").hidden = true; $("rf").hidden = true;
      $("key").textContent = j.reconnectKey || "";
      $("until").textContent = j.identity ? new Date(j.identity.expiresAt).toLocaleString("en-AU") : "it expires";
      $("done").hidden = false;
    } catch (err) { $("msg").textContent = err.message; $("go").disabled = false; }
  });
  const next = () => location.replace(location.pathname === "/gw/enrol" ? "/" : location.href);
  $("cont").addEventListener("click", () => { $("key").textContent = ""; next(); });
  $("rf").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("rgo").disabled = true; $("msg").textContent = "";
    try {
      const r = await fetch("/gw/renew", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-MU-Gateway-Enrol": "1" }, body: JSON.stringify({ reconnectKey: $("rk").value.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "That did not work.");
      $("rk").value = "";
      next();
    } catch (err) { $("msg").textContent = err.message; $("rgo").disabled = false; }
  });
})();`,
  );
}

/** The reversible test update (DOT-GATEWAY-CHECKLIST.md step 8): create, verify, remove, verify gone. */
export function testUpdatePage(nonce: string): string {
  return shell(
    "Reversible test update · Agentic OS gateway",
    nonce,
    `<h1>Reversible test update</h1>
<p>Adds one clearly-marked test activity through <code>crm.activity.add</code>, reads it back, then removes it. Needs the <strong>crm.write</strong> capability; without it every step is refused and nothing changes.</p>
<button id="create">1. Create</button><button id="verify">2. Verify</button><button id="again">3. Create again (no duplicate)</button><button id="remove">4. Remove</button><button id="gone">5. Verify removed</button>
<pre id="out" aria-live="polite"></pre>`,
    `(() => {
  const $ = (id) => document.getElementById(id);
  const eventId = "dot-gateway-test:" + (sessionStorage.getItem("gwTestEvent") || (() => { const v = String(Date.now()); sessionStorage.setItem("gwTestEvent", v); return v; })());
  let activityId = sessionStorage.getItem("gwTestActivity") || "";
  const say = (label, status, body) => { $("out").textContent += label + " -> HTTP " + status + " " + JSON.stringify(body) + "\\n"; };
  const token = async () => (await (await fetch("/__token", { credentials: "same-origin" })).json()).token;
  const call = async (label, method, path, body) => {
    const headers = { "X-Claude-OS-Token": method === "GET" ? "" : await token() };
    if (body) headers["Content-Type"] = "application/json";
    const r = await fetch(path, { method, credentials: "same-origin", headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    say(label, r.status, j);
    return { r, j };
  };
  const add = async (label) => {
    const { r, j } = await call(label, "POST", "/__gateway/crm/activity", { ref: { kind: "company", id: "gateway-test" }, eventId, kind: "note", title: "Gateway test note (safe to remove)" });
    if (r.ok && j.activityId) { activityId = j.activityId; sessionStorage.setItem("gwTestActivity", activityId); }
  };
  $("create").onclick = () => add("create");
  $("again").onclick = () => add("create again");
  $("verify").onclick = () => call("verify", "GET", "/__gateway/crm/activity?eventId=" + encodeURIComponent(eventId));
  $("remove").onclick = () => activityId ? call("remove", "DELETE", "/__gateway/crm/activity/" + encodeURIComponent(activityId)) : say("remove", 0, { error: "Create first." });
  $("gone").onclick = () => call("verify removed", "GET", "/__gateway/crm/activity?eventId=" + encodeURIComponent(eventId));
})();`,
  );
}
