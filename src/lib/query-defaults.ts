// App-wide react-query defaults (audit P1-4). The library default is three retries with growing gaps
// (1 s, 2 s, 4 s), which left a page on grey skeleton rows for about eight seconds before it said the
// source was down. One quick retry is enough for a blip; then the page shows its honest error state.
// A query that sets its own `retry` (leads detail, chat) keeps it.
export const QUERY_DEFAULTS = { queries: { retry: 1, retryDelay: 400 } } as const;
