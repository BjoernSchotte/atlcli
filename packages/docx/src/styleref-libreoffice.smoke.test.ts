/**
 * STYLEREF verification (spec 006 G1) — Stage 2: LibreOffice render smoke.
 *
 * A second-implementation proof that the exported DOCX is truly consumable:
 * export the STYLEREF fixture, render it to PDF with headless LibreOffice, pull
 * text with `pdftotext`, and assert the H1 chapter text appears on page ≥ 2 (so
 * the running-header STYLEREF resolved to the current chapter). Requires
 * `soffice` (LibreOffice) and `pdftotext` (poppler-utils) in the runner image;
 * when either is absent the test SKIPS (so it is green locally and gated on the
 * CI job that installs them). LibreOffice is known to compute STYLEREF slightly
 * differently from Word, so this is necessary-but-not-sufficient evidence — the
 * manual Word protocol in docs/ remains the final truth (spec 006 G1 Stage 3).
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDocx } from "./export.js";
import { buildDocx, fldSimpleResult, headingStyle, para, stylesXml } from "./fixtures.js";
import type { ConfluencePageDetails } from "@atlcli/confluence";

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}
const HAVE_TOOLS = (which("soffice") || which("libreoffice")) && which("pdftotext");

describe("STYLEREF LibreOffice smoke (spec 006 G1 Stage 2)", () => {
  it.skipIf(!HAVE_TOOLS)("renders the chapter into the running header on later pages", async () => {
    const details: ConfluencePageDetails = {
      id: "1",
      title: "StyleRef Smoke",
      url: "u",
      version: 1,
      spaceKey: "DOCSY",
      // Enough content to spill onto page 2 so the running header is exercised.
      storage: `<h1>Chapter One</h1>${"<p>filler paragraph to push content onto a second page.</p>".repeat(80)}`,
      tinyUrl: "t",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      createdBy: { displayName: "A" },
      modifiedBy: { displayName: "B" },
      labels: [],
    };
    const templateBytes = buildDocx({
      body: para("$scroll.content"),
      styles: stylesXml(headingStyle("SH1", "Scroll Heading 1")),
      header: fldSimpleResult(" STYLEREF &quot;Scroll Heading 1&quot; \\* MERGEFORMAT ", "STALE"),
    });
    const { bytes } = await exportDocx({
      templateBytes,
      details,
      template: { name: "t.docx", modificationDate: new Date(2026, 0, 1) },
      deps: {
        getSpace: async () => ({ id: "s", key: "DOCSY", name: "S", type: "global" as const }),
        getCurrentUser: async () => ({ accountId: "u", displayName: "U" }),
        getPageOwner: async () => ({ accountId: "o", displayName: "O" }),
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "atlcli-styleref-"));
    const docxPath = join(dir, "out.docx");
    writeFileSync(docxPath, bytes);
    const soffice = which("soffice") ? "soffice" : "libreoffice";
    const conv = spawnSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", dir, docxPath], {
      encoding: "utf8",
    });
    expect(conv.status).toBe(0);
    const pdfPath = join(dir, "out.pdf");
    const txt = spawnSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    expect(txt.status).toBe(0);
    // The chapter text must appear (in the header) beyond the first occurrence.
    expect(txt.stdout).toContain("Chapter One");
    // A second occurrence (the running header on page 2) proves the field
    // resolved rather than staying "STALE".
    expect((txt.stdout.match(/Chapter One/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(txt.stdout).not.toContain("STALE");
  });
});
