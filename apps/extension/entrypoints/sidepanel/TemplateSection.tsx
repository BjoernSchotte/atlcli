/**
 * DOCX template upload / scan / export panel section (spec 004 Tasks 3 & 5).
 *
 * Thin imperative shell over the tested pure core in `utils/docx/*`:
 *   - upload a `.docx` → {@link scanTemplate} → persist via the IndexedDB store;
 *     survives reload because the current template is re-read on mount;
 *   - render the placeholder scan (✓ supported / ⚠ unsupported / ✗ never);
 *   - when a Confluence page is loaded, Export runs {@link exportDocx} and
 *     triggers a browser download, then shows the export report.
 *
 * All heavy logic (unzip, scan, resolve, serialize, engine render) lives in the
 * pure modules and is unit-tested; this file only does DOM/IDB/`chrome`-adjacent
 * wiring.
 */
import React, { useEffect, useRef, useState } from "react";
import { ConfluenceClient } from "@atlcli/confluence/browser";
import { profileFromTabUrl } from "../../utils/profile.js";
import type { LoadedPage } from "../../utils/read-path.js";
import type { ScanResult } from "../../utils/docx/scan.js";
import {
  deleteTemplate,
  getTemplate,
  putTemplate,
  type StoredTemplate,
} from "../../utils/docx/template-store.js";
import type { ExportReport } from "../../utils/docx/export.js";

// PizZip + docxtemplater (+ the OOXML serializer and, transitively, lazy Shiki)
// are heavy and only needed once the user opts into template upload/export.
// Load them behind these dynamic imports so the initial panel bundle stays lean
// (the common detect/read path never pulls them). Vite code-splits each into its
// own chunk fetched on first use.
const loadScan = () => import("../../utils/docx/scan.js");
const loadExport = () => import("../../utils/docx/export.js");

const MAX_MB = 20;

interface CurrentTemplate {
  name: string;
  uploadedAt: number;
  scan: ScanResult;
  bytes: ArrayBuffer;
}

function toStored(name: string, bytes: ArrayBuffer, scan: ScanResult): StoredTemplate {
  return { id: "current", name, bytes, uploadedAt: Date.now(), scan };
}

/** Trigger a browser download of the given bytes. */
function download(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  useEffect(() => {
    let cancelled = false;
    void getTemplate().then((stored) => {
      if (cancelled || !stored) return;
      setTemplate({ name: stored.name, uploadedAt: stored.uploadedAt, scan: stored.scan, bytes: stored.bytes });
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
      await putTemplate(toStored(file.name, buf, scan));
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
      const { exportDocx } = await loadExport();
      const profile = profileFromTabUrl(pageUrl);
      const client = profile ? new ConfluenceClient(profile) : null;
      const { bytes, report: rep } = await exportDocx({
        templateBytes: new Uint8Array(template.bytes),
        details: loadedPage.details,
        template: { name: template.name, modificationDate: new Date(template.uploadedAt) },
        deps: client
          ? {
              getSpace: (key) => client.getSpace(key),
              getCurrentUser: () => client.getCurrentUser(),
            }
          : {},
      });
      download(bytes, rep.filename);
      setReport(rep);
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`);
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

function ScanView({ scan }: { scan: ScanResult }): React.JSX.Element {
  const { supported, unsupported, never } = scan;
  return (
    <div data-testid="template-scan" style={{ marginTop: 8, fontSize: 12 }}>
      {supported.length === 0 && unsupported.length === 0 && never.length === 0 && (
        <p style={{ color: "#7a869a", margin: 0 }}>No Scroll placeholders detected.</p>
      )}
      <ScanGroup icon="✓" color="#006644" label="Supported" hits={supported} />
      <ScanGroup icon="⚠" color="#974f0c" label="Will be empty" hits={unsupported} note="will be empty" />
      <ScanGroup icon="✗" color="#bf2600" label="Not supported" hits={never} />
    </div>
  );
}

function ScanGroup({
  icon,
  color,
  label,
  hits,
  note,
}: {
  icon: string;
  color: string;
  label: string;
  hits: ScanResult["supported"];
  note?: string;
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
            {note ? <span style={{ color: "#7a869a" }}> — {note}</span> : ""}
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
        {report.skippedImages > 0 && <li data-testid="report-skipped-images">{report.skippedImages} image(s) skipped (embedding not yet available)</li>}
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
