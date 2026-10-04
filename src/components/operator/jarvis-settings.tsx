import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { jarvisSettingsProblem, notSaved } from "./jarvis-settings-check";

type Person = { name: string; role?: string; tailscale?: string[]; telegram?: string[]; notes?: string };
type Settings = { greeting: string; shorthand: { defaults: Record<string, string>; own: Record<string, string> }; people: Person[] };
type PersonRow = { name: string; role: string; tailscale: string; telegram: string; notes: string };
type TermRow = { term: string; meaning: string };

const toRow = (p: Person): PersonRow => ({ name: p.name, role: p.role ?? "", tailscale: (p.tailscale ?? []).join(", "), telegram: (p.telegram ?? []).join(", "), notes: p.notes ?? "" });

/**
 * Settings → Jarvis: the spoken greeting, his shorthand, and who can reach Jarvis. Saved by
 * /__operator/jarvis/settings, which validates everything and only accepts changes made at
 * this PC. Voice, engine and the wake word stay in the voice panel.
 */
export function JarvisSettings() {
  const [loaded, setLoaded] = useState<Settings | null>(null);
  const [greeting, setGreeting] = useState("");
  const [terms, setTerms] = useState<TermRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const apply = (s: Settings) => {
    setLoaded(s);
    setGreeting(s.greeting);
    setTerms(Object.entries(s.shorthand.own).map(([term, meaning]) => ({ term, meaning })));
    setPeople(s.people.map(toRow));
    setDirty(false);
  };
  useEffect(() => {
    operatorRequest<Settings>("/jarvis/settings").then(apply, (e) => setError((e as Error).message));
  }, []);
  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    setError("");
    const problem = jarvisSettingsProblem(greeting, people);
    if (problem) {
      setError(notSaved(problem));
      return;
    }
    setBusy(true);
    try {
      const result = await operatorRequest<Settings>("/jarvis/settings", {
        greeting,
        shorthand: Object.fromEntries(terms.filter((t) => t.term.trim()).map((t) => [t.term, t.meaning])),
        people: people.map((p) => ({ name: p.name, role: p.role, tailscale: p.tailscale, telegram: p.telegram, notes: p.notes })),
      });
      apply(result);
      setSaved(true);
    } catch (e) {
      setError(notSaved((e as Error).message, (e as { status?: number }).status ?? 0));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p>{error ? <span className="ws-error">{error}</span> : "Loading Jarvis settings…"}</p>;
  return (
    <div className="jarvis-settings">
      <fieldset disabled={busy}>
        <label className="jarvis-settings-field">
          <span>Greeting (spoken when a voice conversation starts)</span>
          <input value={greeting} maxLength={120} onChange={(e) => (setGreeting(e.target.value), touch())} />
        </label>

        <h3>Your shorthand</h3>
        <p className="jarvis-settings-hint">
          Jarvis reads these the same way by voice, in chat and on Telegram. Built in:{" "}
          {Object.entries(loaded.shorthand.defaults)
            .slice(0, 12)
            .map(([t, m]) => `${t} = ${m}`)
            .join(" · ")}
          …
        </p>
        {terms.length > 0 && <table className="jarvis-settings-table">
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Means</th>
              <th scope="col"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {terms.map((row, i) => (
              <tr key={i}>
                <td><input aria-label="Term" value={row.term} maxLength={20} onChange={(e) => (setTerms(terms.map((t, j) => (j === i ? { ...t, term: e.target.value } : t))), touch())} /></td>
                <td><input aria-label="Meaning" value={row.meaning} maxLength={80} onChange={(e) => (setTerms(terms.map((t, j) => (j === i ? { ...t, meaning: e.target.value } : t))), touch())} /></td>
                <td><button type="button" aria-label={`Remove ${row.term || "term"}`} onClick={() => (setTerms(terms.filter((_, j) => j !== i)), touch())}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>}
        <button type="button" className="jarvis-settings-add" onClick={() => (setTerms([...terms, { term: "", meaning: "" }]), touch())}>
          <Plus size={14} /> Add shorthand
        </button>

        <h3>Who can reach Jarvis</h3>
        <p className="jarvis-settings-hint">
          Telegram by numeric user ID, the web app by Tailscale login. Anyone not listed is refused. Keep one person with the role “owner”.
        </p>
        <table className="jarvis-settings-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Tailscale logins</th>
              <th scope="col">Telegram IDs</th>
              <th scope="col"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {people.map((row, i) => (
              <tr key={i}>
                {(["name", "role", "tailscale", "telegram"] as const).map((field) => (
                  <td key={field}>
                    <input aria-label={field} value={row[field]} onChange={(e) => (setPeople(people.map((p, j) => (j === i ? { ...p, [field]: e.target.value } : p))), touch())} />
                  </td>
                ))}
                <td><button type="button" aria-label={`Remove ${row.name || "person"}`} onClick={() => (setPeople(people.filter((_, j) => j !== i)), touch())}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="jarvis-settings-add" onClick={() => (setPeople([...people, { name: "", role: "", tailscale: "", telegram: "", notes: "" }]), touch())}>
          <Plus size={14} /> Add a person
        </button>
      </fieldset>

      <p className="jarvis-settings-hint">Voice, engine, “Hey Jarvis” and “Act while I speak” are in the Jarvis voice panel.</p>
      {error && <p className="ws-error" role="alert">{error}</p>}
      <footer className="ws-settings-save">
        <span role="status">{saved ? <><Check size={14} /> Saved; Jarvis has the changes</> : error ? "Not saved" : dirty ? "Unsaved changes" : "Saved on this computer"}</span>
        <button type="button" className="ws-primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save Jarvis settings"}
        </button>
      </footer>
    </div>
  );
}
