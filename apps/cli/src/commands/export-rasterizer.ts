/**
 * The CLI's mermaid + SVG-attachment rasterizer (spec 005a Node leg / spec 006
 * G4): resvg-wasm plus the diagram fonts, materialized as EMBEDDED assets.
 *
 * The `with { type: "file" }` imports are the load-bearing part. Under
 * `bun run` they resolve to the real files in `node_modules` /
 * `packages/docx/fonts`; under `bun build --compile` (the release binaries
 * that Homebrew installs) each file is embedded into the executable and the
 * import yields its `$bunfs` path. Under a plain `bun build --target bun` dist
 * bundle the import yields a path RELATIVE to the emitted bundle directory
 * (`./asset-<hash>.wasm`) — `readFile` would resolve that against the process
 * CWD and fail. `assetFilePath` anchors relative paths to `import.meta.dir` so
 * all three run modes work (the exact fix spec 008 applied to the typst wasm in
 * `export-pdf-assets.ts`). This is also why the wasm build of resvg was chosen
 * over the napi one, whose per-platform `.node` addons cannot be embedded when
 * cross-compiling every target from one Linux runner.
 *
 * Failure here (however unlikely) must never fail an export: the caller
 * degrades to the spec-004 code-block fallback (or the G4 `image-svg-no-rasterizer`
 * note) — but the underlying error is surfaced via the optional `onError` sink
 * so a packaging regression is debuggable instead of silently swallowed.
 */
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };
import interRegular from "@atlcli/docx/fonts/Inter-Regular.ttf" with { type: "file" };
import interMedium from "@atlcli/docx/fonts/Inter-Medium.ttf" with { type: "file" };
import interSemiBold from "@atlcli/docx/fonts/Inter-SemiBold.ttf" with { type: "file" };
import interBold from "@atlcli/docx/fonts/Inter-Bold.ttf" with { type: "file" };
import interItalic from "@atlcli/docx/fonts/Inter-Italic.ttf" with { type: "file" };
import monoRegular from "@atlcli/docx/fonts/JetBrainsMono-Regular.ttf" with { type: "file" };
import monoBold from "@atlcli/docx/fonts/JetBrainsMono-Bold.ttf" with { type: "file" };
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { SvgRasterizer } from "@atlcli/docx";

/**
 * Resolve a `with { type: "file" }` import path to something `readFile` can open
 * from any CWD. In source runs and `bun build --compile` binaries the path is
 * already absolute (a `node_modules` path or a `$bunfs` path). In a plain
 * `bun build --target bun` dist bundle the import yields a path RELATIVE to the
 * emitted bundle directory; anchoring relative paths to `import.meta.dir` (the
 * bundle's own directory) makes all three modes work. Shared shape with
 * `export-pdf-assets.ts` `assetFilePath` (spec 008 T3.1).
 */
export function assetFilePath(imported: string): string {
  return isAbsolute(imported) ? imported : resolve(import.meta.dir, imported);
}

/**
 * Build the resvg-backed {@link SvgRasterizer} from the embedded assets, or
 * `null` (never a throw) when they can't be loaded — mermaid diagrams then
 * degrade to source code blocks, and SVG attachments to `image-svg-no-rasterizer`,
 * exactly as when no rasterizer exists. The optional `onError` receives the
 * underlying failure message so callers can surface it (e.g. into a cli-note)
 * instead of losing it to the swallow.
 */
export async function buildDiagramRasterizer(
  onError?: (message: string) => void
): Promise<SvgRasterizer | null> {
  try {
    const { resvgSvgRasterizer } = await import("@atlcli/docx");
    const [wasm, ...fonts] = await Promise.all(
      [resvgWasm, interRegular, interMedium, interSemiBold, interBold, interItalic, monoRegular, monoBold].map(
        async (path) => new Uint8Array(await readFile(assetFilePath(path)))
      )
    );
    return resvgSvgRasterizer({ wasm, fonts });
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
    return null;
  }
}
