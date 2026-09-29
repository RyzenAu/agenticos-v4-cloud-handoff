// A page that isn't there: a heading, one plain sentence and the way back (audit P2-8: /coding/nope
// showed a raw "Unknown coding route" with no heading and no link). The route also answers a real 404.
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ds";

export function NotFoundPanel({ title, description, backTo, backLabel }: { title: string; description: string; backTo: string; backLabel: string }) {
  return (
    <div className="w-full max-w-[1680px]" data-not-found="">
      <PageHeader title={title} description={description} />
      <Link to={backTo as never} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground hover:bg-accent">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {backLabel}
      </Link>
    </div>
  );
}
