/**
 * spec 004 engine hook-in (DOCX): the optional `macros` field resolves dynamic
 * macros on BOTH entry points — `exportDocx(input)` directly and `runExport`
 * with `macros` on the env — and omitting it reproduces today's output.
 */
import { describe, expect, it } from "bun:test";
import { storageToBlocks } from "@atlcli/confluence";
import { createRegistry, type MacroResolutionOptions, type MacroRenderer } from "@atlcli/export-macros";
import { exportDocx } from "./export.js";
import { runExport } from "./env.js";
import { buildDocx, para } from "./fixtures.js";

const TEMPLATE = buildDocx({ body: para("$scroll.content") });
const STORAGE = `<p>Before</p><ac:structured-macro ac:name="acme-widget" ac:macro-id="m1"/><p>After</p>`;
const WALKER_CODES = ["unknown-macro", "macro-not-rendered"];
const hasWalkerNote = (notes: { code: string }[]) => notes.some((n) => WALKER_CODES.includes(n.code));

function widgetRenderer(): MacroRenderer {
  return {
    id: "widget",
    macros: ["acme-widget"],
    requiresLivePort: false,
    async render() {
      return {
        kind: "blocks",
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "RENDERED-WIDGET" }] }],
      };
    },
  };
}

function macroOptions(): MacroResolutionOptions {
  return {
    registry: createRegistry([widgetRenderer()]),
    contextFor: (page) => ({ page, depth: 0, visited: new Set() }),
  };
}

const details = { id: "1", title: "Root", storage: STORAGE, spaceKey: "DOC" };
const template = { name: "t.docx", modificationDate: new Date(0) };

describe("DOCX macro hook-in", () => {
  it("resolves macros when set on ExportInput (direct exportDocx call)", async () => {
    const { report } = await exportDocx({
      templateBytes: TEMPLATE,
      details,
      template,
      macros: macroOptions(),
    });
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(true);
    expect(hasWalkerNote(report.notes)).toBe(false);
  });

  it("resolves macros identically when set on ExportEnv (runExport)", async () => {
    let bytes: Uint8Array | undefined;
    const report = await runExport(
      { details, template },
      {
        templates: { getBytes: async () => TEMPLATE },
        output: { emit: async (_n, b) => void (bytes = b) },
        macros: macroOptions(),
      }
    );
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(true);
    expect(bytes && bytes.length > 0).toBe(true);
  });

  it("omitting macros reproduces today's placeholder behavior", async () => {
    const { report } = await exportDocx({ templateBytes: TEMPLATE, details, template });
    expect(hasWalkerNote(report.notes)).toBe(true);
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(false);
  });
});

/**
 * Host-walked input (spec 010). The CLI walks the storage ITSELF — it pre-resolves
 * @mentions before calling the engine — and then hands the engine the blocks via
 * `input.blocks` and the walker notes via `input.sourceNotes`. That split used to
 * leave `resolveMacroBlocks` with an empty note list, so its terminal
 * `macro-rendered-via` was APPENDED next to the provisional `macro-not-rendered`
 * it was supposed to REPLACE: the report both claimed the macro rendered and
 * claimed it did not.
 *
 * Fixture shape (two macros, one non-macro note between them) is deliberate: the
 * resolver's pairing is POSITIONAL over the macro-code subsequence, so only a
 * fixture where the outcomes differ per macro can tell a correct pairing from an
 * off-by-one. The macro that renders live is the SECOND one.
 */
describe("DOCX macro hook-in — host-walked blocks + sourceNotes (spec 010)", () => {
  const HOST_STORAGE =
    `<p>Before</p>` +
    `<ac:structured-macro ac:name="acme-quiet" ac:macro-id="m1"/>` +
    `<ac:image/>` + // no attachment/url child → a non-macro walker note
    `<ac:structured-macro ac:name="acme-widget" ac:macro-id="m2"/>` +
    `<p>After</p>`;

  /** Mirrors the CLI: walk here, hand the engine both halves of the result. */
  const hostWalk = (): { blocks: ReturnType<typeof storageToBlocks>["blocks"]; notes: ReturnType<typeof storageToBlocks>["notes"] } =>
    storageToBlocks(HOST_STORAGE, { exporter: "word" });

  const hostDetails = { id: "1", title: "Root", storage: HOST_STORAGE, spaceKey: "DOC" };

  it("pairs each host walker note with its own macro and replaces it exactly once", async () => {
    const walked = hostWalk();
    // Precondition: the walk really produced two macro notes with a non-macro
    // note between them — otherwise the pairing claim below is vacuous.
    expect(walked.notes.map((n) => n.code)).toEqual(["unknown-macro", "image-unresolved", "unknown-macro"]);

    const { report } = await exportDocx({
      templateBytes: TEMPLATE,
      details: hostDetails,
      blocks: walked.blocks,
      sourceNotes: walked.notes,
      template,
      macros: macroOptions(),
    });

    // The reconciled source notes, in order: the first macro fell to the
    // placeholder floor, the untouched image note kept its slot, and the second
    // macro — the one the registry renders — became `macro-rendered-via`. An
    // off-by-one pairing would swap the two terminal codes; an unreconciled list
    // would keep both `unknown-macro` notes and append the terminals.
    expect((report.sourceNotes ?? []).map((n) => [n.code, n.macroName])).toEqual([
      ["macro-degraded", "acme-quiet"],
      ["image-unresolved", undefined],
      ["macro-rendered-via", "acme-widget"],
    ]);

    // The same facts as seen through the report's own note list: exactly one
    // note per macro, and no surviving provisional note.
    expect(report.notes.filter((n) => n.code === "macro-rendered-via")).toHaveLength(1);
    expect(report.notes.filter((n) => n.code === "macro-degraded")).toHaveLength(1);
    expect(hasWalkerNote(report.notes)).toBe(false);
    expect(report.notes.filter((n) => n.code === "image-unresolved")).toHaveLength(1);
  });

  it("keeps exactly one provisional note per macro when no resolver is wired", async () => {
    const walked = hostWalk();
    const { report } = await exportDocx({
      templateBytes: TEMPLATE,
      details: hostDetails,
      blocks: walked.blocks,
      sourceNotes: walked.notes,
      template,
    });
    // Nothing resolved, so nothing is reconciled — but nothing is dropped or
    // duplicated either. Fixing the double-report by discarding walker notes
    // would hide a macro that genuinely did not render; this pins that it can't.
    expect(report.notes.filter((n) => WALKER_CODES.includes(n.code))).toHaveLength(2);
    expect(report.notes.some((n) => n.code === "macro-rendered-via")).toBe(false);
    expect((report.sourceNotes ?? []).map((n) => n.code)).toEqual([
      "unknown-macro",
      "image-unresolved",
      "unknown-macro",
    ]);
  });
});
