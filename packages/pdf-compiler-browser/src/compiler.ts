/// <reference path="./vendor.d.ts" />

// The VENDORED, CSP-patched glue (spec 009 Special cases): a package
// self-reference so the same specifier works from workspace source, from
// dist, and inside packed tarballs (see exports "./vendor/*").
import initTypst, {
  TypstCompilerBuilder,
  type TypstCompiler,
} from "@atlcli/pdf-compiler-browser/vendor/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
import {
  PDF_RUNTIME_ASSETS,
  assertResolvedPdfFontRequirementsV1,
  type PdfCompileContext,
  type PdfCompileResult,
  type PdfFontLoadEvidenceV1,
  type PdfSourceBundle,
  type ResolvedPdfFontRequirementsV1,
} from "@atlcli/pdf/browser";
import { mapPdfDiagnostics } from "@atlcli/pdf/internal";

export const PDF_BROWSER_COMPILER_VERSION = "typst.ts 0.7.0 / Typst 0.14.2";

export interface BrowserPdfCompilerFontSourceV1 {
  assetId: string;
  sha256: string;
  load(context?: PdfCompileContext): Promise<Uint8Array> | Uint8Array;
}

export interface BrowserPdfCompilerAssets {
  wasm: ArrayBuffer | URL | Response;
  /**
   * Legacy byte arrays retain full-bundle behavior. Demand-aware hosts provide
   * byte-free loaders for every statically bundled font; only the requirement
   * subset is invoked for a compile.
   */
  fonts: readonly Uint8Array[] | readonly BrowserPdfCompilerFontSourceV1[];
}

const MEMORY_PROBE_AFTER_VFS_LOADED = Symbol.for(
  "atlcli.pdf-compiler-browser.memory-probe.after-vfs-loaded"
);
const MEMORY_PROBE_REGISTER_WASM_MEMORY = Symbol.for(
  "atlcli.pdf-compiler-browser.memory-probe.register-wasm-memory"
);

interface MemoryProbeHost {
  [MEMORY_PROBE_AFTER_VFS_LOADED]?: () => void | Promise<void>;
  [MEMORY_PROBE_REGISTER_WASM_MEMORY]?: (memory: WebAssembly.Memory) => void;
}

interface RawPdfDiagnostic {
  package?: string;
  path?: string;
  severity?: string;
  range?: string;
  message: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("PDF compilation was cancelled.", "AbortError");
  }
}

function isFontSource(
  value: Uint8Array | BrowserPdfCompilerFontSourceV1,
): value is BrowserPdfCompilerFontSourceV1 {
  return !(value instanceof Uint8Array);
}

interface CompilerSelection {
  key: string;
  registeredAssetIds: string[];
  fullBundleFallback: boolean;
  load(context?: PdfCompileContext): Promise<Uint8Array[]>;
}

let globalCompilerTail: Promise<void> = Promise.resolve();
let globalCompilerOwner: BrowserPdfCompiler | null = null;

function runWithGlobalCompilerLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = globalCompilerTail.then(operation);
  globalCompilerTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Version-pinned, browser-only adapter around typst.ts. */
export class BrowserPdfCompiler {
  readonly version = PDF_BROWSER_COMPILER_VERSION;
  private compiler: TypstCompiler | null = null;
  private compilerKey: string | null = null;
  private registeredAssetIds: string[] = [];
  private initPromise: Promise<TypstCompiler> | null = null;
  private runtimePromise: ReturnType<typeof initTypst> | null = null;
  private compileTail: Promise<void> = Promise.resolve();

  constructor(private readonly assets: BrowserPdfCompilerAssets) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.compileTail.then(() =>
      runWithGlobalCompilerLock(operation)
    );
    this.compileTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private claimGlobalCompiler(): void {
    if (globalCompilerOwner === this) return;
    globalCompilerOwner?.dropCompiler();
    globalCompilerOwner = this;
  }

  private selection(
    requirements: ResolvedPdfFontRequirementsV1 | undefined,
  ): CompilerSelection {
    const entries = this.assets.fonts;
    const sourceFlags = entries.map(isFontSource);
    if (sourceFlags.some(Boolean) && sourceFlags.some((value) => !value)) {
      throw new Error(
        "BrowserPdfCompiler font assets must be all byte arrays or all demand-aware sources.",
      );
    }
    if (!sourceFlags.some(Boolean)) {
      const fonts = entries as readonly Uint8Array[];
      return {
        key: `legacy-full-bundle/${fonts.length}`,
        registeredAssetIds: PDF_RUNTIME_ASSETS.fonts
          .slice(0, fonts.length)
          .map((font) => font.assetId),
        fullBundleFallback: true,
        load: async (context) => {
          throwIfAborted(context?.signal);
          return [...fonts];
        },
      };
    }

    const sources = entries as readonly BrowserPdfCompilerFontSourceV1[];
    const byId = new Map<string, BrowserPdfCompilerFontSourceV1>();
    for (const source of sources) {
      if (byId.has(source.assetId)) {
        throw new Error(`Duplicate PDF compiler font source ${source.assetId}.`);
      }
      byId.set(source.assetId, source);
    }
    const selectedRequirements = requirements?.assets ??
      PDF_RUNTIME_ASSETS.fonts.map((font) => ({
        assetId: font.assetId,
        sha256: font.sha256,
      }));
    if (requirements) assertResolvedPdfFontRequirementsV1(requirements);
    const selected = selectedRequirements.map((requirement) => {
      const source = byId.get(requirement.assetId);
      if (!source) {
        throw new Error(
          `PDF compiler font source is missing ${requirement.assetId}.`,
        );
      }
      if (source.sha256 !== requirement.sha256) {
        throw new Error(
          `PDF compiler font source ${requirement.assetId} does not match the required SHA-256.`,
        );
      }
      return source;
    });
    const key = requirements?.key ??
      `legacy-full-bundle/${selected.map((source) => source.assetId).join("|")}`;
    return {
      key,
      registeredAssetIds: selected.map((source) => source.assetId),
      fullBundleFallback: requirements === undefined,
      load: async (context) => {
        throwIfAborted(context?.signal);
        const fonts = await Promise.all(
          selected.map(async (source) => {
            const bytes = await source.load(context);
            throwIfAborted(context?.signal);
            return bytes;
          }),
        );
        return fonts;
      },
    };
  }

  private initialize(
    selection: CompilerSelection,
    context?: PdfCompileContext,
  ): Promise<TypstCompiler> {
    if (this.compiler && this.compilerKey === selection.key) {
      return Promise.resolve(this.compiler);
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      throwIfAborted(context?.signal);
      if (this.compiler) this.dropCompiler();
      const fonts = await selection.load(context);
      throwIfAborted(context?.signal);
      this.runtimePromise ??= initTypst({ module_or_path: this.assets.wasm });
      const runtime = await this.runtimePromise;
      throwIfAborted(context?.signal);
      // Same Symbol.for pattern as the after-vfs-loaded probe: the Chrome/V8
      // harness registers here to read WASM linear-memory high-water for the
      // host-versus-WASM attribution gate (specs/issue-118). Production hosts
      // never install the hook and the public API stays unchanged.
      const registerMemory = (globalThis as MemoryProbeHost)[MEMORY_PROBE_REGISTER_WASM_MEMORY];
      if (registerMemory) registerMemory(runtime.memory);
      const builder = new TypstCompilerBuilder();
      for (const font of fonts) {
        throwIfAborted(context?.signal);
        await builder.add_raw_font(font);
      }
      const compiler = await builder.build();
      this.compiler = compiler;
      this.compilerKey = selection.key;
      this.registeredAssetIds = [...selection.registeredAssetIds];
      throwIfAborted(context?.signal);
      return compiler;
    })().catch((error) => {
      this.initPromise = null;
      this.dropCompiler();
      throw error;
    }).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async compileExclusive(
    bundle: PdfSourceBundle,
    context: PdfCompileContext,
  ): Promise<PdfCompileResult> {
    throwIfAborted(context.signal);
    const selection = this.selection(bundle.fontRequirements);
    this.claimGlobalCompiler();
    const compiler = await this.initialize(selection, context);
    throwIfAborted(context.signal);
    compiler.reset_shadow();
    try {
      compiler.add_source("/main.typ", bundle.main);
      compiler.add_source("/atlcli.typ", bundle.template);
      for (const asset of bundle.assets) compiler.map_shadow(`/${asset.path}`, asset.bytes);
      // The Symbol.for hook keeps benchmark instrumentation out of the public
      // package API. Normal hosts never install it; the Chrome/V8 harness
      // pauses here to sample the otherwise-unobservable Typst VFS peak.
      const memoryProbe = (globalThis as MemoryProbeHost)[MEMORY_PROBE_AFTER_VFS_LOADED];
      // Do not `await undefined`: production must not gain a microtask yield
      // between VFS population and compile, because typst.ts' access model is
      // process-global and another compiler instance could interleave there.
      if (memoryProbe) await memoryProbe();
      const result = compiler.compile("/main.typ", [], "pdf", 3) as {
        result?: Uint8Array;
        diagnostics?: RawPdfDiagnostic[];
      };
      const diagnostics = mapPdfDiagnostics(
        (result.diagnostics ?? []).map((diagnostic) => {
          const range = diagnostic.range?.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
          return {
            severity: diagnostic.severity,
            message: diagnostic.message,
            path: diagnostic.path,
            line: range ? Number(range[1]) + 1 : undefined,
            column: range ? Number(range[2]) : undefined,
            endLine: range ? Number(range[3]) + 1 : undefined,
            endColumn: range ? Number(range[4]) : undefined,
          };
        }),
        bundle.sourceMap
      );
      const fontEvidence: PdfFontLoadEvidenceV1 = {
        schema: "atlcli.pdf-font-load-evidence/1",
        requirementKey: selection.key,
        registeredAssetIds: [...this.registeredAssetIds],
        loadedFontNames: await compiler.get_loaded_fonts(),
        fullBundleFallback: selection.fullBundleFallback,
      };
      return {
        pdf: result.result,
        diagnostics,
        compilerVersion: this.version,
        fontEvidence,
      };
    } finally {
      compiler.reset_shadow();
    }
  }

  compile(
    bundle: PdfSourceBundle,
    context: PdfCompileContext = {},
  ): Promise<PdfCompileResult> {
    return this.enqueue(() => this.compileExclusive(bundle, context));
  }

  getLoadedFonts(): Promise<string[]> {
    return this.enqueue(async () => {
      this.claimGlobalCompiler();
      if (this.compiler) return this.compiler.get_loaded_fonts();
      return (
        await this.initialize(this.selection(undefined))
      ).get_loaded_fonts();
    });
  }

  getRegisteredFontAssetIds(): readonly string[] {
    return [...this.registeredAssetIds];
  }

  private dropCompiler(): void {
    const compiler = this.compiler;
    this.compiler = null;
    this.compilerKey = null;
    this.registeredAssetIds = [];
    if (compiler) {
      compiler.reset();
      compiler.free();
    }
  }

  reset(): Promise<void> {
    return this.enqueue(async () => {
      this.initPromise = null;
      this.runtimePromise = null;
      this.dropCompiler();
      if (globalCompilerOwner === this) globalCompilerOwner = null;
    });
  }
}
