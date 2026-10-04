import { cn } from "@/lib/utils";
import hermesFace from "@/assets/hermes-face.png";
import openclawLogo from "@/assets/logos/openclaw.svg";
import claudeLogo from "@/assets/claude-logo.png";
import codexLogo from "@/assets/logos/codex.png";

export type Agent = "hermes" | "openclaw" | "claude-code" | "codex";

const AGENTS: Record<Agent, { name: string; src: string; round?: boolean }> = {
  hermes: { name: "Hermes", src: hermesFace, round: true },
  openclaw: { name: "OpenClaw", src: openclawLogo },
  "claude-code": { name: "Claude Code", src: claudeLogo },
  codex: { name: "Codex", src: codexLogo },
};

/**
 * An agent's identity, at the size of a chip. This is the ONLY place an
 * agent's own brand appears — pages are never themed in its colours, fonts
 * or artwork (audit P2-9). Use in page headers, list rows and source lines.
 */
export function BrandMark({
  agent,
  size = 16,
  withLabel = false,
  className,
}: {
  agent: Agent;
  size?: 14 | 16 | 20 | 24;
  withLabel?: boolean;
  className?: string;
}) {
  const a = AGENTS[agent];
  const img = (
    <img
      src={a.src}
      alt={withLabel ? "" : a.name}
      width={size}
      height={size}
      className={cn("shrink-0 object-contain", a.round ? "rounded-full object-cover" : "rounded-[4px]")}
      style={{ width: size, height: size }}
    />
  );
  if (!withLabel) return <span className={cn("inline-flex", className)}>{img}</span>;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-inset py-0.5 pl-1 pr-2.5 text-xs font-medium text-foreground",
        className,
      )}
    >
      {img}
      {a.name}
    </span>
  );
}
