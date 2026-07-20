/**
 * The Export screen — today's panel functionality, rebuilt on ports.
 *
 * The two engine panels are rendered independently: a host that advertises
 * `docx-export` but not `pdf-export` (SPIKE.md's conditional GO, "Browserbasis
 * nur DOCX") gets the Word panel and nothing else, with no branching anywhere
 * else in the app. T5.1's `ScopeSection` slots in above them; T5.3's preview
 * becomes its own registered screen rather than a fork of this one.
 */
import React from "react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { PageSummary } from "../export/PageSummary.js";
import { PdfExportPanel } from "../export/PdfExportPanel.js";
import { DocxExportPanel } from "../export/DocxExportPanel.js";

export function ExportScreen({ ports, page, retry }: ScreenProps): React.JSX.Element {
  const loadedPage = page.status === "loaded" ? page.page : null;
  const pageUrl = page.status === "loaded" ? page.ref.url : null;

  return (
    <div className="flex flex-col gap-4">
      <PageSummary state={page} onRetry={retry} />

      {ports.pdf && (
        <PdfExportPanel port={ports.pdf} page={loadedPage} pageUrl={pageUrl} />
      )}

      {ports.docx && ports.docxTemplates && (
        <DocxExportPanel
          port={ports.docx}
          store={ports.docxTemplates}
          page={loadedPage}
          pageUrl={pageUrl}
        />
      )}
    </div>
  );
}
