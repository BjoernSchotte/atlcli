import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import type { ExportScope, LabelFilter } from "@atlcli/confluence/browser";
import {
  resolveCodeThemeId,
  type CodeThemeId,
} from "@atlcli/code-highlight/registry";
import type {
  AppPorts,
  ExportScopeRequest,
  TemplateSettingValue,
} from "../../utils/ports/index.js";
import type { PanelState } from "../../utils/panel-state.js";
import {
  initialScopeState,
  reduceScope,
  toExportScope,
  toLabelFilter,
  type ScopeContext,
  type ScopeEvent,
  type ScopeState,
} from "../../utils/scope-state.js";
import { PDF_LEVEL_A_SETTINGS } from "../export/pdf-settings.js";
import {
  defaultValues,
  mergeValues,
  toPdfSettings,
  type SettingValue,
} from "../export/settings-schema.js";

export const PDF_BUILTIN_TEMPLATE_ID = "builtin.editorial-indigo";
const PDF_PREFS_ENGINE = "typst" as const;

export type PublishingFormat = "pdf" | "docx";

export interface PublishingDraft {
  format: PublishingFormat;
  setFormat: (format: PublishingFormat) => void;
  scope: ScopeState;
  dispatchScope: React.Dispatch<ScopeEvent>;
  scopeContext: ScopeContext;
  exportScope: ExportScope | undefined;
  labels: LabelFilter | undefined;
  scopeRequest: ExportScopeRequest;
  resolveMacros: boolean;
  setResolveMacros: (value: boolean) => void;
  imageProfile: "original" | "standard" | "print";
  setImageProfile: (value: "original" | "standard" | "print") => void;
  imagePpi: number | undefined;
  setImagePpi: (value: number | undefined) => void;
  values: Record<string, SettingValue>;
  onSettingChange: (key: string, value: SettingValue) => void;
  onSettingsReset: () => void;
  pdfSettings: ReturnType<typeof toPdfSettings>;
  codeTheme: CodeThemeId;
}

const PublishingDraftContext = createContext<PublishingDraft | null>(null);

export function PublishingDraftProvider({
  ports,
  page,
  children,
}: {
  ports: AppPorts;
  page: PanelState;
  children: React.ReactNode;
}): React.JSX.Element {
  const loadedPage = page.status === "loaded" ? page.page : null;
  const spaceKey = loadedPage?.details.spaceKey ?? undefined;
  const [scope, dispatchScope] = useReducer(reduceScope, initialScopeState);
  const [resolveMacros, setResolveMacros] = useState(true);
  const [format, setFormat] = useState<PublishingFormat>(() =>
    ports.pdf ? "pdf" : "docx"
  );
  const [values, setValues] = useState<Record<string, SettingValue>>(() =>
    defaultValues(PDF_LEVEL_A_SETTINGS)
  );
  const library = ports.templates ?? null;

  useEffect(() => {
    if (format === "pdf" && !ports.pdf && ports.docx) setFormat("docx");
    if (format === "docx" && (!ports.docx || !ports.docxTemplates) && ports.pdf) setFormat("pdf");
  }, [format, ports.docx, ports.docxTemplates, ports.pdf]);

  const scopeContext = useMemo<ScopeContext>(
    () => ({ pageId: loadedPage?.details.id ?? "", spaceKey }),
    [loadedPage, spaceKey]
  );

  const exportScope = useMemo<ExportScope | undefined>(() => {
    if (!loadedPage) return undefined;
    try {
      return toExportScope(scope, scopeContext);
    } catch {
      return undefined;
    }
  }, [loadedPage, scope, scopeContext]);

  const labels = useMemo<LabelFilter | undefined>(() => toLabelFilter(scope), [scope]);
  const codeTheme = useMemo(
    () => resolveCodeThemeId(values.codeTheme),
    [values.codeTheme],
  );
  const [imageProfile, setImageProfile] = useState<"original" | "standard" | "print">("original");
  const [imagePpi, setImagePpi] = useState<number | undefined>(undefined);
  const scopeRequest = useMemo<ExportScopeRequest>(
    () => ({
      ...(exportScope ? { scope: exportScope } : {}),
      ...(labels ? { labels } : {}),
      resolveMacros,
      codeTheme,
      // Explicit image profile for durable PDF jobs (issue #118 Phase 3);
      // preview stays original regardless.
      ...(imageProfile !== "original" ? { imageProfile } : {}),
      ...(imageProfile !== "original" && imagePpi !== undefined ? { imagePpi } : {}),
    }),
    [codeTheme, exportScope, labels, resolveMacros, imageProfile, imagePpi]
  );

  useEffect(() => {
    if (!library) return;
    let cancelled = false;
    void library
      .readSettings(PDF_PREFS_ENGINE, spaceKey, PDF_BUILTIN_TEMPLATE_ID)
      .then((stored) => {
        if (!cancelled) setValues(mergeValues(PDF_LEVEL_A_SETTINGS, stored));
      })
      .catch(() => undefined);
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
        .catch(() => undefined);
    },
    [library, spaceKey]
  );

  const onSettingChange = useCallback(
    (key: string, value: SettingValue) => {
      setValues((previous) => {
        const next = { ...previous, [key]: value };
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
  const value = useMemo<PublishingDraft>(
    () => ({
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
      codeTheme,
    }),
    [
      format,
      scope,
      scopeContext,
      exportScope,
      labels,
      scopeRequest,
      resolveMacros,
      imageProfile,
      imagePpi,
      values,
      onSettingChange,
      onSettingsReset,
      pdfSettings,
      codeTheme,
    ]
  );

  return (
    <PublishingDraftContext.Provider value={value}>
      {children}
    </PublishingDraftContext.Provider>
  );
}

export function usePublishingDraft(): PublishingDraft {
  const value = useContext(PublishingDraftContext);
  if (!value) throw new Error("usePublishingDraft must be used inside PublishingDraftProvider");
  return value;
}

export function useOptionalPublishingDraft(): PublishingDraft | null {
  return useContext(PublishingDraftContext);
}
