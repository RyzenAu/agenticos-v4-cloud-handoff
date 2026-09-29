import { docTitle } from "@/components/shell/destinations";
import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Check, Brain, Clock, Coins, Plug, Settings2, UserRound, Cpu } from "lucide-react";
import { JarvisSettings } from "@/components/operator/jarvis-settings";
import {
  profileChanges,
  useWorkspaceProfile,
  type WorkspaceProfile,
} from "@/lib/workspace-profile";
import { PersonalProfileFields, ToolDiscovery } from "@/components/operator/workspace-onboarding";
import { AccountConnectionsContent } from "@/components/operator/accounts-hub";
import { OperatorPreferences } from "@/components/operator/preferences";
import { setCurrency } from "@/lib/currency";
import { PageFoot, PageHeader, Section, Button, Widget, WidgetGrid } from "@/components/ds";
import "@/components/operator/workspace-settings.css";
import "@/components/operator/settings-readable.css";
// W-E: the System pages share the calm reading scale (src/components/shell/calm.css).
import { CalmPage } from "@/components/shell/calm";
import { fmtMoney } from "@/lib/format";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: docTitle("/settings") },
      { name: "description", content: "Your profile, connections and workspace preferences." },
    ],
  }),
  component: SettingsPage,
});
const tabs = [
  { id: "personal-profile", label: "Personal profile", Icon: UserRound },
  { id: "connections", label: "Connections", Icon: Plug },
  { id: "ai-tools", label: "AI tools", Icon: Cpu },
  { id: "preferences", label: "Workspace", Icon: Settings2 },
  { id: "jarvis", label: "Jarvis", Icon: Bot },
];
function SettingsPage() {
  const profile = useWorkspaceProfile();
  const base = useRef(profile.profile);
  const [section, setSection] = useState("personal-profile"),
    [draft, setDraft] = useState(profile.profile),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const update = () => {
      const hash = window.location.hash.slice(1);
      if (tabs.some((t) => t.id === hash)) setSection(hash);
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (!dirty) {
      base.current = profile.profile;
      setDraft(profile.profile);
    }
  }, [profile.profile, dirty]);
  function change(patch: Partial<WorkspaceProfile>) {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
    setSaved(false);
  }
  async function save() {
    if (busy || !profile.data) return;
    setBusy(true);
    setError("");
    try {
      const result = await profile.save(profileChanges(base.current, draft));
      setCurrency(result.currency);
      setDirty(false);
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <CalmPage className="ws-settings">
      <PageHeader title="Settings" description="Your profile, accounts and how the OS works for you." className="mb-6" />
      <WidgetGrid className="mb-6 lg:mb-8" aria-label="Your setup at a glance">
        <Widget
          icon={UserRound}
          title="Profile"
          value={draft.name || null}
          line={dirty ? "Unsaved changes" : profile.profile.updatedAt ? "Saved on this computer" : "No profile saved yet"}
          action={
            <Button variant="outline" size="sm" onClick={() => { setSection("personal-profile"); window.history.replaceState(null, "", "#personal-profile"); }}>
              Edit profile
            </Button>
          }
        />
        <Widget
          icon={Clock}
          title="Time zone"
          value={draft.timeZone ? draft.timeZone.split("/").pop()?.replaceAll("_", " ") : null}
          line={draft.timeZone ? draft.timeZone.replaceAll("_", " ") : "Not set"}
          action={
            <Button variant="outline" size="sm" onClick={() => { setSection("personal-profile"); window.history.replaceState(null, "", "#personal-profile"); }}>
              Change
            </Button>
          }
        />
        <Widget
          icon={Coins}
          title="Hour of your time"
          value={draft.hourlyRate ? fmtMoney(draft.hourlyRate, { currency: draft.currency, trimZeros: true }) : null}
          line={draft.hourlyRate ? "per hour, used for time saved" : "Not set, so no dollar value is shown"}
          action={
            <Button variant="outline" size="sm" onClick={() => { setSection("personal-profile"); window.history.replaceState(null, "", "#personal-profile"); }}>
              Set it
            </Button>
          }
        />
        <Widget
          icon={Cpu}
          title="Setup"
          value={profile.profile.onboardingCompletedAt ? "Done" : "Not done"}
          line={profile.profile.onboardingCompletedAt ? "You can run it again any time" : "Connect your tools and choose a model"}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/setup">
                {profile.profile.onboardingCompletedAt ? "Review your setup" : "Set up your Agentic OS"}
                <ArrowUpRight size={14} />
              </Link>
            </Button>
          }
        />
      </WidgetGrid>      <div
        role="tablist"
        aria-label="Settings sections"
        className="ws-settings-tabs"
      >
        {tabs.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={section === t.id}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={section === t.id ? 0 : -1}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = tabs[(i + step + tabs.length) % tabs.length];
              setSection(next.id);
              window.history.replaceState(null, "", `#${next.id}`);
              requestAnimationFrame(() =>
                document.getElementById(`settings-tab-${next.id}`)?.focus(),
              );
            }}
            onClick={() => {
              setSection(t.id);
              window.history.replaceState(null, "", `#${t.id}`);
            }}
          >
            <t.Icon size={14} />
            {t.label}
          </button>
        ))}
      </div>
      <div
        id={`settings-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
        className="ws-settings-panel"
      >
        {section === "personal-profile" && (
          <Section
            id="personal-profile-section"
            title="Your personal context"
            description="Remembered across the OS and used in Chat when Personal context is on."
          >
            {profile.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading your profile…</p>
            ) : profile.error ? (
              <p role="alert" className="text-sm text-danger">
                Your profile couldn’t load. Refresh to try again.
              </p>
            ) : (
              <>
                <PersonalProfileFields value={draft} onChange={change} disabled={busy} compact />
                {error && (
                  <p className="mt-3 text-sm text-danger" role="alert">
                    {error}
                  </p>
                )}
                <footer className="ws-settings-save">
                  <span role="status" className="text-sm text-muted-foreground">
                    {saved ? (
                      <span className="inline-flex items-center gap-1.5 text-success">
                        <Check size={14} />
                        Profile saved
                      </span>
                    ) : dirty ? (
                      "Unsaved changes"
                    ) : profile.profile.updatedAt ? (
                      "Saved on this computer"
                    ) : (
                      "No profile saved yet"
                    )}
                  </span>
                  <Button variant="accent" size="sm" disabled={busy || !dirty} onClick={() => void save()}>
                    {busy ? "Saving…" : "Save profile"}
                  </Button>
                </footer>
              </>
            )}
          </Section>
        )}
        {section === "connections" && (
          <Section
            id="connections-section"
            title="Your accounts"
            description="Money, audience, messages and calendar."
          >
            <AccountConnectionsContent />
            <div className="ws-settings-memory-link">
              <Brain size={20} />
              <div>
                <strong>Connect your memory</strong>
                <p>Bring in local agents, documents, conversations and photos.</p>
              </div>
              <Link to="/memory">
                Open Memory <ArrowUpRight size={14} />
              </Link>
            </div>
          </Section>
        )}
        {section === "ai-tools" && (
          <Section
            id="ai-tools-section"
            title="Your choice of intelligence"
            description="Installed tools and models are checked separately."
          >
            <ToolDiscovery />
            <div className="ws-settings-memory-link">
              <Cpu size={20} />
              <div>
                <strong>Ready for a conversation?</strong>
                <p>Your saved chats share the memory sources you enable.</p>
              </div>
              <Link to="/chat">
                Open Chat <ArrowUpRight size={14} />
              </Link>
            </div>
          </Section>
        )}
        {section === "preferences" && (
          <Section
            id="preferences-section"
            title="Room for what you use"
            description="Your everyday tools, and advanced views when you want them."
          >
            <OperatorPreferences />
          </Section>
        )}
        {section === "jarvis" && (
          <Section
            id="jarvis-section"
            title="Make Jarvis yours"
            description="His greeting, your shorthand, and who can reach him."
          >
            <JarvisSettings />
          </Section>
        )}
      </div>
      <PageFoot>Settings save on this computer. Changes to Jarvis apply everywhere at once.</PageFoot>
    </CalmPage>
  );
}
