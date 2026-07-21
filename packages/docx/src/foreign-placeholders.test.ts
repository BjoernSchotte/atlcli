/**
 * Foreign (docxtpl/Jinja) placeholder detection — spec 010 W3-D, Gap 1.
 *
 * The defect this pins: a Python-engine template fixture full of docxtpl Jinja
 * placeholders was handed to `--engine ts`. The engine happily produced a
 * 62-page `.docx` containing SEVEN literal unfilled placeholders — `{{ title }}`,
 * `{{ author }}`, `{{ spaceName }}`, `{{ modified | date('YYYY-MM-DD') }}`, … —
 * as visible body text, and the report said nothing about them. The only related
 * note was `no-content-placeholder` at `level: "info"`, which mentions neither
 * Jinja nor anything a `--strict` CI run would catch.
 *
 * The fix detects the syntax in the TEMPLATE and says so at `warning` level.
 * Template and page content are separated STRUCTURALLY, not heuristically:
 * `scanZip` runs on the template archive at the top of `exportDocx`, long before
 * the serialized page body is rendered in — so a page that legitimately contains
 * `{{ … }}` can never reach the detector. The last test here is that guard.
 *
 * Pure functions over in-test fixtures; no mocks anywhere.
 */
import { describe, expect, it } from "bun:test";
import type { ConfluencePageDetails, ConfluenceSpace } from "@atlcli/confluence";
import { exportDocx } from "./export.js";
import {
  MAX_FOREIGN_PLACEHOLDERS,
  collectForeignPlaceholders,
  scanTemplate,
} from "./scan.js";
import { buildDocx, headingStyle, para, readPart, runSplitPara, stylesXml } from "./fixtures.js";

const details: ConfluencePageDetails = {
  id: "123",
  title: "Migration Notes",
  url: "https://x.atlassian.net/wiki/spaces/ENG/pages/123",
  version: 1,
  spaceKey: "ENG",
  storage: "<h1>Overview</h1><p>Body paragraph.</p>",
  created: "2026-01-02T10:00:00.000Z",
  modified: "2026-06-30T12:30:00.000Z",
  createdBy: { displayName: "Alice Author" },
  modifiedBy: { displayName: "Mel Modifier" },
  labels: [],
};

const space: ConfluenceSpace = { id: "s", key: "ENG", name: "Engineering", type: "global" };
const template = { name: "fixture.docx", modificationDate: new Date(2026, 6, 14) };
const deps = {
  getSpace: async () => space,
  getCurrentUser: async () => ({ accountId: "u", displayName: "Björn Schotte" }),
  getPageOwner: async () => ({ accountId: "u-9", displayName: "Olga Owner" }),
};

const NOTE_CODE = "template-foreign-placeholders";

/** The real fixture's shape: a docxtpl cover page with no `$scroll.*` at all. */
function docxtplTemplate(): Uint8Array {
  return buildDocx({
    body:
      para("{{ title }}") +
      para("{{ author }}") +
      para("{{ spaceName }} ({{ spaceKey }})") +
      para("{{ modified | date('YYYY-MM-DD') }}") +
      para("{%p content %}"),
    styles: stylesXml(headingStyle("Heading1", "Heading 1")),
  });
}

describe("collectForeignPlaceholders (pure)", () => {
  it("finds Jinja variable and tag forms, whitespace-normalized and deduped", () => {
    expect(collectForeignPlaceholders("Report for {{  title  }} by {{ author }}")).toEqual([
      "{{ title }}",
      "{{ author }}",
    ]);
    expect(collectForeignPlaceholders("{% for p in pages %}{{ p }}{% endfor %}")).toEqual([
      "{% for p in pages %}",
      "{{ p }}",
      "{% endfor %}",
    ]);
    // Repeats collapse to one entry, in first-seen order.
    expect(collectForeignPlaceholders("{{ a }} {{ a }} {{ b }}")).toEqual(["{{ a }}", "{{ b }}"]);
  });

  it("ignores text that is not a doubled-brace placeholder", () => {
    expect(collectForeignPlaceholders("A sentence with no braces at all.")).toEqual([]);
    // Single braces are ordinary prose/code; the PUA delimiter swap means the
    // engine renders them literally on purpose, and flagging them would fire on
    // every template containing a code sample.
    expect(collectForeignPlaceholders("const x = { a: 1 }; if (y) { z(); }")).toEqual([]);
    expect(collectForeignPlaceholders("$scroll.title and $scroll.content")).toEqual([]);
    // A brace pair split by a hard break (rendered as \n) is not one placeholder.
    expect(collectForeignPlaceholders("{{ title\n }}")).toEqual([]);
  });

  it("closes a placeholder at its own delimiter, not the last one on the line", () => {
    expect(collectForeignPlaceholders("{{ a }} tail }}")).toEqual(["{{ a }}"]);
    expect(collectForeignPlaceholders("{{ {'k': 1} }}")).toEqual(["{{ {'k': 1} }}"]);
  });
});

describe("scanTemplate: foreign placeholders in the template archive", () => {
  it("collects the docxtpl fixture's placeholders across body and header", () => {
    const bytes = buildDocx({
      body: para("{{ title }}") + para("$scroll.content"),
      header: para("{{ spaceName }}"),
    });
    expect(scanTemplate(bytes).foreignPlaceholders).toEqual(["{{ title }}", "{{ spaceName }}"]);
  });

  it("merges run-split placeholders the way Word actually stores them", () => {
    // Word's rsid-driven run splitting is exactly why the detector runs on
    // merged paragraph text: a raw-XML regex would see `{{`, ` title `, `}}`
    // as three unrelated runs and report nothing.
    const bytes = buildDocx({ body: runSplitPara(["{{", " title ", "}}"]) + para("$scroll.content") });
    expect(scanTemplate(bytes).foreignPlaceholders).toEqual(["{{ title }}"]);
  });

  it("reports nothing for a clean $scroll.* template", () => {
    const bytes = buildDocx({
      body: para("$scroll.title") + para("Exported $scroll.exportdate") + para("$scroll.content"),
    });
    expect(scanTemplate(bytes).foreignPlaceholders).toEqual([]);
  });

  it("names all seven placeholders in the fixture that produced the finding", async () => {
    // The actual artifact: the PYTHON engine's own test template, which is what
    // got handed to `--engine ts` and produced a 62-page document with seven
    // visible unfilled placeholders. Deliberately cross-package — a synthetic
    // fixture would only prove the detector matches fixtures the same author
    // wrote. If this path ever disappears the test fails loudly rather than
    // quietly stopping to check the one template this whole fix exists for.
    const url = new URL("../../export/tests/fixtures/basic-template.docx", import.meta.url);
    const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
    expect(scanTemplate(bytes).foreignPlaceholders).toEqual([
      "{{ title }}",
      "{{ author }}",
      "{{ modified | date('YYYY-MM-DD') }}",
      "{{ spaceName }}",
      "{{ spaceKey }}",
      "{{p content }}",
      "{{ exportDate | date('YYYY-MM-DD HH:mm') }}",
    ]);
  });

  it("caps the distinct forms it records", () => {
    const body = Array.from({ length: MAX_FOREIGN_PLACEHOLDERS + 7 }, (_, i) =>
      para(`{{ field${i} }}`)
    ).join("");
    expect(scanTemplate(buildDocx({ body })).foreignPlaceholders).toHaveLength(
      MAX_FOREIGN_PLACEHOLDERS
    );
  });
});

describe("exportDocx: the report names the foreign placeholders", () => {
  it("emits a WARNING note naming examples, and still produces the document", async () => {
    const { bytes, report } = await exportDocx({
      templateBytes: docxtplTemplate(),
      details,
      template,
      deps,
    });

    const note = report.notes.find((n) => n.code === NOTE_CODE);
    expect(note).toBeDefined();
    // Level is load-bearing: `info` notes never trip `--strict`, which is what
    // made this class of failure invisible in CI.
    expect(note!.level).toBe("warning");
    expect(note!.message).toContain("{{ title }}");
    expect(note!.message).toContain("{{ author }}");
    expect(note!.message).toContain("$scroll.");
    // The export is NOT refused — a hybrid template is a real workflow.
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(readPart(bytes, "word/document.xml")).toContain("Overview");
  });

  it("tallies the overflow instead of listing every placeholder", async () => {
    const body = Array.from({ length: 9 }, (_, i) => para(`{{ field${i} }}`)).join("");
    const { report } = await exportDocx({
      templateBytes: buildDocx({ body: `${body}${para("$scroll.content")}` }),
      details,
      template,
      deps,
    });
    const note = report.notes.find((n) => n.code === NOTE_CODE);
    expect(note?.message).toContain("{{ field0 }}");
    expect(note?.message).toMatch(/and 4 more/);
  });

  it("says nothing for a clean $scroll.* template", async () => {
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { report } = await exportDocx({ templateBytes, details, template, deps });
    expect(report.notes.some((n) => n.code === NOTE_CODE)).toBe(false);
  });

  it("does NOT flag a page whose CONTENT documents Jinja (false-positive guard)", async () => {
    // A page explaining docxtpl syntax is legitimate content. The template is
    // clean, so nothing is wrong with this export — and the literal braces must
    // survive into the body untouched.
    const pageDetails: ConfluencePageDetails = {
      ...details,
      storage:
        "<h1>Docs</h1><p>Write {{ title }} in a docxtpl template; use {% for p in pages %} to loop.</p>",
    };
    const templateBytes = buildDocx({
      body: para("$scroll.title") + para("$scroll.content"),
      styles: stylesXml(headingStyle("Heading1", "Heading 1")),
    });
    const { bytes, report } = await exportDocx({
      templateBytes,
      details: pageDetails,
      template,
      deps,
    });
    expect(report.notes.some((n) => n.code === NOTE_CODE)).toBe(false);
    const doc = readPart(bytes, "word/document.xml");
    expect(doc).toContain("{{ title }}");
    expect(doc).toContain("{% for p in pages %}");
  });
});
