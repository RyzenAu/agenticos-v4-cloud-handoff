"use client";
import { useSyncExternalStore } from "react";
import { EMPTY, snapshot, subscribe, type ListingsState } from "./state";

/** Re-renders the caller once the listings have loaded, and returns them. Every client component that reads listings calls this. */
export function useListings(): ListingsState {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
