import { test } from "bun:test";
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createPrincipalGate, requestPrincipal, requestPageTokenMatches } from '../identity/gate';
import { pageTokenFor, pairingTokenFor } from '../identity/principal';
import { DeviceStore, SESSION_TTL_MS } from '../devices/store';
import { syntheticTailnetForTests } from '../remote-access';
import { createCrmMiddleware } from './plugin';
import { createGatewayTrust } from '../gateway/hub';
import { signAssertion } from '../gateway/assertion';
import { ASSERTION_HEADER, VIA_VALUE, FILES } from '../gateway/config';
import { createLocalOwnerProof, readLocalOwnerToken, writeProtectedSecret } from '../identity/local-owner-token';


// Real identity/session/gateway and CRM transport composed together. Only the CRM data service is
// in memory; every session, gateway assertion and filesystem fixture is synthetic and temporary.
test("paired founder CRM writes retain their own CSRF proof through the real identity gate", async () => {
  const previousDataDir = process.env.MU_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), "founder-crm-gate-"));
  try {
    // Force every data access into this test's empty fixture directory.
    process.env.MU_DATA_DIR = join(root, '.operator-data');
    mkdirSync(process.env.MU_DATA_DIR);
    const host = 'proof-hub.tail-test.ts.net:8443';
    const tailnetName = host.split(':')[0];
    const internal = 'synthetic-internal-page-token';
    const gatewayKey = 'synthetic-gateway-key-for-isolated-proof-only-00000000';
    const login = { usman: 'owner@example.test', mehroz: 'partner@example.test' };
    writeFileSync(join(process.env.MU_DATA_DIR, 'people.json'), JSON.stringify({ people: Object.entries(login).map(([name, value]) => ({ name: name === 'usman' ? 'Usman' : 'Mehroz', tailscale: [value] })) }));
    let now = Date.now() - SESSION_TTL_MS - 1000;
    const store = new DeviceStore(root, { now: () => now });
    const expired = store.mintSession('usman', 'Synthetic expired', 'tailnet');
    now = Date.now();
    const sessions = Object.fromEntries(Object.keys(login).map(person => [person, store.mintSession(person, 'Synthetic confirmed', 'tailnet')]));
    const revoked = store.mintSession('usman', 'Synthetic revoked', 'tailnet');
    store.revokeSession(revoked.session.id);
    const pending = store.mintSession('usman', 'Synthetic pending', 'tailnet', { pending: true });
    const dir = join(process.env.MU_DATA_DIR, 'gateway');
    mkdirSync(dir);
    writeProtectedSecret(join(dir, FILES.secret), gatewayKey);
    const trust = createGatewayTrust({ root, dir, enabled: true, internalToken: () => internal, env: { MU_DATA_DIR: process.env.MU_DATA_DIR } });
    const gateOptions = { root, internalToken: () => internal, role: 'server', store, tailnetName, tailnet: syntheticTailnetForTests(tailnetName, ['100.64.0.1']), servePeer: () => true, localOwnerProof: { check: () => false }, gateway: trust };
    const gate = createPrincipalGate(gateOptions);
    const forgeGate = createPrincipalGate({ ...gateOptions, servePeer: () => false });
    let calls = [];
    let opens = 0;
    const middleware = createCrmMiddleware({ root, token: internal, role: () => 'server', readOnly: () => false, service: () => { opens++; return { snapshot: () => ({ companies: [] }), resolveLegacyLead: () => null, operations: { list: () => [], run(name, input, principal) { calls.push({ name, personId: principal.personId, via: principal.via, actor: principal.actor }); return { ok: true }; } } }; } });
    function token(person) { return pageTokenFor({ personId: person, via: 'paired-session' }, internal); }
    function paired(person) { return { host, 'tailscale-user-login': login[person], 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https', cookie: `mu_session=${encodeURIComponent(sessions[person].cookie)}`, 'x-claude-os-token': token(person), 'content-type': 'application/json' }; }
    const rows = [];
    async function attempt(name, headers, expected, opts = {}) {
      calls = [];
      const req = new PassThrough();
      req.url = opts.path ?? '/__crm/ops'; req.method = opts.method ?? 'POST';
      req.headers = { ...headers }; req.socket = { remoteAddress: opts.remote ?? '127.0.0.1' };
      let resolved;
      let reached = false;
      const result = await new Promise((resolve, reject) => {
        const res = { statusCode: 200, setHeader() {}, getHeader() {}, end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); } };
      const run = () => {
          reached = true;
          const p = requestPrincipal(req, gateOptions);
          resolved = p ? { personId: p.personId, via: p.via, actor: p.actor } : null;
          middleware.handle(req, res, () => { res.statusCode = 404; res.end(); }).catch(reject);
          req.end(JSON.stringify(opts.body ?? { name: 'crm.company.create', input: { name: 'Synthetic only', doNotContact: true, emailAllowed: false } }));
        };
        if (opts.bypassGate) run(); else (opts.gate ?? gate)(req, res, run);
      });
      assert.equal(result.status, expected, name);
      if (expected >= 400) assert.equal(calls.length, 0, name + ' has no service operation');
      if (expected === 200 && req.method === 'POST') assert.equal(calls[0].personId, opts.person ?? 'usman', name + ' correct attribution');
      rows.push({ name, status: result.status, reachedCrm: reached, principal: resolved ?? null, operations: calls.length });
    }
    try {
      for (const person of ['usman', 'mehroz']) await attempt('paired-' + person, paired(person), 200, { person });
      await attempt('paired-query', paired('usman'), 200, { body: { name: 'crm.companies.query', input: { search: 'zzz' } } });
      await attempt('confirmed-read', paired('usman'), 200, { method: 'GET', path: '/__crm/snapshot' });
      await attempt('missing-page-token', { ...paired('usman'), 'x-claude-os-token': '' }, 403);
      await attempt('forged-page-token', { ...paired('usman'), 'x-claude-os-token': 'p1.forged' }, 403);
      await attempt('other-founder-token', { ...paired('usman'), 'x-claude-os-token': token('mehroz') }, 403);
      await attempt('raw-internal-token', { ...paired('usman'), 'x-claude-os-token': internal }, 403);
      await attempt('array-token', { ...paired('usman'), 'x-claude-os-token': [token('usman')] }, 403);
      await attempt('pairing-only-token', { ...paired('usman'), 'x-claude-os-token': pairingTokenFor('usman', internal) }, 403);
      await attempt('stale-page-token-after-restart', { ...paired('usman'), 'x-claude-os-token': pageTokenFor({ personId: 'usman', via: 'paired-session' }, internal + '-previous') }, 403);
      await attempt('anonymous', { host: 'unknown.invalid' }, 401, { remote: '192.168.1.20' });
      await attempt('expired-session', { ...paired('usman'), cookie: `mu_session=${expired.cookie}` }, 401);
      await attempt('revoked-session', { ...paired('usman'), cookie: `mu_session=${revoked.cookie}` }, 401);
      await attempt('wrong-founder-session', { ...paired('usman'), cookie: `mu_session=${sessions.mehroz.cookie}` }, 403);
      await attempt('pending-session', { ...paired('usman'), cookie: `mu_session=${pending.cookie}` }, 403);
      await attempt('unpaired-founder', { ...paired('usman'), cookie: '' }, 403);
      await attempt('forged-serve-peer', paired('usman'), 401, { gate: forgeGate });
      await attempt('cross-origin', { ...paired('usman'), origin: 'https://other.invalid' }, 403);
      await attempt('same-site-other-port', { ...paired('usman'), 'sec-fetch-site': 'same-site' }, 403);
      await attempt('forged-token-forwarding-headers', { ...paired('usman'), 'x-claude-os-token': internal, 'x-original-page-token': token('usman'), 'x-server-founder-grant': 'true' }, 403);
      await attempt('dot-with-crm-capability', { host: 'localhost:8081', via: VIA_VALUE, [ASSERTION_HEADER]: signAssertion(gatewayKey, { method: 'POST', target: '/__crm/ops', sessionId: 'a'.repeat(32), caps: ['view', 'crm.write'], delegatedBy: 'usman' }), 'x-claude-os-token': token('usman'), 'content-type': 'application/json' }, 403);
      await attempt('direct-middleware-own-token', paired('usman'), 200, { bypassGate: true });
      await attempt('direct-middleware-raw-internal', { ...paired('usman'), 'x-claude-os-token': internal }, 403, { bypassGate: true });
      await attempt('direct-middleware-wrong-founder-token', { ...paired('usman'), 'x-claude-os-token': token('mehroz') }, 403, { bypassGate: true });
      await attempt('pc-role-remote-write', paired('usman'), 403, { gate: createPrincipalGate({ ...gateOptions, role: 'pc' }) });
      await attempt('cloud-role-remote-write', paired('usman'), 403, { gate: createPrincipalGate({ ...gateOptions, role: 'cloud' }) });
      await attempt('console-only-founder-denied', paired('usman'), 403, { path: '/__dev_restart' });
      const proofEnv = { MU_LOCAL_OWNER_TOKEN_FILE: join(root, 'owner.token') };
      const ownerGate = createPrincipalGate({ ...gateOptions, localOwnerProof: createLocalOwnerProof(root, proofEnv) });
      await attempt('local-owner-unchanged', { host: 'localhost:8081', 'x-mu-local-owner': readLocalOwnerToken(root, proofEnv), 'x-claude-os-token': internal, 'content-type': 'application/json' }, 200, { gate: ownerGate });
      await attempt('body-cannot-choose-attribution', paired('mehroz'), 400, { body: { name: 'crm.company.create', input: {}, by: 'usman' } });
      await attempt('body-cannot-choose-principal', paired('mehroz'), 400, { body: { name: 'crm.company.create', input: {}, principal: { personId: 'usman' } } });
      // Adversarial forwarding cases exercise the actual private-map helper, never a forged principal resolver.
      const req = { url: '/__crm/ops', method: 'POST', headers: paired('usman'), socket: { remoteAddress: '127.0.0.1' } };
      let reached = false;
      const response = { statusCode: 200, setHeader() {}, end() {} };
      gate(req, response, () => { reached = true; });
      assert.equal(reached, true);
      const principal = requestPrincipal(req);
      const check = (name, value, expected) => { assert.equal(value, expected, name); rows.push({ name, matched: value }); };
      check('forwarded-original-valid', requestPageTokenMatches(req, principal, internal), true);
      check('forwarded-wrong-person', requestPageTokenMatches(req, { ...principal, personId: 'mehroz' }, internal), false);
      check('forwarded-copied-principal', requestPageTokenMatches(req, { ...principal }, internal), false);
      check('forwarded-null-principal', requestPageTokenMatches(req, null, internal), false);
      check('forwarded-after-internal-rotation', requestPageTokenMatches(req, principal, internal + '-rotated'), false);
      check('forwarded-no-current-internal', requestPageTokenMatches(req, principal, ''), false);
      const clone = { ...req, headers: { ...req.headers }, forwardedPageTokens: { principal, presented: token('usman') }, serverFounder: true };
      check('request-object-clone-no-proof', requestPageTokenMatches(clone, principal, internal), false);
      req.headers['x-claude-os-token'] = 'p1.forged';
      check('forwarded-mutated-header', requestPageTokenMatches(req, principal, internal), false);
      req.headers['x-claude-os-token'] = token('mehroz');
      check('forwarded-does-not-fall-back-to-other-principal-token', requestPageTokenMatches(req, { ...principal, personId: 'mehroz' }, internal), false);
      req.headers['x-claude-os-token'] = internal + '-rotated';
      check('forged-current-header-after-rotation', requestPageTokenMatches(req, principal, internal + '-rotated'), false);
      req.headers['x-claude-os-token'] = internal;
      gate(req, response, () => {});
      check('second-gate-pass-clears-proof', requestPageTokenMatches(req, principal, internal), false);
      req.headers['x-claude-os-token'] = internal;
      check('header-reinstatement-cannot-revive-proof', requestPageTokenMatches(req, principal, internal), false);
      const legacy = { url: '/__claude_chat', method: 'POST', headers: paired('usman'), socket: { remoteAddress: '127.0.0.1' } };
      let legacyReached = false;
      gate(legacy, response, () => { legacyReached = true; });
      check('legacy-founder-route-still-admitted', legacyReached, true);
      check('legacy-header-translation-unchanged', legacy.headers['x-claude-os-token'] === internal, true);
      // Revocation changes the next request's identity, including after a prior successful write.
      store.revokeSession(sessions.usman.session.id);
      await attempt('new-request-after-founder-revocation', paired('usman'), 401);
      assert.equal(rows.length, 46, 'the complete authorization and forwarding matrix ran');
    } finally { middleware.close(); rmSync(root, { recursive: true, force: true }); }
  } finally {
    if (previousDataDir === undefined) delete process.env.MU_DATA_DIR;
    else process.env.MU_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000); // Windows verifies fixture ACLs through native subprocesses.
