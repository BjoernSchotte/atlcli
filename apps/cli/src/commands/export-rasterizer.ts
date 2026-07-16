/**
 * The CLI's mermaid rasterizer (spec 005a, Node leg): resvg-wasm plus the
 * diagram fonts, materialized as EMBEDDED assets.
 *
 * The `with { type: "file" }` imports are the load-bearing part. Under
 * `bun run` they resolve to the real files in `node_modules` /
 * `packages/docx/fonts`; under `bun build --compile` (the release binaries
 * that Homebrew installs) each file is embedded into the executable and the
 * import yields its `$bunfs` path. Either way `readFile` works and the CLI
 * renders diagrams with zero runtime dependencies — this is why the wasm
 * build of resvg was chosen over the napi one, whose per-platform `.node`
 * addons cannot be embedded when cross-compiling every target from one
 * Linux runner.
 *
 * Failure here (however unlikely) must never fail an export: the caller
 * degrades to the spec-004 code-block fallback with a note.
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
import type { SvgRasterizer } from "@atlcli/docx";

/**
 * Build the resvg-backed {@link SvgRasterizer} from the embedded assets, or
 * `null` (never a throw) when they can't be loaded — mermaid diagrams then
 * degrade to source code blocks exactly as when no rasterizer exists.
 */
export async function buildDiagramRasterizer(): Promise<SvgRasterizer | null> {
  try {
    const { resvgSvgRasterizer } = await import("@atlcli/docx");
    const [wasm, ...fonts] = await Promise.all(
      [resvgWasm, interRegular, interMedium, interSemiBold, interBold, interItalic, monoRegular, monoBold].map(
        async (path) => new Uint8Array(await readFile(path))
      )
    );
    return resvgSvgRasterizer({ wasm, fonts });
  } catch {
    return null;
  }
}
