import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFLUENCE_LEGACY_EMOJI_PROJECTIONS } from "@atlcli/confluence";
import { buildDocx } from "./fixtures.js";
import { paragraph, run } from "./ooxml.js";

function which(cmd: string): boolean {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

const HAVE_TOOLS = (which("soffice") || which("libreoffice")) && which("pdftotext");

describe("legacy emoji projection DOCX font coverage", () => {
  it.skipIf(!HAVE_TOOLS)(
    "round-trips every canonical projection through LibreOffice PDF text extraction",
    () => {
      const entries = Object.values(CONFLUENCE_LEGACY_EMOJI_PROJECTIONS);
      const body = entries
        .map(({ canonicalName, text }) => paragraph(run(`${canonicalName}: ${text}`)))
        .join("");
      const bytes = buildDocx({
        body,
        date: new Date("2026-07-24T00:00:00.000Z"),
      });
      const dir = mkdtempSync(join(tmpdir(), "atlcli-emoji-font-"));
      try {
        const docxPath = join(dir, "emoji-projections.docx");
        const profilePath = join(dir, "libreoffice-profile");
        mkdirSync(profilePath);
        writeFileSync(docxPath, bytes);
        const soffice = which("soffice") ? "soffice" : "libreoffice";
        const converted = spawnSync(
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
        expect(converted.status, converted.stdout + converted.stderr).toBe(0);

        const extracted = spawnSync(
          "pdftotext",
          ["-layout", join(dir, "emoji-projections.pdf"), "-"],
          { encoding: "utf8" }
        );
        expect(extracted.status, extracted.stdout + extracted.stderr).toBe(0);
        for (const { canonicalName, text } of entries) {
          expect(extracted.stdout).toContain(`${canonicalName}:`);
          expect(extracted.stdout).toContain(text);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
