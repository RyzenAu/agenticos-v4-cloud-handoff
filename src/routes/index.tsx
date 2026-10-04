import { createFileRoute, redirect } from "@tanstack/react-router";
// The owner asked (29 Sep 2026) for the Business brief to be the page the OS opens on.
export const Route = createFileRoute("/")({ beforeLoad: () => { throw redirect({ to: "/business", replace: true }); } });
