import { createFileRoute, redirect } from "@tanstack/react-router";

// The Workspace page became Today, and Today merged into the home page, the Business brief (29 Sep
// 2026); the full approvals, call queue, pipeline and sites panels are on Work. Old links land home.
export const Route = createFileRoute("/workspace")({
  beforeLoad: () => {
    throw redirect({ to: "/business", replace: true });
  },
});
