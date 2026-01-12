/**
 * Import utilities for Jira issues.
 *
 * Supports CSV and JSON formats with create-only mode.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { JiraClient } from "./client.js";
import type { ImportIssue, ImportResult, ExportData } from "./types.js";

/**
 * Parse a CSV line respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    i++;
  }
  values.push(current);
  return values;
}

/**
 * Parse CSV content to import issues.
 */
export function parseCsv(content: string): ImportIssue[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const issues: ImportIssue[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j]] = values[j];
    }

    // Skip if no summary
    if (!row.summary) continue;

    // Build fields from row
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "key" || key === "comments" || key === "attachments") continue;
      if (!value) continue;

      // Handle special fields
      if (key === "issuetype") {
        fields.issuetype = { name: value };
      } else if (key === "priority") {
        fields.priority = { name: value };
      } else if (key === "assignee") {
        fields.assignee = { accountId: value };
      } else if (key === "labels") {
        fields.labels = value.split(",").map((l) => l.trim()).filter(Boolean);
      } else if (key === "components") {
        fields.components = value.split(",").map((c) => ({ name: c.trim() })).filter((c) => c.name);
      } else {
        fields[key] = value;
      }
    }

    // Ensure issuetype has a default
    if (!fields.issuetype) {
      fields.issuetype = { name: "Task" };
    }

    const issue: ImportIssue = {
      fields: fields as ImportIssue["fields"],
    };

    // Parse comments if present
    if (row.comments) {
      try {
        const comments = JSON.parse(row.comments);
        if (Array.isArray(comments)) {
          issue.comments = comments.map((c) => ({
            body: typeof c === "string" ? c : c.body ?? String(c),
          }));
        }
      } catch {
        // Ignore invalid comment JSON
      }
    }

    issues.push(issue);
  }

  return issues;
}

/**
 * Parse JSON content to import issues.
 */
export function parseJson(content: string): ImportIssue[] {
  const data = JSON.parse(content) as ExportData | { issues: ExportData["issues"] } | ExportData["issues"];

  // Handle different JSON structures
  let issues: ExportData["issues"];
  if (Array.isArray(data)) {
    issues = data;
  } else if ("issues" in data) {
    issues = data.issues;
  } else {
    throw new Error("Invalid JSON format: expected array or object with 'issues' property");
  }

  return issues.map((exported): ImportIssue => {
    // Build fields, handling nested objects
    const fields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(exported.fields)) {
      if (key === "status" || key === "created" || key === "updated" || key === "creator" || key === "reporter") {
        // Skip read-only fields
        continue;
      }

      if (value === null || value === undefined) continue;

      // Handle object values (extract name/id)
      if (typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if ("name" in obj) {
          fields[key] = { name: obj.name };
        } else if ("id" in obj) {
          fields[key] = { id: obj.id };
        } else if ("accountId" in obj) {
          fields[key] = { accountId: obj.accountId };
        }
      } else {
        fields[key] = value;
      }
    }

    // Ensure required fields
    if (!fields.issuetype) {
      fields.issuetype = { name: "Task" };
    }

    const issue: ImportIssue = {
      fields: fields as ImportIssue["fields"],
    };

    // Include comments
    if (exported.comments && exported.comments.length > 0) {
      issue.comments = exported.comments.map((c) => ({ body: c.body }));
    }

    // Include attachments (will need base64 decoding)
    if (exported.attachments && exported.attachments.length > 0) {
      issue.attachments = exported.attachments.map((a) => ({
        filename: a.filename,
        content: a.content, // Base64 for JSON
      }));
    }

    return issue;
  });
}

/**
 * Import issues into Jira (create-only mode).
 */
export async function importIssues(
  client: JiraClient,
  issues: ImportIssue[],
  options: {
    project: string;
    dryRun?: boolean;
    skipAttachments?: boolean;
  },
  onProgress?: (current: number, total: number, summary: string, status: string) => void
): Promise<ImportResult> {
  const result: ImportResult = {
    total: issues.length,
    created: 0,
    skipped: 0,
    failed: 0,
    issues: [],
  };

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const summary = issue.fields.summary;
    onProgress?.(i + 1, issues.length, summary, "processing");

    // Add project to fields
    const createFields = {
      ...issue.fields,
      project: { key: options.project },
    };

    if (options.dryRun) {
      result.created++;
      result.issues.push({
        summary,
        status: "created",
      });
      continue;
    }

    try {
      // Create the issue
      const created = await client.createIssue({ fields: createFields });
      result.created++;
      result.issues.push({
        key: created.key,
        summary,
        status: "created",
      });

      // Add comments
      if (issue.comments && issue.comments.length > 0) {
        for (const comment of issue.comments) {
          try {
            await client.addComment(created.key, comment.body);
          } catch {
            // Continue on comment failure
          }
        }
      }

      // Upload attachments
      if (!options.skipAttachments && issue.attachments && issue.attachments.length > 0) {
        for (const att of issue.attachments) {
          try {
            // Decode base64 content
            const data = Buffer.from(att.content, "base64");
            await client.uploadAttachment(created.key, att.filename, data);
          } catch {
            // Continue on attachment failure
          }
        }
      }
    } catch (err) {
      result.failed++;
      result.issues.push({
        summary,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Parse import file based on extension.
 */
export async function parseImportFile(filePath: string): Promise<ImportIssue[]> {
  const content = await readFile(filePath, "utf-8");
  const lowerPath = filePath.toLowerCase();

  if (lowerPath.endsWith(".json")) {
    return parseJson(content);
  } else if (lowerPath.endsWith(".csv")) {
    return parseCsv(content);
  } else {
    throw new Error(`Unsupported file format. Use .json or .csv`);
  }
}
