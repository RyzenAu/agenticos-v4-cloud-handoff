import { Link } from "@tanstack/react-router";
import { Notice } from "@/components/ds";
import { useWorkspaceProfile } from "@/lib/workspace-profile";

/**
 * Home shows one calm line until the profile is finished. It used to be a purple crystal banner with a video and third-party logos
 * (audit S9): nothing here sells anything.
 */
export function SetupWelcome() {
  const { profile, isLoading } = useWorkspaceProfile();
  if (isLoading || profile.onboardingCompletedAt) return null;
  return (
    <Notice
      tone="info"
      className="mb-6"
      title="Your profile isn't finished"
      action={<Link to="/setup" className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">{profile.onboardingStep ? "Continue setup" : "Set it up"}</Link>}
    >
      A few details help Jarvis and the pages say the right things.
    </Notice>
  );
}
