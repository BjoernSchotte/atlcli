/**
 * spec 004 additivity golden (DoD: "omitting `macros` reproduces today's
 * output byte-for-byte"): the same fixture — including an unresolved dynamic
 * macro — exported with the `macros` field absent and with `macros: undefined`
 * yields identical zip entries and identical report notes. Entry comparison is
 * per decompressed entry (PizZip stamps wall-clock dates into zip headers, so
 * raw archive bytes differ run-to-run even without any code change — same
 * documented equivalence the spec-006 golden uses).
 */
import { describe, expect, it } from "bun:test";
import PizZip from "pizzip";
import { exportDocx, type ExportInput } from "./export.js";
import { buildDocx, para } from "./fixtures.js";

const STORAGE = `<h1>Title</h1><p>Body</p>
<ac:structured-macro ac:name="acme-widget" ac:macro-id="m1">
  <ac:parameter ac:name="key">v</ac:parameter>
  <ac:rich-text-body><p>Preserved body</p></ac:rich-text-body>
</ac:structured-macro>`;

function input(): ExportInput {
  return {
    templateBytes: buildDocx({ body: para("$scroll.content") }),
    details: { id: "1", title: "Golden", storage: STORAGE, spaceKey: "DOC" },
    template: { name: "t.docx", modificationDate: new Date(0) },
    exportDate: new Date("2026-07-19T00:00:00Z"),
  };
}

function entriesOf(bytes: Uint8Array): Record<string, string> {
  const zip = new PizZip(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    const file = zip.file(name);
    if (file) out[name] = file.asText();
  }
  return out;
}

describe("macros field additivity (spec 004 DoD)", () => {
  it("absent vs. explicitly-undefined macros → identical entries and notes", async () => {
    const without = await exportDocx(input());
    const withUndefined = await exportDocx({ ...input(), macros: undefined });

    expect(entriesOf(withUndefined.bytes)).toEqual(entriesOf(without.bytes));
    // perf-timing carries wall-clock numbers (nondeterministic run-to-run even
    // without any code change) — everything else must match exactly.
    const meaningful = (notes: typeof without.report.notes) =>
      notes.filter((n) => n.code !== "perf-timing");
    expect(meaningful(withUndefined.report.notes)).toEqual(meaningful(without.report.notes));
    expect(withUndefined.report.filename).toBe(without.report.filename);
    // Today's walker note for the unresolved macro is present in both (the
    // resolver never ran — nothing rewrote it).
    expect(without.report.notes.some((n) => n.code === "unknown-macro")).toBe(true);
  });
});
