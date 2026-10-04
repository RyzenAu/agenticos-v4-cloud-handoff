// Provider logos. OpenAI uses an inline SVG (Simple Icons occasionally 404s
// on /openai); the others fetch from the Simple Icons CDN with a tinted-monogram
// fallback if the image fails to load. Per docs/DESIGN-SYSTEM.md § 8, a provider's
// brand colour is kept only on the logo mark itself (the CDN request and the
// monogram fallback below) — never as a page or tile tint. ModelStrip renders
// every vendor inside the same neutral tile.

import { useState } from "react";
import { cn } from "@/lib/utils";

export type ModelKey = "claude" | "openai" | "gemini" | "llama" | "deepseek";

export const MODELS: Record<
  ModelKey,
  { name: string; slug: string; color: string; tagline: string; mono: string }
> = {
  claude: { name: "Claude", slug: "anthropic", color: "D97757", tagline: "Anthropic", mono: "C" },
  openai: { name: "ChatGPT", slug: "openai", color: "10A37F", tagline: "OpenAI", mono: "AI" },
  gemini: { name: "Gemini", slug: "googlegemini", color: "4285F4", tagline: "Google", mono: "G" },
  llama: { name: "Llama (local)", slug: "ollama", color: "F0F0F0", tagline: "Ollama", mono: "L" },
  deepseek: {
    name: "DeepSeek",
    slug: "deepseek",
    color: "4D6BFE",
    tagline: "DeepSeek",
    mono: "DS",
  },
};

function OpenAIMark({ size, color }: { size: number; color: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={`#${color}`}
      aria-label="ChatGPT logo"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.075.075 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.075.075 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export function ModelLogo({ model, size = 20 }: { model: ModelKey; size?: number }) {
  const m = MODELS[model];
  const [errored, setErrored] = useState(false);
  if (model === "openai") return <OpenAIMark size={size} color={m.color} />;
  if (errored) return <MonoFallback model={model} size={size} />;
  return (
    <img
      src={`https://cdn.simpleicons.org/${m.slug}/${m.color}`}
      alt={`${m.name} logo`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErrored(true)}
      className="object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function MonoFallback({ model, size }: { model: ModelKey; size: number }) {
  const m = MODELS[model];
  return (
    <div
      className="flex items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: `#${m.color}`,
        color: "#0b0e13",
        fontSize: Math.round(size * 0.45),
        letterSpacing: "-0.02em",
      }}
    >
      {m.mono}
    </div>
  );
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function ModelStrip({
  usage,
  className = "",
}: {
  usage: Partial<Record<ModelKey, { runs: number; share: number; tokens?: number }>>;
  className?: string;
}) {
  const keys = Object.keys(MODELS) as ModelKey[];
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", className)}>
      {keys.map((k) => {
        const m = MODELS[k];
        const u = usage[k] ?? { runs: 0, share: 0, tokens: 0 };
        const tokens = u.tokens ?? 0;
        return (
          <div
            key={k}
            className="ds-interactive flex flex-col rounded-xl border border-border bg-card p-4 hover:border-border-strong hover:bg-surface-raised"
          >
            <div className="flex items-center gap-3">
              {/* Neutral tile — the vendor's identity is the logo mark only (DESIGN-SYSTEM.md § 8) */}
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-inset">
                <ModelLogo model={k} size={22} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{m.name}</div>
                <div className="truncate text-xs text-muted-foreground">{m.tagline}</div>
              </div>
            </div>

            <div className="mt-4 flex items-baseline justify-between">
              <div className="ds-num text-xl font-semibold leading-none tracking-[-0.01em] text-foreground">
                {u.runs}
              </div>
              <div className="ds-num text-xs text-muted-foreground">{u.share}% share</div>
            </div>
            <div className="ds-num mt-1 flex items-baseline justify-between text-xs text-muted-foreground">
              <span>runs</span>
              <span>
                <span className="text-foreground/80">{formatTokens(tokens)}</span> tokens
              </span>
            </div>

            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-700"
                style={{ width: `${u.share}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
