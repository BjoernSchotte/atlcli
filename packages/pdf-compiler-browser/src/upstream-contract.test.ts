import { describe, expect, it } from "bun:test";
import type {
  TypstCompiler as UpstreamTypstCompiler,
  TypstCompilerBuilder as UpstreamTypstCompilerBuilder,
} from "@myriaddreamin/typst-ts-web-compiler";

/** The generated fork declarations must structurally satisfy every member atlcli calls. */
interface AtlcliTypstCompilerContract {
  free(): void;
  reset(): void;
  add_source(path: string, content: string): boolean;
  map_shadow(path: string, content: Uint8Array): boolean;
  reset_shadow(): void;
  get_loaded_fonts(): string[];
  compile(mainFilePath: string, inputs: never[], format: string, diagnosticsFormat: number): unknown;
}

interface AtlcliTypstCompilerBuilderContract {
  free(): void;
  add_raw_font(data: Uint8Array): Promise<void>;
  build(): Promise<AtlcliTypstCompilerContract>;
}

const compilerContract: AtlcliTypstCompilerContract =
  null as unknown as UpstreamTypstCompiler;
const builderContract: AtlcliTypstCompilerBuilderContract =
  null as unknown as UpstreamTypstCompilerBuilder;

describe("generated typst.ts declaration contract", () => {
  it("is checked structurally by TypeScript without replacing upstream declarations", () => {
    expect(compilerContract).toBeNull();
    expect(builderContract).toBeNull();
  });
});
