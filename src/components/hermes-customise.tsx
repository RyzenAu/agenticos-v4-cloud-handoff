// "Make Hermes yours" on the Hermes page (W-C, 29 Sep 2026; the owner asked for both directly):
//   - Who Hermes thinks you are: the owner profile kept in Hermes' USER.md, built from the M&U wiki.
//   - Your skills in Hermes: the Claude Code skills copied into Hermes, and what was left out and why.
// Both read from /__hermes_owner_profile and /__hermes_skill_sync (scripts/hermes/plugin.ts); the
// buttons POST with the page token. Nothing here shows a .env value, a key or a raw transcript.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookUser, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Badge, Button, Disclosure, Surface } from "@/components/ds";
import { fmtDateTime } from "@/lib/format";

type ProfileState = {
  path: string;
  exists: boolean;
  limit: number;
  current: string[];
  others: string[];
  proposed: string[];
  inSync: boolean;
  usageAfter: number;
  fits: boolean;
  sources: string[];
  warnings: string[];
};
type SyncReport = {
  dryRun: boolean;
  hermesSkillsDir: string;
  category: string;
  backup: string | null;
  results: Array<{ name: string; origin: string; outcome: string; files: number; withheld: Array<{ file: string; reason: string }> }>;
  skipped: Array<{ name: string; origin: string; reason: string }>;
  orphaned: string[];
  counts: { added: number; updated: number; unchanged: number; kept: number; skipped: number };
  finishedAt: string;
};

async function pageToken(): Promise<string> {
  const t = (await fetch("/__token").then((r) => r.json()).catch(() => null)) as { token?: string } | null;
  return t?.token ?? "";
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": await pageToken() },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** "Owner profile (…), who he is: Mohammad…" → { label: "Who he is", text: "Mohammad…" }. */
export function splitProfileEntry(entry: string): { label: string; text: string } {
  const m = /^Owner profile \([^)]*\),\s*([^:]+):\s*([\s\S]*)$/.exec(entry);
  if (!m) return { label: "Profile", text: entry };
  return { label: m[1].charAt(0).toUpperCase() + m[1].slice(1), text: m[2] };
}

/** The sync report in owner words: what's in Hermes now and the one line that matters. */
export function skillsHeadline(report: SyncReport | null): { title: string; detail: string } {
  if (!report) return { title: "Not synced yet", detail: "Hermes doesn't have your Claude Code skills yet." };
  const inHermes = report.results.filter((r) => r.outcome !== "would-add").length;
  const c = report.counts;
  const changed = c.added + c.updated;
  return {
    title: `${inHermes} of your skills are in Hermes`,
    detail: `${changed ? `${changed} added or updated` : "Nothing new"} on the last sync · ${c.skipped} left out${c.kept ? ` · ${c.kept} kept Hermes' own edits` : ""}`,
  };
}

function when(iso: string | null | undefined) {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : fmtDateTime(d);
}

export function OwnerProfileCard() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery<{ state: ProfileState }>({
    queryKey: ["hermes-owner-profile"],
    queryFn: async () => {
      const r = await fetch("/__hermes_owner_profile");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    staleTime: 15_000,
  });
  const s = q.data?.state;
  const shown = s ? (s.current.length ? s.current : s.proposed) : [];
  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await post<{ ok: boolean; changed: boolean; error?: string }>("/__hermes_owner_profile", {});
      setMessage({ ok: true, text: res.changed ? "Updated. Hermes reads it at the start of each new session (in Telegram, send /new)." : "Already up to date." });
      await qc.invalidateQueries({ queryKey: ["hermes-owner-profile"] });
      await qc.invalidateQueries({ queryKey: ["hermes-memory"] });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const status = !s ? null : s.inSync ? { tone: "success" as const, text: "Up to date" } : s.current.length ? { tone: "warn" as const, text: "Wiki has changed" } : { tone: "neutral" as const, text: "Not added yet" };
  return (
    <Surface padding="none" className="flex flex-col gap-5 rounded-2xl p-6 sm:p-7" aria-labelledby="hermes-owner-profile-title">
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground" aria-hidden="true">
          <BookUser className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="hermes-owner-profile-title" className="text-lg font-semibold text-foreground">
            Who Hermes thinks you are
          </h3>
          <p className="mt-1 text-base text-muted-foreground">Your profile and mission from the M&amp;U wiki, in Hermes' own memory (USER.md).</p>
        </div>
        {status && <Badge tone={status.tone}>{status.text}</Badge>}
      </div>
      {q.isLoading ? (
        <p className="text-base text-muted-foreground">Reading USER.md…</p>
      ) : q.error || !s ? (
        <p className="text-base text-muted-foreground">Couldn't read Hermes' profile: {(q.error as Error | null)?.message ?? "unknown"}.</p>
      ) : (
        <>
          {shown.length ? (
            <div className="rounded-2xl bg-inset p-5">
              <p className="text-sm font-medium text-muted-foreground">{splitProfileEntry(shown[0]).label}</p>
              <p className="mt-1 text-base leading-relaxed text-foreground">{splitProfileEntry(shown[0]).text}</p>
            </div>
          ) : (
            <p className="text-base text-muted-foreground">The wiki pages weren't found, so there's nothing to add yet.</p>
          )}
          {shown.length > 1 && (
            <Disclosure triggerClassName="-mx-3" summary={<span className="text-base">{shown.slice(1).map((e) => splitProfileEntry(e).label.toLowerCase()).join(" and ").replace(/^./, (c) => c.toUpperCase())}</span>}>
              <div className="flex flex-col gap-3">
                {shown.slice(1).map((e) => (
                  <div key={e} className="rounded-2xl bg-inset p-5">
                    <p className="text-sm font-medium text-muted-foreground">{splitProfileEntry(e).label}</p>
                    <p className="mt-1 text-base leading-relaxed text-foreground">{splitProfileEntry(e).text}</p>
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className={`text-3xl font-semibold leading-none tracking-tight ${s.fits ? "text-foreground" : "text-danger"}`}>{Math.round((s.usageAfter / Math.max(1, s.limit)) * 100)}%</div>
              <p className="mt-2 text-base text-muted-foreground">
                of Hermes' user memory ({s.usageAfter.toLocaleString("en-AU")} of {s.limit.toLocaleString("en-AU")} characters). {s.others.length ? `${s.others.length} entr${s.others.length === 1 ? "y" : "ies"} Hermes learned itself stay as they are.` : "The rest is room for what Hermes learns."}
              </p>
            </div>            <Button variant={s.inSync ? "outline" : "accent"} className="h-10 rounded-full px-5" disabled={busy || !s.fits || !s.proposed.length} onClick={() => void refresh()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              {s.current.length ? "Refresh from wiki" : "Add to Hermes"}
            </Button>
          </div>
          {message && (
            <p role="status" className={`text-base ${message.ok ? "text-foreground" : "text-danger"}`}>
              {message.text}
            </p>
          )}
          {s.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-warn">
              {s.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <Disclosure triggerClassName="-mx-3" summary={<span className="text-muted-foreground">Where this comes from</span>}>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {s.sources.map((p) => (
                <li key={p} className="font-mono">
                  {p}
                </li>
              ))}
              <li>
                Written to <span className="font-mono">{s.path}</span>. Contact details, street address and date of birth are never copied.
              </li>
            </ul>
          </Disclosure>
        </>
      )}
    </Surface>
  );
}

export function SkillSyncCard() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<null | "sync" | "preview">(null);
  const [preview, setPreview] = useState<SyncReport | null>(null);
  const [error, setError] = useState("");
  const q = useQuery<{ report: SyncReport | null; running: boolean }>({
    queryKey: ["hermes-skill-sync"],
    queryFn: async () => {
      const r = await fetch("/__hermes_skill_sync");
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    },
    staleTime: 15_000,
  });
  const report = q.data?.report ?? null;
  const shownReport = preview ?? report;
  const head = skillsHeadline(report);
  const inHermes = report ? report.results.length : 0;
  async function run(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "sync");
    setError("");
    try {
      const res = await post<{ report: SyncReport }>("/__hermes_skill_sync", { dryRun });
      if (dryRun) setPreview(res.report);
      else {
        setPreview(null);
        await qc.invalidateQueries({ queryKey: ["hermes-skill-sync"] });
        await qc.invalidateQueries({ queryKey: ["hermes-skills"] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Surface padding="none" className="flex flex-col gap-5 rounded-2xl p-6 sm:p-7" aria-labelledby="hermes-skill-sync-title">
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-inset text-muted-foreground" aria-hidden="true">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="hermes-skill-sync-title" className="text-lg font-semibold text-foreground">
            Your skills in Hermes
          </h3>
          <p className="mt-1 text-base text-muted-foreground">Your Claude Code skills, copied into Hermes so Jarvis can use them too.</p>
        </div>
      </div>
      {q.isLoading ? (
        <p className="text-base text-muted-foreground">Reading the last sync…</p>
      ) : (
        <>
          <div>
            <div className="text-3xl font-semibold leading-none tracking-tight text-foreground">{report ? inHermes : "—"}</div>
            <p className="mt-2 text-base text-muted-foreground">
              {report ? `of your skills are in Hermes. ${head.detail.replace(/^./, (c) => c.toUpperCase())}. Last synced ${when(report.finishedAt)}.` : head.detail}
            </p>
          </div>          <div className="flex flex-wrap gap-3">
            <Button variant="accent" className="h-10 rounded-full px-5" disabled={busy !== null || q.data?.running} onClick={() => void run(false)}>
              {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Sync skills now
            </Button>
            <Button variant="outline" className="h-10 rounded-full px-5" disabled={busy !== null} onClick={() => void run(true)}>
              {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Preview changes
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-base text-danger">
              {error}
            </p>
          )}
          {preview && (
            <p role="status" className="text-base text-foreground">
              Preview: {preview.counts.added} to add, {preview.counts.updated} to update, {preview.counts.unchanged} unchanged, {preview.counts.skipped} left out. Nothing was changed.
            </p>
          )}
          {shownReport && (
            <>
              <Disclosure triggerClassName="-mx-3" summary={<span className="text-base">Skills in Hermes</span>} meta={`${shownReport.results.length}`}>
                <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {shownReport.results.map((r) => (
                    <li key={r.name} className="text-sm text-foreground" title={`${r.origin} · ${r.files} files${r.withheld.length ? ` · ${r.withheld.length} withheld` : ""} · ${r.outcome}`}>
                      {r.name}
                    </li>
                  ))}
                </ul>
              </Disclosure>
              <Disclosure triggerClassName="-mx-3" summary={<span className="text-base">Left out, and why</span>} meta={`${shownReport.skipped.length}`}>
                <ul className="flex flex-col gap-2 text-sm">
                  {shownReport.skipped.map((s) => (
                    <li key={`${s.origin}:${s.name}`}>
                      <span className="font-medium text-foreground">{s.name}</span> <span className="text-muted-foreground">· {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
              {shownReport.results.some((r) => r.withheld.length) && (
                <Disclosure triggerClassName="-mx-3" summary={<span className="text-base">Files withheld</span>} meta="never copied">
                  <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {shownReport.results.flatMap((r) =>
                      r.withheld.map((w) => (
                        <li key={`${r.name}/${w.file}`}>
                          <span className="font-mono">
                            {r.name}/{w.file}
                          </span>{" "}
                          · {w.reason}
                        </li>
                      )),
                    )}
                  </ul>
                </Disclosure>
              )}
            </>
          )}
        </>
      )}
    </Surface>
  );
}

/** The two cards side by side under one heading. */
export function HermesCustomiseSection() {
  return (
    <section className="mb-12" aria-labelledby="hermes-customise-title">
      <h2 id="hermes-customise-title" className="mb-1 text-lg font-semibold text-foreground">
        Make Hermes yours
      </h2>
      <p className="mb-5 max-w-[70ch] text-base text-muted-foreground">Who it thinks you are, and the skills it can use.</p>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <OwnerProfileCard />
        <SkillSyncCard />
      </div>
    </section>
  );
}
