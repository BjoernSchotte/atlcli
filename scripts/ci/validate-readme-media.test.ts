import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  README_MEDIA_POLICY,
  validateReadmeMedia,
  type ReadmeMediaIssue,
} from "./validate-readme-media.js";

const roots: string[] = [];

async function fixture(
  readme: string,
  files: Record<string, Uint8Array | string>,
  tracked = Object.keys(files)
): Promise<ReadmeMediaIssue[]> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-readme-media-"));
  roots.push(root);
  await writeFile(join(root, "README.md"), readme);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return validateReadmeMedia({
    repoRoot: root,
    trackedFiles: new Set(["README.md", ...tracked]),
  });
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("README media validation", () => {
  it("accepts committed local Markdown and HTML PNG/PDF references", async () => {
    const issues = await fixture(
      [
        "![Screenshot](assets/readme/example.png)",
        '<img src="assets/readme/example.png" alt="Screenshot">',
        "[Reference](assets/readme/reference.pdf)",
      ].join("\n"),
      {
        "assets/readme/example.png": png(1200, 800),
        "assets/readme/reference.pdf": "%PDF-1.7\n1 0 obj <</Type /Page>> endobj\n%%EOF",
      }
    );
    expect(issues).toEqual([]);
  });

  it("reports missing, uncommitted, and unsupported image references", async () => {
    const issues = await fixture(
      [
        "![Missing](assets/readme/missing.png)",
        "![Uncommitted](assets/readme/uncommitted.png)",
        "![JPEG](assets/readme/example.jpg)",
      ].join("\n"),
      {
        "assets/readme/uncommitted.png": png(100, 100),
        "assets/readme/example.jpg": "jpeg",
      },
      ["assets/readme/example.jpg", "assets/readme/missing.png"]
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "referenced README media does not exist",
      "referenced README media is not committed",
      "unsupported media extension .jpg; allowed: .png, .pdf",
    ]);
  });

  it("reports actionable per-file size limits", async () => {
    const oversized = new Uint8Array(README_MEDIA_POLICY.maxFileBytes + 1);
    oversized.set(png(100, 100));
    const issues = await fixture("![Large](assets/readme/large.png)", {
      "assets/readme/large.png": oversized,
    });
    expect(issues).toContainEqual({
      file: "assets/readme/large.png",
      message: expect.stringContaining("exceeds the per-file limit 10.0 MiB"),
    });
  });

  it("bounds PNG dimensions and detectable PDF page counts", async () => {
    const pages = Array.from(
      { length: README_MEDIA_POLICY.maxPdfPages + 1 },
      (_, index) => `${index + 1} 0 obj <</Type /Page>> endobj`
    ).join("\n");
    const issues = await fixture(
      [
        "![Wide](assets/readme/wide.png)",
        "[Long PDF](assets/readme/long.pdf)",
      ].join("\n"),
      {
        "assets/readme/wide.png": png(README_MEDIA_POLICY.maxPngWidth + 1, 10),
        "assets/readme/long.pdf": `%PDF-1.7\n${pages}\n%%EOF`,
      }
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("PNG dimensions 4097x10"),
      expect.stringContaining("detectable PDF page count 21"),
    ]);
  });

  it("rejects invalid PNG and PDF headers", async () => {
    const issues = await fixture(
      [
        "![Broken PNG](assets/readme/broken.png)",
        "[Broken PDF](assets/readme/broken.pdf)",
      ].join("\n"),
      {
        "assets/readme/broken.png": "not a png",
        "assets/readme/broken.pdf": "not a pdf",
      }
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "invalid PNG signature or IHDR header",
      "invalid PDF header; expected %PDF-",
    ]);
  });

  it("counts duplicate links once and enforces the aggregate size limit", async () => {
    const first = new Uint8Array(README_MEDIA_POLICY.maxFileBytes);
    const second = new Uint8Array(README_MEDIA_POLICY.maxFileBytes);
    const third = new Uint8Array(README_MEDIA_POLICY.maxFileBytes);
    for (const bytes of [first, second, third]) bytes.set(png(100, 100));
    const issues = await fixture(
      [
        "![First](assets/readme/first.png)",
        "![First again](assets/readme/first.png)",
        "![Second](assets/readme/second.png)",
        "![Third](assets/readme/third.png)",
      ].join("\n"),
      {
        "assets/readme/first.png": first,
        "assets/readme/second.png": second,
        "assets/readme/third.png": third,
      }
    );
    expect(issues).toEqual([
      {
        file: "README.md",
        message: expect.stringContaining("exceeding the aggregate limit 25.0 MiB"),
      },
    ]);
  });
});
