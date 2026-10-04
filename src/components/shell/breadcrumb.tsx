import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { locate } from "./destinations";

/** Header location: "Destination › Page". The destination is a link back to its landing page. */
export function Breadcrumb() {
  const { path, view } = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown> | undefined)?.view;
      return { path: s.location.pathname, view: typeof v === "string" ? v : undefined };
    },
  });
  const here = locate(path, view);
  if (!here) return <span className="sh-crumb-current">Agentic OS</span>;
  const { destination, drilldown } = here;
  return (
    <nav aria-label="You are here" className="sh-crumbs">
      {drilldown ? (
        <>
          {/* Phones show the page itself (AUDIT-F1 F1-28: "Receptionist › P." truncated); the sidebar drawer has the rest. */}
          <Link to={destination.to as never} className="sh-crumb-link hidden sm:inline">
            {destination.label}
          </Link>
          <ChevronRight size={14} aria-hidden="true" className="sh-crumb-sep hidden sm:block" />
          <span className="sh-crumb-current" aria-current="page">
            {drilldown.label}
          </span>
        </>
      ) : (
        // R11: on a top-level page the h1 right below says the same word; beside the sidebar it is only for screen readers.
        <span className="sh-crumb-current lg:sr-only" aria-current="page">
          {destination.label}
        </span>
      )}
    </nav>
  );
}
