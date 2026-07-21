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
import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { ExportScope, LabelFilter } from "@atlcli/confluence/browser";
import type { ScreenProps } from "../../utils/screens/registry.js";
import type { ExportScopeRequest, TemplateSettingValue } from "../../utils/ports/index.js";
import {
  initialScopeState,
  reduceScope,
  toExportScope,
  toLabelFilter,
  type ScopeContext,
} from "../../utils/scope-state.js";
import { useT } from "../../utils/i18n/context.js";
import { Button } from "../ui/button.js";
import { PageSummary } from "../export/PageSummary.js";
import { PdfExportPanel } from "../export/PdfExportPanel.js";
import { DocxExportPanel } from "../export/DocxExportPanel.js";
import { ScopeSection } from "../export/ScopeSection.js";
import { SpaceExportConfirm } from "../export/SpaceExportConfirm.js";
import { SettingsForm } from "../export/SettingsForm.js";
import { PDF_LEVEL_A_SETTINGS } from "../export/pdf-settings.js";
import {
  defaultValues,
  mergeValues,
  toPdfSettings,
  type SettingValue,
} from "../export/settings-schema.js";
import { TEMPLATES_SCREEN_ID } from "./TemplatesScreen.js";

/**
 * `BUILTIN_PDF_TEMPLATE_ID` from `@atlcli/pdf`, duplicated as a literal so the
 * portable app layer does not pull the PDF engine barrel (and with it the
 * runtime font inventory) into the panel's first chunk for one string.
 * `tests/settings-form.test.tsx` asserts the two are equal, so a rename in the
 * engine fails loudly instead of silently orphaning everyone's saved settings.
 */
export const PDF_BUILTIN_TEMPLATE_ID = "builtin.editorial-indigo";

/** Prefs are stored per engine; PDF templates are Typst ones. */
const PDF_PREFS_ENGINE = "typst" as const;

export function ExportScreen({ ports, page, retry, navigate }: ScreenProps): React.JSX.Element {
  const t = useT();
  const loadedPage = page.status === "loaded" ? page.page : null;
  const pageUrl = page.status === "loaded" ? page.ref.url : null;
  const spaceKey = loadedPage?.details.spaceKey ?? undefined;

  const [scope, dispatchScope] = useReducer(reduceScope, initialScopeState);
  const [resolveMacros, setResolveMacros] = useState(true);

  const scopeContext = useMemo<ScopeContext>(
    () => ({ pageId: loadedPage?.details.id ?? "", spaceKey }),
    [loadedPage, spaceKey]
  );

  // `toExportScope` runs the shared `validateExportScope`, which throws for a
  // space scope with no space key. The radio already prevents that, so a throw
  // here means the host handed us an inconsistent page — fall back to "let the
  // engine export the loaded page", which is what every pre-T5.1 host does.
  const exportScope = useMemo<ExportScope | undefined>(() => {
    if (!loadedPage) return undefined;
    try {
      return toExportScope(scope, scopeContext);
    } catch {
      return undefined;
    }
  }, [scope, scopeContext, loadedPage]);

  const labels = useMemo<LabelFilter | undefined>(() => toLabelFilter(scope), [scope]);

  const scopeRequest = useMemo<ExportScopeRequest>(
    () => ({
      ...(exportScope ? { scope: exportScope } : {}),
      ...(labels ? { labels } : {}),
      resolveMacros,
    }),
    [exportScope, labels, resolveMacros]
  );

  // ---- PDF Level-A settings -------------------------------------------------

  const [values, setValues] = useState<Record<string, SettingValue>>(() =>
    defaultValues(PDF_LEVEL_A_SETTINGS)
  );
  const library = ports.templates ?? null;

  useEffect(() => {
    if (!library) return;
    let cancelled = false;
    void library
      .readSettings(PDF_PREFS_ENGINE, spaceKey, PDF_BUILTIN_TEMPLATE_ID)
      .then((stored) => {
        if (!cancelled) setValues(mergeValues(PDF_LEVEL_A_SETTINGS, stored));
      })
      .catch(() => {
        // A settings read failure must never block an export: the form simply
        // starts at the schema defaults, which is what the engine applies too.
      });
    return () => {
      cancelled = true;
    };
  }, [library, spaceKey]);

  const persist = useCallback(
    (next: Record<string, SettingValue>) => {
      if (!library) return;
      void library
        .writeSettings(
          PDF_PREFS_ENGINE,
          spaceKey,
          PDF_BUILTIN_TEMPLATE_ID,
          next as Record<string, TemplateSettingValue>
        )
        .catch(() => {
          /* Best-effort: an unsaved preference is not worth failing an export. */
        });
    },
    [library, spaceKey]
  );

  const onSettingChange = useCallback(
    (key: string, value: SettingValue) => {
      setValues((prev) => {
        const next = { ...prev, [key]: value };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const onSettingsReset = useCallback(() => {
    const next = defaultValues(PDF_LEVEL_A_SETTINGS);
    setValues(next);
    persist(next);
  }, [persist]);

  const pdfSettings = useMemo(() => toPdfSettings(values), [values]);

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

  return (
    <div className="flex flex-col gap-4">
      <PageSummary state={page} onRetry={retry} />

      <ScopeSection
        state={scope}
        dispatch={dispatchScope}
        context={scopeContext}
        resolveMacros={resolveMacros}
        onResolveMacrosChange={setResolveMacros}
      />

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
        <>
          <PdfExportPanel
            port={ports.pdf}
            page={loadedPage}
            pageUrl={pageUrl}
            scopeRequest={scopeRequest}
            settings={pdfSettings}
            gate={gate}
          />
          <SettingsForm
            schema={PDF_LEVEL_A_SETTINGS}
            values={values}
            onChange={onSettingChange}
            onReset={onSettingsReset}
            idPrefix="pdf-settings"
            collapsible
          />
        </>
      )}

      {ports.docx && ports.docxTemplates && (
        <DocxExportPanel
          port={ports.docx}
          store={ports.docxTemplates}
          page={loadedPage}
          pageUrl={pageUrl}
          scopeRequest={scopeRequest}
          gate={gate}
        />
      )}

      {ports.templates && (
        <div>
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
  );
}
