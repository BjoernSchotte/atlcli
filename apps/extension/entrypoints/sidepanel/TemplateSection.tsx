/**
 * DOCX template upload / scan / export panel section (spec 004 Tasks 3 & 5).
 *
 * Thin imperative shell over the isomorphic engine in `@atlcli/docx`
 * (spec 006): upload/scan/persist a `.docx` template, then drive the engine's
 * `runExport` with the extension's env adapters (`utils/docx/env.ts` —
 * IndexedDB template source, session asset fetcher, download sink) and show
 * the export report. All heavy logic (unzip, scan, resolve, serialize, engine
 * render) lives in the engine package and is unit-tested; this file only does
 * DOM/IDB/`chrome`-adjacent wiring.
 */
import React, { useEffect, useRef, useState } from "react";
import { ConfluenceClient } from "@atlcli/confluence/browser";
import { getConfluenceBaseUrl } from "@atlcli/core";
import { profileFromTabUrl } from "../../utils/profile.js";
import type { LoadedPage } from "../../utils/read-path.js";
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { RasterizerStats } from "../../utils/docx/env.js";
import {
  deleteTemplate,
  getTemplate,
  putTemplate,
  type StoredTemplate,
} from "../../utils/docx/template-store.js";
import { sessionCache } from "../../utils/docx/session-cache.js";
import { prepareExportDeps } from "../../utils/docx/export-deps.js";

// PizZip + docxtemplater (+ the OOXML serializer and, transitively, lazy Shiki)
// are heavy and only needed once the user opts into template upload/export.
// Load them behind these dynamic imports so the initial panel bundle stays lean
// (the common detect/read path never pulls them). Vite code-splits each into its
// own chunk fetched on first use. The scan import stays a deep path
// (`@atlcli/docx/scan`) so uploading a template fetches only the light scan
// chunk, not the whole engine.
const loadScan = () => import("@atlcli/docx/scan");
const loadExport = () => import("@atlcli/docx/browser");
const loadEnv = () => import("../../utils/docx/env.js");

const MAX_MB = 20;

/** Build the extension-owned rasterizer timing note, if any call succeeded. */
export function rasterizerTimingNote(
  stats: RasterizerStats
): ExportReport["notes"][number] | null {
  if (stats.calls === 0) return null;
  return {
    level: "info",
    code: "perf-timing",
    message:
      `Panel rasterizer: ${stats.calls} call(s) — decode ${stats.decodeMs} ms, ` +
      `draw ${stats.drawMs} ms, encode ${stats.encodeMs} ms (sums; per call ` +
      `${stats.encodeCallsMs.join("/")} ms).`,
  };
}

/**
 * Panel-lifetime TTL cache for the space + icon metadata round-trip, keyed by
 * site + space so multi-site tabs never bleed into each other. Exporting three
 * pages of one space previously paid the ~100ms call three times; within the
 * TTL it now costs one. A renamed space / swapped logo shows up at most five
 * minutes later. Current user, homepage storage, details, and owner are
 * deliberately NOT cached across exports: they can change under the same key
 * without a safe auth/content invalidation signal.
 */
const DEPS_CACHE_TTL_MS = 5 * 60_000;
const spaceInfoCache = sessionCache<Awaited<ReturnType<ConfluenceClient["getSpaceWithIcon"]>>>(DEPS_CACHE_TTL_MS);

interface CurrentTemplate {
  name: string;
  uploadedAt: number;
  scan: ScanResult;
  bytes: ArrayBuffer;
}

/** The scan is not persisted — it is derived from `bytes` on read (see the store). */
function toStored(name: string, bytes: ArrayBuffer): StoredTemplate {
  return { id: "current", name, bytes, uploadedAt: Date.now() };
}

/**
 * Load the persisted template and **re-derive** its scan from the stored bytes.
 *
 * Pure core of the mount effect (both collaborators injected) so the staleness
 * rule is testable without a DOM: the scan the panel shows must come from the
 * CURRENT classification, never from a copy frozen at upload time. It once did
 * — a template uploaded before gap G1 closed kept promising
 * "$scroll.pageowner.fullName will be empty" while the export, which always
 * re-scans, resolved it. Panel and export must agree.
 *
 * @returns the current template, or `null` when nothing is stored.
 */
export async function loadCurrentTemplate(
  get: () => Promise<StoredTemplate | undefined>,
  loadScanner: () => Promise<(bytes: Uint8Array) => ScanResult>
): Promise<CurrentTemplate | null> {
  const stored = await get();
  // Nothing stored → the heavy scan chunk is never fetched (lazy-load contract).
  if (!stored) return null;
  const scan = await loadScanner();
  return {
    name: stored.name,
    uploadedAt: stored.uploadedAt,
    scan: scan(new Uint8Array(stored.bytes)),
    bytes: stored.bytes,
  };
}

/**
 * Turn an export throw into a user-facing message. A {@link DocxRenderError}
 * (docxtemplater could not render the template) is surfaced specifically with
 * the engine's structured explanation rather than as a generic "Export failed"
 * (spec 004, finding #11 second half). Detected by name to avoid pulling the
 * heavy export module into this file's static graph.
 */
function exportErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === "DocxRenderError") {
    const details = (err as { details?: string[] }).details;
    const detail = details?.length ? ` (${details.join("; ")})` : "";
    return `The Word template could not be rendered${detail}. Check the template for stray control characters.`;
  }
  return `Export failed: ${(err as Error).message}`;
}

export function TemplateSection({
  loadedPage,
  pageUrl,
}: {
  loadedPage: LoadedPage | null;
  pageUrl: string | null;
}): React.JSX.Element {
  const [template, setTemplate] = useState<CurrentTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upload" | "export" | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-read the persisted template on mount (survives panel reload).
  //
  // The scan is RE-DERIVED from the stored bytes rather than read back from the
  // record. Persisting it made it drift: a template uploaded before gap G1 closed
  // kept reporting "$scroll.pageowner.fullName will be empty" forever, while the
  // export — which always re-scans — resolved it. The panel is the promise and
  // the export is the delivery, so they must be computed the same way.
  //
  // The scan chunk is loaded only once a template actually exists, so a user who
  // never uploaded one still pays nothing (the lazy-load contract).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await loadCurrentTemplate(getTemplate, async () => (await loadScan()).scanTemplate);
      if (cancelled || !current) return;
      setTemplate(current);
      // A stored template means an export is likely: pull the engine + env
      // chunks NOW so the first export doesn't pay their import cost. Pure
      // warm-up — failures are swallowed and the export path retries its
      // own imports. A user with no template still loads nothing (the
      // lazy-load contract). The mermaid renderer chunk is deliberately NOT
      // warmed here: importing elkjs at mount coincided with a severe
      // rasterizer slowdown during export (under investigation); the export
      // path lazy-loads it exactly as before.
      void Promise.all([loadExport(), loadEnv()]).catch(() => {});
    })().catch(() => {
      // A stored template that no longer scans is unusable; surface it rather
      // than rendering a half-loaded section.
      if (!cancelled) setError("The stored template could not be read. Please upload it again.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setError(null);
    setReport(null);

    if (!/\.docx$/i.test(file.name)) {
      setError("Please choose a .docx file.");
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Template exceeds the ${MAX_MB} MB limit.`);
      return;
    }

    setBusy("upload");
    try {
      const { scanTemplate, DocxError } = await loadScan();
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Validate + scan BEFORE persisting — store nothing on failure.
      let scan: ScanResult;
      try {
        scan = scanTemplate(bytes);
      } catch (err) {
        setError(
          err instanceof DocxError
            ? err.kind === "not-zip"
              ? "That file isn't a valid .docx (not a zip)."
              : err.kind === "not-docx"
                ? "That zip isn't a Word document."
                : "That template is too large."
            : `Could not read the template: ${(err as Error).message}`
        );
        return;
      }
      // A valid upload is an explicit opt-in to the export feature. Warm the
      // engine + host adapters while IndexedDB persists the template so the
      // first Export click does not pay the cold dynamic-import cost.
      void Promise.all([loadExport(), loadEnv()]).catch(() => {});
      await putTemplate(toStored(file.name, buf));
      setTemplate({ name: file.name, uploadedAt: Date.now(), scan, bytes: buf });
    } catch (err) {
      setError(`Could not read the template: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(): Promise<void> {
    await deleteTemplate();
    setTemplate(null);
    setReport(null);
    setError(null);
  }

  async function onExport(): Promise<void> {
    if (!template || !loadedPage || !pageUrl) return;
    setError(null);
    setBusy("export");
    try {
      const profile = profileFromTabUrl(pageUrl);
      const client = profile ? new ConfluenceClient(profile) : null;
      const site = profile ? getConfluenceBaseUrl(profile) : "";
      // Space + icon share ONE `?expand=icon` round-trip (a template using
      // $scroll.space.* and a logo placeholder previously called the same
      // endpoint twice), served from the panel-lifetime TTL cache above so
      // repeat exports within the same space skip it entirely.
      // Start exactly the round-trips named by the already-derived scan BEFORE
      // host chunks/template setup. Rejections have a consumed branch, while
      // the original promises still reach the engine's normal report notes.
      const deps = client
        ? prepareExportDeps(template.scan, loadedPage.details, {
            getSpaceWithIcon: (key) =>
              spaceInfoCache.get(`${site}|${key}`, () => client.getSpaceWithIcon(key)),
            getCurrentUser: () => client.getCurrentUser(),
            getPageOwner: (id) => client.getPageOwner(id),
            getSpaceHomepageStorage: (key) => client.getSpaceHomepageStorage(key),
            // Cross-page include (spec 005 D1): lazy — the include pass calls it
            // per occurrence, so `buildGetIncludedPage` (isomorphic, in the docx
            // engine chunk that `loadExport()` already fetches for this export)
            // is imported on first use, never pulling the heavy barrel into the
            // panel's static graph. Title lookups use the DIRECT content
            // endpoint (findPagesByTitle), NOT CQL — same as the CLI — so a
            // just-created target resolves without the search-index lag.
            getIncludedPage: async (ref) => {
              // buildGetIncludedPage is an internal helper (not a frozen v1
              // seam) — reach it via ./internal, not the trimmed `.` barrel.
              const { buildGetIncludedPage } = await import("@atlcli/docx/internal");
              return buildGetIncludedPage({
                getPage: (id) => client.getPage(id),
                findPagesByTitle: (title, spaceKey) => client.findPagesByTitle(title, { spaceKey }),
                defaultSpaceKey: loadedPage.details.spaceKey,
              })(ref);
            },
          })
        : {};
      const [{ runExport }, env] = await Promise.all([loadExport(), loadEnv()]);
      const {
        memoryTemplateSource,
        sessionAssetFetcher,
        downloadOutputSink,
        canvasSvgRasterizer,
      } = env;
      env.resetRasterizerStats();
      const rep = await runExport(
        {
          details: loadedPage.details,
          template: { name: template.name, modificationDate: new Date(template.uploadedAt) },
          deps,
        },
        {
          // The panel already owns these exact bytes; avoid rereading the same
          // template from IndexedDB on every export.
          templates: memoryTemplateSource(template.bytes),
          // Attachment refs are wiki-base-relative (spec 005); resolve them
          // against the tab's Confluence root so the session cookies apply.
          assets: sessionAssetFetcher(profile ? getConfluenceBaseUrl(profile) : undefined),
          // Mermaid diagrams (spec 005a): the panel document supplies the
          // SVG → PNG raster fallback via a real <canvas>.
          rasterizer: canvasSvgRasterizer(),
          output: downloadOutputSink(),
        }
      );
      // Panel-side rasterizer sub-timings (decode/draw/encode sums) join the
      // report so a slow diagram pipeline names its slow sub-step.
      const stats = env.getRasterizerStats();
      const timingNote = rasterizerTimingNote(stats);
      if (timingNote) rep.notes.push(timingNote);
      setReport(rep);
    } catch (err) {
      setError(exportErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section data-testid="template-section" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", color: "#666" }}>Word template</h2>

      <input
        ref={fileRef}
        type="file"
        accept=".docx"
        onChange={onFile}
        data-testid="template-file"
        style={{ display: "none" }}
      />

      {!template ? (
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy !== null} data-testid="template-upload">
          {busy === "upload" ? "Scanning…" : "Upload .docx template"}
        </button>
      ) : (
        <div
          data-testid="template-current"
          style={{ border: "1px solid #dfe1e6", borderRadius: 6, padding: 10 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong data-testid="template-name">{template.name}</strong>
            <span style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy !== null} data-testid="template-replace">
                Replace
              </button>
              <button type="button" onClick={onDelete} disabled={busy !== null} data-testid="template-delete">
                Delete
              </button>
            </span>
          </div>

          <ScanView scan={template.scan} />

          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              onClick={onExport}
              disabled={busy !== null || !loadedPage}
              data-testid="template-export"
              title={loadedPage ? "Export this page to Word" : "Open a Confluence page to export"}
            >
              {busy === "export" ? "Exporting…" : "Export to Word"}
            </button>
            {!loadedPage && (
              <span style={{ color: "#7a869a", marginLeft: 8 }}>Open a page to export.</span>
            )}
          </div>
        </div>
      )}

      {error && (
        <p data-testid="template-error" style={{ color: "#bf2600", marginTop: 8 }}>
          {error}
        </p>
      )}

      {report && <ReportView report={report} />}
    </section>
  );
}

export function ScanView({ scan }: { scan: ScanResult }): React.JSX.Element {
  const { supported, unsupported, never, hasContentPlaceholder } = scan;
  return (
    <div data-testid="template-scan" style={{ marginTop: 8, fontSize: 12 }}>
      {supported.length === 0 && unsupported.length === 0 && never.length === 0 && (
        <p style={{ color: "#7a869a", margin: 0 }}>No Scroll placeholders detected.</p>
      )}
      <ScanGroup icon="✓" color="#006644" label="Supported" hits={supported} />
      <ScanGroup icon="⚠" color="#974f0c" label="Will be empty" hits={unsupported} />
      <ScanGroup icon="✗" color="#bf2600" label="Not supported" hits={never} />
      <ContentInsertionLine hasContentPlaceholder={hasContentPlaceholder} />
    </div>
  );
}

/**
 * Surface the page-content insertion point explicitly. `$scroll.content` is
 * intentionally excluded from the placeholder list (it is the body anchor, not a
 * fillable value), which led a user to think the anchor was missing (spec 004
 * E2E finding). Display-only — reads the `hasContentPlaceholder` flag the scan
 * already carries; the placeholder classification is unchanged. The absent-case
 * copy matches export.ts's `no-content-placeholder` fallback (the page body is
 * appended before the final section break).
 */
function ContentInsertionLine({
  hasContentPlaceholder,
}: {
  hasContentPlaceholder: boolean;
}): React.JSX.Element {
  return (
    <div
      data-testid="content-insertion-point"
      style={{ marginTop: 6, color: hasContentPlaceholder ? "#006644" : "#5e6c84" }}
    >
      {hasContentPlaceholder ? (
        <span>
          Content insertion point: ✓ found (<code>$scroll.content</code>)
        </span>
      ) : (
        <span>
          No <code>$scroll.content</code> found — the page body will be appended before the final
          section break.
        </span>
      )}
    </div>
  );
}

/**
 * One scan bucket. The group header states the OUTCOME ("Will be empty (4)");
 * each row states its own REASON, which `classifyPlaceholder` already puts on
 * the hit. Rendering a single static note per bucket instead would flatten
 * genuinely different causes — a Cloud-impossible DC username, a gap waiting on
 * the image module, and an unmodelled field all look alike then.
 */
function ScanGroup({
  icon,
  color,
  label,
  hits,
}: {
  icon: string;
  color: string;
  label: string;
  hits: ScanResult["supported"];
}): React.JSX.Element | null {
  if (hits.length === 0) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontWeight: 600, color }}>
        {icon} {label} ({hits.length})
      </div>
      <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
        {hits.map((h) => (
          <li key={h.base}>
            <code>{h.base}</code>
            {h.count > 1 ? ` ×${h.count}` : ""}
            {h.reason ? <span style={{ color: "#7a869a" }}> — {h.reason}</span> : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Notes are the export's trust surface (PLAN §2.5): fetch failures, image
 * skips, date/highlight warnings, walker degradations — all must be visible. */
const NOTE_LEVEL_STYLE: Record<string, { color: string; label: string }> = {
  warning: { color: "#974f0c", label: "Warnings" },
  info: { color: "#5e6c84", label: "Notes" },
};

export function ReportView({ report }: { report: ExportReport }): React.JSX.Element {
  // Group notes by level so warnings stand out from informational notes.
  const groups = new Map<string, ExportReport["notes"]>();
  for (const note of report.notes) {
    const level = note.level === "warning" ? "warning" : "info";
    const bucket = groups.get(level) ?? [];
    bucket.push(note);
    groups.set(level, bucket);
  }

  return (
    <div
      data-testid="export-report"
      style={{ marginTop: 10, padding: 8, borderRadius: 6, background: "#f4f5f7", fontSize: 12 }}
    >
      <strong>Export complete</strong> — {report.filename}
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        <li>{report.resolvedCount} placeholder(s) resolved</li>
        {report.unsupportedNames.length > 0 && (
          <li data-testid="report-unsupported">
            {report.unsupportedNames.length} unsupported: {report.unsupportedNames.join(", ")}
          </li>
        )}
        {report.embeddedImages > 0 && (
          <li data-testid="report-embedded-images">{report.embeddedImages} image(s) embedded</li>
        )}
        {report.renderedDiagrams > 0 && (
          <li data-testid="report-rendered-diagrams">{report.renderedDiagrams} diagram(s) rendered</li>
        )}
        {report.skippedImages > 0 && (
          <li data-testid="report-skipped-images">{report.skippedImages} image(s) skipped (see notes)</li>
        )}
        <li>{report.durationMs} ms</li>
      </ul>

      {(["warning", "info"] as const).map((level) => {
        const notes = groups.get(level);
        if (!notes || notes.length === 0) return null;
        const meta = NOTE_LEVEL_STYLE[level];
        return (
          <div key={level} data-testid={`report-notes-${level}`} style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600, color: meta.color }}>{meta.label} ({notes.length})</div>
            <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
              {notes.map((note, i) => (
                <li key={`${note.code}-${i}`} style={{ color: meta.color }}>
                  {note.message}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
