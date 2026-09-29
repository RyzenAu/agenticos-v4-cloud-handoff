import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { operatorRequest } from "./operator";
import type { PublicProfileLink } from "./workspace-profile-links";
import { fmtMoney } from "./format";

/** Keep untouched defaults and stale snapshots out of partial profile saves. */
export function profileChanges<T extends object>(base: T, draft: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(draft) as Array<keyof T>) {
    const sameArray =
      Array.isArray(base[key]) &&
      Array.isArray(draft[key]) &&
      JSON.stringify(base[key]) === JSON.stringify(draft[key]);
    if (!Object.is(base[key], draft[key]) && !sameArray) patch[key] = draft[key];
  }
  return patch;
}

export interface WorkspaceProfile {
  name: string;
  role: string;
  about: string;
  responsePreferences: string;
  timeZone: string;
  currency: string;
  avatar: string;
  hourlyRate: number | null;
  publicProfiles: PublicProfileLink[];
  tools: string[];
  city: string;
  onboardingFlowVersion: 2;
  onboardingStep: number;
  onboardingCompletedAt?: string;
  updatedAt?: string;
}
/** Display currency to suggest for a timezone when the owner hasn't chosen one (AUD in Australia). */
export function currencyForTimeZone(timeZone?: string | null) {
  if (!timeZone) return "USD";
  if (/^Australia\//.test(timeZone)) return "AUD";
  if (timeZone === "Europe/London") return "GBP";
  return "USD";
}
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The hourly rate every "time saved" figure uses. The profile's rate when set (Settings →
 * Profile); otherwise an assumed $120/h that is always labelled as an assumption.
 */
export const ASSUMED_HOURLY_RATE = 120;
export type HourlyRate = { rate: number; assumed: boolean; currency: string; label: string };
export function effectiveHourlyRate(
  profile: Pick<WorkspaceProfile, "hourlyRate" | "currency"> | null | undefined,
): HourlyRate {
  const currency = profile?.currency || "AUD";
  const set = typeof profile?.hourlyRate === "number" && profile.hourlyRate > 0;
  const rate = set ? (profile!.hourlyRate as number) : ASSUMED_HOURLY_RATE;
  const money = fmtMoney(rate, { currency, whole: true });
  return {
    rate,
    assumed: !set,
    currency,
    label: set ? `at your rate of ${money}/h` : `at ${money}/h (assumed) — set your rate in Settings`,
  };
}

const empty: WorkspaceProfile = {
  name: "",
  role: "",
  about: "",
  responsePreferences: "",
  timeZone: "UTC",
  currency: currencyForTimeZone(browserTimeZone()),
  avatar: "",
  hourlyRate: null,
  publicProfiles: [],
  tools: [],
  city: "",
  onboardingFlowVersion: 2,
  onboardingStep: 0,
};
export function useWorkspaceProfile() {
  const qc = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const query = useQuery<WorkspaceProfile>({
    enabled: hydrated,
    queryKey: ["workspace-profile"],
    queryFn: () => operatorRequest("/profile"),
    staleTime: 30000,
    retry: 1,
  });
  async function save(patch: Partial<WorkspaceProfile> & { complete?: boolean }) {
    const profile = await operatorRequest<WorkspaceProfile>("/profile", patch);
    qc.setQueryData(["workspace-profile"], profile);
    await qc.invalidateQueries({ queryKey: ["operator-state"] });
    window.dispatchEvent(new Event("operator:profile"));
    return profile;
  }
  const profile = hydrated ? query.data || empty : empty;
  return {
    ...query,
    data: hydrated ? query.data : undefined,
    profile,
    /** The rate for every value figure, with its assumption spelled out. */
    rate: effectiveHourlyRate(query.data),
    isLoading: !hydrated || query.isLoading,
    save,
    refresh: () => qc.invalidateQueries({ queryKey: ["workspace-profile"] }),
  };
}
