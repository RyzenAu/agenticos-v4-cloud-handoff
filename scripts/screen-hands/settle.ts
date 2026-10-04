/** Wait for observation, never replay the action. Stops promptly when the owner cancels. */
export async function observedChange<T>(options: {
  before: string;
  read: () => Promise<T>;
  signature: (value: T) => string;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const { signal } = options;
  // Includes the immediate read; cumulative waits are bounded at 2.3 seconds.
  for (const delay of [0, 100, 150, 250, 400, 600, 800]) {
    if (signal.aborted) return false;
    if (delay) {
      await new Promise<void>((resolve, reject) => {
        const stop = () => resolve();
        signal.addEventListener("abort", stop, { once: true });
        options
          .sleep(delay)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", stop));
      });
    }
    if (signal.aborted) return false;
    const value = await options.read();
    if (signal.aborted) return false;
    if (options.signature(value) !== options.before) return true;
  }
  return false;
}
