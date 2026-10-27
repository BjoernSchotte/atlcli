import {
  newQuickJSAsyncWASMModuleFromVariant,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

/**
 * A host capability callable from the guest as `atlcli.<name>(...args)`.
 * Arguments arrive JSON-parsed (never host references); the resolved value is
 * JSON-serialized back into the guest. Validation is the caller's job.
 */
export type HostFunction = (args: unknown[], signal: AbortSignal) => Promise<unknown>;

export interface SandboxLimits {
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** QuickJS native stack limit. */
  stackBytes: number;
  /** Wall-clock budget for the whole run, CPU and awaiting included; `Infinity` for none. */
  deadlineMs: number;
  /** Per host call; the interrupt handler cannot fire while the guest awaits the host. */
  hostCallTimeoutMs: number;
  /** Total host calls per run; `Infinity` for none. */
  maxHostCalls: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  deadlineMs: 60 * 60_000,
  hostCallTimeoutMs: 60_000,
  maxHostCalls: 100_000,
};

export type SandboxLogLevel = "info" | "warn" | "error";

export interface RunScriptOptions {
  /** Keyed by dotted guest path, e.g. `"jira.search"` → `atlcli.jira.search`. */
  host?: Readonly<Record<string, HostFunction>>;
  /**
   * Guest-side wrappers, keyed like `host`: JS source of a function that takes
   * the raw bridged function and returns what the script sees (e.g. an async
   * generator over a paged host call). Trusted code, evaluated before the script.
   */
  wrappers?: Readonly<Record<string, string>>;
  /**
   * Further modules the script may import, by path relative to its directory
   * (`"lib/util.ts"`), already stripped of types. Without it any import fails.
   */
  modules?: Readonly<Record<string, string>>;
  /** JSON object exposed as frozen `atlcli.params` and passed to a default-export function. */
  params?: Readonly<Record<string, unknown>>;
  /**
   * Per-item mode: the default export must be a function and is called as
   * `default(item, params)` (e.g. one Jira issue of `script run --each`).
   */
  item?: unknown;
  /**
   * Batch mode: the export is called once per item in one runtime; the run's
   * value is the array of results. Takes precedence over `item`.
   */
  items?: unknown[];
  /** The export to call in item and batch mode (default `default`), e.g. `fix` or `report`. */
  entry?: string;
  /**
   * Trusted guest code evaluated before the script (after `atlcli` exists). It
   * may set `globalThis.__atlcliArgs = (item, params) => [...]` to shape the
   * arguments each item call gets (default: `[item, params]`), and
   * `globalThis.__atlcliAfter = async (result) => …` to replace the result
   * once the entry returned (the audit report closes its output there).
   */
  prelude?: string;
  limits?: Partial<SandboxLimits>;
  onLog?: (level: SandboxLogLevel, message: string) => void;
  /** Override the WASM build (tests use the sync debug build for leak detection). */
  variant?: QuickJSVariant;
}

export interface RunScriptResult {
  /**
   * JSON-roundtripped result: what a default-export function returns, else the
   * default export's value, else `null` (a plain top-level script).
   */
  value: unknown;
  hostCalls: number;
}

export type ScriptErrorKind =
  | "guest" // the script threw
  | "interrupted" // CPU deadline hit inside the guest
  | "memory"
  | "deadline" // wall-clock deadline hit while awaiting
  | "host-call-limit"
  | "invalid-script"
  | "permission-denied"
  | "write-limit"
  | "template"; // atlcli.render failed (--strict, output limit)

/** A host function rejecting with a ScriptError ends the whole run with it. */
export class ScriptError extends Error {
  constructor(
    readonly kind: ScriptErrorKind,
    message: string,
    readonly guestStack?: string,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

/** Module name of the script itself; imports from it resolve against the script's directory. */
export const SCRIPT_MODULE = "script";
const UNRESOLVED = "atlcli:unresolved:";

/**
 * Paths a relative import may name, in lookup order, relative to the
 * script's directory (`"lib/util.ts"`). Only relative imports are allowed:
 * no packages, no Node built-ins, nothing outside the script's directory.
 */
export function moduleCandidates(base: string, requested: string): string[] | Error {
  if (!requested.startsWith("./") && !requested.startsWith("../")) {
    return new Error(`Imports are not allowed in scripts except relative files: ${requested}`);
  }
  const parts = base === SCRIPT_MODULE || !base.includes("/") ? [] : base.split("/").slice(0, -1);
  for (const segment of requested.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (parts.length === 0) return new Error(`Import leaves the script's directory: ${requested}`);
      parts.pop();
    } else parts.push(segment);
  }
  const path = parts.join("/");
  return [...new Set([path, `${path}.ts`, `${path}.js`, path.replace(/\.js$/, ".ts"), `${path}/index.ts`, `${path}/index.js`])];
}

/** Resolves a guest import against the module map. */
export function resolveModule(base: string, requested: string, modules: Readonly<Record<string, string>>): string | Error {
  if (requested === SCRIPT_MODULE) return requested;
  const candidates = moduleCandidates(base, requested);
  if (candidates instanceof Error) return candidates;
  return candidates.find((c) => Object.hasOwn(modules, c)) ?? new Error(`Cannot find module ${requested} (imported from ${base === SCRIPT_MODULE ? "the script" : base})`);
}

const HOST_NAME = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

// Raw bridges are captured in closures and removed from globalThis before user
// code runs: `h(name, argsJson) → Promise<json>`, `l(level, text)` and, in the
// entry, `done(ok, payload)`. Everything crossing them is a string. JSON is
// captured too, so a script overriding globals only breaks itself.
const PRELUDE = `
const h = globalThis.__atlcliHost, l = globalThis.__atlcliLog, names = globalThis.__atlcliNames, wrappers = globalThis.__atlcliWrappers, params = globalThis.__atlcliParams;
const { parse, stringify } = JSON;
delete globalThis.__atlcliHost; delete globalThis.__atlcliLog; delete globalThis.__atlcliNames; delete globalThis.__atlcliWrappers; delete globalThis.__atlcliParams;
const wrap = parse(wrappers);
const fmt = (v) => typeof v === "string" ? v : (() => { try { return stringify(v); } catch { return String(v); } })();
const say = (level) => (...a) => l(level, a.map(fmt).join(" "));
globalThis.console = Object.freeze({ log: say("info"), info: say("info"), warn: say("warn"), error: say("error") });
const root = Object.create(null);
for (const name of parse(names)) {
  const parts = name.split(".");
  let node = root;
  for (const p of parts.slice(0, -1)) node = node[p] ??= Object.create(null);
  const raw = (...args) => h(name, stringify(args)).then(parse, (json) => {
    const { name: errorName, message } = parse(json);
    const error = new Error(message);
    error.name = errorName;
    // An explicit stack sidesteps a quickjs-ng debug-build leak seen when the
    // lazily captured stack of an error made inside a promise job is consumed.
    error.stack = errorName + ": " + message + "\\n    at atlcli." + name + "\\n";
    throw error;
  });
  node[parts.at(-1)] = wrap[name] ? (0, eval)("(" + wrap[name] + ")")(raw) : raw;
}
root.params = parse(params);
const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") freeze(v); return Object.freeze(o); };
Object.defineProperty(globalThis, "atlcli", { value: freeze(root), writable: false, configurable: false, enumerable: false });
`;

// Only the API both module kinds share is used (no asyncified host functions),
// so sync and asyncify builds behave alike.
let defaultModule: Promise<QuickJSWASMModule> | undefined;
let defaultWasmBinary: (() => Promise<ArrayBuffer>) | undefined;
const variantModules = new WeakMap<QuickJSVariant, Promise<QuickJSWASMModule>>();

const fromVariant = (variant: QuickJSVariant): Promise<QuickJSWASMModule> =>
  variant.type === "async"
    ? (newQuickJSAsyncWASMModuleFromVariant(variant) as Promise<unknown> as Promise<QuickJSWASMModule>)
    : newQuickJSWASMModuleFromVariant(variant);

function loadModule(variant?: QuickJSVariant): Promise<QuickJSWASMModule> {
  if (!variant) {
    // The engine swap point. The CLI ships this build's WASM (beside its dist
    // bundle, or embedded and handed over via setDefaultQuickJsWasmBinary; see
    // apps/cli/src/quickjs-wasm.ts), and quickjs-ng has no single-file build,
    // so sync and asyncify cannot both ship.
    defaultModule ??= import("@jitl/quickjs-ng-wasmfile-release-asyncify").then((v) =>
      fromVariant(defaultWasmBinary ? newVariant(v.default, { wasmBinary: defaultWasmBinary }) : v.default),
    );
    return defaultModule;
  }
  let module = variantModules.get(variant);
  if (!module) {
    module = fromVariant(variant);
    variantModules.set(variant, module);
  }
  return module;
}

/**
 * Supplies the default build's WASM bytes instead of the file the loader reads
 * beside the bundle. A compiled CLI binary embeds the WASM under its own path,
 * so it must hand the bytes over (see apps/cli/src/quickjs-wasm.ts). Pass
 * `undefined` to return to the loader's lookup. Runs with an explicit
 * `variant` are unaffected.
 */
export function setDefaultQuickJsWasmBinary(load: (() => Promise<ArrayBuffer>) | undefined): void {
  defaultWasmBinary = load;
  defaultModule = undefined;
}

function forgetModule(variant?: QuickJSVariant): void {
  if (variant) variantModules.delete(variant);
  else defaultModule = undefined;
}

/**
 * Run an ES module (already stripped of types). The module body is the script:
 * top-level `await` and `atlcli.*` work directly; a default-export function, if
 * present, is called with `params` afterwards. One QuickJS runtime per run,
 * always disposed. The guest has no fetch, no imports and no host references,
 * only the frozen `atlcli` namespace.
 */
export async function runScript(js: string, options: RunScriptOptions = {}): Promise<RunScriptResult> {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...options.limits };
  const host = options.host ?? {};
  const wrappers = options.wrappers ?? {};
  for (const name of [...Object.keys(host), ...Object.keys(wrappers)]) {
    if (!HOST_NAME.test(name)) throw new TypeError(`Invalid host function name: ${name}`);
  }
  for (const name of Object.keys(wrappers)) {
    if (!Object.hasOwn(host, name)) throw new TypeError(`Wrapper without host function: ${name}`);
  }
  const quickjs = await loadModule(options.variant);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const deadline = Date.now() + limits.deadlineMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const modules = options.modules ?? {};
  // A normalizer failure loses its message on the way through QuickJS, so it
  // resolves to a name the loader turns back into the error.
  runtime.setModuleLoader(
    (name) => {
      if (name === SCRIPT_MODULE) return js;
      if (name.startsWith(UNRESOLVED)) return { error: new Error(name.slice(UNRESOLVED.length)) };
      return Object.hasOwn(modules, name) ? modules[name]! : { error: new Error(`Cannot find module ${name}`) };
    },
    (base, requested) => {
      const resolved = resolveModule(base, requested, modules);
      return typeof resolved === "string" ? resolved : `${UNRESOLVED}${resolved.message}`;
    },
  );

  const ctx = runtime.newContext();
  const abort = new AbortController();
  const pending = new Set<QuickJSDeferredPromise>();
  let disposed = false;
  let hostCalls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The guest reports its outcome through a synchronous `done` bridge rather
  // than ctx.resolvePromise: that keeps no long-lived host handles, so an early
  // exit (limit, deadline) can always dispose the runtime cleanly. Fatal errors
  // win even if the guest catches the error it was shown.
  let resolveRun!: (json: string) => void;
  let rejectRun!: (error: ScriptError) => void;
  const outcome = new Promise<string>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  let failure: ScriptError | undefined;
  const fail = (error: ScriptError) => {
    failure ??= error;
    rejectRun(error);
  };

  const pump = () => {
    if (disposed) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      const error = toScriptError(ctx, jobs.error);
      jobs.error.dispose();
      fail(error);
    }
  };

  const settle = (deferred: QuickJSDeferredPromise, apply: () => void) => {
    pending.delete(deferred);
    if (disposed) return;
    apply();
    deferred.dispose();
    pump();
  };

  const define = (name: string, fn: Parameters<QuickJSContext["newFunction"]>[1]) =>
    ctx.newFunction(name, fn).consume((handle) => ctx.setProp(ctx.global, name, handle));

  try {
    define("__atlcliHost", (nameHandle, argsHandle) => {
      const name = ctx.getString(nameHandle);
      const fn = Object.hasOwn(host, name) ? host[name] : undefined;
      if (!fn) return { error: ctx.newError(`Unknown host function: ${name}`) };
      if (++hostCalls > limits.maxHostCalls) {
        const error = new ScriptError("host-call-limit", `Host call limit exceeded (${limits.maxHostCalls})`);
        fail(error);
        return { error: ctx.newError(error.message) };
      }
      const args = JSON.parse(ctx.getString(argsHandle)) as unknown[];
      const deferred = ctx.newPromise();
      pending.add(deferred);
      callWithTimeout(fn, args, abort.signal, limits.hostCallTimeoutMs).then(
        // resolve/reject do not take ownership of the value handle.
        (value) =>
          settle(deferred, () => ctx.newString(JSON.stringify(value ?? null)).consume((h) => deferred.resolve(h))),
        (error: unknown) => {
          if (error instanceof ScriptError) fail(error);
          settle(deferred, () => ctx.newString(guestErrorJson(error)).consume((h) => deferred.reject(h)));
        },
      );
      return deferred.handle;
    });
    define("__atlcliLog", (levelHandle, textHandle) => {
      options.onLog?.(ctx.getString(levelHandle) as SandboxLogLevel, ctx.getString(textHandle));
    });
    define("__atlcliDone", (okHandle, payloadHandle) => {
      if (ctx.dump(okHandle) === true) resolveRun(ctx.getString(payloadHandle));
      else fail(toScriptError(ctx, payloadHandle));
    });
    ctx.newString(JSON.stringify(Object.keys(host))).consume((names) =>
      ctx.setProp(ctx.global, "__atlcliNames", names),
    );
    ctx.newString(JSON.stringify(wrappers)).consume((w) => ctx.setProp(ctx.global, "__atlcliWrappers", w));
    ctx.newString(JSON.stringify(options.params ?? {})).consume((p) => ctx.setProp(ctx.global, "__atlcliParams", p));
    if (options.items !== undefined) {
      ctx.newString(JSON.stringify(options.items)).consume((i) => ctx.setProp(ctx.global, "__atlcliItems", i));
    } else if (options.item !== undefined) {
      ctx.newString(JSON.stringify(options.item)).consume((i) => ctx.setProp(ctx.global, "__atlcliItem", i));
    }
    if (options.prelude) {
      const pre = ctx.evalCode(options.prelude, "atlcli:host-prelude", { type: "global" });
      if (pre.error) {
        const error = toScriptError(ctx, pre.error);
        pre.error.dispose();
        throw error;
      }
      pre.value.dispose();
    }

    // The CPU deadline also covers the prelude: under load a tiny deadline can
    // interrupt it, which must surface as a ScriptError, not a raw QuickJS error.
    const prelude = ctx.evalCode(PRELUDE, "atlcli:prelude", { type: "global" });
    if (prelude.error) {
      const error = toScriptError(ctx, prelude.error);
      prelude.error.dispose();
      throw error;
    }
    prelude.value.dispose();

    const entryName = JSON.stringify(options.entry ?? "default");
    const entry = `(async () => {
  const done = globalThis.__atlcliDone, { stringify, parse } = JSON, item = globalThis.__atlcliItem, items = globalThis.__atlcliItems;
  const argsFor = globalThis.__atlcliArgs || ((it, params) => [it, params]), after = globalThis.__atlcliAfter;
  delete globalThis.__atlcliDone; delete globalThis.__atlcliItem; delete globalThis.__atlcliItems; delete globalThis.__atlcliArgs; delete globalThis.__atlcliAfter;
  try {
    const m = await import(${JSON.stringify(SCRIPT_MODULE)});
    const fn = m[${entryName}];
    const perItem = item !== undefined || items !== undefined;
    if (perItem && typeof fn !== "function") {
      throw new SyntaxError(${JSON.stringify(
        (options.entry ?? "default") === "default"
          ? "In per-issue mode (--each) the script must export a function: export default async (issue) => { … }"
          : `The script does not export a function "${options.entry}"`,
      )});
    }
    let r;
    if (items !== undefined) {
      r = [];
      for (const it of parse(items)) r.push(await fn(...argsFor(it, atlcli.params)));
    } else if (item !== undefined) {
      r = await fn(...argsFor(parse(item), atlcli.params));
    } else {
      r = typeof fn === "function" ? await fn(atlcli.params) : fn;
    }
    if (after) r = await after(r);
    done(true, stringify(r === undefined ? null : r) ?? "null");
  } catch (e) { done(false, e); }
})();`;
    // setTimeout treats Infinity (no deadline) as 0, so only finite deadlines arm it.
    if (Number.isFinite(limits.deadlineMs)) {
      timer = setTimeout(
        () => fail(new ScriptError("deadline", `Script deadline exceeded (${limits.deadlineMs} ms)`)),
        limits.deadlineMs,
      );
    }
    const evaluated = ctx.evalCode(entry, "atlcli:entry", { type: "global" });
    if (evaluated.error) {
      const error = toScriptError(ctx, evaluated.error);
      evaluated.error.dispose();
      fail(error);
    } else {
      evaluated.value.dispose();
    }
    pump();
    return { value: JSON.parse(await outcome), hostCalls };
  } finally {
    clearTimeout(timer);
    abort.abort();
    disposed = true;
    for (const deferred of pending) deferred.dispose();
    // ponytail: after an out-of-memory error QuickJS cannot always free its heap
    // cleanly, so the whole WASM instance is dropped and the next run starts fresh.
    // Finer-grained recovery is only worth it if OOM runs become frequent.
    if (failure?.kind === "memory") forgetModule(options.variant);
    try {
      ctx.dispose();
      runtime.dispose();
    } catch (error) {
      forgetModule(options.variant);
      if (failure?.kind !== "memory" && !isTeardownLeak(error)) throw error;
      if (failure?.kind !== "memory") teardownLeaks++;
    }
  }
}

/**
 * QuickJS checks at runtime teardown that no object is left
 * (`list_empty(&rt->gc_obj_list)`). That check fails, with both QuickJS and
 * quickjs-ng 0.32 under quickjs-emscripten, once a garbage collection ran
 * while an async function was resumed, e.g. a script that collects a few
 * hundred thousand objects after its first `await`. The run itself finished;
 * dropping the WASM instance frees everything it held.
 *
 * ponytail: tolerated rather than fixed upstream; the count lets tests tell
 * this from a handle the bridge forgot to dispose. Revisit on a
 * quickjs-emscripten upgrade.
 */
let teardownLeaks = 0;

/** Runs whose teardown hit the QuickJS leak check (tests only). */
export function teardownLeakCount(): number {
  return teardownLeaks;
}

function isTeardownLeak(error: unknown): boolean {
  return error instanceof Error && error.message.includes("list_empty(&rt->gc_obj_list)");
}

async function callWithTimeout(
  fn: HostFunction,
  args: unknown[],
  runSignal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const call = new AbortController();
  const onAbort = () => call.abort(runSignal.reason);
  runSignal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(args, call.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Host call timed out after ${timeoutMs} ms`);
          reject(error); // before abort, so a host that settles on abort cannot win the race
          call.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    runSignal.removeEventListener("abort", onAbort);
  }
}

/**
 * Host errors cross as a JSON string of name + message; the prelude rebuilds a
 * guest Error. Host stacks never reach the guest, and no host-made error object
 * lives in the guest heap.
 */
function guestErrorJson(error: unknown): string {
  const e = error instanceof Error ? error : new Error(String(error));
  return JSON.stringify({ name: e.name, message: e.message });
}

function toScriptError(ctx: QuickJSContext, handle: QuickJSHandle): ScriptError {
  const dumped = ctx.dump(handle) as { name?: string; message?: string; stack?: string } | string;
  const name = typeof dumped === "object" && dumped ? dumped.name : undefined;
  const message = typeof dumped === "object" && dumped ? String(dumped.message ?? dumped) : String(dumped);
  const stack = typeof dumped === "object" && dumped ? dumped.stack : undefined;
  if (name === "InternalError" && message === "interrupted") {
    return new ScriptError("interrupted", "Script interrupted: CPU deadline exceeded");
  }
  if (name === "InternalError" && /out of memory/i.test(message)) {
    return new ScriptError("memory", "Script exceeded its memory limit");
  }
  if (/Imports are not allowed in scripts|Cannot find module|Import leaves the script's directory/.test(message) || name === "SyntaxError") {
    return new ScriptError("invalid-script", message, stack);
  }
  return new ScriptError("guest", name ? `${name}: ${message}` : message, stack);
}
