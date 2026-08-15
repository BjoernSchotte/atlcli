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
import { Check, FileText, FileType2, Settings2 } from "lucide-react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import { useT } from "../../utils/i18n/context.js";
import { Button } from "../ui/button.js";
import { cn } from "../ui/utils.js";
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
import { SETTINGS_SCREEN_ID } from "./SettingsScreen.js";
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
        <StudioHeading onOpenSettings={() => navigate(SETTINGS_SCREEN_ID)} />
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
    imageProfile,
    setImageProfile,
    imagePpi,
    setImagePpi,
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
      <StudioHeading onOpenSettings={() => navigate(SETTINGS_SCREEN_ID)} />
      <PageSummary state={page} onRetry={retry} />

      <StudioStep number="01" label={t("studio.step.scope")} complete>
        <ScopeSection
          state={scope}
          dispatch={dispatchScope}
          context={scopeContext}
          resolveMacros={resolveMacros}
          onResolveMacrosChange={setResolveMacros}
        />
      </StudioStep>

      <StudioStep number="02" label={t("studio.step.format")} complete>
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
            <p className="m-0 rounded-lg border bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t("pdf.builtIn")}
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor="pdf-image-quality">
                {t("export.imageQuality")}
              </label>
              <select
                id="pdf-image-quality"
                data-testid="pdf-image-quality"
                className="h-11 rounded-md border bg-background px-2.5 text-sm"
                value={imageProfile}
                onChange={(event) =>
                  setImageProfile(event.target.value as "original" | "standard" | "print")
                }
              >
                <option value="original">{t("export.imageQuality.original")}</option>
                <option value="standard">{t("export.imageQuality.standard")}</option>
                <option value="print">{t("export.imageQuality.print")}</option>
              </select>
              {imageProfile !== "original" && (
                <input
                  type="number"
                  min={72}
                  max={1200}
                  data-testid="pdf-image-ppi"
                  className="h-11 rounded-md border bg-background px-2.5 text-sm"
                  placeholder={t("export.imageQuality.ppi")}
                  value={imagePpi ?? ""}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    setImagePpi(
                      Number.isSafeInteger(parsed) && parsed >= 72 && parsed <= 1200
                        ? parsed
                        : undefined,
                    );
                  }}
                />
              )}
            </div>
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
  complete = false,
}: {
  number: string;
  label: string;
  children: React.ReactNode;
  complete?: boolean;
}): React.JSX.Element {
  const t = useT();
  return (
    <section
      className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2.5 pb-5 after:absolute after:bottom-0 after:left-[13px] after:top-7 after:w-px after:bg-border last:pb-0 last:after:hidden"
      data-testid={`studio-step-${number}`}
    >
      <span
        className={cn(
          "relative z-10 grid size-7 place-items-center rounded-full border bg-background text-xs font-bold",
          complete
            ? "border-success/30 bg-success/10 text-success"
            : "border-input text-muted-foreground"
        )}
        aria-label={complete ? t("studio.step.complete") : undefined}
      >
        {complete ? <Check size={14} aria-hidden="true" /> : number}
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 className="m-0 text-[13px] font-bold tracking-[-0.01em]">{label}</h2>
        <div className="mt-2">
          {children}
        </div>
      </div>
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
    <label className="relative min-w-0 cursor-pointer" data-testid={testId}>
      <input
        type="radio"
        name="publishing-format"
        value={title}
        checked={active}
        onChange={onClick}
        className="peer sr-only"
      />
      <span
        className={cn(
          "grid min-h-[58px] content-center gap-1 rounded-lg border bg-card px-2.5 py-2 text-left",
          "transition-colors peer-focus-visible:outline peer-focus-visible:outline-2",
          "peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
          "peer-checked:border-primary/45 peer-checked:bg-accent peer-checked:text-primary hover:border-input hover:bg-muted"
        )}
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-bold [&>svg]:size-4">
          {icon}
          {title}
        </span>
        <span className="truncate text-xs leading-tight text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

function StudioHeading({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <div className="mb-1 flex items-start justify-between gap-4">
      <div>
        <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.13em] text-primary">
          {t("studio.kicker")}
        </span>
        <h1 className="m-0 font-serif text-[26px] font-semibold leading-none tracking-[-0.04em]">
          {t("studio.heading")}
        </h1>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0"
        aria-label={t("studio.settings")}
        title={t("studio.settings")}
        onClick={onOpenSettings}
        data-testid="publishing-settings"
      >
        <Settings2 aria-hidden="true" />
      </Button>
    </div>
  );
}
