import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { VaultPage } from "@/components/shell/pages/vault-page";

// /memory/vault — the memory track's curated vault (search, sources, corrections) mounts here.
export const Route = createFileRoute("/memory_/vault")({
  head: () => ({ meta: [{ title: docTitle("/memory/vault") }] }),
  component: VaultPage,
});
