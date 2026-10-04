import { useCallback } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

export const SETTINGS_TABS = ["personal-profile", "connections", "ai-tools", "workspace", "jarvis"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab an address names: an unknown or empty hash is the first tab. */
export function settingsTabFor(hash: string): SettingsTab {
  const raw = hash.replace(/^#/, "");
  const id = raw === "preferences" ? "workspace" : raw; // the old address of the Workspace tab keeps working
  return (SETTINGS_TABS as readonly string[]).includes(id) ? (id as SettingsTab) : "personal-profile";
}

/**
 * The Settings tab lives in the address (#connections), read through the router so Back and Forward move between tabs. A click is a
 * step in history through the router's own navigation (its index and scroll keys stay right); the arrow keys only move along the tabs, so
 * they replace. Choosing the tab already showing never adds an entry.
 */
export function useSettingsTab() {
  const hash = useRouterState({ select: (s) => s.location.hash });
  const navigate = useNavigate();
  const section = settingsTabFor(hash);
  const select = useCallback(
    (id: SettingsTab, replace = false) => {
      if (id === section) return;
      void navigate({ to: ".", hash: id, replace, resetScroll: false } as never);
    },
    [navigate, section],
  );
  return { section, select };
}
