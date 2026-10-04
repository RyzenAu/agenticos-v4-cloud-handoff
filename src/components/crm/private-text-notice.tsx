import { Notice } from "@/components/ds";
import { useBrowserPending } from "@/components/shell/signed-in";

/**
 * The CRM's "Private text is hidden" notice. A browser that is not confirmed already has the shell's banner ("isn't confirmed yet", with
 * the link to confirm it) across the top of every page, so this says nothing then: at most one message. It still shows for a caller the
 * banner does not cover (for example the hub owner's own program session).
 */
export function PrivateTextNotice({ withheld }: { withheld: boolean }) {
  const bannerShowing = useBrowserPending();
  if (!withheld || bannerShowing) return null;
  return (
    <Notice tone="info" className="mb-5" title="Private text is hidden">
      Confirm this browser to read and edit notes, drafts, document text and next actions.
      Names, stages and dates are still shown.
    </Notice>
  );
}
