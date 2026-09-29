import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
// The page body lives in ./-pages/dashboard.tsx: other pages import pieces of it, and exports
// from a route file are never code-split, so they used to load this whole page (and its
// dependencies) on every route. Keep this file to the route definition only.
import { Home } from "./-pages/dashboard";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: docTitle("/dashboard") },
      {
        name: "description",
        content:
          "Operator home: skills ROI, memory graph, integrations, automations and the daily Dream review.",
      },
    ],
  }),
  component: Home,
});
