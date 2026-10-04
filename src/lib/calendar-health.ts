// Client side of scripts/calendar-health.ts: the one "is the calendar current?" answer every
// page that shows calendar data should use (Calendar, Business "Events today", status tiles).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { operatorRequest } from "./operator";
import { fmtDay, fmtTime } from "./format";

export type CalendarHealth = {
  state: "live" | "stale" | "offline" | "none";
  source: "codex" | "google" | "outlook" | "cal" | null;
  sourceLabel: string | null;
  syncedAt: string | null;
  ageMs: number | null;
  savedEvents: number;
  headline: string;
  problem?: string;
  ownerAction?: string;
  background: {
    intervalMinutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    results: Array<{ source: string; ok: boolean; at: string; skipped?: string; error?: string }>;
  };
};

export function useCalendarHealth() {
  // Mount-gated like the other operator queries, so server and client HTML match.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return useQuery<CalendarHealth>({
    queryKey: ["calendar-health"],
    queryFn: () => operatorRequest<CalendarHealth>("/calendar/health", undefined, "GET"),
    enabled: ready,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/** "22 Sept, 3:15 am · 1 day ago" — always dated, never a bare time that reads as today. */
export function syncedLabel(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "unknown";
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  const ago =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 36 * 60
          ? `${Math.round(minutes / 60)} h ago`
          : `${Math.round(minutes / 1440)} days ago`;
  const date = fmtDay(at);
  const time = fmtTime(at);
  return `${date}, ${time} · ${ago}`;
}
