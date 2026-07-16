/**
 * Golden-file equality (spec 006 Task 4) — the proof the extraction changed
 * nothing observable.
 *
 * `golden-extension-export.json` was captured by running the PRE-refactor
 * extension pipeline (`apps/extension/utils/docx/export.ts` at commit c2feae9,
 * spec 004 final shape) on a feature-zoo fixture page + realistic template
 * with a FIXED export date. The capture recorded the STEADY-STATE output
 * (second export in the process): before the highlight warmup fix, shiki's
 * lazy grammar compile made the very first export tokenize code differently —
 * the engine now warms the grammar so every export matches this steady state
 * (see highlight.test.ts). It records every zip entry's decompressed content
 * plus the deterministic report fields. This test renders the identical input
 * through the extracted `@atlcli/docx` engine and asserts per-entry equality.
 *
 * Equality is structural, not byte-level: PizZip stamps wall-clock entry
 * dates into zip headers, so raw bytes differ run-to-run even WITHOUT any
 * refactor (documented Task 4 decision). Decompressed entry content is fully
 * deterministic given the fixed export date. `durationMs` is excluded for the
 * same reason. Cross-host reuse (the same golden rendered under Node adapters)
 * is asserted in `node-consumer.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import PizZip from "pizzip";
import { exportDocx, type ExportResult } from "./export.js";
import { buildDocx, headingStyle, para, runSplitPara, stylesXml } from "./fixtures.js";
import type { ConfluencePageDetails } from "@atlcli/confluence";

interface Golden {
  entries: Record<string, string>;
  report: {
    resolvedCount: number;
    unsupportedNames: string[];
    skippedImages: number;
    filename: string;
    noteCodes: string[];
  };
}

const golden: Golden = JSON.parse(
  readFileSync(new URL("./golden-extension-export.json", import.meta.url), "utf8")
);

/** EXACTLY the capture script's input — do not "improve" without recapturing. */
const STORAGE = `
<h1>Overview</h1>
<p>Intro <strong>bold</strong> <em>it</em> <u>u</u> <s>s</s> <code>inline</code> and <a href="https://x.com">link</a>.</p>
<h2>Details</h2>
<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>note body</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;
export function f(): number { return x; }]]></ac:plain-text-body></ac:structured-macro>
<ul><li><p>alpha</p></li><li><p>beta</p><ul><li><p>nested</p></li></ul></li></ul>
<ol><li><p>one</p></li><li><p>two</p></li></ol>
<table><tbody><tr><th><p>H1</p></th><th><p>H2</p></th></tr><tr><td><p>cell</p></td><td><p>page uses $scroll.title literally</p></td></tr></tbody></table>
<blockquote><p>quoted</p></blockquote>
<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>
<p>Literal braces {notATag} and «guillemets» survive.</p>
`;

export const GOLDEN_DETAILS: ConfluencePageDetails = {
  id: "1117356071",
  title: "DOCX Feature Zoo / Golden",
  url: "https://mayflower.atlassian.net/wiki/spaces/DOCSY/pages/1117356071",
  version: 7,
  spaceKey: "DOCSY",
  storage: STORAGE,
  tinyUrl: "https://mayflower.atlassian.net/wiki/x/AbC",
  created: "2026-01-02T10:00:00.000Z",
  modified: "2026-06-30T12:30:00.000Z",
  createdBy: { displayName: "Alice Author" },
  modifiedBy: { displayName: "Mel Modifier" },
  labels: ["architecture", "golden"],
};

export const GOLDEN_TEMPLATE_META = { name: "mayflower.docx", modificationDate: new Date(2026, 6, 14) };
export const GOLDEN_EXPORT_DATE = new Date(2026, 6, 14, 9, 5);

export const GOLDEN_DEPS = {
  getSpace: async () => ({ id: "s", key: "DOCSY", name: "Docs Space", type: "global" as const }),
  getCurrentUser: async () => ({ accountId: "u", displayName: "Björn Schotte" }),
  getPageOwner: async () => ({ accountId: "u-9", displayName: "Olga Owner" }),
};

export function goldenTemplateBytes(): Uint8Array {
  return buildDocx({
    body:
      para("$scroll.title") +
      para("$scroll.space.name") +
      para("Exported $scroll.exportdate by $scroll.exporter.fullName") +
      para("$scroll.content") +
      para("$scroll.pageowner.fullName") +
      para("$scroll.spacelogo"),
    styles: stylesXml(headingStyle("SH1", "Scroll Heading 1") + headingStyle("SH2", "Scroll Heading 2")),
    header: para("$scroll.title"),
    footer: runSplitPara(["$scroll.exporter", ".fullName"]),
  });
}

/** Compare an export result against the golden capture (shared with the Node-consumer test). */
export function expectMatchesGolden({ bytes, report }: ExportResult): void {
  const zip = new PizZip(bytes);
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir)
    .sort();
  expect(names).toEqual(Object.keys(golden.entries).sort());
  for (const name of names) {
    expect(zip.files[name].asText()).toBe(golden.entries[name]);
  }

  expect(report.resolvedCount).toBe(golden.report.resolvedCount);
  expect(report.unsupportedNames).toEqual(golden.report.unsupportedNames);
  expect(report.skippedImages).toBe(golden.report.skippedImages);
  expect(report.filename).toBe(golden.report.filename);
  expect(report.notes.map((n) => n.code)).toEqual(golden.report.noteCodes);
}

describe("golden-file equality (spec 006 Task 4)", () => {
  it("the extracted engine reproduces the pre-refactor extension export exactly", async () => {
    const result = await exportDocx({
      templateBytes: goldenTemplateBytes(),
      details: GOLDEN_DETAILS,
      template: GOLDEN_TEMPLATE_META,
      exportDate: GOLDEN_EXPORT_DATE,
      deps: GOLDEN_DEPS,
    });
    expectMatchesGolden(result);
  });
});
