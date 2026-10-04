import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { QUERY_DEFAULTS } from "./lib/query-defaults";

export const getRouter = () => {
  const queryClient = new QueryClient({ defaultOptions: QUERY_DEFAULTS });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
