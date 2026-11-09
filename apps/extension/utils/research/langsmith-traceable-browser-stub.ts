/**
 * DeepAgentsJS >= 1.16 imports `getCurrentRunTree` from `langsmith/traceable`
 * only to forward trace headers to async subagents, which the browser worker
 * never starts. That module constructs `node:async_hooks` AsyncLocalStorage at
 * load time and crashes an MV3 worker, so the browser build sees no run tree.
 */
export function getCurrentRunTree(): undefined {
  return undefined;
}
