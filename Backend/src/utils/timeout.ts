/** Race a promise against a deadline. Rejects with TimeoutError if the
 *  promise does not settle within `ms` milliseconds.
 *
 *  Used by the health endpoint: a slow/unreachable dependency (e.g. Redis
 *  on a free tier with no managed instance) must never hang a probe.
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
