/**
 * PDF-owned runtime adapters for template authoring.
 *
 * The host-neutral package supplies the workflow. The CLI injects the current
 * PDF catalog/baseline source generator and the real pinned Typst-WASM gate.
 */
import { PdfGeneratedTemplateProofCompiler } from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import type {
  TemplateGeneratedPackCompilerV1,
  TemplateGeneratedPackCompileInputV1,
  TemplateGeneratedPackCompileResultV1,
} from "@atlcli/pdf-template-authoring";
import { loadPdfCompilerAssets } from "./export-pdf-assets.js";

export class CliGeneratedPdfTemplateCompiler
  implements TemplateGeneratedPackCompilerV1
{
  #compiler?: BrowserPdfCompiler;

  async #getCompiler(): Promise<BrowserPdfCompiler> {
    if (this.#compiler) return this.#compiler;
    // The embedded assets: `import.meta.resolve` finds no node_modules inside a
    // `bun build --compile` binary (#274).
    this.#compiler = new BrowserPdfCompiler(await loadPdfCompilerAssets());
    return this.#compiler;
  }

  async compile(
    input: TemplateGeneratedPackCompileInputV1
  ): Promise<TemplateGeneratedPackCompileResultV1> {
    return new PdfGeneratedTemplateProofCompiler(
      await this.#getCompiler()
    ).compile(input);
  }

  async reset(): Promise<void> {
    await this.#compiler?.reset();
    this.#compiler = undefined;
  }
}
