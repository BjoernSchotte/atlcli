#!/usr/bin/env bun
import {
  AdfValidationError,
  validateAdf,
} from "@atlcli/confluence/browser";

interface BenchmarkRecord {
  name: string;
  inputBytes?: number;
  durationMs: number;
  outcome: "accepted" | "rejected";
  code?: string;
  nodes?: number;
  maxDepth?: number;
}

function measure(name: string, input: string | unknown): BenchmarkRecord {
  const start = performance.now();
  try {
    const result = validateAdf(input);
    return {
      name,
      inputBytes: typeof input === "string" ? new TextEncoder().encode(input).byteLength : undefined,
      durationMs: Number((performance.now() - start).toFixed(3)),
      outcome: "accepted",
      nodes: result.stats.nodes,
      maxDepth: result.stats.maxDepth,
    };
  } catch (error) {
    return {
      name,
      inputBytes: typeof input === "string" ? new TextEncoder().encode(input).byteLength : undefined,
      durationMs: Number((performance.now() - start).toFixed(3)),
      outcome: "rejected",
      code: error instanceof AdfValidationError ? error.code : "unexpected-error",
    };
  }
}

const realistic = JSON.stringify({
  version: 1,
  type: "doc",
  content: Array.from({ length: 15_000 }, (_, index) => ({
    type: "paragraph",
    content: [{
      type: "text",
      text: `Synthetic paragraph ${index}`,
      marks: index % 3 === 0 ? [{ type: "strong" }] : [],
    }],
  })),
});

const wide = JSON.stringify({
  version: 1,
  type: "doc",
  content: Array.from({ length: 80_000 }, () => ({ type: "paragraph", content: [] })),
});

let deep: Record<string, unknown> = { type: "text", text: "end" };
for (let depth = 0; depth < 127; depth += 1) {
  deep = { type: "future-container", content: [deep] };
}

let tooDeep: Record<string, unknown> = { type: "text", text: "end" };
for (let depth = 0; depth < 128; depth += 1) {
  tooDeep = { type: "future-container", content: [tooDeep] };
}

const records = [
  measure("realistic-rich", realistic),
  measure("wide-near-node-budget", wide),
  measure("deep-at-budget", { version: 1, type: "doc", content: [deep] }),
  measure("deep-over-budget", { version: 1, type: "doc", content: [tooDeep] }),
  measure("input-over-budget", " ".repeat(8 * 1024 * 1024 + 1)),
];

console.log(JSON.stringify({
  schemaVersion: 1,
  runtime: `bun ${Bun.version}`,
  records,
}, null, 2));
