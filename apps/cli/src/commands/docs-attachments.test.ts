import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAttachmentFile, resolveAttachmentFile } from "./docs-attachments.js";

describe("resolveAttachmentFile", () => {
  test("resolves a flat attachment inside its page directory", () => {
    expect(resolveAttachmentFile("/tmp/page.attachments", "architecture.drawio")).toBe(
      resolve("/tmp/page.attachments/architecture.drawio"),
    );
  });

  test("rejects traversal, absolute, Windows-style, and empty names", () => {
    for (const filename of ["../secret", "/etc/passwd", "nested/file", "..\\secret", "", ".", ".."]) {
      expect(resolveAttachmentFile("/tmp/page.attachments", filename)).toBeUndefined();
    }
  });

  test("refuses to read an attachment symlink that points outside the directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "atlcli-attachment-guard-"));
    try {
      const attachments = join(root, "page.attachments");
      const outside = join(root, "secret.drawio");
      await mkdir(attachments);
      await writeFile(outside, "secret");
      await symlink(outside, join(attachments, "diagram.drawio"));

      await expect(readAttachmentFile(attachments, "diagram.drawio")).rejects.toThrow("not a regular file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
