/**
 * DOCX header verification (spec 006 G1) — Stage 2: LibreOffice render smoke.
 *
 * This second-implementation check proves that an exported DOCX is consumable
 * and that its header part is actually attached to the document section: render
 * a multi-page export with headless LibreOffice, extract its PDF text, and
 * assert that a static header appears on both pages.
 *
 * This deliberately does NOT claim that LibreOffice verifies STYLEREF. In
 * headless conversion, supported LibreOffice versions either retain the stale
 * cached result or replace it with "Reference source not found" instead of
 * updating the imported Word field. STYLEREF therefore remains covered by the
 * OOXML invariants in styleref.test.ts and the manual Word protocol.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exportDocx } from "./export.js";
import { buildDocx, para } from "./fixtures.js";
import type { ConfluencePageDetails } from "@atlcli/confluence";

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}
const HAVE_TOOLS = (which("soffice") || which("libreoffice")) && which("pdftotext");
const HEADER_TEXT = "ATLCLI HEADER RENDER SMOKE";

describe("DOCX header LibreOffice smoke (spec 006 G1 Stage 2)", () => {
  it.skipIf(!HAVE_TOOLS)("renders an attached static header on every page", async () => {
    const details: ConfluencePageDetails = {
      id: "1",
      title: "Header Smoke",
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
      header: para(HEADER_TEXT),
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

    const dir = mkdtempSync(join(tmpdir(), "atlcli-header-smoke-"));
    try {
      const docxPath = join(dir, "out.docx");
      const profilePath = join(dir, "libreoffice-profile");
      mkdirSync(profilePath);
      writeFileSync(docxPath, bytes);
      const soffice = which("soffice") ? "soffice" : "libreoffice";
      const conv = spawnSync(
        soffice,
        [
          `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          docxPath,
        ],
        { cwd: dir, encoding: "utf8" }
      );
      if (conv.status !== 0) {
        throw new Error(
          `LibreOffice conversion failed with status ${String(conv.status)}:\n${conv.stdout}${conv.stderr}`
        );
      }

      const pdfPath = join(dir, "out.pdf");
      const txt = spawnSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
      if (txt.status !== 0) {
        throw new Error(`pdftotext failed with status ${String(txt.status)}:\n${txt.stdout}${txt.stderr}`);
      }
      const pages = txt.stdout.split("\f").filter((page) => page.trim().length > 0);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(pages[0]).toContain(HEADER_TEXT);
      expect(pages[1]).toContain(HEADER_TEXT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
