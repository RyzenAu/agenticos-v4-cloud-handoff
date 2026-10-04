import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
// The page body lives in ./-pages/setup.tsx: other pages import pieces of it, and exports
// from a route file are never code-split, so they used to load this whole page (and its
// dependencies) on every route. Keep this file to the route definition only.
import { SetupRoute } from "./-pages/setup";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: docTitle("/setup") },
      {
        name: "description",
        content: "Your profile, connections and priorities in one place.",
      },
    ],
  }),
  component: SetupRoute,
});
