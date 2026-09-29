import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { ReceptionistDestination } from "@/components/shell/pages/receptionist-destination";

export const Route = createFileRoute("/receptionist")({
  head: () => ({ meta: [{ title: docTitle("/receptionist") }] }),
  component: ReceptionistDestination,
});
