import { useSettingsTab } from "@/lib/settings-tab";
import { docTitle } from "@/components/shell/destinations";
import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, Bot, Check, Brain, Plug, Settings2, UserRound, Cpu } from "lucide-react";
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
import { PageFoot, PageHeader, Section, Button, Tabs } from "@/components/ds";
import "@/components/operator/workspace-settings.css";
import "@/components/operator/settings-readable.css";
// W-E: the System pages share the calm reading scale (src/components/shell/calm.css).
import { CalmPage } from "@/components/shell/calm";

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
  { id: "workspace", label: "Workspace", Icon: Settings2 },
  { id: "jarvis", label: "Jarvis", Icon: Bot },
] as const;
function SettingsPage() {
  const profile = useWorkspaceProfile();
  const base = useRef(profile.profile);
  const { section, select: selectTab } = useSettingsTab();
  const [draft, setDraft] = useState(profile.profile),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
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
      <PageHeader
        title="Settings"
        actions={
          <Button variant="outline" asChild>
            <Link to="/setup">
              Review setup <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </Button>
        }
        className="mb-6"
      />
      {dirty && section !== "personal-profile" && (
        <p role="status" className="mb-4 text-sm text-warn">
          Your profile has unsaved changes. Return to Personal profile to save them.
        </p>
      )}
      {/* R12 rollout: the shared Tabs (arrow keys, a select on a phone), not a hand-made tablist. */}
      <Tabs
        idBase="settings"
        label="Settings sections"
        className="mb-6"
        value={section}
        onChange={(id) => selectTab(id)}
        tabs={tabs.map((t) => ({
          id: t.id,
          label: (
            <span className="inline-flex items-center gap-2">
              <t.Icon size={14} aria-hidden="true" />
              {t.label}
            </span>
          ),
        }))}
      />
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
            title="AI tools"
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
        {section === "workspace" && (
          <Section
            id="workspace-section"
            title="Workspace preferences"
            description="Your everyday tools, and advanced views when you want them."
          >
            <OperatorPreferences />
          </Section>
        )}
        {section === "jarvis" && (
          <Section
            id="jarvis-section"
            title="Jarvis preferences"
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
