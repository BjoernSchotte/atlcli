import { newQuickJSAsyncWASMModuleFromVariant, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { GUEST_PRELUDE } from "./guest.js";
import { NUNJUCKS_SOURCE } from "./vendor/nunjucks-source.js";

/**
 * Nunjucks runs inside QuickJS, never on the host: it compiles templates to
 * JavaScript, so a template is code, and templates also come from shared
 * packs. One long-lived runtime per process keeps renders cheap (the bundle is
 * evaluated once); it is rebuilt after a limit was hit.
 */
export interface JinjaLimits {
  /** Per render call. */
  timeoutMs: number;
  memoryBytes: number;
}

export const DEFAULT_JINJA_LIMITS: JinjaLimits = { timeoutMs: 5_000, memoryBytes: 64 * 1024 * 1024 };

export class JinjaError extends Error {
  constructor(
    message: string,
    readonly kind: "limit" | "internal",
  ) {
    super(message);
    this.name = "JinjaError";
  }
}

let module: QuickJSWASMModule | undefined;
let loading: Promise<void> | undefined;
let live: { runtime: QuickJSRuntime; ctx: QuickJSContext } | undefined;

/** Loads the QuickJS module once. Rendering is synchronous after this resolved. */
export function initJinja(): Promise<void> {
  // The QuickJS build the CLI already ships (one emscripten-module.wasm beside the bundle).
  return (loading ??= import("@jitl/quickjs-ng-wasmfile-release-asyncify")
    .then((v) => newQuickJSAsyncWASMModuleFromVariant(v.default))
    .then((m) => {
      // Only the synchronous API is used, which the asyncify build shares.
      module = m as unknown as QuickJSWASMModule;
    }));
}

/** Whether `initJinja()` has finished. */
export function jinjaReady(): boolean {
  return module !== undefined;
}

function context(limits: JinjaLimits): { runtime: QuickJSRuntime; ctx: QuickJSContext } {
  if (!module) throw new JinjaError("Jinja is not initialized: await initJinja() before rendering", "internal");
  if (live) return live;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const ctx = runtime.newContext();
  const boot = ctx.evalCode(`${NUNJUCKS_SOURCE}\n;${GUEST_PRELUDE}`, "atlcli:jinja", { type: "global" });
  if (boot.error) {
    const detail = ctx.dump(boot.error);
    boot.error.dispose();
    ctx.dispose();
    runtime.dispose();
    throw new JinjaError(`Jinja failed to start: ${JSON.stringify(detail)}`, "internal");
  }
  boot.value.dispose();
  live = { runtime, ctx };
  return live;
}

function reset(): void {
  const old = live;
  live = undefined;
  try {
    old?.ctx.dispose();
    old?.runtime.dispose();
  } catch {
    // ponytail: QuickJS may assert on teardown after an OOM; the next render starts a fresh runtime.
  }
}

/** One call into the guest with a JSON payload; returns the guest's parsed JSON answer. */
export function callGuest<T>(payload: unknown, limits: JinjaLimits = DEFAULT_JINJA_LIMITS): T {
  const { runtime, ctx } = context(limits);
  const deadline = Date.now() + limits.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  ctx.newString(JSON.stringify(payload)).consume((h) => ctx.setProp(ctx.global, "__atlcliPayload", h));
  const result = ctx.evalCode("__atlcliJinja()", "atlcli:jinja-call", { type: "global" });
  if (result.error) {
    const dumped = ctx.dump(result.error) as { message?: string } | string;
    result.error.dispose();
    reset();
    const message = typeof dumped === "object" && dumped ? String(dumped.message ?? "") : String(dumped);
    if (/interrupted/i.test(message)) throw new JinjaError(`Template rendering took longer than ${limits.timeoutMs} ms`, "limit");
    if (/out of memory/i.test(message)) throw new JinjaError("Template rendering used too much memory", "limit");
    throw new JinjaError(`Template engine error: ${message}`, "internal");
  }
  const text = ctx.getString(result.value);
  result.value.dispose();
  return JSON.parse(text) as T;
}
