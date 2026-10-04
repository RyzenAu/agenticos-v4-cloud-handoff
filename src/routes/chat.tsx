import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageSkeleton } from "@/components/ds";

// The chat itself is the floating chat, portalled into #argentic-chat-host once its lazy bundle has
// loaded (6–9 s on a busy machine). Until something lands in the host, a skeleton in the chat's
// shape says it is loading instead of an empty page, and the page always has its heading
// (audit F3-31).
function ChatWorkspace() {
  const host = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (el) el.dataset.ready = "true";
    const check = () => setMounted(!!el && el.childElementCount > 0);
    const watch = el && typeof MutationObserver !== "undefined" ? new MutationObserver(check) : null;
    if (el) watch?.observe(el, { childList: true });
    check();
    window.dispatchEvent(new Event("argentic:chat-host"));
    return () => {
      watch?.disconnect();
      window.dispatchEvent(new Event("argentic:chat-close"));
    };
  }, []);
  return (
    <div className="relative">
      <h1 className="sr-only">Chat</h1>
      <div ref={host} id="argentic-chat-host" className="ar-chat-workspace-host" aria-label="Chat workspace" />
      {!mounted && (
        <div className="pointer-events-none absolute inset-0 mx-auto flex max-w-[830px] flex-col px-6 pt-10" data-testid="chat-loading">
          <PageSkeleton variant="page" rows={3} label="Loading chat" />
        </div>
      )}
    </div>
  );
}
export const Route = createFileRoute("/chat")({
  head: () => ({ meta: [{ title: docTitle("/chat") }] }),
  component: ChatWorkspace,
});
