// /skill-drafts — narrated-workflow skill drafts (scripts/meeting-mode/narrate.ts,
// narrate-store.ts, the /skill-drafts route in scripts/meeting-mode/narrate-api.ts). Say "Jarvis,
// I'm going to walk you through how I do X", then "that's it" or "done"; a draft shows up here for
// review. Approving is the only action that installs anything (writes the SKILL.md) — nothing here
// runs automatically.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Notice, PageHeader, Skeleton } from "@/components/ds";
import { operatorRequest } from "@/lib/operator";
import { SkillDraftReview, type SkillDraftEdit, type SkillDraftRow } from "@/components/skill-draft-review";
// W-E: the System pages share the calm reading scale (src/components/shell/calm.css).
import { CalmPage } from "@/components/shell/calm";

export function SkillDraftsPage() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery<{ drafts: SkillDraftRow[] }>({
    queryKey: ["skill-drafts"],
    queryFn: () => operatorRequest("/skill-drafts"),
    refetchInterval: 15_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["skill-drafts"] });
  const approve = async (id: string) => {
    await operatorRequest(`/skill-drafts/${id}/approve`, {});
    refresh();
  };
  const edit = async (id: string, patch: SkillDraftEdit) => {
    await operatorRequest(`/skill-drafts/${id}/edit`, patch);
    refresh();
  };
  const discard = async (id: string) => {
    await operatorRequest(`/skill-drafts/${id}/discard`, {});
    refresh();
  };
  return (
    <CalmPage className="max-w-[1000px]">
      <PageHeader
        title="Skill drafts"
        description={'From narrating a walkthrough: "Jarvis, I\'m going to walk you through how I do X", then "that\'s it" when done. Nothing is built until you approve it.'}
      />
      {error && <Notice tone="danger" title="Couldn't read the skill drafts">{(error as Error).message}</Notice>}
      {isLoading && <Skeleton className="h-40 w-full" />}
      {data && <SkillDraftReview drafts={data.drafts} onApprove={approve} onEdit={edit} onDiscard={discard} />}
    </CalmPage>
  );
}
