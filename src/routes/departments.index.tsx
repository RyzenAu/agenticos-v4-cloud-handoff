import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { DepartmentsIndex } from "@/components/departments/department-page";

// R12: the AI departments (Sales & CRM, Design & Websites, Engineering, Finance, Research, Operations) over the existing agents, jobs and results.
export const Route = createFileRoute("/departments/")({
  head: () => ({ meta: [{ title: docTitle("/departments") }] }),
  component: DepartmentsIndex,
});
