/**
 * Keep an MV3 service-worker transport alive while the offscreen host performs
 * a long, otherwise silent local-model invocation.
 *
 * This is deliberately a transport concern: it neither changes the agent's
 * progress stream nor counts as model usage. The injected scheduler keeps the
 * lifecycle contract deterministic in tests.
 */
export async function withLocalRunHeartbeatV1<T>(input: {
  runId: string;
  operation: () => Promise<T>;
  sendHeartbeat: (runId: string) => void | Promise<void>;
  intervalMs?: number;
  schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  cancel?: (handle: ReturnType<typeof setInterval>) => void;
}): Promise<T> {
  const schedule = input.schedule ?? ((callback, intervalMs) =>
    globalThis.setInterval(callback, intervalMs));
  const cancel = input.cancel ?? ((handle) => globalThis.clearInterval(handle));
  const handle = schedule(() => {
    void Promise.resolve(input.sendHeartbeat(input.runId)).catch(() => undefined);
  }, input.intervalMs ?? 20_000);

  try {
    return await input.operation();
  } finally {
    cancel(handle);
  }
}
