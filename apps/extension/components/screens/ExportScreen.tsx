/**
 * The Export screen — one scope, two engines (spec 010 T5.1 / Architecture
 * point 7).
 *
 * Layout, top to bottom: the page summary, the **shared** `ScopeSection`, then
 * the PDF and Word panels. The scope lives here rather than in either panel so
 * the two engines cannot disagree about what "the export" covers; the panels
 * receive the derived `ExportScope`/`LabelFilter` and hand them straight to
 * their port.
 *
 * The two engine panels stay independently mountable: a host that advertises
 * `docx-export` but not `pdf-export` (SPIKE.md's conditional GO, "Browserbasis
 * nur DOCX") gets the Word panel and nothing else, with no branching anywhere
 * but the two `&&`s below.
 *
 * **Defaults are today's behaviour.** `initialScopeState` is "current page, no
 * filters", macro resolution is on, and every other knob is behind
 * `ScopeSection`'s closed `<details>`. Opening the panel and clicking Export is
 * exactly as many interactions as before this screen learned about trees.
 *
 * **PDF settings are PDF settings.** `SettingsForm`'s values reach
 * `PdfExportRequest.settings`; `DocxExportRequest` deliberately has no such
 * field (`packages/docx`'s `ExportInput` has none), so nothing here can write
 * one — see `settings-schema.ts`.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, FileType2 } from "lucide-react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { useT } from "../../utils/i18n/context.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { PageSummary } from "../export/PageSummary.js";
import { PdfExportPanel } from "../export/PdfExportPanel.js";
import { DocxExportPanel } from "../export/DocxExportPanel.js";
import { ScopeSection } from "../export/ScopeSection.js";
import { SpaceExportConfirm } from "../export/SpaceExportConfirm.js";
import { SettingsForm } from "../export/SettingsForm.js";
import {
  CODE_THEME_SETTINGS,
  PDF_LEVEL_A_SETTINGS,
} from "../export/pdf-settings.js";
import { TEMPLATES_SCREEN_ID } from "./TemplatesScreen.js";
import { PreviewScreen } from "./PreviewScreen.js";
import {
  PublishingDraftProvider,
  useOptionalPublishingDraft,
  usePublishingDraft,
} from "../app/publishing-draft.js";

/**
 * `BUILTIN_PDF_TEMPLATE_ID` from `@atlcli/pdf`, duplicated as a literal so the
 * portable app layer does not pull the PDF engine barrel (and with it the
 * runtime font inventory) into the panel's first chunk for one string.
 * `tests/settings-form.test.tsx` asserts the two are equal, so a rename in the
 * engine fails loudly instead of silently orphaning everyone's saved settings.
 */
export { PDF_BUILTIN_TEMPLATE_ID } from "../app/publishing-draft.js";

export function ExportScreen(props: ScreenProps): React.JSX.Element {
  const draft = useOptionalPublishingDraft();
  if (draft) return <ExportScreenBody {...props} />;
  return (
    <PublishingDraftProvider ports={props.ports} page={props.page}>
      <ExportScreenBody {...props} />
    </PublishingDraftProvider>
  );
}

function ExportScreenBody({ ports, page, retry, navigate }: ScreenProps): React.JSX.Element {
  if (page.status !== "loaded") {
    return (
      <div className="flex flex-col gap-3" data-testid="publishing-studio">
        <PageSummary state={page} onRetry={retry} />
      </div>
    );
  }

  return <LoadedExportScreenBody ports={ports} page={page} retry={retry} navigate={navigate} />;
}

function LoadedExportScreenBody({ ports, page, retry, navigate }: ScreenProps): React.JSX.Element {
  const t = useT();
  const loadedPage = page.status === "loaded" ? page.page : null;
  const pageUrl = page.status === "loaded" ? page.ref.url : null;
  const spaceKey = loadedPage?.details.spaceKey ?? undefined;
  const {
    format,
    setFormat,
    scope,
    dispatchScope,
    scopeContext,
    exportScope,
    labels,
    scopeRequest,
    resolveMacros,
    setResolveMacros,
    values,
    onSettingChange,
    onSettingsReset,
    pdfSettings,
  } = usePublishingDraft();

  // ---- The space-export confirmation ---------------------------------------

  const [pending, setPending] = useState<(() => void) | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  // Bound once per `ports`: a fresh `.bind()` on every render would give the
  // effect below a new dependency identity each time, and the `setCounting`
  // inside it would then re-trigger the effect forever.
  const countScopePages = useMemo(
    () => (ports.countScopePages ? ports.countScopePages.bind(ports) : null),
    [ports]
  );

  useEffect(() => {
    if (!pending || !exportScope || !countScopePages) return;
    const controller = new AbortController();
    setCounting(true);
    void countScopePages({ scope: exportScope, labels, signal: controller.signal })
      .then((count) => {
        if (!controller.signal.aborted) setPageCount(count);
      })
      .catch(() => {
        // A failed estimate is "count unknown", never a blocked export.
      })
      .finally(() => {
        if (!controller.signal.aborted) setCounting(false);
      });
    return () => controller.abort();
  }, [pending, exportScope, labels, countScopePages]);

  /**
   * The single place an engine panel asks to start.
   *
   * Only `space` scope is gated: a page or a bounded tree is a cost the user
   * chose explicitly and can cancel, whereas a whole space is the one scope
   * whose size the panel cannot show before asking.
   */
  const gate = useCallback(
    (run: () => void) => {
      if (scope.kind !== "space") {
        run();
        return;
      }
      setPageCount(null);
      // Stored as a thunk-returning updater: `setState(fn)` would *call* a bare
      // function instead of storing it.
      setPending(() => run);
    },
    [scope.kind]
  );

  // Changing the scope while the confirmation is open retracts the question:
  // the pending closure captured the scope as it was at click time, so
  // answering "continue" afterwards would export something the dialog no
  // longer describes.
  useEffect(() => {
    if (scope.kind !== "space") setPending(null);
  }, [scope.kind]);

  const confirm = useCallback(() => {
    const run = pending;
    setPending(null);
    run?.();
  }, [pending]);

  const pdfSettingsSummary = useMemo(() => {
    const parts = [
      values.page === "letter" ? t("pdf.settings.page.letter") : t("pdf.settings.page.a4"),
      values.orientation === "landscape"
        ? t("pdf.settings.orientation.landscape")
        : t("pdf.settings.orientation.portrait"),
    ];
    if (values.cover === true) parts.push(t("pdf.settings.cover"));
    if (values.outline === true) parts.push(t("pdf.settings.outline"));
    return parts.join(" · ");
  }, [t, values.cover, values.orientation, values.outline, values.page]);

  return (
    <div className="flex flex-col gap-3" data-testid="publishing-studio">
      <PageSummary state={page} onRetry={retry} />

      <StudioStep number="01" label={t("studio.step.scope")}>
        <ScopeSection
          state={scope}
          dispatch={dispatchScope}
          context={scopeContext}
          resolveMacros={resolveMacros}
          onResolveMacrosChange={setResolveMacros}
        />
      </StudioStep>

      <StudioStep number="02" label={t("studio.step.format")}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("studio.format.label")}>
          {ports.pdf && (
            <FormatChoice
              active={format === "pdf"}
              icon={<FileText aria-hidden="true" />}
              title="PDF"
              detail={t("studio.format.pdfDetail")}
              onClick={() => setFormat("pdf")}
              testId="format-pdf"
            />
          )}
          {ports.docx && ports.docxTemplates && (
            <FormatChoice
              active={format === "docx"}
              icon={<FileType2 aria-hidden="true" />}
              title="Word"
              detail={t("studio.format.docxDetail")}
              onClick={() => setFormat("docx")}
              testId="format-docx"
            />
          )}
        </div>
      </StudioStep>

      {pending !== null && (
        <SpaceExportConfirm
          spaceKey={spaceKey ?? ""}
          pageCount={pageCount}
          counting={counting}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      )}

      {ports.pdf && (
        <div
          hidden={format !== "pdf"}
          style={format !== "pdf" ? { display: "none" } : undefined}
          className="flex flex-col gap-3"
        >
          <StudioStep number="03" label={t("studio.step.design")}>
            <SettingsForm
              schema={PDF_LEVEL_A_SETTINGS}
              values={values}
              onChange={onSettingChange}
              onReset={onSettingsReset}
              idPrefix="pdf-settings"
              collapsible
              summary={pdfSettingsSummary}
            />
          </StudioStep>

          {ports.host.capabilities.includes("pdf-preview") && (
            <StudioStep number="04" label={t("studio.step.review")}>
              <div data-testid="studio-preview">
                <PreviewScreen ports={ports} page={page} retry={retry} navigate={navigate} embedded />
              </div>
            </StudioStep>
          )}

          <StudioStep number={ports.host.capabilities.includes("pdf-preview") ? "05" : "04"} label={t("studio.step.export")}>
            <PdfExportPanel
              port={ports.pdf}
              page={loadedPage}
              pageUrl={pageUrl}
              scopeRequest={scopeRequest}
              settings={pdfSettings}
              gate={gate}
              compact
            />
          </StudioStep>
        </div>
      )}

      {ports.docx && ports.docxTemplates && (
        <div
          hidden={format !== "docx"}
          style={format !== "docx" ? { display: "none" } : undefined}
          className="flex flex-col gap-3"
        >
          <StudioStep number="03" label={t("export.codeTheme")}>
            <SettingsForm
              schema={CODE_THEME_SETTINGS}
              values={values}
              onChange={onSettingChange}
              idPrefix="docx-code-theme"
            />
          </StudioStep>
          <DocxExportPanel
            port={ports.docx}
            store={ports.docxTemplates}
            page={loadedPage}
            pageUrl={pageUrl}
            scopeRequest={scopeRequest}
            gate={gate}
          />

          {ports.templates && (
            <div className="border-t pt-3">
              <Button
                size="sm"
                variant="outline"
                data-testid="open-template-library"
                onClick={() => navigate(TEMPLATES_SCREEN_ID)}
              >
                {t("templates.manage")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StudioStep({
  number,
  label,
  children,
}: {
  number: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5" data-testid={`studio-step-${number}`}>
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        <span className="text-primary">{number}</span>
        <span>{label}</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}

function FormatChoice({
  active,
  icon,
  title,
  detail,
  onClick,
  testId,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  testId: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-testid={testId}
      onClick={onClick}
      className={
        "min-h-16 rounded-lg border p-2 text-left transition-colors " +
        (active
          ? "border-primary bg-accent text-foreground shadow-sm"
          : "bg-card text-foreground hover:border-primary/40 hover:bg-accent/50")
      }
    >
      <span className="mb-1 block text-primary [&>svg]:size-4">{icon}</span>
      <span className="block text-xs font-semibold">{title}</span>
      <span className="block text-[10px] leading-tight text-muted-foreground">{detail}</span>
    </button>
  );
}
