// React wrapper for PublishFlow (src/lib/publish-flow.ts): one flow per (what, which one), wired to this browser's activity stream.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { activityHub } from "./activity-stream";
import { approvalsFromActivity, fetchApproval, PublishFlow, type ApprovalFeed, type FlowState, type KV, type Reply } from "./publish-flow";

/** The approval changes the hub streams (topic "approval"), through the ONE connection this browser already holds. */
export const activityApprovalFeed: ApprovalFeed = {
  subscribe(listener) {
    const hub = activityHub();
    const release = hub.acquire();
    const off = hub.subscribe((m) => {
      const list = approvalsFromActivity(m as never);
      if (list.length) listener(list);
    });
    return () => {
      off();
      release();
    };
  },
  healthy: () => activityHub().healthy(),
};

function browserStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function usePublishFlow(opts: {
  /** Which action on which thing ("lead:7:deploy"); a refresh resumes an open approval under this key. */
  resumeKey: string;
  /** The POST: with an approvalId it is the run. Never throws for an HTTP status. */
  send: (approvalId?: string) => Promise<Reply>;
  /** After the flow finished or the hub's state may have changed: refetch what the page shows. */
  onSettled?: (state: FlowState) => void;
}) {
  const latest = useRef(opts);
  latest.current = opts;
  const flow = useMemo(
    () =>
      new PublishFlow({
        send: (id) => latest.current.send(id),
        fetchApproval: (id) => fetchApproval(id),
        feed: activityApprovalFeed,
        storage: browserStorage(),
        resumeKey: `mu-publish-open:${opts.resumeKey}`,
        onSettled: (s) => latest.current.onSettled?.(s),
      }),
    [opts.resumeKey],
  );
  useEffect(() => {
    flow.attach();
    void flow.resume();
    return () => flow.dispose();
  }, [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  return { state, flow };
}
