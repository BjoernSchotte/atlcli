/**
 * Export utilities for Jira issues.
 *
 * Supports CSV and JSON formats with comments and attachments.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import type { JiraClient } from "./client.js";
import type {
  JiraIssue,
  ExportedIssue,
  ExportedComment,
  ExportedAttachment,
  ExportData,
  ExportOptions,
} from "./types.js";

/**
 * Escape a value for CSV (RFC 4180 compliant).
 */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  // If contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Flatten issue fields for CSV export.
 */
function flattenFields(fields: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      flat[key] = "";
    } else if (typeof value === "object") {
      // Extract meaningful values from objects
      const obj = value as Record<string, unknown>;
      if ("name" in obj) {
        flat[key] = String(obj.name);
      } else if ("displayName" in obj) {
        flat[key] = String(obj.displayName);
      } else if ("key" in obj) {
        flat[key] = String(obj.key);
      } else if (Array.isArray(value)) {
        // Arrays: join names or values
        flat[key] = value
          .map((v) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>).name ?? JSON.stringify(v) : String(v)))
          .join(", ");
      } else {
        flat[key] = JSON.stringify(value);
      }
    } else {
      flat[key] = String(value);
    }
  }
  return flat;
}

/**
 * Convert exported issues to CSV string.
 */
export function issuesToCsv(issues: ExportedIssue[], includeComments = true, includeAttachments = true): string {
  if (issues.length === 0) return "";

  // Collect all field keys from all issues
  const fieldKeys = new Set<string>();
  for (const issue of issues) {
    for (const key of Object.keys(issue.fields)) {
      fieldKeys.add(key);
    }
  }

  // Build header row
  const headers = ["key", ...Array.from(fieldKeys).sort()];
  if (includeComments) headers.push("comments");
  if (includeAttachments) headers.push("attachments");

  const rows: string[] = [headers.map(escapeCsvValue).join(",")];

  // Build data rows
  for (const issue of issues) {
    const flat = flattenFields(issue.fields);
    const values: string[] = [
      escapeCsvValue(issue.key),
      ...Array.from(fieldKeys)
        .sort()
        .map((k) => escapeCsvValue(flat[k] ?? "")),
    ];
    if (includeComments) {
      values.push(escapeCsvValue(issue.comments ?? []));
    }
    if (includeAttachments) {
      // For CSV, just list filenames
      const filenames = (issue.attachments ?? []).map((a) => a.filename).join(", ");
      values.push(escapeCsvValue(filenames));
    }
    rows.push(values.join(","));
  }

  return rows.join("\n");
}

/**
 * Convert exported issues to JSON string.
 */
export function issuesToJson(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Collect all issues with comments and attachments for export.
 */
export async function collectExportData(
  client: JiraClient,
  issues: JiraIssue[],
  options: ExportOptions,
  onProgress?: (current: number, total: number, key: string) => void
): Promise<ExportedIssue[]> {
  const exported: ExportedIssue[] = [];
  const attachmentDir = options.format === "csv" ? `${options.outputPath}_attachments` : null;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    onProgress?.(i + 1, issues.length, issue.key);

    // Flatten fields, keeping customfield_* names
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(issue.fields)) {
      // Skip complex nested objects that aren't useful
      if (key === "attachment" || key === "comment") continue;
      fields[key] = value;
    }

    const exportedIssue: ExportedIssue = {
      key: issue.key,
      fields,
    };

    // Fetch comments if requested
    if (options.includeComments) {
      try {
        const commentsResult = await client.getComments(issue.key, { maxResults: 1000 });
        exportedIssue.comments = commentsResult.comments.map((c): ExportedComment => ({
          author: c.author?.displayName ?? c.author?.emailAddress ?? "Unknown",
          body: client.adfToText(c.body),
          created: c.created,
        }));
      } catch {
        // Skip comments if fetch fails
        exportedIssue.comments = [];
      }
    }

    // Fetch and download attachments if requested
    if (options.includeAttachments) {
      try {
        const attachments = await client.getIssueAttachments(issue.key);
        exportedIssue.attachments = [];

        for (const att of attachments) {
          try {
            const data = await client.downloadAttachment(att.content);

            if (options.format === "json") {
              // Base64 encode for JSON
              exportedIssue.attachments.push({
                filename: att.filename,
                content: data.toString("base64"),
                size: att.size,
                mimeType: att.mimeType,
              });
            } else if (attachmentDir) {
              // Save to file for CSV
              const issueDir = join(attachmentDir, issue.key);
              await mkdir(issueDir, { recursive: true });
              const filePath = join(issueDir, att.filename);
              await writeFile(filePath, data);
              exportedIssue.attachments.push({
                filename: att.filename,
                content: `${issue.key}/${att.filename}`, // Relative path
                size: att.size,
                mimeType: att.mimeType,
              });
            }
          } catch {
            // Skip individual attachment on error
          }
        }
      } catch {
        // Skip attachments if fetch fails
        exportedIssue.attachments = [];
      }
    }

    exported.push(exportedIssue);
  }

  return exported;
}

/**
 * Write export data to file.
 */
export async function writeExportFile(
  data: ExportData,
  options: ExportOptions
): Promise<void> {
  const dir = dirname(options.outputPath);
  if (dir && dir !== ".") {
    await mkdir(dir, { recursive: true });
  }

  if (options.format === "json") {
    await writeFile(options.outputPath, issuesToJson(data));
  } else {
    const csv = issuesToCsv(
      data.issues,
      options.includeComments ?? true,
      options.includeAttachments ?? true
    );
    await writeFile(options.outputPath, csv);
  }
}
