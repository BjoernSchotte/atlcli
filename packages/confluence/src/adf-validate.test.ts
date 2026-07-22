import { describe, expect, test } from "bun:test";
import {
  ADF_COVERAGE,
  PINNED_ADF_MARK_TYPES,
  PINNED_ADF_NODE_TYPES,
} from "./adf-coverage.js";
import { AdfValidationError } from "./adf-types.js";
import { validateAdf } from "./adf-validate.js";

function doc(content: unknown[] = []): Record<string, unknown> {
  return { version: 1, type: "doc", content };
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AdfValidationError);
    return (error as AdfValidationError).code;
  }
}

describe("validateAdf", () => {
  test("accepts the minimal version-1 document", () => {
    const result = validateAdf('{"version":1,"type":"doc","content":[]}');
    expect(result.document).toEqual({ version: 1, type: "doc", content: [] });
    expect(result.diagnostics).toEqual([]);
    expect(result.stats).toMatchObject({ nodes: 1, marks: 0, maxDepth: 0 });
    expect(result.stats.inputBytes).toBe(39);
  });

  test("rejects invalid JSON, root, version, node, and mark envelopes", () => {
    expect(errorCode(() => validateAdf("{"))).toBe("invalid-json");
    expect(errorCode(() => validateAdf({ type: "paragraph", content: [] }))).toBe("invalid-root");
    expect(errorCode(() => validateAdf({ version: 2, type: "doc", content: [] }))).toBe("unsupported-version");
    expect(errorCode(() => validateAdf(doc([null])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "paragraph", marks: [null] }])))).toBe("invalid-mark");
  });

  test("checks known decoder-facing node and mark shapes", () => {
    expect(errorCode(() => validateAdf(doc([{ type: "text" }])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "heading", attrs: { level: 7 }, content: [] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "taskItem", attrs: { state: "MAYBE" }, content: [] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "text", text: "x", marks: [{ type: "link", attrs: {} }] }])))).toBe("invalid-attributes");
    expect(errorCode(() => validateAdf(doc([{ type: "text", text: "x", marks: [{ type: "subsup", attrs: { type: "sideways" } }] }])))).toBe("invalid-attributes");
  });

  test("checks UTF-8 input bytes before parsing", () => {
    const raw = JSON.stringify(doc([{ type: "text", text: "🙂" }]));
    expect(errorCode(() => validateAdf(raw, { budget: { maxInputBytes: raw.length } })))
      .toBe("input-too-large");
  });

  test("enforces node, depth, text, mark, attribute-byte, attribute-value, and diagnostic budgets", () => {
    const twoParagraphs = doc([
      { type: "paragraph", content: [] },
      { type: "paragraph", content: [] },
    ]);
    expect(errorCode(() => validateAdf(twoParagraphs, { budget: { maxNodes: 2 } })))
      .toBe("node-budget-exceeded");

    const nested = doc([{ type: "paragraph", content: [{ type: "unknown", content: [] }] }]);
    expect(errorCode(() => validateAdf(nested, { budget: { maxDepth: 1 } })))
      .toBe("depth-budget-exceeded");

    const text = doc([{ type: "text", text: "🙂" }]);
    expect(errorCode(() => validateAdf(text, { budget: { maxTextBytes: 3 } })))
      .toBe("text-budget-exceeded");

    const marked = doc([{ type: "text", text: "x", marks: [{ type: "strong" }, { type: "em" }] }]);
    expect(errorCode(() => validateAdf(marked, { budget: { maxMarks: 1 } })))
      .toBe("mark-budget-exceeded");

    const attributes = doc([{ type: "unknown", attrs: { value: "abcdef" } }]);
    expect(errorCode(() => validateAdf(attributes, { budget: { maxAttributeBytes: 5 } })))
      .toBe("attribute-budget-exceeded");
    expect(errorCode(() => validateAdf(attributes, { budget: { maxAttributeValues: 1 } })))
      .toBe("attribute-budget-exceeded");

    const drift = doc([
      { type: "future-a" }, { type: "future-b" }, { type: "future-c" },
    ]);
    const result = validateAdf(drift, { budget: { maxDiagnostics: 2 } });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.at(-1)).toMatchObject({ kind: "diagnostics-truncated", count: 2 });
  });

  test("walks deeply nested documents iteratively without overflowing the call stack", () => {
    let child: Record<string, unknown> = { type: "text", text: "end" };
    for (let depth = 0; depth < 5_000; depth += 1) {
      child = { type: "future-container", content: [child] };
    }
    const result = validateAdf(doc([child]), {
      budget: { maxDepth: 5_002, maxNodes: 5_010, maxDiagnostics: 1 },
    });
    expect(result.stats.nodes).toBe(5_002);
    expect(result.stats.maxDepth).toBe(5_001);
  });

  test("preserves unknown node, mark, and attribute names as bounded drift", () => {
    const result = validateAdf(doc([{
      type: "futureNode",
      futureEnvelope: true,
      attrs: { futureAttr: "kept" },
      marks: [{ type: "futureMark", attrs: { futureMarkAttr: 1 } }],
    }]));
    expect(result.document.content[0]).toMatchObject({ type: "futureNode" });
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual([
      "unknown-attribute",
      "unknown-node",
      "unknown-attribute",
      "unknown-mark",
      "unknown-attribute",
    ]);
  });

  test("rejects prototype-polluting keys, non-plain objects, cycles, shared objects, and non-finite numbers", () => {
    const polluted = JSON.parse('{"version":1,"type":"doc","content":[{"type":"future","attrs":{"__proto__":{"x":1}}}]}');
    expect(errorCode(() => validateAdf(polluted))).toBe("invalid-attributes");

    const constructorKey = JSON.parse('{"version":1,"type":"doc","content":[{"type":"future","attrs":{"constructor":1}}]}');
    expect(errorCode(() => validateAdf(constructorKey))).toBe("invalid-attributes");

    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: new Date() }]))))
      .toBe("invalid-attributes");

    const cyclicAttrs: Record<string, unknown> = {};
    cyclicAttrs.self = cyclicAttrs;
    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: cyclicAttrs }]))))
      .toBe("invalid-attributes");

    const shared = { type: "paragraph", content: [] };
    expect(errorCode(() => validateAdf(doc([shared, shared])))).toBe("invalid-node");
    expect(errorCode(() => validateAdf(doc([{ type: "future", attrs: { value: Number.NaN } }]))))
      .toBe("invalid-attributes");
  });

  test("classifies every pinned schema node and mark exactly once", () => {
    expect(PINNED_ADF_NODE_TYPES).toHaveLength(43);
    expect(PINNED_ADF_MARK_TYPES).toHaveLength(17);
    expect(new Set(PINNED_ADF_NODE_TYPES).size).toBe(43);
    expect(new Set(PINNED_ADF_MARK_TYPES).size).toBe(17);
    expect(ADF_COVERAGE.filter(({ kind }) => kind === "node").map(({ type }) => type).sort())
      .toEqual([...PINNED_ADF_NODE_TYPES].sort());
    expect(ADF_COVERAGE.filter(({ kind }) => kind === "mark").map(({ type }) => type).sort())
      .toEqual([...PINNED_ADF_MARK_TYPES].sort());
  });
});
