import { describe, expect, test } from "bun:test";
import type { Profile } from "@atlcli/core";
import { buildCliDocxJobRequest, buildCliExportSource, buildCliPdfJobRequest } from "./export-job-request.js";
import { parseExportRequest } from "./export-request.js";

const profile = {
  name: "work",
  baseUrl: "https://example.atlassian.net/wiki",
  auth: { type: "apiToken", email: "x@example.com", token: "secret" },
} as Profile;

describe("durable CLI export job requests", () => {
  test("keeps an unresolved tree source and every traversal limit without credentials", () => {
    const parsed = parseExportRequest("DOCS:Architecture", {
      scope: "tree",
      "max-depth": "7",
      "max-pages": "80",
      "max-folders": "20",
      "label-exclude": "private",
    });
    expect(buildCliExportSource(parsed, profile)).toEqual({
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "content-key", value: "DOCS:Architecture" },
      scope: { kind: "tree", includeRoot: true, maxDepth: 7 },
      labels: { exclude: ["private"] },
      completenessMode: "strict",
      maxPages: 80,
      maxFolders: 20,
    });
  });

  test("pins DOCX replay and legacy replace authorization but never the token", () => {
    const request = buildCliDocxJobRequest({
      id: "job-1", idempotencyKey: "key-1", createdAt: 10,
      request: parseExportRequest("123", {}), profile, outputPath: "out/report.docx",
      template: { recordKey: "template:1", sha256: "a".repeat(64), name: "report.docx" },
      embedImages: true, keepIgnored: false, strict: true, noFieldUpdatePrompt: true,
      overwriteExisting: true,
      codeTheme: "dracula",
    });
    expect(request.source.locator).toEqual({ kind: "page-id", id: "123" });
    expect(request.options).toMatchObject({ strict: true, updateFields: "never" });
    expect(request.options.codeTheme).toBe("dracula");
    expect(request.output.overwriteExisting).toBe(true);
    expect(JSON.stringify(request)).not.toContain("secret");
  });

  test("pins PDF output policy and reproducible timestamp", () => {
    const request = buildCliPdfJobRequest({
      id: "job-2", idempotencyKey: "key-2", createdAt: 20,
      request: parseExportRequest(undefined, { scope: "space", space: "DOCS" }),
      profile, outputPath: "/tmp/report.pdf", force: false, strict: true, noCache: true,
      exportedAt: new Date("2026-01-02T03:04:05Z"),
      codeTheme: "dracula",
    });
    expect(request.source.locator).toEqual({ kind: "space-key", spaceKey: "DOCS" });
    expect(request.output.overwriteExisting).toBe(false);
    expect(request.output.targetKind).toBe("file");
    expect(request.options).toMatchObject({ strict: true, noCache: true, exportedAt: 1767323045000 });
    expect(request.options.codeTheme).toBe("dracula");
    expect(request.template).toEqual({
      kind: "builtin",
      id: "builtin-default",
      manifestVersion: "1",
    });
  });

  test("persists only the verified content-addressed PDF pack identity", () => {
    const archiveSha256 = "d".repeat(64);
    const request = buildCliPdfJobRequest({
      id: "job-pack",
      idempotencyKey: "key-pack",
      createdAt: 20,
      request: parseExportRequest("123", {}),
      profile,
      outputPath: "/tmp/report.pdf",
      force: false,
      strict: false,
      noCache: false,
      template: {
        kind: "pack",
        archiveSha256,
        recordKey: `template-pack:sha256:${archiveSha256}`,
      },
    });
    expect(request.template).toEqual({
      kind: "pack",
      archiveSha256,
      recordKey: `template-pack:sha256:${archiveSha256}`,
    });
    expect(JSON.stringify(request)).not.toContain(".wiki-pdf-template");
  });

  test("records a directory target without pretending its basename is a filename", () => {
    const request = buildCliPdfJobRequest({
      id: "job-dir", idempotencyKey: "key-dir", createdAt: 30,
      request: parseExportRequest("123", {}), profile, outputPath: "/tmp/exports",
      outputTargetKind: "directory", force: false, strict: false, noCache: false,
    });
    expect(request.output).toMatchObject({ targetRef: "/tmp/exports", targetKind: "directory" });
    expect(request.requestedFilename).toBeUndefined();
  });

  test("materializes the stable default theme before durable persistence", () => {
    const request = buildCliPdfJobRequest({
      id: "job-default", idempotencyKey: "key-default", createdAt: 40,
      request: parseExportRequest("123", {}), profile, outputPath: "/tmp/default.pdf",
      force: false, strict: false, noCache: false,
    });
    expect(request.options.codeTheme).toBe("github-light");
  });
});
