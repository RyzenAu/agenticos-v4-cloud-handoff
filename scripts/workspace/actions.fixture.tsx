// Real controls, fabricated business metadata only; browser acceptance intercepts every request.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { TodayPanel } from "../../src/components/workspace/today-panel";
import { AgentQuestionsPanel } from "../../src/components/operator/agent-jobs-panel";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRootRoute({ component: () => <main className="operator-shell min-h-screen bg-background p-5 text-foreground sm:p-8"><h1 className="mb-6 text-xl font-semibold">Synthetic decision review</h1><TodayPanel now={Date.parse("2026-09-30T01:00:00Z")} /><div className="mt-8"><AgentQuestionsPanel /></div></main> });
const router = createRouter({ routeTree: root });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
