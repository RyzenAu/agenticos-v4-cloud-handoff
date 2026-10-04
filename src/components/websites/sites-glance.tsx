// Websites → "At a glance" (W-F, 29 Sep 2026): each of M&U's sites from the existing catalogue, calmly:
// its live address, a preview address when there is one, and when it was last deployed (from the
// cached, read-only Vercel listing). Unknown stays "—" with the reason; nothing here deploys.
import { Fragment } from "react";
import { ExternalLink, Globe2 } from "lucide-react";
import { Button, Widget } from "@/components/ds";
import { hostOf, type LocalTemplate, type OurSite } from "@/lib/websites";
import { deployLine, previewFor } from "./glance";
import { VERTICAL_LABEL, type Vertical } from "@/lib/leads";

/** A host that wraps at its dots (and hyphens) rather than mid-word: "bianca.<wbr>muventures.<wbr>com.au". */
export function BreakableHost({ host }: { host: string }) {
  const parts = host.split(/(?<=[.-])/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * L2 (29 Sep): one widget per site in the Websites page grid (the caller's WidgetGrid): the site's
 * name, its live address as the one piece of content, preview and last deploy, and "Open live".
 */
export function SitesGlance({
  sites,
  templates,
  vercel,
}: {
  sites: readonly OurSite[];
  templates: readonly LocalTemplate[];
  vercel: { error: string | null; at: string | null };
}) {
  if (!sites.length) return null;
  return (
    <>
      {sites.map((s) => {
        const deploy = deployLine(s, vercel);
        const preview = previewFor(s, templates);
        return (
          <Widget
            key={s.id}
            icon={Globe2}
            title={s.name}
            badge="Live"
            data-glance={s.id}
            line={`${VERTICAL_LABEL[s.vertical as Vertical] ?? s.vertical} ${s.kind === "client" ? "client" : "flagship"}`}
            action={
              <Button asChild size="sm" variant="outline" className="rounded-full">
                <a href={s.url} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" /> Open live
                </a>
              </Button>
            }
          >
            <a href={s.url} target="_blank" rel="noreferrer" data-glance-host="" className="block text-lg font-semibold leading-snug underline-offset-4 [overflow-wrap:break-word] hover:underline">
              <BreakableHost host={hostOf(s.url)} />
            </a>
            <dl className="mt-3 grid gap-3 text-sm">
              <div data-glance-row="preview" className="min-w-0">
                <dt className="text-muted-foreground">Preview</dt>
                <dd className="mt-0.5 min-w-0 [overflow-wrap:anywhere]">
                  {preview ? (
                    <a href={preview.href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                      <BreakableHost host={preview.label} />
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div data-glance-row="deploy" className="min-w-0">
                <dt className="text-muted-foreground">Last deploy</dt>
                <dd className={deploy.known ? "mt-0.5" : "mt-0.5 text-muted-foreground"}>{deploy.text}</dd>
              </div>
            </dl>
          </Widget>
        );
      })}
    </>
  );
}
