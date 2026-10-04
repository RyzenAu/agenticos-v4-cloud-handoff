import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { ComputersPage } from "@/components/computers/computers-page";

// /computers — System > Computers: your paired PCs and the shared agent computers.
export const Route = createFileRoute("/computers")({
  head: () => ({ meta: [{ title: docTitle("/computers") }] }),
  component: ComputersPage,
});
