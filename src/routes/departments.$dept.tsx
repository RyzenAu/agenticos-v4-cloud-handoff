import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { NotFoundPanel } from "@/components/shell/not-found-panel";
import { DepartmentPage } from "@/components/departments/department-page";
import { DEPARTMENT_BY_ID, isDepartmentId } from "@/lib/departments";

// R12: one department. `?task=<job id>` opens that task's drawer (so Back closes it, and a link can open it).
export const Route = createFileRoute("/departments/$dept")({
  validateSearch: (s: Record<string, unknown>): { task?: string } => (typeof s.task === "string" && /^[\w:.-]{1,80}$/.test(s.task) ? { task: s.task } : {}),
  head: ({ params }) => ({ meta: [{ title: docTitle(isDepartmentId(params.dept) ? DEPARTMENT_BY_ID[params.dept].name : "/not-found") }] }),
  loader: ({ params }) => {
    if (!isDepartmentId(params.dept)) throw notFound();
    return {};
  },
  notFoundComponent: () => <NotFoundPanel title="No such department" description="Departments are Sales, Design, Engineering, Finance, Research and Operations." backTo="/departments" backLabel="All departments" />,
  component: DepartmentRoute,
});

function DepartmentRoute() {
  const { dept } = Route.useParams();
  const { task } = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!isDepartmentId(dept)) return <NotFoundPanel title="No such department" description="Departments are Sales, Design, Engineering, Finance, Research and Operations." backTo="/departments" backLabel="All departments" />;
  return <DepartmentPage key={dept} dept={dept} taskId={task ?? null} onTask={(id) => void navigate({ search: (prev) => ({ ...prev, task: id ?? undefined }) })} />;
}
