// True only after hydration (merge review U1). The server and the first client render both see
// `false`, so anything that depends on client-only data (a react-query cache another component has
// already filled) renders the same loading state on both sides, then updates after mount. A
// component mounted later, on a client-side navigation, gets `true` straight away.
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** A query result as it must look before hydration: loading, with no data, no error, not fetching. */
export function pendingUntilHydrated<T extends { isLoading: boolean }>(result: T, hydrated: boolean): T {
  if (hydrated) return result;
  return { ...result, data: undefined, isLoading: true, isPending: true, isError: false, isFetching: false, error: null, dataUpdatedAt: 0 };
}
