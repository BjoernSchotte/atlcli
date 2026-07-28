/**
 * PDF-owned runtime adapters for template authoring.
 *
 * The host-neutral package supplies the workflow. The CLI injects the current
 * PDF catalog/baseline source generator and the real pinned Typst-WASM gate.
 */
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  PdfGeneratedTemplateProofCompiler,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import type {
  TemplateGeneratedPackCompilerV1,
  TemplateGeneratedPackCompileInputV1,
  TemplateGeneratedPackCompileResultV1,
} from "@atlcli/pdf-template-authoring";
async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer()
  );
}

export class CliGeneratedPdfTemplateCompiler
  implements TemplateGeneratedPackCompilerV1
{
  #compiler?: BrowserPdfCompiler;

  async #getCompiler(): Promise<BrowserPdfCompiler> {
    if (this.#compiler) return this.#compiler;
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
        packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
      ),
    ]);
    this.#compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
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
