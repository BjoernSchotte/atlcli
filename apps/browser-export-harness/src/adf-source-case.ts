/** Browser conformance that starts with real ADF before either render engine. */
import type { TreeSource } from "@atlcli/confluence";
import { runExport } from "@atlcli/docx/browser";
import { memoryTemplateSource } from "@atlcli/docx/browser-runtime";
import { unzipDocx } from "@atlcli/docx/scan";
import {
  ADF_CODE_BLOCK_SOURCE,
  ADF_CONFORMANCE_DETAILS,
  ADF_CONFORMANCE_METADATA,
  ADF_CONFORMANCE_SOURCE,
  DOCX_TEMPLATE_BYTES,
  adfConformanceBlocks,
} from "@atlcli/export-fixtures";
import type {
  DocxExportJobRequestV1,
  PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  createConfluenceDocxResolveInputV1,
  createConfluencePdfResolveInputV1,
  resolveConfluenceSourceV1,
  type ConfluenceSourceResolverPortV1,
  type ResolvedConfluenceSourceV1,
} from "@atlcli/export-wiring/jobs";
import { validatePdfOutput } from "@atlcli/pdf/browser";
import { sha256Hex } from "./digest.js";
import {
  runDocxJobParityCase,
  type DocxJobParityFixtureV1,
} from "./docx-job-parity-case.js";
import { MemoryOutputSink } from "./memory-output.js";
import {
  runPdfJobParityCase,
  type PdfJobParityFixtureV1,
} from "./pdf-job-parity-case.js";
import { HarnessPdfWorkerClient } from "./pdf-worker-client.js";
import { compilePdf } from "./pdf-run.js";

const compiler = new HarnessPdfWorkerClient();

export interface AdfSourceCaseResult {
  representation: "atlas_doc_format";
  blockTypes: string[];
  sourceNoteCodes: string[];
  pdfTagged: boolean;
  pdfPageCount: number;
  docxHasInlineCode: boolean;
  docxHasEmbeddedCodeFont: boolean;
  docxHasEmoji: boolean;
  docxHasCustomEmojiFallback: boolean;
  docxHasBlockAlignment: boolean;
  docxHasBlockIndentation: boolean;
  docxHasSmallParagraphText: boolean;
  docxHasNestedListSemantics: boolean;
  docxHasTaskAndDecisionSemantics: boolean;
  docxHasCodeLineNumbers: boolean;
  docxHasCustomPanelPresentation: boolean;
  neutralHasBlockLocalIdentities: boolean;
  neutralHasCodeBlockSemantics: boolean;
  neutralHasCustomPanelSemantics: boolean;
  neutralHasMentionSemantics: boolean;
  neutralHasDateStatusPlaceholderSemantics: boolean;
  neutralHasAnnotationAndFragmentIdentity: boolean;
  neutralHasTablePresentation: boolean;
  neutralHasLayoutPresentation: boolean;
  neutralHasDisclosureSemantics: boolean;
  docxHasTable: boolean;
  docxHasTablePresentation: boolean;
  docxHasLayoutPresentation: boolean;
  docxHasDisclosureSemantics: boolean;
  docxHasDateStatusPlaceholderSemantics: boolean;
  docxHasMentionPresentation: boolean;
  docxHasCardTitle: boolean;
  docxHasExtensionBody: boolean;
  docxHasVisibleMediaFallback: boolean;
  pdfJobArtifactAndReportParity: boolean;
  docxJobArtifactAndReportParity: boolean;
}

const SOURCE_REQUEST = {
  kind: "confluence" as const,
  siteOrigin: "https://example.invalid",
  locator: {
    kind: "page-id" as const,
    id: ADF_CONFORMANCE_DETAILS.id,
    version: ADF_CONFORMANCE_DETAILS.version,
  },
  scope: { kind: "page" as const },
  completenessMode: "strict" as const,
};

function sourcePort(): ConfluenceSourceResolverPortV1 {
  return {
    createTreeSource(): TreeSource {
      return {
        async getPage(id) {
          if (id !== ADF_CONFORMANCE_DETAILS.id) throw new Error("Unknown ADF fixture page.");
          return {
            id,
            title: ADF_CONFORMANCE_DETAILS.title,
            version: ADF_CONFORMANCE_DETAILS.version,
            spaceKey: ADF_CONFORMANCE_DETAILS.spaceKey,
            labels: ADF_CONFORMANCE_DETAILS.labels,
            exportSource: {
              primary: {
                representation: "atlas_doc_format",
                value: ADF_CONFORMANCE_SOURCE,
              },
              sourceVersion: ADF_CONFORMANCE_DETAILS.version,
            },
          };
        },
        async getPageVersion(id) {
          if (id !== ADF_CONFORMANCE_DETAILS.id) throw new Error("Unknown ADF fixture page.");
          return {
            title: ADF_CONFORMANCE_DETAILS.title,
            version: ADF_CONFORMANCE_DETAILS.version,
          };
        },
        async getChildren() { return []; },
        async getSpaceHomepageId() { return null; },
      };
    },
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&amp;/gu, "&");
}

function numberedCodeParagraphTexts(documentXml: string): string[] {
  const paragraphs = documentXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gu) ?? [];
  return paragraphs
    .filter((paragraph) => paragraph.includes('<w:ind w:start="480" w:hanging="480"/>'))
    .map((paragraph, index) => {
      const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu)]
        .map((match) => decodeXmlText(match[1] ?? ""))
        .join("");
      return text.slice(String(index + 1).length);
    });
}

function assertResolvedParity(
  direct: ResolvedConfluenceSourceV1,
  job: ResolvedConfluenceSourceV1,
): void {
  const project = (value: ResolvedConfluenceSourceV1) => ({
    blocks: value.blocks,
    sourceNotes: value.sourceNotes,
    complete: value.complete,
    root: value.root,
    pages: value.pages,
    pageCount: value.pageCount,
    sourceSummary: value.sourceSummary,
  });
  if (JSON.stringify(project(direct)) !== JSON.stringify(project(job))) {
    throw new Error("ADF direct and background source resolution diverged.");
  }
}

export async function runAdfSourceCase(): Promise<AdfSourceCaseResult> {
  const decodedPdf = adfConformanceBlocks("pdf");
  const decodedWord = adfConformanceBlocks("word");
  if (
    decodedPdf.representation !== "atlas_doc_format"
    || decodedWord.representation !== "atlas_doc_format"
  ) {
    throw new Error("ADF-source conformance did not retain its primary representation.");
  }
  if (JSON.stringify(decodedPdf.blocks) !== JSON.stringify(decodedWord.blocks)) {
    throw new Error("ADF target decoders produced different neutral blocks.");
  }
  const [pdfSource, wordSource] = await Promise.all([
    resolveConfluenceSourceV1(SOURCE_REQUEST, {
      exporter: "pdf",
      port: sourcePort(),
      signal: new AbortController().signal,
    }),
    resolveConfluenceSourceV1(SOURCE_REQUEST, {
      exporter: "word",
      port: sourcePort(),
      signal: new AbortController().signal,
    }),
  ]);
  if (
    JSON.stringify(pdfSource.blocks) !== JSON.stringify(decodedPdf.blocks)
    || JSON.stringify(wordSource.blocks) !== JSON.stringify(decodedWord.blocks)
  ) {
    throw new Error("ADF shared source resolver diverged from direct representation dispatch.");
  }

  const pdf = await compilePdf(
    compiler,
    pdfSource.blocks,
    ADF_CONFORMANCE_METADATA,
    "ADF Browser Conformance.pdf",
    pdfSource.sourceNotes,
  );
  const inspection = validatePdfOutput(pdf.bytes);
  if (!inspection.tagged || inspection.pageCount < 1) {
    throw new Error("ADF-source PDF did not pass structural validation.");
  }

  const output = new MemoryOutputSink();
  await runExport(
    {
      details: ADF_CONFORMANCE_DETAILS,
      blocks: wordSource.blocks,
      sourceNotes: wordSource.sourceNotes,
      template: {
        name: "adf-conformance-template.docx",
        modificationDate: new Date("2026-07-22T08:00:00.000Z"),
      },
      exportDate: new Date("2026-07-22T08:00:00.000Z"),
      captionLang: "de-DE",
    },
    { templates: memoryTemplateSource(DOCX_TEMPLATE_BYTES), output },
  );
  const zip = unzipDocx(output.single.bytes);
  const documentXml = zip.file("word/document.xml")?.asText() ?? "";
  const relationships = zip.file("word/_rels/document.xml.rels")?.asText() ?? "";
  const numberingXml = zip.file("word/numbering.xml")?.asText() ?? "";
  const fontTableXml = zip.file("word/fontTable.xml")?.asText() ?? "";
  const fontTableRels = zip.file("word/_rels/fontTable.xml.rels")?.asText() ?? "";
  const embeddedCodeFont =
    zip.file("word/fonts/atlcli-code-001b70dc-aa60-4ad5-90ec-18a0948e1eae.odttf");
  const pdfRequest: PdfExportJobRequestV1 = {
    schema: "atlcli.export-job-request/1",
    id: "adf-pdf-job",
    idempotencyKey: "adf-pdf-action",
    format: "pdf",
    renderer: "pdf-typst",
    source: SOURCE_REQUEST,
    authRef: "browser-harness",
    displayName: ADF_CONFORMANCE_DETAILS.title,
    requestedFilename: "ADF Browser Conformance.pdf",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: { id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: false, profile: "tagged" },
  };
  const pdfResolveInput = createConfluencePdfResolveInputV1({
    port: sourcePort(),
    build(resolved) {
      assertResolvedParity(pdfSource, resolved);
      return {
        input: {
          metadata: ADF_CONFORMANCE_METADATA,
          filename: "ADF Browser Conformance.pdf",
          profile: "tagged",
        },
        env: {
          assets: {
            async resolve(): Promise<never> { throw new Error("unused"); },
          },
        },
      };
    },
  });
  const pdfFixture: PdfJobParityFixtureV1 = {
    request: pdfRequest,
    input: {
      blocks: pdfSource.blocks,
      sourceNotes: pdfSource.sourceNotes,
      complete: pdfSource.complete,
      metadata: ADF_CONFORMANCE_METADATA,
      filename: "ADF Browser Conformance.pdf",
      profile: "tagged",
      page: {
        id: pdfSource.root.id,
        ...(pdfSource.root.version !== undefined
          ? { version: pdfSource.root.version }
          : {}),
        ...(pdfSource.root.spaceKey !== undefined
          ? { spaceKey: pdfSource.root.spaceKey }
          : {}),
      },
    },
    resolveInput: pdfResolveInput,
  };
  const pdfJobParity = await runPdfJobParityCase({ fixture: pdfFixture });

  const docxRequest = async (): Promise<DocxExportJobRequestV1> => ({
    schema: "atlcli.export-job-request/1",
    id: "adf-docx-job",
    idempotencyKey: "adf-docx-action",
    format: "docx",
    renderer: "docx-typescript",
    source: SOURCE_REQUEST,
    authRef: "browser-harness",
    displayName: ADF_CONFORMANCE_DETAILS.title,
    requestedFilename: "ADF Browser Conformance.docx",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template: {
      recordKey: "template:adf-browser-conformance",
      sha256: await sha256Hex(DOCX_TEMPLATE_BYTES),
      name: "adf-conformance-template.docx",
    },
    options: {
      embedImages: true,
      resolveMacros: false,
      updateFields: "auto",
      captionLang: "de-DE",
    },
  });
  const docxFixture: DocxJobParityFixtureV1 = {
    request: docxRequest,
    templateBytes: DOCX_TEMPLATE_BYTES,
    requireMediaPart: false,
    input: (rasterizer) => ({
      details: ADF_CONFORMANCE_DETAILS,
      blocks: wordSource.blocks,
      sourceNotes: wordSource.sourceNotes,
      complete: wordSource.complete,
      templateBytes: DOCX_TEMPLATE_BYTES.slice(),
      template: {
        name: "adf-conformance-template.docx",
        modificationDate: new Date("2026-07-22T08:00:00.000Z"),
      },
      exportDate: new Date("2026-07-22T08:00:00.000Z"),
      captionLang: "de-DE",
      rasterizer,
    }),
    resolveInput: (rasterizer) => createConfluenceDocxResolveInputV1({
      port: sourcePort(),
      build(resolved) {
        assertResolvedParity(wordSource, resolved);
        const {
          id: _id,
          title: _title,
          version: _version,
          spaceKey: _spaceKey,
          storage: _storage,
          ...rootDetails
        } = ADF_CONFORMANCE_DETAILS;
        return {
          input: {
            template: {
              name: "adf-conformance-template.docx",
              modificationDate: new Date("2026-07-22T08:00:00.000Z"),
            },
            exportDate: new Date("2026-07-22T08:00:00.000Z"),
            captionLang: "de-DE",
            rasterizer,
          },
          rootDetails,
        };
      },
    }),
  };
  const docxJobParity = await runDocxJobParityCase({ fixture: docxFixture });
  const neutralCodeBlock = pdfSource.blocks.find((block) => block.type === "codeBlock");
  const neutralCustomPanel = pdfSource.blocks.find(
    (block) => block.type === "callout" && block.localId === "custom-panel-local",
  );
  const codeGutterParagraphs =
    documentXml.match(/<w:ind w:start="480" w:hanging="480"\/>/gu)?.length ?? 0;
  const codeGutterRuns =
    documentXml.match(/<w:color w:val="6B778C"\/>/gu)?.length ?? 0;
  const expectedCodeLines = ADF_CODE_BLOCK_SOURCE.split("\n").length;
  const codeParagraphTexts = numberedCodeParagraphTexts(documentXml);

  const result: AdfSourceCaseResult = {
    representation: decodedPdf.representation,
    blockTypes: pdfSource.blocks.map((block) => block.type),
    sourceNoteCodes: pdfSource.sourceNotes.map((note) => note.code),
    pdfTagged: inspection.tagged,
    pdfPageCount: inspection.pageCount,
    docxHasInlineCode: documentXml.includes('w:rFonts w:ascii="JetBrains Mono"'),
    docxHasEmbeddedCodeFont:
      (embeddedCodeFont?.asUint8Array().byteLength ?? 0) > 250_000
      && fontTableXml.includes('<w:font w:name="JetBrains Mono">')
      && fontTableXml.includes("<w:embedRegular")
      && fontTableRels.includes("relationships/font")
      && relationships.includes("relationships/fontTable"),
    docxHasEmoji: documentXml.includes("⚠️"),
    docxHasCustomEmojiFallback: documentXml.includes(":custom_party:"),
    docxHasBlockAlignment: documentXml.includes('<w:jc w:val="center"/>'),
    docxHasBlockIndentation: documentXml.includes('<w:ind w:start="1440"/>'),
    docxHasSmallParagraphText:
      documentXml.includes('<w:sz w:val="18"/>') &&
      documentXml.includes('<w:szCs w:val="18"/>'),
    docxHasNestedListSemantics:
      documentXml.includes("Third item")
      && documentXml.includes("Eighth nested item")
      && numberingXml.includes('<w:start w:val="3"/>')
      && numberingXml.includes('<w:start w:val="8"/>')
      && documentXml.includes("Bullet parent")
      && documentXml.includes("Bullet child")
      && documentXml.includes('<w:ilvl w:val="1"/>'),
    docxHasTaskAndDecisionSemantics:
      documentXml.includes("☐")
      && documentXml.includes("☑")
      && documentXml.includes("◆")
      && documentXml.includes("Nested task"),
    docxHasCodeLineNumbers:
      codeGutterParagraphs === expectedCodeLines
      // Other authored content may legitimately use the same muted color.
      && codeGutterRuns >= expectedCodeLines
      && documentXml.includes('<w:t xml:space="preserve">1</w:t>')
      && documentXml.includes(`<w:t xml:space="preserve">${expectedCodeLines}</w:t>`)
      && JSON.stringify(codeParagraphTexts) === JSON.stringify(ADF_CODE_BLOCK_SOURCE.split("\n")),
    docxHasCustomPanelPresentation:
      documentXml.includes('w:fill="DBE1E6"')
      && documentXml.includes('w:color="123456"')
      && documentXml.includes("★")
      && documentXml.includes("ADF custom panel")
      && !documentXml.includes(":star:"),
    neutralHasBlockLocalIdentities:
      JSON.stringify(pdfSource.blocks).includes('"localId":"heading-local"')
      && JSON.stringify(pdfSource.blocks).includes('"localId":"paragraph-local"')
      && JSON.stringify(pdfSource.blocks).includes('"localId":"ordered-item-local"')
      && JSON.stringify(pdfSource.blocks).includes('"localId":"bullet-item-local"'),
    neutralHasCodeBlockSemantics:
      neutralCodeBlock?.type === "codeBlock"
      && neutralCodeBlock.code === ADF_CODE_BLOCK_SOURCE
      && neutralCodeBlock.language === "typescript"
      && neutralCodeBlock.wrap === false
      && neutralCodeBlock.hideLineNumbers === false
      && neutralCodeBlock.localId === "code-local"
      && neutralCodeBlock.uniqueId === "code-unique",
    neutralHasCustomPanelSemantics:
      neutralCustomPanel?.type === "callout"
      && neutralCustomPanel.kind === "panel"
      && neutralCustomPanel.panelColor === "#123456"
      && neutralCustomPanel.panelIcon === ":star:"
      && neutralCustomPanel.panelIconId === "custom-panel-icon"
      && neutralCustomPanel.panelIconText === "★",
    neutralHasMentionSemantics:
      JSON.stringify(pdfSource.blocks).includes(
        '"type":"mention","accountId":"mention-account-1","sourceText":"@Example Person","displayName":"Example Person","localId":"mention-local","accessLevel":"SITE","userType":"DEFAULT"',
      ),
    neutralHasDateStatusPlaceholderSemantics:
      JSON.stringify(pdfSource.blocks).includes(
        '"type":"date","timestamp":"1709510400000","localId":"date-local"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"type":"status","text":"Ready","color":"purple","localId":"status-local"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"type":"status","text":"Keep Case","color":"neutral","style":"mixedCase"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"type":"placeholder","text":"editor-only-secret","localId":"placeholder-local"',
      ),
    neutralHasAnnotationAndFragmentIdentity:
      JSON.stringify(pdfSource.blocks).includes('"id":"annotation-inline-code","annotationType":"inlineComment"')
      && JSON.stringify(pdfSource.blocks).includes('"localId":"table-fragment","name":"semantic-table"'),
    neutralHasTablePresentation:
      JSON.stringify(pdfSource.blocks).includes(
        '"presentation":{"layout":"align-end","width":480,"displayMode":"fixed","numberedColumn":true,"localId":"table-local"}',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"columnWidths":[240],"verticalAlignment":"middle","localId":"table-header-local"',
      ),
    neutralHasLayoutPresentation:
      JSON.stringify(pdfSource.blocks).includes(
        '"type":"layout","columns":[{"width":30,"verticalAlignment":"middle","localId":"layout-sidebar-local"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '{"width":70,"verticalAlignment":"bottom","localId":"layout-main-local"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"localId":"layout-local","breakout":{"mode":"wide","width":960}',
      ),
    neutralHasDisclosureSemantics:
      JSON.stringify(pdfSource.blocks).includes(
        '"type":"expand","nested":false,"title":"Expanded title","localId":"expand-local"',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"type":"expand","nested":true,"title":"Nested expanded title","localId":""',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"type":"mediaFallback","label":"Visible media fallback","media":{"mediaType":"file","id":"unresolved-media"}',
      )
      && JSON.stringify(pdfSource.blocks).includes(
        '"caption":{"kind":"figure","content":[{"type":"text","text":"Media caption"}],"localId":"media-caption-local"}',
      ),
    docxHasTable: documentXml.includes("<w:tbl"),
    docxHasTablePresentation:
      documentXml.includes('<w:tblW w:w="7200" w:type="dxa"/>')
      && documentXml.includes('<w:jc w:val="end"/>')
      && documentXml.includes('<w:tblLayout w:type="fixed"/>')
      && documentXml.includes('<w:vAlign w:val="center"/>')
      && documentXml.includes('<w:vAlign w:val="bottom"/>')
      && documentXml.includes(">1</w:t>"),
    docxHasLayoutPresentation:
      documentXml.includes('<w:gridCol w:w="2700"/>')
      && documentXml.includes('<w:gridCol w:w="6300"/>')
      && documentXml.includes('<w:tblLook w:val="0000"')
      && documentXml.includes("Layout sidebar")
      && documentXml.includes("Layout main"),
    docxHasDisclosureSemantics:
      documentXml.includes("[-] Expanded title")
      && documentXml.includes("Expanded body")
      && documentXml.includes("[-] Nested expanded title")
      && documentXml.includes("Nested expanded body"),
    docxHasDateStatusPlaceholderSemantics:
      documentXml.includes("4. März 2024")
      && documentXml.includes("> READY </w:t>")
      && documentXml.includes("> Keep Case </w:t>")
      && documentXml.includes('w:fill="EAE6FF"')
      && !documentXml.includes("editor-only-secret")
      && !documentXml.includes("1709510400000"),
    docxHasMentionPresentation:
      documentXml.includes("@Example Person")
      && !documentXml.includes("mention-account-1"),
    docxHasCardTitle:
      documentXml.includes("Local card title")
      && (documentXml.includes("https://example.invalid/adf-card")
        || relationships.includes("https://example.invalid/adf-card")),
    docxHasExtensionBody: documentXml.includes("Extension body"),
    docxHasVisibleMediaFallback: documentXml.includes("Visible media fallback") && documentXml.includes("Media caption"),
    pdfJobArtifactAndReportParity:
      pdfJobParity.byteIdentical && pdfJobParity.reportIdentical,
    docxJobArtifactAndReportParity:
      docxJobParity.partsIdentical
      && docxJobParity.mediaIdentical
      && docxJobParity.reportIdentical,
  };

  if (!result.docxHasCodeLineNumbers) {
    throw new Error(
      "ADF-source DOCX assertion failed: docxHasCodeLineNumbers "
      + `(gutter paragraphs ${codeGutterParagraphs}/${expectedCodeLines}, muted runs ${codeGutterRuns}).`,
    );
  }
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith("docxHas") && value !== true) {
      throw new Error(`ADF-source DOCX assertion failed: ${key}.`);
    }
  }
  if (!result.sourceNoteCodes.includes("adf-media-unresolved")) {
    throw new Error("ADF-source case lost the unresolved-media degradation note.");
  }
  if (!result.sourceNoteCodes.includes("emoji-text-fallback")) {
    throw new Error("ADF-source case lost the custom-emoji textual fallback note.");
  }
  if (result.sourceNoteCodes.filter((code) => code === "expand-static").length !== 2) {
    throw new Error("ADF-source case lost a static-disclosure report fact.");
  }
  if (!result.pdfJobArtifactAndReportParity || !result.docxJobArtifactAndReportParity) {
    throw new Error("ADF-source direct/background artifact or report parity failed.");
  }
  if (!result.neutralHasAnnotationAndFragmentIdentity) {
    throw new Error("ADF-source annotation or fragment identity was lost in the packed browser.");
  }
  if (!result.neutralHasBlockLocalIdentities) {
    throw new Error("ADF-source paragraph, heading, or list-item identity was lost in the packed browser.");
  }
  if (!result.neutralHasCodeBlockSemantics) {
    throw new Error("ADF-source code-block presentation or identity was lost in the packed browser.");
  }
  if (!result.neutralHasCustomPanelSemantics) {
    throw new Error("ADF-source custom-panel presentation or identity was lost in the packed browser.");
  }
  if (!result.neutralHasMentionSemantics || !result.docxHasMentionPresentation) {
    throw new Error("ADF-source mention semantics or privacy-safe presentation was lost in the packed browser.");
  }
  if (!result.neutralHasDateStatusPlaceholderSemantics) {
    throw new Error("ADF-source date, status, or placeholder semantics were lost in the packed browser.");
  }
  if (!result.neutralHasTablePresentation) {
    throw new Error("ADF-source table presentation was lost in the packed browser.");
  }
  if (!result.neutralHasLayoutPresentation) {
    throw new Error("ADF-source layout presentation was lost in the packed browser.");
  }
  if (!result.neutralHasDisclosureSemantics) {
    throw new Error("ADF-source disclosure or caption semantics were lost in the packed browser.");
  }
  return result;
}
