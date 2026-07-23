import { describe, expect, expectTypeOf, it } from "bun:test";
import { parseDocxExportJobRequestV1, parsePdfExportJobRequestV1 } from "./index.js";
import type {
  DocxExportJobRequestV1,
  ExportJobEventV1,
  ExportJobEventPageV1,
  ExportJobEventQueryV1,
  ExportJobEventReaderV1,
  ExportJobExecutionResultV1,
  ExportJobExecutor,
  ExportJobHostCapabilityV1,
  ExportJobRequestV1,
  ExportJobSnapshotV1,
  PdfExportJobRequestV1,
} from "./index.js";

const source = {
  kind: "confluence" as const,
  siteOrigin: "https://example.atlassian.net",
  locator: { kind: "space-key" as const, spaceKey: "DOCS" },
  scope: { kind: "space" as const },
  maxFolders: 200,
};

const base = {
  schema: "atlcli.export-job-request/1" as const,
  id: "job-1",
  idempotencyKey: "idem-1",
  source,
  authRef: "session:default",
  displayName: "Documentation",
  createdAt: 1,
  priority: "interactive" as const,
  output: { policy: "path" as const, targetRef: "/exports/document", overwriteExisting: true },
};

const docxRequest: DocxExportJobRequestV1 = {
  ...base,
  format: "docx",
  renderer: "docx-typescript",
  template: { recordKey: "default", sha256: "abc", name: "Default" },
  options: {
    embedImages: true,
    resolveMacros: true,
    keepIgnored: true,
    strict: true,
    updateFields: "never",
  },
};

const pdfRequest: PdfExportJobRequestV1 = {
  ...base,
  format: "pdf",
  renderer: "pdf-typst",
  template: { id: "default", manifestVersion: "1" },
  settings: {},
  options: {
    resolveMacros: true,
    strict: true,
    noCache: true,
    exportedAt: 1_753_161_600_000,
  },
};

describe("version-1 export job contracts", () => {
  it("form a closed renderer-discriminated request union", () => {
    const formats = ([docxRequest, pdfRequest] satisfies ExportJobRequestV1[]).map(
      (request) => request.format,
    );

    expect(formats).toEqual(["docx", "pdf"]);
    expectTypeOf(docxRequest.renderer).toEqualTypeOf<"docx-typescript">();
    expectTypeOf(pdfRequest.renderer).toEqualTypeOf<"pdf-typst">();
    expectTypeOf(source.maxFolders).toEqualTypeOf<number>();
    expectTypeOf(docxRequest.options.keepIgnored).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(pdfRequest.options.exportedAt).toEqualTypeOf<number | undefined>();
    expectTypeOf(base.output.overwriteExisting).toEqualTypeOf<boolean>();
  });

  it("exposes snapshots, events, executors, and host capabilities from the public entrypoint", () => {
    expectTypeOf<ExportJobSnapshotV1["schema"]>().toEqualTypeOf<"atlcli.export-job/1">();
    expectTypeOf<NonNullable<ExportJobSnapshotV1["derivedFrom"]>>().toHaveProperty("actionKey");
    expectTypeOf<ExportJobEventV1["kind"]>().toEqualTypeOf<
      "state" | "stage" | "progress" | "retry" | "issue" | "recovery" | "artifact"
    >();
    expectTypeOf<ExportJobExecutor<ExportJobRequestV1>>().toHaveProperty("execute");
    expectTypeOf<ExportJobEventReaderV1>().toHaveProperty("readEvents");
    expectTypeOf<ExportJobEventQueryV1>().toHaveProperty("afterSeq");
    expectTypeOf<ExportJobEventPageV1>().toHaveProperty("nextAfterSeq");
    expectTypeOf<ExportJobExecutionResultV1>().toHaveProperty("stagedArtifact");
    expectTypeOf<ExportJobHostCapabilityV1>().toHaveProperty("canRerun");
    expectTypeOf(parsePdfExportJobRequestV1).returns.toEqualTypeOf<PdfExportJobRequestV1>();
    expectTypeOf(parseDocxExportJobRequestV1).returns.toEqualTypeOf<DocxExportJobRequestV1>();
  });
});
