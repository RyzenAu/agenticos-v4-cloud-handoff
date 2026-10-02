import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button, buttonVariants } from "../ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { createProfileApi, type DeviceView, type DevicesView, type Me, type PersonId, type ProfileApi, type SessionView } from "./profile-api";

/**
 * Profile: who you are on this device, the name picker, paired browsers and companions, and
 * who's online. The name picker is personalisation only — the server narrows access if the
 * picked name differs from the person this device is paired to, and never widens it.
 * Mount anywhere (os-shell owns the route); everything talks to /__devices.
 */

const day = 24 * 60 * 60 * 1000;
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" }) : "—");
const daysLeft = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / day));
const nameOf = (people: Me["people"], id: PersonId | null | undefined) => people.find((p) => p.id === id)?.name ?? id ?? "";

const card = "min-w-0 rounded-xl border border-border bg-card p-5 text-card-foreground";
const muted = "text-sm leading-6 text-muted-foreground";
// Inner layouts follow the panel's own width (a container query), not the window's: on /system the
// panel sits in a half-width column, where lg:grid-cols-2 squeezed the pairing code onto two lines
// and "Can use" wrapped word by word (audit F3-20).
const pairGrid = "grid gap-4 @3xl:grid-cols-2";

/**
 * What a revoke will do, restated in the confirmation (audit F3-02). Pure; exported for tests.
 * For a browser the dialog offers both outcomes as buttons, so whether the person's next device needs
 * a pairing code is chosen at click time, not by a checkbox far from the row.
 */
export type RevokeTarget = { kind: "session"; session: SessionView } | { kind: "device"; device: DeviceView };
export function revokeConsequence(t: RevokeTarget, people: Me["people"]): { title: string; lines: string[]; action: string; strictAction?: string } {
  if (t.kind === "device") {
    const who = nameOf(people, t.device.owner);
    return {
      title: `Revoke "${t.device.label}"?`,
      lines: [`${who}'s companion on this machine is signed out now. Jarvis can't act on it until it's paired again with a new one-time code.`],
      action: "Revoke machine",
    };
  }
  const s = t.session;
  const who = nameOf(people, s.personId);
  return {
    title: `Revoke "${s.label}"?`,
    lines: [
      s.current
        ? "This is the browser you're using now. It is signed out as soon as you confirm."
        : `${who}'s browser, paired ${when(s.createdAt)}, last seen ${when(s.lastSeen)}. It is signed out at its next request.`,
      `Revoke browser: ${who} can pair a browser again with their Tailscale login.`,
      `Revoke and require a code: ${who}'s next new device will need a one-time pairing code; a Tailscale login alone won't pair it. Use this for a lost device, and remove it from Tailscale too.`,
    ],
    action: "Revoke browser",
    strictAction: "Revoke and require a code",
  };
}

export function ProfilePanel({ api: given }: { api?: ProfileApi }) {
  const api = useMemo(() => given ?? createProfileApi(), [given]);
  const [me, setMe] = useState<Me | null>(null);
  const [devices, setDevices] = useState<DevicesView | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<RevokeTarget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      if (m.authorised) {
        const [d, s] = await Promise.all([api.devices(), api.sessions()]);
        setDevices(d);
        setSessions(s.sessions);
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your profile.");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setNotice(done);
      setError("");
      await refresh();
    } catch (e) {
      setNotice("");
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  const revoke = (t: RevokeTarget, requireCode = false) =>
    t.kind === "device"
      ? act(() => api.revokeDevice(t.device.id), `Revoked "${t.device.label}". Jarvis can no longer act on it.`)
      : act(
          () => api.revokeSession(t.session.id, requireCode),
          `Revoked "${t.session.label}".${requireCode ? ` ${nameOf(me?.people ?? [], t.session.personId)}'s next new device needs a pairing code.` : ""}`,
        );
  const confirmRevoke = (requireCode: boolean) => {
    const t = confirm;
    setConfirm(null);
    if (t) void revoke(t, requireCode);
  };
  const confirmText = confirm && me ? revokeConsequence(confirm, me.people) : null;

  if (!me) {
    return (
      <section className={card} aria-busy={!error}>
        <p className={muted}>{error || "Loading your profile…"}</p>
      </section>
    );
  }

  return (
    <div className="@container grid gap-4">
      {/* Visible, not sr-only: a revoke used to show nothing but a row vanishing (audit F3-02). */}
      <div role="status" aria-live="polite">
        {notice ? (
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-success-soft px-4 py-3 text-sm" data-testid="profile-notice">
            <span>{notice}</span>
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setNotice("")}>Dismiss</button>
          </p>
        ) : null}
      </div>
      {error ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">{error}</p> : null}
      {!me.authorised ? (
        <PairThisDevice me={me} api={api} onPaired={() => act(async () => undefined, "This device is paired.")} onError={setError} />
      ) : (
        <>
          {/* Signed in by a verified Tailscale login but not remembered yet: offer the 30-day, revocable session. */}
          {me.canSelfPair && !me.session ? (
            <PairThisDevice me={me} api={api} onPaired={() => act(async () => undefined, "This device is paired.")} onError={setError} />
          ) : null}
          <ConfirmBrowser me={me} api={api} onConfirm={(code) => act(() => api.confirmBrowser(code), "This browser is confirmed.")} onError={setError} />
          <div className={pairGrid}>
            <ThisDevice me={me} />
            <NamePicker me={me} onPick={(id) => act(() => api.pickName(id), id ? `Showing as ${nameOf(me.people, id)}.` : "Name reset.")} />
          </div>
          <div className={pairGrid}>
            <WhoIsOnline devices={devices} />
            <PairAnother me={me} api={api} onError={setError} />
          </div>
          <PairedDevices me={me} devices={devices} sessions={sessions}
            onRevokeSession={(session) => setConfirm({ kind: "session", session })}
            onRevokeDevice={(device) => setConfirm({ kind: "device", device })} />
        </>
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                {confirmText?.lines.map((line) => <p key={line}>{line}</p>)}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {confirmText?.strictAction ? (
              <AlertDialogAction className={`${buttonVariants({ variant: "outline" })} text-foreground`} onClick={() => confirmRevoke(true)}>
                {confirmText.strictAction}
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction onClick={() => confirmRevoke(false)}>{confirmText?.action ?? "Revoke"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PairThisDevice({ me, api, onPaired, onError }: { me: Me; api: ProfileApi; onPaired: () => void; onError: (m: string) => void }) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onPaired();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-xl font-semibold">Pair this device</h2>
      <p className={`mt-2 max-w-prose ${muted}`}>
        {me.person ? <>Tailscale says this is <strong className="text-foreground">{me.person.name}</strong>. </> : null}
        Pair once and this device stays signed in for 30 days. You can revoke it any time from another paired device.
      </p>
      <label className="mt-4 grid max-w-sm gap-1 text-sm" htmlFor={`${id}-label`}>
        Name this device
        <input id={`${id}-label`} className="min-h-11 rounded-md border border-border bg-background px-3" placeholder="e.g. Study PC" value={label} maxLength={48} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <div className="mt-5 grid gap-6 @2xl:grid-cols-2">
        {me.canSelfPair ? (
          <div>
            <h3 className="font-medium">With your Tailscale login</h3>
            <p className={`mt-1 ${muted}`}>You're already signed in to Tailscale as yourself.</p>
            <Button className="mt-3 min-h-11" variant="accent" disabled={busy} onClick={() => run(() => api.pairWithTailnet(label))}>Pair this device</Button>
          </div>
        ) : null}
        <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) void run(() => api.redeemCode(code, label)); }}>
          <h3 className="font-medium">With a one-time code</h3>
          <p className={`mt-1 ${muted}`}>Make a code on one of your paired devices (Profile → Pair another device). It works once, for 10 minutes.</p>
          <label className="mt-3 grid max-w-xs gap-1 text-sm" htmlFor={`${id}-code`}>
            Pairing code
            <input id={`${id}-code`} className="min-h-11 rounded-md border border-border bg-background px-3 font-mono" autoComplete="one-time-code" placeholder="ABCD-EFGH" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} />
          </label>
          <Button type="submit" className="mt-3 min-h-11" variant="outline" disabled={busy || !code.trim()}>Use code</Button>
        </form>
      </div>
    </section>
  );
}

/**
 * AUDIT-A1-3: opening the OS at this PC in a new browser makes a PENDING session (a page load is
 * something any local program can fake). REVIEW-S1 F2b: the code travels the other way. Usman makes a
 * one-time code on a browser he already uses (or his own paired phone), or with the local command, and
 * types it into the new browser. The pending browser is never shown a code, so a program that faked the
 * page load has nothing to read.
 */
function ConfirmBrowser({ me, api, onConfirm, onError }: { me: Me; api: ProfileApi; onConfirm: (code: string) => void; onError: (m: string) => void }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [made, setMade] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = !!me.hubSession?.pending;
  const canMake = me.principal?.personId === "usman" && me.principal.actor === "human" && !me.sharedOnly;
  if (!pending && !canMake) return null;
  async function make() {
    setBusy(true);
    try {
      setMade(await api.createConfirmCode());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">{pending ? "Confirm this browser" : "Confirm a new browser at this PC"}</h2>
      {pending ? (
        <form className="mt-1" onSubmit={(e) => { e.preventDefault(); if (code.trim()) { onConfirm(code); setCode(""); } }}>
          <p className={`max-w-prose ${muted}`}>
            This browser opened the OS at this PC, but it can't approve anything until you confirm it. Make a code in Profile on a browser you already use here (or your own paired phone), or run <code className="font-mono">bun scripts/identity/confirm-browser.ts</code> yourself in a terminal on this PC. Then type the code here.
          </p>
          <label className="mt-3 grid max-w-xs gap-1 text-sm" htmlFor={`${id}-code`}>
            Confirm code
            <input id={`${id}-code`} className="min-h-11 rounded-md border border-border bg-background px-3 font-mono" autoComplete="off" placeholder="ABCD-EFGH" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} />
          </label>
          <Button type="submit" className="mt-3 min-h-11" variant="outline" disabled={!code.trim()}>Confirm this browser</Button>
        </form>
      ) : (
        <div className="mt-1">
          <p className={`max-w-prose ${muted}`}>Opened the OS in another browser at this PC? Make a code here and type it into that browser's Profile. It works once, for 10 minutes.</p>
          {made ? <p className="mt-3 font-mono text-2xl" aria-live="polite">{made.code}</p> : null}
          <Button type="button" className="mt-3 min-h-11" variant="outline" disabled={busy} onClick={make}>{made ? "Make another code" : "Make a confirm code"}</Button>
        </div>
      )}
    </section>
  );
}

function ThisDevice({ me }: { me: Me }) {
  const id = useId();
  const via = me.via === "loopback" ? "At Usman's PC (this computer)" : me.via === "session" ? "Paired browser over Tailscale" : me.via === "tailnet" ? "Your Tailscale login (pair to remember this browser)" : "Companion";
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">This device</h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Signed in as</dt><dd className="font-medium">{me.principal?.displayName ?? me.person?.name ?? "—"}</dd>
        <dt className="text-muted-foreground">How</dt><dd>{via}</dd>
        {me.session ? (<>
          <dt className="text-muted-foreground">Device name</dt><dd>{me.session.label}</dd>
          <dt className="text-muted-foreground">Paired</dt><dd>{when(me.session.createdAt)}</dd>
          <dt className="text-muted-foreground">Session ends</dt><dd>{when(me.session.expiresAt)} ({daysLeft(me.session.expiresAt)} days)</dd>
        </>) : null}
        <dt className="text-muted-foreground">Can use</dt>
        <dd>
          {[me.permissions.business && "shared business", me.permissions.memory.length && `memory: ${me.permissions.memory.join(", ")}`, me.permissions.finance && "finance", me.permissions.devices === "own" ? "control of your own devices" : "no device control"].filter(Boolean).join(" · ")}
        </dd>
      </dl>
      {me.sharedOnly ? (
        <p className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          Showing as {nameOf(me.people, me.displayAs)}, but this device is paired to {me.person?.name}. Private memory, finance and device control are off until you switch back.
        </p>
      ) : null}
    </section>
  );
}

function NamePicker({ me, onPick }: { me: Me; onPick: (id: PersonId | null) => void }) {
  const id = useId();
  const current = me.displayAs ?? me.person?.id ?? null;
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">Who's using this device?</h2>
      <p className={`mt-1 ${muted}`}>Remembered here for 30 days. This only changes names and greetings — it never unlocks anything.</p>
      <div role="radiogroup" aria-labelledby={`${id}-t`} className="mt-4 flex flex-wrap gap-3">
        {me.people.map((p) => (
          <Button key={p.id} role="radio" aria-checked={current === p.id} variant={current === p.id ? "accent" : "outline"} className="min-h-11 min-w-28" onClick={() => onPick(p.id === me.person?.id ? null : p.id)}>
            {p.name}
          </Button>
        ))}
      </div>
    </section>
  );
}

function WhoIsOnline({ devices }: { devices: DevicesView | null }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">Who's online</h2>
      <ul className="mt-3 grid gap-2 text-sm">
        {(devices?.people ?? []).map((p) => {
          const own = (devices?.devices ?? []).filter((d) => d.owner === p.id && !d.revoked);
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span aria-hidden className={`inline-block size-2.5 rounded-full ${p.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
              <span className="font-medium">{p.name}</span>
              <span className="text-muted-foreground">{p.online ? "online" : p.lastSeen ? `last seen ${when(p.lastSeen)}` : "offline"}</span>
              <span className="text-muted-foreground">· {own.filter((d) => d.online).length}/{own.length} machines up</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PairAnother({ me, api, onError }: { me: Me; api: ProfileApi; onError: (m: string) => void }) {
  const id = useId();
  const [made, setMade] = useState<{ code: string; expiresAt: number; purpose: string; personId: PersonId } | null>(null);
  const [forPerson, setForPerson] = useState<PersonId>(me.person?.id ?? "usman");
  const canChoose = me.person?.id === "usman" && !me.sharedOnly;
  const make = async (purpose: "browser" | "companion") => {
    try {
      setMade(await api.createCode(purpose, canChoose ? forPerson : undefined));
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't make a code.");
    }
  };
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">Pair another device</h2>
      <p className={`mt-1 ${muted}`}>A one-time code, valid for 10 minutes. Use it in a new browser, or with the companion on your own PC so Jarvis can act there.</p>
      {canChoose ? (
        <label className="mt-3 flex items-center gap-3 text-sm">For
          <select className="min-h-11 rounded-md border border-border bg-background px-3" value={forPerson} onChange={(e) => setForPerson(e.target.value as PersonId)}>
            {me.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button variant="outline" className="min-h-11" disabled={me.sharedOnly} onClick={() => make("browser")}>Code for a browser</Button>
        <Button variant="outline" className="min-h-11" disabled={me.sharedOnly} onClick={() => make("companion")}>Code for a companion</Button>
      </div>
      {made ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4" aria-live="polite">
          <p className="whitespace-nowrap font-mono text-xl sm:text-2xl">{made.code}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {made.purpose === "companion" ? "Companion" : "Browser"} code for {nameOf(me.people, made.personId)} · expires {new Date(made.expiresAt).toLocaleTimeString("en-AU", { timeStyle: "short" })}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function PairedDevices({ me, devices, sessions, onRevokeSession, onRevokeDevice }: {
  me: Me; devices: DevicesView | null; sessions: SessionView[];
  onRevokeSession: (s: SessionView) => void; onRevokeDevice: (d: DeviceView) => void;
}) {
  const id = useId();
  const mayManage = (owner: PersonId) => !me.sharedOnly && (owner === me.person?.id || me.person?.id === "usman");
  // Confirmed hub sessions are minted for each browser opened at this PC; they all read "This PC's
  // browser" and can't be told apart, so the others are counted, not listed. The browser you're using
  // and any PENDING hub browser (REVIEW-S1 F2b: not yet confirmed with a code) are listed on their own,
  // so they can be seen and revoked.
  const open = sessions.filter((s) => !s.revoked && !s.expired);
  const live = open.filter((s) => s.via !== "hub" || s.pending || s.current);
  const hub = open.length - live.length;
  const machines = (devices?.devices ?? []).filter((d) => !d.revoked);
  return (
    <section aria-labelledby={`${id}-t`} className={card}>
      <h2 id={`${id}-t`} className="text-lg font-semibold">Paired devices</h2>
      <h3 className="mt-4 text-sm font-medium">Machines Jarvis can act on</h3>
      <ul className="mt-2 divide-y divide-border text-sm">
        {machines.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="font-medium">{d.label}{d.primary ? <span className="ml-2 text-xs text-muted-foreground">default</span> : null}</p>
              <p className="text-muted-foreground">
                {nameOf(me.people, d.owner)}'s machine · {d.online ? (d.busy ? "online, working" : "online") : "offline"}
                {d.kind === "companion" ? ` · mic ${d.micOwned ? "held here" : "not held"} · until ${when(d.expiresAt)}` : " · the OS runs here"}
              </p>
            </div>
            {d.kind === "companion" && mayManage(d.owner) ? <Button size="sm" variant="outline" className="min-h-11" onClick={() => onRevokeDevice(d)}>Revoke</Button> : null}
          </li>
        ))}
      </ul>
      <h3 className="mt-6 text-sm font-medium">Browsers</h3>
      {live.length ? (
        <ul className="mt-2 divide-y divide-border text-sm">
          {live.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{s.label}{s.current ? <span className="ml-2 text-xs text-muted-foreground">this device</span> : null}</p>
                <p className="text-muted-foreground">{nameOf(me.people, s.personId)} · paired {when(s.createdAt)} by {s.via === "code" ? "code" : s.via === "hub" ? "opening the OS at this PC" : "Tailscale login"} · last seen {when(s.lastSeen)} · {daysLeft(s.expiresAt)} days left{s.pending ? " · waiting to be confirmed" : ""}</p>
              </div>
              {mayManage(s.personId) ? <Button size="sm" variant="outline" className="min-h-11" onClick={() => onRevokeSession(s)}>Revoke</Button> : null}
            </li>
          ))}
        </ul>
      ) : <p className={`mt-2 ${muted}`}>No paired browsers yet.{me.via === "loopback" ? " This PC doesn't need one." : ""}</p>}
      {hub ? (
        <p className={`mt-2 ${muted}`} data-testid="hub-sessions">
          Plus {hub} {live.some((s) => s.via === "hub") ? "other " : ""}browser{hub === 1 ? "" : "s"} opened at this PC. They were confirmed at this PC, and the oldest are cleared automatically.
        </p>
      ) : null}
    </section>
  );
}

export default ProfilePanel;
