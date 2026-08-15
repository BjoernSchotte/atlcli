import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { handleWikiImport } from "./wiki-import.js";
import {
  buildDocxFixture,
  p,
  r,
} from "../../../../packages/import-docx/src/test-support.js";

describe("wiki import (preview mode, offline)", () => {
  let dir: string;
  let stdout: string[];
  let writeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-import-test-"));
    stdout = [];
    writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("previews without any config, profile, or network access", async () => {
    const file = join(dir, "fixture.docx");
    writeFileSync(
      file,
      buildDocxFixture({
        body:
          p(r("My Handbook"), { style: "Heading1" }) +
          p(r("Intro text")) +
          p(r("item"), { numId: "1" }),
      }),
    );

    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.mode).toBe("preview");
    expect(parsed.preview.target).toEqual({
      spaceKey: "DOCSY",
      title: "My Handbook",
      parentId: undefined,
    });
    expect(parsed.preview.counts).toEqual({ heading: 1, paragraph: 2, list: 1 });
    expect(parsed.preview.adfDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("renders a human preview with confirm hint in text mode", async () => {
    const file = join(dir, "fixture.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Title"), { style: "Heading1" }) }));

    await handleWikiImport([file], { space: "DOCSY" }, { json: false });

    const text = stdout.join("");
    expect(text).toContain("Import preview");
    expect(text).toContain("H1 Title");
    expect(text).toContain("--confirm");
  });

  it("previews a --split page tree with per-page block counts", async () => {
    const file = join(dir, "split.docx");
    writeFileSync(
      file,
      buildDocxFixture({
        body:
          p(r("Preamble")) +
          p(r("Intro"), { style: "Heading1" }) +
          p(r("Intro text")) +
          p(r("Background"), { style: "Heading2" }) +
          p(r("Background text")) +
          p(r("Usage"), { style: "Heading1" }) +
          p(r("Usage text")),
      }),
    );

    await handleWikiImport(
      [file],
      { space: "DOCSY", title: "Guide", split: "2", json: true },
      { json: true },
    );

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.mode).toBe("preview");
    expect(parsed.tree.title).toBe("Guide");
    expect(parsed.tree.children.map((c: { title: string }) => c.title)).toEqual([
      "Intro",
      "Usage",
    ]);
    expect(parsed.tree.children[0].children[0].title).toBe("Background");
  });

  it("rejects a --split that would produce duplicate titles", async () => {
    const file = join(dir, "dupes.docx");
    writeFileSync(
      file,
      buildDocxFixture({
        body:
          p(r("Setup"), { style: "Heading1" }) + p(r("x")) + p(r("Setup"), { style: "Heading1" }),
      }),
    );

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport(
        [file],
        { space: "DOCSY", split: "1", json: true },
        { json: true },
      ).catch(() => {});
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain("same title");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("previews a directory batch with per-file summaries", async () => {
    const batchDir = join(dir, "batch");
    mkdirSync(batchDir);
    writeFileSync(
      join(batchDir, "b-second.docx"),
      buildDocxFixture({ body: p(r("Second Doc"), { style: "Heading1" }) + p(r("text")) }),
    );
    writeFileSync(
      join(batchDir, "a-first.docx"),
      buildDocxFixture({ body: p(r("First Doc"), { style: "Heading1" }) }),
    );
    writeFileSync(join(batchDir, "broken.docx"), new TextEncoder().encode("not a zip"));

    await handleWikiImport([batchDir], { space: "DOCSY", json: true }, { json: true });

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.mode).toBe("batch-preview");
    // Sorted, deterministic order; the broken file is reported, not fatal.
    expect(parsed.items.map((i: { file: string }) => basename(i.file))).toEqual([
      "a-first.docx",
      "b-second.docx",
      "broken.docx",
    ]);
    expect(parsed.items[0].title).toBe("First Doc");
    expect(parsed.items[1].pages).toBe(1);
    expect(parsed.items[2].error).toContain("docx");
  });

  it("rejects a batch whose files would create the same title", async () => {
    const batchDir = join(dir, "dupes");
    mkdirSync(batchDir);
    for (const name of ["one.docx", "two.docx"]) {
      writeFileSync(
        join(batchDir, name),
        buildDocxFixture({ body: p(r("Same Title"), { style: "Heading1" }) }),
      );
    }
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport([batchDir], { space: "DOCSY", json: true }, { json: true }).catch(
        () => {},
      );
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain("same title");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("shows governance in the preview and stays fully offline", async () => {
    const file = join(dir, "gov.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc"), { style: "Heading1" }) }));

    await handleWikiImport(
      [file],
      {
        space: "DOCSY",
        restriction: "explicit",
        viewer: ["account:557058:abc", "group-id:g9"],
        label: ["Migrated", "migrated"],
        "content-property": ["atlcli.import.batch=wave-1"],
        "staging-parent": "Imported drafts",
        json: true,
      },
      { json: true },
    );

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.mode).toBe("preview");
    expect(parsed.governance.restriction.mode).toBe("explicit");
    expect(parsed.governance.restriction.viewers).toEqual([
      { kind: "cloud-account", accountId: "557058:abc" },
      { kind: "cloud-group", groupId: "g9" },
    ]);
    expect(parsed.governance.labels).toEqual(["migrated"]);
    expect(parsed.governance.contentProperties).toEqual([
      { key: "atlcli.import.batch", value: "wave-1" },
    ]);
    expect(parsed.governance.staging).toEqual({ mode: "private-parent", title: "Imported drafts" });
  });

  it("rejects invalid governance before any preview", async () => {
    const file = join(dir, "gov-bad.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc")) }));

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport(
        [file],
        { space: "DOCSY", restriction: "explicit", viewer: ["group:legacy-dc"], json: true },
        { json: true },
      ).catch(() => {});
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain("Data Center kind");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("falls back to the file name when the document has no level-1 heading", async () => {
    const file = join(dir, "notes.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("just text")) }));

    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.preview.target.title).toBe("notes");
  });
});
