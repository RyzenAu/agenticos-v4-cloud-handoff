// Mount point for /memory/vault (src/components/shell/mounts.tsx). The memory track's curated vault.
// `?ref=<wiki_ref>` opens a fact on arrival (the "facts used" links on a Jarvis answer).
import { useState } from "react";
import type { MountProps } from "@/components/shell/mounts";
import { MemoryVault } from "@/components/memory";

export default function MemoryDestinationMount(_props: MountProps) {
  // Mounts are client-only (DestinationMount waits for the client), so reading the URL here is safe.
  const [initialRef] = useState(() => new URLSearchParams(window.location.search).get("ref")?.slice(0, 120) || undefined);
  return <MemoryVault initialRef={initialRef} />;
}
