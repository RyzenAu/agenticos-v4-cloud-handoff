import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Smartphone } from "lucide-react";
import { operatorRequest } from "@/lib/operator";
import { BrandMark, Disclosure, PageHeader, VerdictCard } from "@/components/ds";
import { OPENCLAW_PURPOSE, openClawView } from "@/lib/openclaw-status";

// OpenClaw (W-B, 29 Sep 2026). Owner: "I don't know the point of it." Here it is only a bridge: paired
// devices (the iPhone, Mehroz's PC) join its loopback gateway as nodes and Hermes acts on them through
// `openclaw nodes invoke`. The page says that in one sentence and shows only what's useful: is the
// phone connected, and how to pair or reconnect it. The coding-swarm concept cards (nothing ran them)
// are gone (audit F3-22 had already labelled them "concept only").
// Status is REAL only, from /__operator/capabilities (devices.openclaw-nodes); nothing is invented.

export const Route = createFileRoute("/agents/openclaw")({
  head: () => ({
    meta: [
      { title: docTitle("/agents/openclaw") },
      { name: "description", content: "OpenClaw: the bridge that lets Jarvis act on your paired phone." },
    ],
  }),
  component: OpenClawPage,
});

interface OperatorCapability {
  id: string;
  status: string;
  evidence?: string;
  ownerAction?: string;
}

function OpenClawPage() {
  const query = useQuery<{ capabilities: OperatorCapability[] }>({
    queryKey: ["capabilities"],
    queryFn: () => operatorRequest("/capabilities"),
    staleTime: 30_000,
  });
  const capability = query.data?.capabilities.find((c) => c.id === "devices.openclaw-nodes");
  const v = openClawView(query.isLoading ? undefined : capability ?? null, query.isError || (!query.isLoading && !capability));

  return (
    <div className="min-w-0 max-w-[1040px] [overflow-wrap:anywhere]">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <BrandMark agent="openclaw" size={24} />
            OpenClaw
          </span>
        }
        description={OPENCLAW_PURPOSE}
      />

      <VerdictCard
        className="mb-12"
        tone={v.tone}
        title={v.title}
        titleId="openclaw-status"
        why={v.why}
        facts={[
          `Bridge: ${v.gateway}`,
          v.devices.length ? v.devices.map((d) => `${d.name}${d.commands !== null ? ` · ${d.commands} actions` : ""}`).join(" · ") : v.gateway === "unknown" ? "Devices: not read" : "No device online",
          "Tailscale only, never the public internet",
        ]}
        footer="Live from /__operator/capabilities (devices.openclaw-nodes)."
      >
        <Disclosure summary={<span className="font-medium">How to pair or reconnect your phone</span>} icon={<Smartphone className="size-4 text-muted-foreground" />}>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>On the phone: Tailscale on (turn off iCloud Private Relay and other VPNs if it can't reach the PC), and the OpenClaw app installed.</li>
            <li>
              On this PC, run the pairing helper yourself in a terminal:{" "}
              <code className="rounded-lg bg-inset px-2 py-0.5 font-mono text-xs text-foreground">scripts\windows\openclaw-pair-phone.ps1</code>. It shows a one-time QR code (a credential: only scan it with the phone).
            </li>
            <li>When the phone says it's waiting, approve its request in that terminal. Nothing approves it for you.</li>
            <li>Test it: ask Jarvis “what's my phone's battery?”</li>
          </ol>
          {v.next && <p className="mt-3 text-sm text-muted-foreground">What the status check suggests: {v.next}</p>}
        </Disclosure>
        <Disclosure summary={<span className="font-medium">What it is, and what it isn't</span>}>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Hermes stays the brain and asks OpenClaw to run one action on a paired device (the <code className="font-mono text-xs">openclaw-nodes</code> skill). OpenClaw's own chat and agent are never used, it isn't a coding swarm, and a shell on the phone isn't reachable this way. You use the OS on the phone in Safari and Telegram, not through OpenClaw.
          </p>
        </Disclosure>
      </VerdictCard>
    </div>
  );
}
