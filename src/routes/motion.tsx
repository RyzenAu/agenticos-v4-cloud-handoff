import { docTitle } from "@/components/shell/destinations";
import { MotionLibrary } from "@/components/motion/motion-library";
import { TABS, type Tab } from "@/components/motion/library-types";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

type Search = { style?: string; stress?: number; tab?: Tab };

export const Route = createFileRoute("/motion")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    style:
      typeof search.style === "string" && /^[a-z0-9-]{1,64}$/.test(search.style)
        ? search.style
        : undefined,
    // ?stress=120 repeats the wall to test smoothness at wave-2 size.
    stress:
      Number.isInteger(Number(search.stress)) && Number(search.stress) > 0
        ? Math.min(240, Number(search.stress))
        : undefined,
    // ?tab=kit opens the M&U kit (the Websites "Make a site" flow links here).
    tab: TABS.includes(search.tab as Tab) && search.tab !== "styles" ? (search.tab as Tab) : undefined,
  }),
  head: () => ({
    meta: [{ title: docTitle("/motion") }],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    ],
  }),
  component: MotionStudioPage,
});

function MotionStudioPage() {
  const { style, stress, tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/motion" });
  return (
    <MotionLibrary
      selected={style}
      stress={stress}
      tab={tab}
      onTab={(next) =>
        void navigate({
          search: (prev) => ({ ...prev, tab: next === "styles" ? undefined : next }),
          resetScroll: false,
          replace: true,
        })
      }
      onSelect={(id) =>
        void navigate({
          search: (prev) => ({ ...prev, style: id }),
          resetScroll: false,
        })
      }
    />
  );
}
