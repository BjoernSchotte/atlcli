/**
 * The template library list (spec 010 T5.2, BASELINE-DESIGN B2).
 *
 * Replaces the single-slot "upload / replace / delete" surface with the actual
 * library: every stored template, its scope badge, when it was uploaded, and
 * its scan verdict. Actions are upload, set active, assign to the current
 * space, delete.
 *
 * Four properties this component is responsible for:
 *
 *  - **The scan verdict is re-derived on read, never persisted.** It is
 *    computed by calling the export port's `scan()` over the bytes the library
 *    just returned, on demand, per row. A stored verdict drifted from its bytes
 *    once already (spec 004); the panel's promise and the export's delivery are
 *    therefore computed the same way, from the same bytes.
 *  - **A sha256 mismatch is a hard error.** `getBytes` throws
 *    `TemplateIntegrityError` ("template was modified, re-upload") and the row
 *    shows exactly that. There is deliberately no fallback to another entry:
 *    silently exporting with a different template than the one named is the
 *    failure mode this check exists to prevent.
 *  - **"Assign to current space" creates a new entry**, carrying the source
 *    entry's logical `templateId` with `scope: "space"`. The global row is
 *    never mutated, so deleting the override falls back to the global entry —
 *    the same two-level model `resolveTemplate` implements for the CLI.
 *  - **DOCX template bytes only.** PDF renders with the built-in document
 *    design; 007's Level-B custom-Typst render path does not exist, so a PDF
 *    upload control here would promise something no engine can do.
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  DocxExportPort,
  TemplateLibraryItem,
  TemplateLibraryPort,
} from "../../utils/ports/index.js";
import { useT } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { Badge, FieldHelp, SectionHeading } from "../ui/field.js";
import { ScanView } from "./ScanView.js";
import { templateRejectionMessage } from "./docx-template.js";
import { formatDate } from "./format.js";
import type { ScanResult } from "@atlcli/docx/scan";

const MAX_MB = 20;
const ENGINE = "docx" as const;

/** Duck-typed engine rejection: `DocxError` carries a `kind` plus a message. */
function isDocxRejection(value: unknown): value is { kind: string; message: string } {
  return value instanceof Error && typeof (value as { kind?: unknown }).kind === "string";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TemplateLibraryPanelProps {
  library: TemplateLibraryPort;
  /** Needed to re-derive a scan from stored bytes. `null` disables the verdict. */
  scanner: Pick<DocxExportPort, "scan"> | null;
  /** The loaded page's space, when known — gates "assign to this space". */
  spaceKey: string | null;
}

interface RowState {
  scan?: ScanResult;
  error?: string;
  busy?: boolean;
}

export function TemplateLibraryPanel({
  library,
  scanner,
  spaceKey,
}: TemplateLibraryPanelProps): React.JSX.Element {
  const t = useT();
  const [items, setItems] = useState<TemplateLibraryItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [entries, active] = await Promise.all([
      library.listAll(ENGINE),
      library.getActiveTemplateId(ENGINE, spaceKey ?? undefined),
    ]);
    setItems(entries);
    setActiveId(active);
  }, [library, spaceKey]);

  useEffect(() => {
    let cancelled = false;
    void refresh().catch((reason) => {
      if (!cancelled) setError(t("templates.error.list", { message: messageOf(reason) }));
    });
    return () => {
      cancelled = true;
    };
  }, [refresh, t]);

  const setRow = useCallback((recordKey: string, patch: RowState): void => {
    setRows((prev) => ({ ...prev, [recordKey]: { ...prev[recordKey], ...patch } }));
  }, []);

  /**
   * Load an entry's bytes and classify them. Two failures are distinct and must
   * stay distinct: an integrity failure is "these are not the bytes you
   * uploaded", an engine rejection is "these bytes are not a usable template".
   */
  const verify = useCallback(
    async (item: TemplateLibraryItem): Promise<void> => {
      setRow(item.recordKey, { busy: true, error: undefined, scan: undefined });
      try {
        const bytes = await library.getBytes(item);
        const scan = scanner ? await scanner.scan(bytes) : undefined;
        setRow(item.recordKey, { busy: false, scan });
      } catch (reason) {
        setRow(item.recordKey, {
          busy: false,
          // The integrity message is quoted verbatim — it is the shared
          // engine's wording and matches what the CLI would print.
          error: isDocxRejection(reason)
            ? templateRejectionMessage(t, reason)
            : messageOf(reason),
        });
      }
    },
    [library, scanner, setRow, t]
  );

  async function onFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);

    if (!/\.docx$/i.test(file.name)) {
      setError(t("docx.error.notDocx"));
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(t("docx.error.tooLarge", { limit: MAX_MB }));
      return;
    }

    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      // Validate BEFORE persisting — a rejected template is never stored.
      if (scanner) await scanner.scan(new Uint8Array(bytes));
      const added = await library.add({ name: file.name, bytes });
      await library.setActiveTemplateId(ENGINE, spaceKey ?? undefined, added.id);
      await refresh();
    } catch (reason) {
      setError(
        isDocxRejection(reason)
          ? templateRejectionMessage(t, reason)
          : t("docx.error.read", { message: messageOf(reason) })
      );
    } finally {
      setUploading(false);
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    }
  }

  return (
    <section data-testid="template-library" className="flex flex-col gap-2">
      <SectionHeading>{t("templates.title")}</SectionHeading>
      <FieldHelp>{t("templates.docxOnly")}</FieldHelp>

      <input
        ref={fileRef}
        type="file"
        accept=".docx"
        onChange={onFile}
        data-testid="template-library-file"
        className="hidden"
      />
      <div>
        <Button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          data-testid="template-library-upload"
        >
          {uploading ? t("docx.scanning") : t("docx.upload")}
        </Button>
      </div>

      {error && (
        <Alert role="alert" tone="danger" data-testid="template-library-error">
          {error}
        </Alert>
      )}

      {items === null ? (
        <FieldHelp data-testid="template-library-loading">{t("templates.loading")}</FieldHelp>
      ) : items.length === 0 ? (
        <FieldHelp data-testid="template-library-empty">{t("templates.empty")}</FieldHelp>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="template-library-list">
          {items.map((item) => {
            const row = rows[item.recordKey] ?? {};
            const isActive = item.id === activeId;
            const canAssign =
              spaceKey !== null && !(item.scope === "space" && item.spaceKey === spaceKey);
            return (
              <li key={item.recordKey}>
                <Card data-testid={`template-row-${item.recordKey}`}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <strong className="block truncate text-sm" data-testid="template-row-name">
                          {item.displayName}
                        </strong>
                        <span className="text-xs text-muted-foreground">
                          {item.fileName} · {formatDate(Date.parse(item.uploadedAt))}
                        </span>
                      </div>
                      <span className="flex shrink-0 items-center gap-1">
                        <Badge
                          tone={item.scope === "space" ? "accent" : "muted"}
                          data-testid="template-row-scope"
                        >
                          {item.scope === "space"
                            ? t("templates.scope.space", { spaceKey: item.spaceKey ?? "" })
                            : t("templates.scope.global")}
                        </Badge>
                        {isActive && (
                          <Badge tone="accent" data-testid="template-row-active">
                            {t("templates.active")}
                          </Badge>
                        )}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isActive}
                        data-testid={`template-activate-${item.recordKey}`}
                        onClick={() =>
                          void run(() =>
                            library.setActiveTemplateId(ENGINE, spaceKey ?? undefined, item.id)
                          )
                        }
                      >
                        {t("templates.setActive")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canAssign}
                        title={
                          spaceKey === null ? t("templates.assignNeedsSpace") : undefined
                        }
                        data-testid={`template-assign-${item.recordKey}`}
                        onClick={() =>
                          void run(async () => {
                            if (spaceKey) await library.assignToSpace(item, spaceKey);
                          })
                        }
                      >
                        {t("templates.assignToSpace", { spaceKey: spaceKey ?? "" })}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={row.busy}
                        data-testid={`template-verify-${item.recordKey}`}
                        onClick={() => void verify(item)}
                      >
                        {row.busy ? t("templates.checking") : t("templates.check")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`template-delete-${item.recordKey}`}
                        onClick={() => void run(() => library.remove(item.recordKey))}
                      >
                        {t("docx.delete")}
                      </Button>
                    </div>

                    {row.error && (
                      <Alert
                        role="alert"
                        tone="danger"
                        className="mt-2"
                        data-testid={`template-row-error-${item.recordKey}`}
                      >
                        {row.error}
                      </Alert>
                    )}
                    {row.scan && <ScanView scan={row.scan} />}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
