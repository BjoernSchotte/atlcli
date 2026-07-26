import { getCodeHighlightEngineId } from "@atlcli/code-highlight";
import type { ExportBlock } from "@atlcli/confluence";
import { runExport } from "@atlcli/docx/browser";
import {
  memoryTemplateSource,
  prepareDocxCodeHighlighting,
} from "@atlcli/docx/browser-runtime";
import { DOCX_TEMPLATE_BYTES } from "@atlcli/export-fixtures";
import { sha256Hex } from "./digest.js";
import { MemoryOutputSink } from "./memory-output.js";

const REPRESENTATIVE_CODE = [
  ["ts", "const answer: number = 42;\n\n"],
  ["tsx", "export const App = () => <main>Hello</main>;"],
  ["javascript", "export const answer = 42;"],
  ["jsx", "export const App = () => <main>Hello</main>;"],
  ["json", '{"answer":42}'],
  ["python", "answer: int = 42"],
  ["java", "final int answer = 42;"],
  ["kotlin", "val answer: Int = 42"],
  ["csharp", "var answer = 42;"],
  ["go", "answer := 42"],
  ["rust", "let answer: i32 = 42;"],
  ["c", "int answer = 42;"],
  ["cpp", "const int answer = 42;"],
  ["php", "<?php $answer = 42;"],
  ["ruby", "answer = 42"],
  ["shellscript", "answer=42"],
  ["sql", "SELECT 42 AS answer;"],
  ["yaml", "answer: 42"],
  ["html", "<main>Hello</main>"],
  ["xml", "<answer>42</answer>"],
  ["css", "main { color: red; }"],
  ["markdown", "# Answer\n\n42"],
] as const;

const HIGHLIGHT_BLOCKS: ExportBlock[] = REPRESENTATIVE_CODE.map(
  ([language, code]) => ({ type: "codeBlock", language, code }),
);

export interface HighlightBenchmarkResult {
  engine: string | null;
  preloadMs: number;
  exportMs: number;
  digest: string;
  byteLength: number;
  base64: string;
  timings: {
    highlightEngineInitMs: number;
    highlightGrammarLoadMs: number;
    highlightTokenizeMs: number;
    highlightCodeBlocks: number;
    highlightLanguageCount: number;
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function runHighlightBenchmark(
  preload: boolean,
): Promise<HighlightBenchmarkResult> {
  const preloadStartedAt = performance.now();
  if (preload) await prepareDocxCodeHighlighting(HIGHLIGHT_BLOCKS);
  const preloadMs = preload ? performance.now() - preloadStartedAt : 0;

  const output = new MemoryOutputSink();
  const exportStartedAt = performance.now();
  const report = await runExport(
    {
      details: {
        id: "highlight-benchmark",
        title: "Highlight benchmark",
        storage: "",
        spaceKey: "DOC",
      },
      blocks: HIGHLIGHT_BLOCKS,
      template: {
        name: "highlight-benchmark.docx",
        modificationDate: new Date("2026-07-26T08:00:00.000Z"),
      },
      exportDate: new Date("2026-07-26T08:00:00.000Z"),
    },
    {
      templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES),
      output,
    },
  );
  const exportMs = performance.now() - exportStartedAt;
  const bytes = output.single.bytes;
  return {
    engine: getCodeHighlightEngineId(),
    preloadMs,
    exportMs,
    digest: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    base64: toBase64(bytes),
    timings: {
      highlightEngineInitMs: report.timings.highlightEngineInitMs ?? 0,
      highlightGrammarLoadMs: report.timings.highlightGrammarLoadMs ?? 0,
      highlightTokenizeMs: report.timings.highlightTokenizeMs ?? 0,
      highlightCodeBlocks: report.timings.highlightCodeBlocks ?? 0,
      highlightLanguageCount: report.timings.highlightLanguageCount ?? 0,
    },
  };
}

declare global {
  interface Window {
    __ATLCLI_DOCX_HIGHLIGHT_BENCHMARK?: (
      preload: boolean,
    ) => Promise<HighlightBenchmarkResult>;
  }
}

window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK = runHighlightBenchmark;
