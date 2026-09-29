import { createFileRoute, redirect } from "@tanstack/react-router";

// Today merged into the Business brief, the home page (owner, 29 Sep 2026). Old links still work,
// search included (?scene=1 still opens the Command scene).
export const Route = createFileRoute("/today")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/business", search: location.search as never, replace: true });
  },
});
