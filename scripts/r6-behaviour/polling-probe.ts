// Run in its own process by r6-ui-behaviour.test.tsx: react-query decides at import time whether it is on a server
// (no window), so a fresh process with a window defined is the only reliable place to watch its polling.
(globalThis as any).window = globalThis; (globalThis as any).document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
const { QueryClient, QueryObserver, focusManager } = await import("@tanstack/react-query");
const { leadsListQuery } = await import("../../src/lib/leads-queries");
let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const observer = new QueryObserver(new QueryClient(), { ...leadsListQuery(false, 25), queryFn: async () => { calls++; return { leads: [] }; } } as never);
const unsub = observer.subscribe(() => {});
focusManager.setFocused(true); await sleep(150); const visible = calls;
focusManager.setFocused(false); await sleep(60); const atHide = calls; await sleep(200); const hidden = calls - atHide;
focusManager.setFocused(true); await sleep(150); const resumed = calls - atHide;
unsub();
console.log(JSON.stringify({ visible, hidden, resumed }));
process.exit(0);
export {};
