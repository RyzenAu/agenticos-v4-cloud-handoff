// Why a bot conversation could not be read, and the next move, in the person's words. One notice per cause (see ThreadReadKind in
// src/lib/agent-chat.ts): never a vague "unavailable", never a retry button for something retrying cannot fix.
import { Notice } from "@/components/ds";
import { NOT_ALLOWED_PREFIX, type ThreadReadKind } from "@/lib/agent-chat";
import type { ReadIssue } from "./use-bot-chat";

const TITLE: Record<ThreadReadKind | "other", string> = {
  "not-paired": "This browser can't open the conversation yet",
  "not-found": "This bot isn't here any more",
  store: "The hub can't read its saved conversations",
  server: "The hub hit an error reading the conversation",
  network: "This browser can't reach the hub",
  timeout: "The hub is slow to answer",
  shape: "The hub's answer couldn't be read",
  other: "The conversation may be out of date",
};

export function ReadNotice({ issue, onTryAgain }: { issue: ReadIssue; onTryAgain: () => void }) {
  const said = issue.message.startsWith(NOT_ALLOWED_PREFIX) ? issue.message.slice(NOT_ALLOWED_PREFIX.length) : issue.message;
  // Pairing and a missing bot are not retried and have no retry button: only the person can fix them.
  const retry = issue.retryable;
  const status = !retry ? "" : issue.gaveUp ? " It stopped retrying on its own." : " It keeps trying in the background.";
  return (
    <div data-testid="read-issue" data-kind={issue.kind} data-gave-up={issue.gaveUp ? "true" : "false"}>
      <Notice
        tone="warn"
        title={TITLE[issue.kind]}
        role="status"
        action={
          retry ? (
            <button type="button" className="ds-interactive rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-raised" onClick={onTryAgain}>
              Try again
            </button>
          ) : undefined
        }
      >
        {said} {issue.action}
        {status}
      </Notice>
    </div>
  );
}
