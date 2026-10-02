import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { pageName } from "@/components/shell/destinations";

/** Pages a sentence may point at by path ("count them on /receptionist"). Anything else stays plain text. */
export const LINKABLE_ROUTES = [
  "receptionist", "leads", "coding", "work", "memory", "finance", "studio", "models", "system", "settings",
  "inbox", "calendar", "jarvis", "websites", "design", "motion", "activity", "automations", "skills", "usage", "workspaces",
] as const;

const ROUTE_RE = new RegExp(String.raw`(^|[\s(])(/(?:${LINKABLE_ROUTES.join("|")}))(?=$|[\s).,;:!?])`, "g");

/** Pure: splits text into plain and route segments. Exported for tests. */
export function splitRoutes(text: string): Array<{ text: string; to?: string }> {
  const out: Array<{ text: string; to?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(ROUTE_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: m[2], to: m[2] });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/**
 * Sentence text in which a page path like "/receptionist" is a real link. A "needs you" message that
 * names a page must take you there; a path you can only read is an inert instruction.
 */
export function RouteText({ children }: { children: string }): ReactNode {
  return (
    <>
      {splitRoutes(children).map((part, i) =>
        part.to ? (
          <Link key={i} to={part.to as never} className="font-medium text-foreground underline underline-offset-2 hover:text-brand">
            {pageName(part.to)}
          </Link>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
