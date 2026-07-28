import {
  getCodeHighlightEngineId,
  prepareCodeHighlighting,
  type CodeThemeId,
} from "@atlcli/code-highlight";
import type { ExportBlock } from "@atlcli/confluence";
import {
  memoryTemplateSource,
  prepareDocxExportRuntime,
  runExport,
} from "@atlcli/docx/browser-entry";
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

const FLAT_HIGHLIGHT_BLOCKS: ExportBlock[] = REPRESENTATIVE_CODE.map(
  ([language, code]) => ({ type: "codeBlock", language, code }),
);
const HIGHLIGHT_BLOCKS: ExportBlock[] = [
  {
    type: "callout",
    kind: "info",
    content: [FLAT_HIGHLIGHT_BLOCKS[0]!],
  },
  {
    type: "table",
    rows: [{
      cells: [{
        header: false,
        colspan: 1,
        rowspan: 1,
        content: [FLAT_HIGHLIGHT_BLOCKS[1]!],
      }],
    }],
  },
  {
    type: "paragraph",
    content: [{
      type: "text",
      text: "Inline code also needs the bundled face: INLINE_TOKEN",
      marks: ["code"],
    }],
  },
  ...FLAT_HIGHLIGHT_BLOCKS.slice(2),
];

export interface HighlightBenchmarkResult {
  engine: string | null;
  preloadMs: number;
  exportMs: number;
  preparation: Awaited<ReturnType<typeof prepareDocxExportRuntime>> | null;
  phases: {
    intentStartedAt: number;
    entryReadyAt: number;
    preloadStartedAt: number;
    preloadEndedAt: number;
    exportStartedAt: number;
    exportEndedAt: number;
  };
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

export interface RuntimePreparationBenchmarkResult {
  cold: Awaited<ReturnType<typeof prepareDocxExportRuntime>>;
  warm: Awaited<ReturnType<typeof prepareDocxExportRuntime>>;
  coldMs: number;
  warmMs: number;
  sampledPeakJsHeapBytes: number;
  phases: {
    coldStartedAt: number;
    coldEndedAt: number;
    warmStartedAt: number;
    warmEndedAt: number;
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
  const preparation = preload
    ? await prepareDocxExportRuntime(HIGHLIGHT_BLOCKS, {
        preloadCodeFont: true,
      })
    : null;
  const preloadEndedAt = performance.now();
  const preloadMs = preload ? preloadEndedAt - preloadStartedAt : 0;

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
  const exportEndedAt = performance.now();
  const exportMs = exportEndedAt - exportStartedAt;
  const bytes = output.single.bytes;
  return {
    engine: getCodeHighlightEngineId(),
    preloadMs,
    exportMs,
    preparation,
    phases: {
      intentStartedAt:
        window.__ATLCLI_DOCX_BROWSER_INTENT_STARTED_AT ?? 0,
      entryReadyAt:
        window.__ATLCLI_DOCX_BROWSER_ENTRY_READY_AT ?? 0,
      preloadStartedAt,
      preloadEndedAt,
      exportStartedAt,
      exportEndedAt,
    },
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

function usedJsHeapBytes(): number {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    }
  ).memory;
  return memory?.usedJSHeapSize ?? 0;
}

async function runRuntimePreparationBenchmark(
  preloadCodeFont: boolean,
): Promise<RuntimePreparationBenchmarkResult> {
  let sampledPeakJsHeapBytes = usedJsHeapBytes();
  const sample = (): void => {
    sampledPeakJsHeapBytes = Math.max(sampledPeakJsHeapBytes, usedJsHeapBytes());
  };
  const sampler = setInterval(sample, 1);
  try {
    const coldStartedAt = performance.now();
    const cold = await prepareDocxExportRuntime([], {
      ...(preloadCodeFont ? { preloadCodeFont: true } : {}),
    });
    const coldEndedAt = performance.now();
    const coldMs = coldEndedAt - coldStartedAt;
    sample();
    const warmStartedAt = performance.now();
    const warm = await prepareDocxExportRuntime([], {
      ...(preloadCodeFont ? { preloadCodeFont: true } : {}),
    });
    const warmEndedAt = performance.now();
    const warmMs = warmEndedAt - warmStartedAt;
    sample();
    return {
      cold,
      warm,
      coldMs,
      warmMs,
      sampledPeakJsHeapBytes,
      phases: {
        coldStartedAt,
        coldEndedAt,
        warmStartedAt,
        warmEndedAt,
      },
    };
  } finally {
    clearInterval(sampler);
  }
}

async function prepareHighlightModules(
  languages: readonly string[],
  theme: CodeThemeId,
): Promise<void> {
  await prepareCodeHighlighting(languages, theme);
}

declare global {
  interface Window {
    __ATLCLI_DOCX_BROWSER_INTENT_STARTED_AT?: number;
    __ATLCLI_DOCX_BROWSER_ENTRY_READY_AT?: number;
    __ATLCLI_DOCX_HIGHLIGHT_BENCHMARK?: (
      preload: boolean,
    ) => Promise<HighlightBenchmarkResult>;
    __ATLCLI_DOCX_RUNTIME_PREPARATION_BENCHMARK?: (
      preloadCodeFont: boolean,
    ) => Promise<RuntimePreparationBenchmarkResult>;
    __ATLCLI_PREPARE_CODE_HIGHLIGHTING?: (
      languages: readonly string[],
      theme: CodeThemeId,
    ) => Promise<void>;
  }
}

window.__ATLCLI_DOCX_HIGHLIGHT_BENCHMARK = runHighlightBenchmark;
window.__ATLCLI_DOCX_RUNTIME_PREPARATION_BENCHMARK =
  runRuntimePreparationBenchmark;
window.__ATLCLI_PREPARE_CODE_HIGHLIGHTING = prepareHighlightModules;
