import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("Node/Bun no-code runtime boundary", () => {
  test("real DOCX and PDF preparation leave the engine uninstalled", () => {
    const stateUrl = pathToFileURL(
      resolve(workspaceRoot, "packages/code-highlight/src/highlight-engine-state.ts"),
    ).href;
    const docxUrl = pathToFileURL(
      resolve(workspaceRoot, "packages/docx/src/index.ts"),
    ).href;
    const pdfUrl = pathToFileURL(
      resolve(workspaceRoot, "packages/pdf/src/index.ts"),
    ).href;
    const source = String.raw`
      import { getCodeHighlightEngineId } from ${JSON.stringify(stateUrl)};
      import { prepareDocxExportRuntime } from ${JSON.stringify(docxUrl)};
      import { preparePdfDocument } from ${JSON.stringify(pdfUrl)};

      if (getCodeHighlightEngineId() !== null) {
        throw new Error("highlighting initialized during package import");
      }

      await prepareDocxExportRuntime([]);
      await preparePdfDocument(
        [{
          type: "paragraph",
          content: [{ type: "text", text: "No highlighted code" }],
        }],
        {
          resolve: async () => {
            throw new Error("the no-code PDF preparation requested an asset");
          },
        },
      );

      if (getCodeHighlightEngineId() !== null) {
        throw new Error("highlighting initialized during no-code preparation");
      }
    `;
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--conditions=development",
        "-e",
        source,
      ],
      cwd: workspaceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(
      result.exitCode,
      new TextDecoder().decode(result.stderr),
    ).toBe(0);
  });
});
