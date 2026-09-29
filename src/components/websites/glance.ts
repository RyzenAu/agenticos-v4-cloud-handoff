// Pure helpers for Websites → "At a glance" (sites-glance.tsx).
import { fmtRelative } from "@/components/ds/format";
import { hostOf, type LocalTemplate, type OurSite } from "@/lib/websites";

/** "3 days ago", or "—" with why it's unknown. Pure. */
export function deployLine(
  site: Pick<OurSite, "deployedAt">,
  vercel: { error: string | null; at: string | null },
): { text: string; known: boolean } {
  if (site.deployedAt) return { text: fmtRelative(site.deployedAt), known: true };
  if (vercel.error) return { text: "— Vercel couldn't be read", known: false };
  if (!vercel.at) return { text: "— not checked yet", known: false };
  return { text: "— not in the Vercel listing", known: false };
}

/** The preview address for a site: its other live address, else its vertical's local lead template. Pure. */
export function previewFor(
  site: Pick<OurSite, "alsoAt" | "kind" | "vertical">,
  templates: readonly LocalTemplate[],
): { href: string; label: string } | null {
  if (site.alsoAt[0]) return { href: site.alsoAt[0], label: hostOf(site.alsoAt[0]) };
  const t =
    site.kind === "flagship" ? templates.find((x) => x.vertical === site.vertical) : undefined;
  return t?.localUrl ? { href: t.localUrl, label: "Local template" } : null;
}
