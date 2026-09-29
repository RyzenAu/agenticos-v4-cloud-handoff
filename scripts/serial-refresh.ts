// One refresh at a time, with a debounced trigger (Track 8 / API audit F5 P2-6). A request that
// arrives while a run is in flight queues exactly one more run after it; schedule() coalesces a
// burst (e.g. several Jarvis settings saves) into one run `delayMs` after the last request.
export function serialRefresher(run: () => Promise<void>, options: { delayMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}) {
  const delayMs = options.delayMs ?? 5_000;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runs = 0;
  const now = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    runs++;
    // Promise.resolve().then: a run that throws synchronously is a rejection here, never an uncaught
    // exception from a timer (seen in the suite: it failed whichever test was running at the time).
    running = Promise.resolve()
      .then(run)
      .catch(() => undefined)
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          schedule();
        }
      });
    return running;
  };
  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void now();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    now,
    schedule,
    stop() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
    get runs() {
      return runs;
    },
  };
}
