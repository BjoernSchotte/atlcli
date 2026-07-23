/**
 * Word template panel — a port consumer (spec 010 Phase 0).
 *
 * Upload/scan/persist and export all run through {@link DocxTemplateStore} and
 * {@link DocxExportPort}; this component owns no IndexedDB, no engine import
 * and no `chrome` call. Phase 0 deliberately keeps the **single-slot**
 * behaviour the panel has today even though the store underneath is now a
 * multi-slot library (T5.2): the library UI — list, scope badges, assign to
 * space — is wave-2 work, and shipping half of it here would land in the panel
 * shape T5.2 then has to rewrite.
 */
import React, { useEffect, useRef, useState } from "react";
import type { LoadedPage } from "../../utils/read-path.js";
import type {
  DocxExportPort,
  DocxTemplateStore,
  ExportScopeRequest,
} from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { SectionHeading } from "../ui/field.js";
import { useExportRuns } from "../app/export-runs.js";
import { ScanView } from "./ScanView.js";
import { ReportView } from "./DocxReportView.js";
import {
  loadCurrentTemplate,
  templateRejectionMessage,
  type CurrentTemplate,
} from "./docx-template.js";

const MAX_MB = 20;

/** Duck-typed engine rejection: `DocxError` carries a `kind` plus a message. */
function isDocxRejection(value: unknown): value is { kind: string; message: string } {
  return (
    value instanceof Error &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function DocxExportPanel({
  port,
  store,
  page,
  pageUrl,
  scopeRequest,
  gate = (run) => run(),
}: {
  port: DocxExportPort;
  store: DocxTemplateStore;
  page: LoadedPage | null;
  pageUrl: string | null;
  /**
   * The **shared** scope, owned by the Export screen above both engines.
   *
   * Note what is *not* here and must never be: a `settings` field.
   * `packages/docx`'s `ExportInput` has none, so anything the panel put on a
   * `DocxExportRequest` would be dropped while looking like a feature.
   */
  scopeRequest?: ExportScopeRequest;
  /** Lets the screen interpose a confirmation (space scope) before starting. */
  gate?: (run: () => void) => void;
}): React.JSX.Element {
  const t = useT();
  const { docx, startDocx, setDocxError } = useExportRuns();
  const [template, setTemplate] = useState<CurrentTemplate | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = page !== null && pageUrl !== null;

  // Re-read the persisted template on mount (survives a panel reload). The scan
  // is RE-DERIVED from the stored bytes rather than restored: persisting it made
  // it drift once already, so the panel's promise and the export's delivery are
  // computed the same way (see `loadCurrentTemplate`).
  useEffect(() => {
    let cancelled = false;
    void loadCurrentTemplate(
      () => store.get(),
      async () => (bytes) => port.scan(bytes)
    )
      .then((current) => {
        if (cancelled || !current) return;
        setTemplate(current);
        // A stored template means an export is likely: warm the heavy chunks now
        // so the first Export click does not pay the cold import. Pure warm-up.
        port.warm?.();
      })
      .catch(() => {
        if (!cancelled) setDocxError(t("docx.error.storedUnreadable"));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, store]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setDocxError(null);

    if (!/\.docx$/i.test(file.name)) {
      setDocxError(t("docx.error.notDocx"));
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setDocxError(t("docx.error.tooLarge", { limit: MAX_MB }));
      return;
    }

    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      // Validate + scan BEFORE persisting — store nothing on failure.
      const scan = await port.scan(new Uint8Array(buffer));
      port.warm?.();
      const stored = await store.put({ name: file.name, bytes: buffer });
      setTemplate({
        name: stored.name,
        uploadedAt: stored.uploadedAt,
        scan,
        bytes: stored.bytes,
        ...(stored.recordKey ? { recordKey: stored.recordKey } : {}),
        ...(stored.sha256 ? { sha256: stored.sha256 } : {}),
      });
    } catch (error) {
      setDocxError(
        isDocxRejection(error)
          ? templateRejectionMessage(t, error)
          : t("docx.error.read", {
              message: error instanceof Error ? error.message : String(error),
            })
      );
    } finally {
      setUploading(false);
    }
  }

  async function onDelete(): Promise<void> {
    await store.remove();
    setTemplate(null);
    setDocxError(null);
  }

  const busy = uploading || docx.running;

  return (
    <section data-testid="template-section" className="flex flex-col gap-2">
      <SectionHeading>{t("docx.title")}</SectionHeading>

      <input
        ref={fileRef}
        type="file"
        accept=".docx"
        onChange={onFile}
        data-testid="template-file"
        className="hidden"
      />

      {!template ? (
        <div>
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="template-upload"
          >
            {uploading ? t("docx.scanning") : t("docx.upload")}
          </Button>
        </div>
      ) : (
        <Card data-testid="template-current">
          <CardContent className="p-3">
            <div className="flex items-center justify-between gap-2">
              <strong className="truncate text-sm" data-testid="template-name">
                {template.name}
              </strong>
              <span className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  data-testid="template-replace"
                >
                  {t("docx.replace")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void onDelete()}
                  disabled={busy}
                  data-testid="template-delete"
                >
                  {t("docx.delete")}
                </Button>
              </span>
            </div>

            <ScanView scan={template.scan} explainWordRendering />

            <div className="mt-2.5 flex items-center gap-2">
              <Button
                onClick={() => {
                  if (ready && !busy) {
                    gate(() =>
                      startDocx(port, {
                        page,
                        pageUrl,
                        template: {
                          name: template.name,
                          uploadedAt: template.uploadedAt,
                          bytes: template.bytes,
                          ...(template.recordKey
                            ? { recordKey: template.recordKey }
                            : {}),
                          ...(template.sha256
                            ? { sha256: template.sha256 }
                            : {}),
                        },
                        ...scopeRequest,
                      })
                    );
                  }
                }}
                disabled={busy || !ready}
                data-testid="template-export"
                title={ready ? t("docx.export") : t("docx.needsPage")}
              >
                {docx.running ? t("docx.exporting") : t("docx.export")}
              </Button>
              {!ready && (
                <span className="text-xs text-muted-foreground">{t("docx.needsPage")}</span>
              )}
            </div>

            {docx.progress && docx.progress.total > 0 && (
              <p className="m-0 mt-1.5 text-xs text-muted-foreground" data-testid="docx-progress">
                {t("export.progress", {
                  fetched: docx.progress.fetched,
                  total: docx.progress.total,
                  title: docx.progress.currentTitle ?? "",
                })}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {docx.error && (
        <Alert role="alert" tone="danger" data-testid="template-error">
          {docx.error}
        </Alert>
      )}

      {docx.report && <ReportView report={docx.report} />}
    </section>
  );
}
