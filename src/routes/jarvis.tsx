import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { JarvisPage } from "@/components/shell/pages/jarvis-page";

export const Route = createFileRoute("/jarvis")({
  head: () => ({ meta: [{ title: docTitle("/jarvis") }] }),
  component: JarvisPage,
});
