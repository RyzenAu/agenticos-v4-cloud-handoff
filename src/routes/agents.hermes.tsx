import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
// The page body lives in ./-pages/hermes.tsx: other pages import pieces of it, and exports
// from a route file are never code-split, so they used to load this whole page (and its
// dependencies) on every route. Keep this file to the route definition only.
import { HermesPage } from "./-pages/hermes";

export const Route = createFileRoute("/agents/hermes")({
  head: () => ({
    meta: [
      { title: docTitle("/agents/hermes") },
      {
        name: "description",
        content: "Hermes: an autonomous agent that grows with you.",
      },
    ],
  }),
  component: HermesPage,
});
