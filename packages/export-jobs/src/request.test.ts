import { describe, expect, it } from "bun:test";
import {
  parsePdfExportJobRequestV1,
  templatePackRecordKey,
  type PdfExportJobRequestV1,
} from "./index.js";

function request(template: unknown): unknown {
  return {
    schema: "atlcli.export-job-request/1",
    id: "job-1",
    idempotencyKey: "request-1",
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin: "https://example.atlassian.net",
      locator: { kind: "page-id", id: "42" },
      scope: { kind: "page" },
      completenessMode: "strict",
    },
    authRef: "cli-profile:test",
    displayName: "Synthetic export",
    createdAt: 1,
    priority: "interactive",
    output: { policy: "collect" },
    template,
    settings: {},
    options: { resolveMacros: true },
  };
}

describe("PDF template request reference", () => {
  it("round-trips the exact tagged built-in and pack union", () => {
    const builtin = request({
      kind: "builtin",
      id: "builtin.editorial-indigo",
      manifestVersion: "1.0.0",
    }) as PdfExportJobRequestV1;
    expect(parsePdfExportJobRequestV1(builtin)).toBe(builtin);

    const archiveSha256 = "a".repeat(64);
    const pack = request({
      kind: "pack",
      archiveSha256,
      recordKey: templatePackRecordKey(archiveSha256),
    }) as PdfExportJobRequestV1;
    expect(parsePdfExportJobRequestV1(pack)).toBe(pack);
  });

  it("reads a historical untagged built-in as a tagged built-in", () => {
    const parsed = parsePdfExportJobRequestV1(
      request({ id: "default", manifestVersion: "1" })
    );
    expect(parsed.template).toEqual({
      kind: "builtin",
      id: "default",
      manifestVersion: "1",
    });
  });

  it("rejects mixed fields, local paths, and hashes without their content key", () => {
    const archiveSha256 = "b".repeat(64);
    for (const template of [
      {
        kind: "pack",
        archiveSha256,
        recordKey: templatePackRecordKey(archiveSha256),
        id: "builtin",
      },
      {
        kind: "pack",
        archiveSha256,
        recordKey: "/tmp/design.wiki-pdf-template",
      },
      { kind: "pack", archiveSha256 },
      {
        kind: "builtin",
        id: "builtin",
        manifestVersion: "1",
        path: "./design.wiki-pdf-template",
      },
    ]) {
      expect(() => parsePdfExportJobRequestV1(request(template))).toThrow();
    }
  });
});
