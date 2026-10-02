// App-wide react-query defaults (audit P1-4). The library default is three retries with growing gaps
// (1 s, 2 s, 4 s), which left a page on grey skeleton rows for about eight seconds before it said the
// source was down. One quick retry is enough for a blip; then the page shows its honest error state.
// A query that sets its own `retry` (leads detail, chat) keeps it.
//
// Round 6: a read is "fresh" for 5 s. Without that, every component that mounted a query another component had just fetched started a second
// request (a Home load made /__operator/state x4, /__operator/models x3 and a dozen other duplicates in 6 s). Polling intervals, invalidation after
// a change, Refresh buttons and the stream's hints are unaffected: staleTime only stops a mount or a focus from refetching data that is seconds old.
export const QUERY_DEFAULTS = { queries: { retry: 1, retryDelay: 400, staleTime: 5_000 } } as const;
