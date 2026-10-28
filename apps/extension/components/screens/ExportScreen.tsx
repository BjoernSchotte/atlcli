/**
 * The Export screen — one scope, two engines (spec 010 T5.1 / Architecture
 * point 7).
 *
 * Layout, top to bottom: the page summary, the **shared** `ScopeSection`, the
 * format switch, the per-engine settings, the live preview — and a **sticky
 * action bar** at the bottom of the scroll container, so the primary export
 * button is visible in every scroll position. The engine panels keep owning
 * their export logic; they merely render their action block into the bar via
 * a portal (`actionSlot`). The scope lives here rather than in either panel so
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
import { FileText, FileType2, Settings2 } from "lucide-react";
import type { ScreenProps } from "../../utils/screens/registry.js";
import type { ScopeKind } from "../../utils/scope-state.js";
import { useT } from "../../utils/i18n/context.js";
import type { MessageKey } from "../../utils/i18n/messages.js";
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

const SCOPE_LABEL_KEYS: Record<ScopeKind, MessageKey> = {
  page: "scope.kind.page",
  tree: "scope.kind.tree",
  space: "scope.kind.space",
};

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
        <StudioContextRow onOpenSettings={() => navigate(SETTINGS_SCREEN_ID)}>
          <PageSummary state={page} onRetry={retry} />
        </StudioContextRow>
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

  // The sticky action bar. The active engine panel renders its export block
  // into this element through a portal, so the button logic stays with the
  // panel while the button itself is always on screen.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);

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

  const footerSummary =
    format === "pdf"
      ? `${t(SCOPE_LABEL_KEYS[scope.kind])} · ${pdfSettingsSummary}`
      : `${t(SCOPE_LABEL_KEYS[scope.kind])} · Word`;

  return (
    <div className="flex flex-col gap-4" data-testid="publishing-studio">
      <StudioContextRow onOpenSettings={() => navigate(SETTINGS_SCREEN_ID)}>
        <PageSummary state={page} onRetry={retry} />
      </StudioContextRow>

      <StudioGroup id="scope" label={t("studio.step.scope")}>
        <ScopeSection
          state={scope}
          dispatch={dispatchScope}
          context={scopeContext}
          resolveMacros={resolveMacros}
          onResolveMacrosChange={setResolveMacros}
        />
      </StudioGroup>

      <StudioGroup id="format" label={t("studio.step.format")}>
        <div
          className="flex overflow-hidden rounded-md border border-input bg-muted"
          role="radiogroup"
          aria-label={t("studio.format.label")}
        >
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
      </StudioGroup>

      {ports.pdf && (
        <div
          hidden={format !== "pdf"}
          style={format !== "pdf" ? { display: "none" } : undefined}
          className="flex flex-col gap-4"
        >
          <StudioGroup id="design" label={t("studio.step.design")}>
            <p className="m-0 rounded-md border bg-muted px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
              {t("pdf.builtIn")}
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor="pdf-image-quality">
                {t("export.imageQuality")}
              </label>
              <select
                id="pdf-image-quality"
                data-testid="pdf-image-quality"
                className="h-9 rounded-md border bg-background px-2.5 text-sm"
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
                  className="h-9 rounded-md border bg-background px-2.5 text-sm"
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
          </StudioGroup>

          {ports.host.capabilities.includes("pdf-preview") && (
            <StudioGroup id="review" label={t("studio.step.review")}>
              <div data-testid="studio-preview">
                <PreviewScreen ports={ports} page={page} retry={retry} navigate={navigate} embedded />
              </div>
            </StudioGroup>
          )}

          <PdfExportPanel
            port={ports.pdf}
            page={loadedPage}
            pageUrl={pageUrl}
            scopeRequest={scopeRequest}
            settings={pdfSettings}
            gate={gate}
            compact
            actionSlot={format === "pdf" ? actionSlot : null}
          />
        </div>
      )}

      {ports.docx && ports.docxTemplates && (
        <div
          hidden={format !== "docx"}
          style={format !== "docx" ? { display: "none" } : undefined}
          className="flex flex-col gap-4"
        >
          <StudioGroup id="code-theme" label={t("export.codeTheme")}>
            <SettingsForm
              schema={CODE_THEME_SETTINGS}
              values={values}
              onChange={onSettingChange}
              idPrefix="docx-code-theme"
            />
          </StudioGroup>
          <DocxExportPanel
            port={ports.docx}
            store={ports.docxTemplates}
            page={loadedPage}
            pageUrl={pageUrl}
            scopeRequest={scopeRequest}
            gate={gate}
            actionSlot={format === "docx" ? actionSlot : null}
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

      {/*
        The sticky action bar. `-bottom-[18px]`/`-mb-[18px]` cancel the scroll
        container's own padding so the bar sits flush with the shell edge, and
        `sticky` keeps the primary action on screen in every scroll position —
        the redesign's core promise: export without scrolling.
      */}
      <div
        className={cn(
          "sticky -bottom-[18px] z-10 -mx-4 -mb-[18px] mt-auto flex flex-col gap-2 border-t",
          "bg-background px-4 py-2.5 shadow-[0_-6px_16px_-10px_rgb(0_0_0/0.25)]"
        )}
        data-testid="studio-footer"
      >
        {pending !== null && (
          <SpaceExportConfirm
            spaceKey={spaceKey ?? ""}
            pageCount={pageCount}
            counting={counting}
            onConfirm={confirm}
            onCancel={() => setPending(null)}
          />
        )}
        <div ref={setActionSlot} className="flex flex-col gap-1.5" data-testid="studio-footer-action" />
        <p className="m-0 truncate text-[11px] text-muted-foreground" data-testid="studio-footer-summary">
          {footerSummary}
        </p>
      </div>
    </div>
  );
}

function StudioGroup({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-testid={`studio-group-${id}`}>
      <h2 className="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </h2>
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
    <label
      className="relative min-w-0 flex-1 cursor-pointer border-r border-border last:border-r-0"
      data-testid={testId}
      title={detail}
    >
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
          "flex min-h-9 items-center justify-center gap-1.5 px-1 text-xs font-medium text-muted-foreground",
          "transition-colors peer-focus-visible:outline peer-focus-visible:outline-2",
          "peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-ring",
          "peer-checked:bg-background peer-checked:font-semibold peer-checked:text-primary",
          "peer-checked:shadow-[inset_0_-2px_0_0_var(--primary)]",
          "hover:text-foreground [&>svg]:size-3.5"
        )}
      >
        {icon}
        {title}
      </span>
    </label>
  );
}

/**
 * The page-context card plus the one route into Publishing settings. The old
 * serif studio headline is gone on purpose: the sidebar is a tool, and the tab
 * bar already names the place.
 */
function StudioContextRow({
  children,
  onOpenSettings,
}: {
  children: React.ReactNode;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const t = useT();
  return (
    <div className="flex items-start gap-1.5">
      <div className="min-w-0 flex-1">{children}</div>
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
