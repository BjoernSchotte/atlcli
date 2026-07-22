/**
 * Preview screen (spec 010 T5.3).
 *
 * **One screen, two shells.** The side panel mounts it compactly inside the
 * `Sections` nav; `entrypoints/preview/` mounts the *same component* full-size
 * in its own tab over the *same cached bytes* (`utils/pdf/preview-cache.ts`).
 * There is no second viewer and no second compile path — the only thing that
 * differs is a layout value supplied through {@link PreviewShellContext}, which
 * is host configuration, not a fork. If this component ever needs branching on
 * "which shell am I in" beyond layout, that is a defect in the Phase 0 screen
 * model and belongs there, not here.
 *
 * **Preview is opt-in.** Compiling starts only when the user asks — the
 * "Generate preview" button, or the "Update automatically" toggle which is
 * **off by default**. The common path (open the panel, click Export) therefore
 * never pays for a preview compile.
 *
 * **Honest scope label.** A tree/space preview is labelled "first N of M
 * chapters", never "pages": the compiled page count only exists after
 * `validatePdfOutput`, and one source page can compile to many PDF pages.
 *
 * **Honest freshness label.** The read path returns the last *published*
 * version, never the open editor draft, so the panel says so rather than
 * letting the user discover it.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  Maximize2,
  Minus,
  Minimize2,
  MoreHorizontal,
  MoveHorizontal,
  MoveVertical,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { PdfBytesHandle } from "@atlcli/pdf/browser";
import type { ScreenDefinition, ScreenProps } from "../../utils/screens/registry.js";
import type { HostCapability } from "../../utils/ports/index.js";
import type { LoadedPage } from "../../utils/read-path.js";
import type { PdfPreviewResult } from "../../utils/pdf/preview.js";
import type {
  PdfPreviewFit,
  ResolvedPdfPreviewFit,
  PdfPreviewViewer,
} from "../../utils/pdf/viewer.js";
import { useI18n } from "../../utils/i18n/context.js";
import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Card, CardContent } from "../ui/card.js";
import { FieldHelp, SectionHeading } from "../ui/field.js";
import { cn } from "../ui/utils.js";
import { useOptionalPublishingDraft } from "../app/publishing-draft.js";

/** The capability a host must advertise for this screen to be usable. */
export const PREVIEW_CAPABILITY: HostCapability = "pdf-preview";

/** Registry id — exported so a shell can request this screen by name. */
export const PREVIEW_SCREEN_ID = "preview";

// ---------------------------------------------------------------------------
// Host-shell configuration
// ---------------------------------------------------------------------------

export interface PreviewShellConfig {
  /** `"compact"` = 400 px side panel, `"full"` = its own tab. */
  layout: "compact" | "full";
  /**
   * Opens the large view. `null` hides the action — which is what the large
   * view itself passes, and what a host without tabs (Forge) gets.
   */
  openLargePreview: (() => void) | null;
  /** Closes a full-tab preview. Compact and non-tab hosts pass `null`. */
  closePreview: (() => void) | null;
}

function defaultOpenLargePreview(): (() => void) | null {
  // Runtime-guarded, never module scope: the portable app must stay importable
  // with `chrome` undefined. A host without it simply does not show the action.
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome
    ?.runtime;
  if (typeof runtime?.getURL !== "function" || typeof globalThis.open !== "function") return null;
  const url = runtime.getURL("preview.html");
  return () => {
    globalThis.open(url, "_blank", "noopener");
  };
}

export const PreviewShellContext = createContext<PreviewShellConfig | null>(null);

export function usePreviewShell(): PreviewShellConfig {
  const value = useContext(PreviewShellContext);
  return useMemo(
    () =>
      value ?? {
        layout: "compact",
        openLargePreview: defaultOpenLargePreview(),
        closePreview: null,
      },
    [value]
  );
}

// ---------------------------------------------------------------------------
// Runtime seam
// ---------------------------------------------------------------------------

export interface PreviewCompileRequest {
  page: LoadedPage;
  pageUrl: string;
  settings?: import("@atlcli/pdf/browser").PdfTemplateSettings;
  resolveMacros?: boolean;
  signal?: AbortSignal;
}

/**
 * The effectful half, injected.
 *
 * Deliberately a context rather than a member of `AppPorts`: the port surface
 * is owned by Phase 0 and a sibling task, and this keeps the screen renderable
 * in a test (and in a `chrome`-less host) without touching it. Promoting it to
 * `AppPorts.pdfPreview` is the natural follow-up once the port module is free.
 *
 * The default implementation lazy-`import()`s the pipeline and the viewer, so a
 * session that never opens this screen never parses PDF.js or the exporter —
 * the same pattern the export panel uses for `run-export`.
 */
export interface PreviewRuntime {
  compile(request: PreviewCompileRequest): Promise<PdfPreviewResult>;
  /**
   * The cached result for this request, or `null`.
   *
   * This is what makes "the large view opens over the *same* bytes" true rather
   * than aspirational: the tab page reads the entry the side panel wrote
   * instead of compiling the document a second time.
   */
  readCached(request: PreviewCompileRequest): Promise<PdfPreviewResult | null>;
  openViewer(bytes: PdfBytesHandle): Promise<PdfPreviewViewer>;
}

async function cacheParts(request: PreviewCompileRequest) {
  const { previewCacheParts } = await import("../../utils/pdf/preview.js");
  return previewCacheParts({
    pageUrl: request.pageUrl,
    page: { id: request.page.details.id, version: request.page.details.version },
    // v1 previews the loaded page. Once the scope form threads a scope and
    // label filter through, they belong here — `previewCacheParts` already
    // folds them into the identity.
    scope: { kind: "page", pageId: request.page.details.id },
    settings: {
      document: request.settings ?? null,
      resolveMacros: request.resolveMacros !== false,
    },
  });
}

const defaultRuntime: PreviewRuntime = {
  async compile(request) {
    const { runPagePdfPreview } = await import("../../utils/pdf/preview.js");
    const result = await runPagePdfPreview({
      page: request.page,
      pageUrl: request.pageUrl,
      settings: request.settings,
      ...(request.resolveMacros === false ? { macros: { live: false } } : {}),
      signal: request.signal,
    });
    if (result.status === "ready" && result.bytes) {
      const { putPreview } = await import("../../utils/pdf/preview-cache.js");
      // Best-effort: a cache write must never turn a successful preview into a
      // failed one. The user has the document on screen either way.
      await putPreview({
        ...(await cacheParts(request)),
        pdf: await result.bytes.asUint8Array(),
        filename: result.filename ?? "preview.pdf",
        truncated: result.truncated,
        includedChapters: result.includedChapters,
        totalChapters: result.totalChapters,
      }).catch(() => undefined);
    }
    return result;
  },
  async readCached(request) {
    const { getPreviewEntry } = await import("../../utils/pdf/preview-cache.js");
    const hit = await getPreviewEntry(await cacheParts(request)).catch(() => undefined);
    if (!hit) return null;
    return {
      status: "ready",
      bytes: hit.bytes,
      filename: hit.entry.filename,
      truncated: hit.entry.truncated,
      includedChapters: hit.entry.includedChapters,
      totalChapters: hit.entry.totalChapters,
      reason: hit.entry.truncated ? "chapters" : "none",
    };
  },
  async openViewer(bytes) {
    const { openPdfViewer } = await import("../../utils/pdf/viewer.js");
    return openPdfViewer(bytes);
  },
};

export const PreviewRuntimeContext = createContext<PreviewRuntime | null>(null);

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type PreviewPhase = "idle" | "compiling" | "ready" | "error";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PreviewScreen({
  page,
  embedded = false,
}: ScreenProps & { embedded?: boolean }): React.JSX.Element {
  const { t } = useI18n();
  // `useI18n` deliberately provides a no-Provider fallback whose function
  // identity is not stable. The page-render effect writes render state on
  // success, so depending on that function would turn the fallback path into a
  // render loop. Keep the latest translator for the error branch without
  // making successful annotation renders depend on its identity.
  const tRef = useRef(t);
  tRef.current = t;
  const shell = usePreviewShell();
  const full = shell.layout === "full";
  const runtime = useContext(PreviewRuntimeContext) ?? defaultRuntime;
  const publishingDraft = useOptionalPublishingDraft();

  const loadedPage = page.status === "loaded" ? page.page : null;
  const pageUrl = page.status === "loaded" ? page.ref.url : null;
  const draftSettings = publishingDraft?.pdfSettings;
  const draftResolveMacros = publishingDraft?.resolveMacros;
  const previewRequest = useMemo<PreviewCompileRequest | null>(
    () =>
      loadedPage && pageUrl
        ? {
            page: loadedPage,
            pageUrl,
            ...(draftSettings
              ? {
                  settings: draftSettings,
                  resolveMacros: draftResolveMacros,
                }
              : {}),
          }
        : null,
    [draftResolveMacros, draftSettings, loadedPage, pageUrl]
  );
  const [phase, setPhase] = useState<PreviewPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfPreviewResult | null>(null);
  const [viewer, setViewer] = useState<PdfPreviewViewer | null>(null);
  const [renderedRequest, setRenderedRequest] = useState<PreviewCompileRequest | null>(null);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState<PdfPreviewFit>(full ? "auto" : "width");
  const [pageRender, setPageRender] = useState<{
    viewer: PdfPreviewViewer;
    pageNumber: number;
    zoom: number;
    frameWidth: number;
    frameHeight: number;
    requestedFit: PdfPreviewFit;
    resolvedFit: ResolvedPdfPreviewFit;
  } | null>(null);

  const [auto, setAuto] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRootRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<PdfPreviewViewer | null>(null);
  viewerRef.current = viewer;

  /**
   * The width and height a page is fitted to, measured from the frame that holds the
   * canvas — never from the canvas, which `renderPage` resizes itself.
   *
   * This has to be measured rather than assumed because the same component
   * runs in a 400 px side panel and in a full-width tab, and either can be
   * resized while a preview is on screen.
   */
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [frameHeight, setFrameHeight] = useState(0);

  // `useLayoutEffect`, not `useEffect`: the first render must fit the real
  // frame, and layout is only guaranteed readable before paint.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      setFrameWidth(frame.clientWidth);
      setFrameHeight(frame.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [viewer]);

  // Tear the viewer down on unmount: it owns a PDF.js document, a worker
  // channel and (via the handle) an object URL.
  useEffect(
    () => () => {
      void viewerRef.current?.destroy().catch(() => undefined);
    },
    []
  );

  // Fullscreen belongs to the dedicated preview tab, not the side panel. The
  // API requires a user gesture in the document that enters fullscreen, so the
  // compact shell first opens this tab and the user promotes it from here.
  useEffect(() => {
    if (!full || typeof document === "undefined") return;
    const root = fullscreenRootRef.current;
    const supported = Boolean(
      document.fullscreenEnabled &&
        root &&
        typeof root.requestFullscreen === "function" &&
        typeof document.exitFullscreen === "function"
    );
    setFullscreenSupported(supported);
    const sync = () => setIsFullscreen(document.fullscreenElement === root);
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [full]);

  const toggleFullscreen = useCallback(async () => {
    const root = fullscreenRootRef.current;
    if (!root || typeof document === "undefined") return;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen({ navigationUI: "hide" });
    } catch (cause) {
      setFullscreenError(t("preview.fullscreenFailed", { message: messageOf(cause) }));
    }
  }, [t]);

  const show = useCallback(
    async (next: PdfPreviewResult, shownRequest: PreviewCompileRequest) => {
      if (!next.bytes) {
        setPhase("error");
        setError(t("preview.failed", { message: "no output" }));
        return;
      }
      await viewerRef.current?.destroy().catch(() => undefined);
      const opened = await runtime.openViewer(next.bytes);
      setResult(next);
      setViewer(opened);
      setRenderedRequest(shownRequest);
      setPageRender(null);
      setPageNumber(1);
      setZoom(1);
      setFitMode(full ? "auto" : "width");
      setPhase("ready");
    },
    [full, runtime, t]
  );

  const compile = useCallback(async () => {
    if (!previewRequest) return;
    setPhase("compiling");
    setError(null);
    try {
      const next = await runtime.compile(previewRequest);
      // A superseded preview is not an error and not a result: a newer request
      // is already in flight, so the previous view simply stays on screen.
      if (next.status === "superseded") {
        setPhase(viewerRef.current ? "ready" : "idle");
        return;
      }
      await show(next, previewRequest);
    } catch (cause) {
      setPhase("error");
      setError(t("preview.failed", { message: messageOf(cause) }));
    }
  }, [previewRequest, runtime, show, t]);

  // Open over the cached bytes when there are any. This is the entire reason
  // the large-preview tab is not a second compile: it mounts the same screen,
  // finds the entry the side panel wrote, and renders it.
  useEffect(() => {
    if (!previewRequest || phase !== "idle") return;
    let cancelled = false;
    void runtime
      .readCached(previewRequest)
      .then(async (cached) => {
        if (cancelled || !cached) return;
        await show(cached, previewRequest);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [phase, previewRequest, runtime, show]);

  // Auto-refresh: the CONFCLOUD-84742 loop is `edit → publish → preview`, and
  // publishing is exactly what changes the page version the panel already
  // watches. Debounced through the shared scheduler so a burst of detections
  // (SPA navigation re-firing) collapses into one compile; superseding an
  // in-flight compile is the compiler host's coalescing rule, never
  // `pdf:cancel` — that path terminates the warm worker.
  useEffect(() => {
    if (!auto || !previewRequest) return;
    let cancelled = false;
    let scheduler: { cancel(): void } | null = null;
    void import("../../utils/pdf/preview.js").then(({ createPreviewScheduler }) => {
      if (cancelled) return;
      const created = createPreviewScheduler();
      scheduler = created;
      created.request(() => void compile());
    });
    return () => {
      cancelled = true;
      scheduler?.cancel();
    };
  }, [auto, previewRequest, compile]);

  // Render the current page whenever it, the zoom, fit or frame size changes.
  // document changes. Only the visible page is rasterized — never the whole
  // document.
  useEffect(() => {
    const canvas = canvasRef.current;
    const annotationLayer = annotationLayerRef.current;
    // A zero relevant extent means the frame has not been laid out yet.
    // Rendering anyway would fit the page to nothing; measurement re-runs this.
    if (
      !viewer ||
      !canvas ||
      !annotationLayer ||
      frameWidth <= 0 ||
      (fitMode !== "width" && frameHeight <= 0)
    ) return;
    let cancelled = false;
    void viewer
      .renderPage(pageNumber, canvas, {
        zoom,
        fit: fitMode,
        containerWidth: frameWidth,
        containerHeight: frameHeight,
        annotationLayer,
        onNavigate: setPageNumber,
      })
      .then(({ fit }) => {
        if (!cancelled) {
          setPageRender({
            viewer,
            pageNumber,
            zoom,
            frameWidth,
            frameHeight,
            requestedFit: fitMode,
            resolvedFit: fit,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(tRef.current("preview.failed", { message: messageOf(cause) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [viewer, pageNumber, zoom, fitMode, frameWidth, frameHeight]);

  const pageCount = viewer?.pageCount ?? 0;
  // Never leave the previous page's hotspots over a newly selected page while
  // its render is still settling. The render identity makes stale async results
  // invisible even before the effect cleanup runs.
  const visibleRender =
    pageRender?.viewer === viewer &&
    pageRender.pageNumber === pageNumber &&
    pageRender.zoom === zoom &&
    pageRender.frameWidth === frameWidth &&
    pageRender.frameHeight === frameHeight &&
    pageRender.requestedFit === fitMode
      ? pageRender
      : null;
  const activeFit =
    visibleRender?.resolvedFit ?? (fitMode === "auto" ? null : fitMode);
  const scopeLabel = result?.truncated
    ? t("preview.scope.truncated", {
        included: result.includedChapters,
        total: result.totalChapters,
      })
    : t("preview.scope.full");
  const hasPreview = result !== null && viewer !== null;
  const stale = hasPreview && renderedRequest !== previewRequest;
  const previewStatus =
    phase === "compiling"
      ? "compiling"
      : phase === "error"
        ? "error"
        : hasPreview
          ? stale
            ? "stale"
            : "current"
          : "empty";
  const statusLabel = t(`preview.status.${previewStatus}`);
  const statusClass =
    previewStatus === "current"
      ? "bg-success/15 text-success"
      : previewStatus === "stale"
        ? "bg-warning/15 text-warning"
        : previewStatus === "error"
          ? "bg-destructive/10 text-destructive"
          : previewStatus === "compiling"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground";

  return (
    <div
      ref={fullscreenRootRef}
      className={cn(
        "flex flex-col",
        full ? "h-full min-h-0" : embedded ? "gap-2" : "gap-4",
        isFullscreen && "bg-background"
      )}
      data-testid="preview-screen"
      data-layout={shell.layout}
      data-fullscreen={isFullscreen ? "true" : "false"}
    >
      {full ? (
        <header
          className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2"
          data-testid="preview-full-header"
        >
          <div className="text-sm font-semibold" data-testid="preview-scope">
            {scopeLabel}
          </div>
          <div className="flex items-center gap-1">
            {fullscreenSupported && hasPreview && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={isFullscreen ? t("preview.exitFullscreen") : t("preview.enterFullscreen")}
                title={isFullscreen ? t("preview.exitFullscreen") : t("preview.enterFullscreen")}
                onClick={() => void toggleFullscreen()}
                data-testid="preview-fullscreen"
              >
                {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </Button>
            )}
            {shell.closePreview && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("preview.closeLarge")}
                title={t("preview.closeLarge")}
                onClick={shell.closePreview}
                data-testid="preview-close"
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        </header>
      ) : !embedded ? (
        <SectionHeading>{t("preview.title")}</SectionHeading>
      ) : null}

      {!full && (
        <Card className={cn(embedded && "border-0 bg-transparent shadow-none")}>
          <CardContent className={cn("flex flex-col gap-2", embedded ? "p-0" : "p-3")}>
            {!loadedPage ? (
              <Alert data-testid="preview-needs-page">{t("preview.needsPage")}</Alert>
            ) : embedded ? (
              <div className="rounded-md border bg-card px-2 py-1.5" data-testid="preview-summary">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">{t("preview.status.label")}</div>
                    <div
                      className="mt-0.5 truncate text-[10px] text-muted-foreground"
                      title={t("preview.publishedOnly")}
                      data-testid="preview-metadata"
                    >
                      {loadedPage.details.version !== undefined &&
                        t("preview.meta.versionShort", {
                          version: loadedPage.details.version,
                        })}
                      {loadedPage.details.version !== undefined && hasPreview && " · "}
                      {hasPreview && t("preview.meta.pages", { count: pageCount })}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                      statusClass
                    )}
                    data-testid="preview-status"
                    data-status={previewStatus}
                  >
                    {statusLabel}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center gap-1">
                  {previewStatus === "current" && shell.openLargePreview && (
                    <Button
                      size="sm"
                      onClick={shell.openLargePreview}
                      data-testid="preview-open-large"
                    >
                      <ExternalLink aria-hidden="true" />
                      {t("preview.openLargeCompact")}
                    </Button>
                  )}
                  <Button
                    size={previewStatus === "current" && shell.openLargePreview ? "icon" : "sm"}
                    variant={previewStatus === "current" && shell.openLargePreview ? "ghost" : "default"}
                    className={cn(previewStatus === "current" && shell.openLargePreview && "size-7")}
                    onClick={() => void compile()}
                    disabled={phase === "compiling"}
                    aria-label={
                      previewStatus === "current" && shell.openLargePreview
                        ? t("preview.refresh")
                        : undefined
                    }
                    title={
                      previewStatus === "current" && shell.openLargePreview
                        ? t("preview.refresh")
                        : undefined
                    }
                    data-testid="preview-generate"
                  >
                    {hasPreview ? <RefreshCw aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {!(previewStatus === "current" && shell.openLargePreview) &&
                      (phase === "compiling"
                        ? t("preview.status.compiling")
                        : phase === "error"
                          ? t("preview.retry")
                          : hasPreview
                            ? t("preview.refresh")
                            : t("preview.generate"))}
                  </Button>
                  {previewStatus !== "current" && hasPreview && shell.openLargePreview && (
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-7"
                      onClick={shell.openLargePreview}
                      aria-label={t("preview.openLarge")}
                      title={t("preview.openLarge")}
                      data-testid="preview-open-large"
                    >
                      <ExternalLink aria-hidden="true" />
                    </Button>
                  )}
                  <details className="relative ml-auto text-xs" data-testid="preview-options">
                    <summary
                      className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground [&::-webkit-details-marker]:hidden"
                      aria-label={t("preview.options")}
                      title={t("preview.options")}
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </summary>
                    <div className="absolute right-0 top-8 z-20 flex w-64 flex-col gap-1.5 rounded-md border bg-popover p-2 text-popover-foreground shadow-md">
                      <label className="flex items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={auto}
                          onChange={(event) => setAuto(event.target.checked)}
                          data-testid="preview-auto"
                        />
                        {t("preview.auto")}
                      </label>
                      <FieldHelp>{t("preview.autoHelp")}</FieldHelp>
                      <FieldHelp>{t("preview.publishedOnly")}</FieldHelp>
                    </div>
                  </details>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void compile()}
                    disabled={phase === "compiling"}
                    data-testid="preview-generate"
                  >
                    <Eye aria-hidden="true" />
                    {phase === "ready" ? t("preview.refresh") : t("preview.generate")}
                  </Button>
                  {shell.openLargePreview && (
                    <Button
                      variant="outline"
                      onClick={shell.openLargePreview}
                      data-testid="preview-open-large"
                    >
                      <ExternalLink aria-hidden="true" />
                      {t("preview.openLarge")}
                    </Button>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={auto}
                    onChange={(event) => setAuto(event.target.checked)}
                    data-testid="preview-auto"
                  />
                  {t("preview.auto")}
                </label>
                {!embedded && <FieldHelp>{t("preview.autoHelp")}</FieldHelp>}
                <FieldHelp>{t("preview.publishedOnly")}</FieldHelp>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {fullscreenError && (
        <Alert role="alert" tone="danger" data-testid="preview-fullscreen-error">
          {fullscreenError}
        </Alert>
      )}

      {!embedded && phase === "compiling" && (
        <Alert tone="info" data-testid="preview-compiling">
          {t("preview.compiling")}
        </Alert>
      )}

      {phase === "error" && error && (
        <Alert role="alert" tone="danger" data-testid="preview-error">
          {error}
        </Alert>
      )}

      {!embedded && phase === "idle" && loadedPage && (
        <Alert data-testid="preview-empty">{t("preview.empty")}</Alert>
      )}

      {hasPreview && result && (
        <Card
          className={cn(
            full && "flex min-h-0 flex-1 flex-col rounded-none border-0",
            embedded && "rounded-lg"
          )}
          data-testid="preview-document"
        >
          <CardContent
            className={cn(
              "flex flex-col gap-2",
              embedded ? "p-2" : "p-3",
              full && "min-h-0 flex-1"
            )}
          >
            {!full && (!embedded || result.truncated) && (
              <div className="text-xs text-muted-foreground" data-testid="preview-scope">
                {scopeLabel}
              </div>
            )}
            {result.truncated && (
              <Alert tone="warning" data-testid="preview-truncated-hint">
                {t("preview.truncatedDownloadHint")}
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.previousPage")}
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
                data-testid="preview-prev"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span className="px-1 text-xs tabular-nums" data-testid="preview-page-label">
                {t("preview.page", { current: pageNumber, total: pageCount })}
              </span>
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.nextPage")}
                disabled={pageNumber >= pageCount}
                onClick={() => setPageNumber((n) => Math.min(pageCount, n + 1))}
                data-testid="preview-next"
              >
                <ChevronRight aria-hidden="true" />
              </Button>
              <span className="grow" />
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.zoomOut")}
                onClick={() => setZoom((z) => stepZoom(z, -1))}
                data-testid="preview-zoom-out"
              >
                <Minus aria-hidden="true" />
              </Button>
              {/*
                `MoveHorizontal`, not `Scan`: the scan-corners glyph reads as
                "fullscreen" next to − and +, and the first person to try it
                pressed it expecting a full-screen viewer. Full size is the
                separate "Open large preview" action.
              */}
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.fitWidth")}
                title={t("preview.fitWidth")}
                disabled={zoom === 1 && activeFit === "width"}
                onClick={() => {
                  setFitMode("width");
                  setZoom(1);
                }}
                data-testid="preview-fit-width"
              >
                <MoveHorizontal aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.fitHeight")}
                title={t("preview.fitHeight")}
                disabled={zoom === 1 && activeFit === "height"}
                onClick={() => {
                  setFitMode("height");
                  setZoom(1);
                }}
                data-testid="preview-fit-height"
              >
                <MoveVertical aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label={t("preview.zoomIn")}
                onClick={() => setZoom((z) => stepZoom(z, 1))}
                data-testid="preview-zoom-in"
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>

            <div
              className={cn(
                "overflow-auto rounded-md border bg-muted p-2",
                full && "min-h-0 flex-1"
              )}
              data-testid="preview-viewer"
            >
              {/*
                The measured frame. It is a plain block, so it stays at the
                scroll container's content width even when the canvas inside it
                is wider — which is what makes it a stable fit basis at any
                zoom. The canvas deliberately carries NO `max-w-full`: clamping
                it would make zooming in change the backing store while the
                visible size stayed put.
              */}
              <div
                ref={frameRef}
                className={full ? "h-full min-h-0" : undefined}
                data-testid="preview-frame"
              >
                <div className="relative inline-block align-top" data-testid="preview-page">
                  <canvas className="block" ref={canvasRef} data-testid="preview-canvas" />
                  <div
                    ref={annotationLayerRef}
                    className={cn(
                      "pdf-annotation-layer",
                      !visibleRender && "invisible pointer-events-none"
                    )}
                    aria-hidden={visibleRender ? undefined : "true"}
                    data-testid="preview-annotation-layer"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function stepZoom(current: number, direction: 1 | -1): number {
  const index = ZOOM_STEPS.findIndex((step) => step >= current - 1e-6);
  const base = index < 0 ? ZOOM_STEPS.length - 1 : index;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, base + direction));
  return ZOOM_STEPS[next]!;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The registry entry.
 *
 * Exported ready-made so the shell owner adds one import and one array element
 * to `components/screens/index.ts` — the registry, not this file, decides where
 * the screen appears. The `pdf-preview` capability must also be advertised by
 * the host (`CHROME_CAPABILITIES`); until it is, the entry renders as
 * disabled-with-a-reason, which is the registry behaving correctly.
 */
export const previewScreenDefinition: ScreenDefinition = {
  id: PREVIEW_SCREEN_ID,
  labelKey: "screen.preview.label",
  descriptionKey: "screen.preview.description",
  icon: Eye,
  component: PreviewScreen,
  requirements: [{ kind: "loaded-page" }, { kind: "capability", capability: PREVIEW_CAPABILITY }],
  order: 15,
  navigation: "hidden",
};
