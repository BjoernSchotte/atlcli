import type {
  DocxExportJobRequestV1,
  ExportJobEventV1,
  ExportJobHostCapabilityV1,
  ExportJobRequestV1,
  ExportJobSnapshotV1,
  PdfExportJobRequestV1,
  StagedArtifactV1,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Value extends true> = Value;

type _RequestFormats = Assert<Equal<ExportJobRequestV1["format"], "docx" | "pdf">>;
type _DocxRenderer = Assert<Equal<DocxExportJobRequestV1["renderer"], "docx-typescript">>;
type _PdfRenderer = Assert<Equal<PdfExportJobRequestV1["renderer"], "pdf-typst">>;
type _SnapshotSchema = Assert<Equal<ExportJobSnapshotV1["schema"], "atlcli.export-job/1">>;
type _DerivedActionKey = Assert<
  Equal<NonNullable<ExportJobSnapshotV1["derivedFrom"]>["actionKey"], string>
>;
type _EventKinds = Assert<
  Equal<
    ExportJobEventV1["kind"],
    "state" | "stage" | "progress" | "retry" | "issue" | "recovery" | "artifact"
  >
>;
type _RerunCapability = Assert<Equal<ExportJobHostCapabilityV1["canRerun"], boolean>>;
type _StagedTimestamp = Assert<Equal<StagedArtifactV1["stagedAt"], number>>;
type _StagedHasNoCommittedTimestamp = Assert<
  Equal<"committedAt" extends keyof StagedArtifactV1 ? true : false, false>
>;

declare const base: Omit<DocxExportJobRequestV1, "format" | "renderer">;

const invalidDocxRequest: DocxExportJobRequestV1 = {
  ...base,
  format: "docx",
  // @ts-expect-error DOCX requests cannot select the PDF renderer.
  renderer: "pdf-typst",
};

void invalidDocxRequest;
