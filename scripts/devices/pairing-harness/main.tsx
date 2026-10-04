import React from "react";
import { createRoot } from "react-dom/client";
import "../../../src/styles.css";
import { ProfilePanel } from "../../../src/components/profile/profile-panel";

// The real Profile panel against the synthetic server-role hub in hub.ts. Nothing else of the OS is loaded.
createRoot(document.getElementById("root")!).render(
  <div className="mx-auto max-w-4xl bg-background p-6 text-foreground">
    <p className="mb-4 text-xs text-muted-foreground" data-testid="harness-banner">Synthetic server hub (R7-G pairing harness): not the OS, no real data.</p>
    <ProfilePanel />
  </div>,
);
