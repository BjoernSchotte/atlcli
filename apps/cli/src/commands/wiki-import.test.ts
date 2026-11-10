import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deleteSupersededAttachments, handleWikiImport, resolvePolicyFromFlags, rollbackBatchItem } from "./wiki-import.js";
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

  it("rejects governance flags in batch mode instead of publishing without them", async () => {
    const batchDir = join(dir, "governed");
    mkdirSync(batchDir);
    writeFileSync(join(batchDir, "one.docx"), buildDocxFixture({ body: p(r("One"), { style: "Heading1" }) }));
    writeFileSync(join(batchDir, "two.docx"), buildDocxFixture({ body: p(r("Two"), { style: "Heading1" }) }));

    // Any request would be a publish the user did not ask for: fail it loudly.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("no network in this test");
    }) as never);
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const cases: Array<[string, Record<string, string | string[]>]> = [
      ["--restriction", { restriction: "private" }],
      ["--viewer", { viewer: ["account:1"] }],
      ["--editor", { editor: ["account:1"] }],
      ["--staging-parent", { "staging-parent": "Drafts" }],
      ["--label", { label: ["migrated"] }],
      ["--content-property", { "content-property": ["atlcli.import.batch=w1"] }],
      ["--title-conflict", { "title-conflict": "rename" }],
      ["--update-page", { "update-page": "12345" }],
      ["--expect-version", { "expect-version": "3" }],
    ];
    try {
      for (const [flag, extra] of cases) {
        for (const confirm of [false, true]) {
          stdout.length = 0;
          const run = handleWikiImport([batchDir], { space: "DOCSY", json: true, ...(confirm ? { confirm: true } : {}), ...extra }, { json: true });
          await expect(run).rejects.toThrow("exit 1");
          const error = JSON.parse(stdout.join("")).error;
          expect(error.code).toBe("ATLCLI_ERR_VALIDATION");
          expect(error.message).toContain(`${flag} is not supported for batch imports yet`);
        }
      }
      // A manifest batch takes its destination from the manifest, not from flags.
      for (const confirm of [false, true]) {
        stdout.length = 0;
        const manifest = join(dir, "batch.yaml"); // rejected before it is even read
        const run = handleWikiImport([], { manifest, restriction: "private", json: true, ...(confirm ? { confirm: true } : {}) }, { json: true });
        await expect(run).rejects.toThrow("exit 1");
        expect(JSON.parse(stdout.join("")).error.message).toContain("--restriction is not supported for batch imports yet");
      }
      // ...and its titles, split levels and resume: flags that say otherwise were ignored without a word.
      const owned: Array<[string, Record<string, string | boolean | string[]>]> = [
        ["--space", { space: "DOCSY" }],
        ["--parent", { parent: "123" }],
        ["--split", { split: "1" }],
        ["--skip-existing", { "skip-existing": true }],
        ["--title", { title: "Other" }],
        ["--recipe", { recipe: "r.yaml" }],
        ["--comments", { comments: "skip" }],
      ];
      for (const [flag, extra] of owned) {
        for (const confirm of [false, true]) {
          stdout.length = 0;
          const run = handleWikiImport([], { manifest: join(dir, "batch.yaml"), json: true, ...(confirm ? { confirm: true } : {}), ...extra }, { json: true });
          await expect(run).rejects.toThrow("exit 1");
          const error = JSON.parse(stdout.join("")).error;
          expect(error.code).toBe("ATLCLI_ERR_VALIDATION");
          expect(error.message).toContain(`${flag} is not used with --manifest`);
        }
      }
      stdout.length = 0;
      await expect(handleWikiImport(["a.docx"], { manifest: join(dir, "batch.yaml"), json: true }, { json: true })).rejects.toThrow("exit 1");
      expect(JSON.parse(stdout.join("")).error.message).toContain("a.docx: a manifest import takes its files from the manifest's documents");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      fetchSpy.mockRestore();
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

  it("applies an override file plus CLI flags with provenance in the preview", async () => {
    const file = join(dir, "policy.docx");
    writeFileSync(
      file,
      buildDocxFixture({ body: p(r("Doc"), { style: "Heading1" }) + p(r("plain")) }),
    );
    const overrides = join(dir, "overrides.yaml");
    writeFileSync(
      overrides,
      `schema: atlcli.docx-import-overrides/1\noptions:\n  revisions: reject\nstyleMappings:\n  Hinweis: blockquote\n`,
    );

    await handleWikiImport(
      [file],
      { space: "DOCSY", overrides, "map-style": ["Legacy=code"], json: true },
      { json: true },
    );

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.policy.options.revisions).toBe("reject");
    expect(parsed.policy.provenance["options.revisions"]).toBe("override-file");
    expect(parsed.policy.styleMappings).toEqual({ hinweis: "blockquote", legacy: "code" });
    expect(parsed.policy.provenance["style:legacy"]).toBe("cli");
    // Unmatched mappings surface as info issues, not silence.
    expect(
      parsed.preview.issues.some(
        (i: { code: string }) => i.code === "docx-import/style-mapping-unmatched",
      ),
    ).toBe(true);
  });

  it("fails closed on explicit CLI vs override-file conflicts", async () => {
    const file = join(dir, "conflict.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc")) }));
    const overrides = join(dir, "conflict.yaml");
    writeFileSync(
      overrides,
      `schema: atlcli.docx-import-overrides/1\noptions:\n  revisions: reject\n`,
    );

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport(
        [file],
        { space: "DOCSY", overrides, revisions: "accept", json: true },
        { json: true },
      ).catch(() => {});
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain("Conflicting explicit settings");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("applies a recipe file with digest provenance in the preview", async () => {
    const file = join(dir, "recipe-doc.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc"), { style: "Heading1" }) }));
    const recipeFile = join(dir, "handbook.yaml");
    writeFileSync(
      recipeFile,
      `schema: atlcli.docx-import-recipe/1\nid: handbook\nversion: "1.0"\ntitle: Handbook rules\ntargets: [cloud]\noptions:\n  unsupported: fail\noverrides:\n  styleMappings:\n    Hinweis: blockquote\n`,
    );

    await handleWikiImport([file], { space: "DOCSY", recipe: recipeFile, json: true }, { json: true });

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.recipe.id).toBe("handbook");
    expect(parsed.recipe.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.policy.options.unsupported).toBe("fail");
    expect(parsed.policy.provenance["options.unsupported"]).toBe("recipe");
    expect(parsed.policy.provenance["style:hinweis"]).toBe("recipe");
  });

  it("rejects a recipe that does not target cloud, and validates via the subcommand", async () => {
    const recipeFile = join(dir, "dc-only.yaml");
    writeFileSync(
      recipeFile,
      `schema: atlcli.docx-import-recipe/1\nid: dc-only\nversion: "1"\ntitle: DC\ntargets: [data-center]\n`,
    );
    const file = join(dir, "x.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc")) }));

    let exitCode: number | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never);
    try {
      await handleWikiImport(
        [file],
        { space: "DOCSY", recipe: recipeFile, json: true },
        { json: true },
      ).catch(() => {});
      expect(exitCode).toBe(1);
      expect(stdout.join("")).toContain("not cloud");
    } finally {
      exitSpy.mockRestore();
    }

    stdout.length = 0;
    await handleWikiImport(["recipe", "validate", recipeFile], { json: true }, { json: true });
    const validated = JSON.parse(stdout.join(""));
    expect(validated.valid).toBe(true);
    expect(validated.id).toBe("dc-only");
  });

  it("exports the resolved policy as a recipe that round-trips through import", async () => {
    const out = join(dir, "exported.yaml");
    await handleWikiImport(
      ["recipe", "export"],
      {
        id: "team-conventions",
        version: "1.2",
        title: "Team conventions",
        output: out,
        "map-style": ["Hinweis=blockquote"],
        unsupported: "fail",
        json: true,
      },
      { json: true },
    );
    const exported = JSON.parse(stdout.join(""));
    expect(exported.file).toBe(out);
    expect(exported.digest).toMatch(/^[0-9a-f]{64}$/);

    // The exported recipe drives an import preview with recipe provenance.
    stdout.length = 0;
    const file = join(dir, "rt.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("Doc"), { style: "Heading1" }) }));
    await handleWikiImport([file], { space: "DOCSY", recipe: out, json: true }, { json: true });
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.recipe.id).toBe("team-conventions");
    expect(parsed.recipe.digest).toBe(exported.digest);
    expect(parsed.policy.provenance["style:hinweis"]).toBe("recipe");
    expect(parsed.policy.provenance["options.unsupported"]).toBe("recipe");
  });

  it("falls back to the file name when the document has no level-1 heading", async () => {
    const file = join(dir, "notes.docx");
    writeFileSync(file, buildDocxFixture({ body: p(r("just text")) }));

    await handleWikiImport([file], { space: "DOCSY", json: true }, { json: true });

    const parsed = JSON.parse(stdout.join(""));
    expect(parsed.preview.target.title).toBe("notes");
  });
});

describe("wiki import policy flags", () => {
  it("reads the documented --comments mode into the policy", () => {
    expect(resolvePolicyFromFlags({}, { json: false }).options.comments).toBe("auto");
    for (const mode of ["inline", "footer", "skip"]) {
      const policy = resolvePolicyFromFlags({ comments: mode }, { json: false });
      expect(policy.options.comments as string).toBe(mode);
      expect(policy.provenance["options.comments"]).toBe("cli");
    }
  });
});

describe("superseded attachment cleanup after an update", () => {
  // Regression: it runs after the new baseline is sealed; a failed listing threw,
  // the body was rolled back, and the next update called the page diverged.
  it("turns a failed attachment listing into orphan warnings instead of throwing", async () => {
    const client = {
      listAttachments: async () => {
        throw new Error("HTTP 503");
      },
      deleteAttachment: async () => {
        throw new Error("must not be reached");
      },
    };
    expect(await deleteSupersededAttachments(client, "1", [{ remoteFilename: "old.png" }, { remoteFilename: "older.png" }])).toEqual([
      "orphaned attachment old.png: attachments could not be listed: HTTP 503",
      "orphaned attachment older.png: attachments could not be listed: HTTP 503",
    ]);
  });

  it("deletes what it finds, warns about a failed delete, and lists nothing when nothing is superseded", async () => {
    const deleted: string[] = [];
    const client = {
      listAttachments: async () => [{ id: "a1", filename: "old.png" }, { id: "a2", filename: "stuck.png" }, { id: "a3", filename: "kept.png" }] as never,
      deleteAttachment: async (id: string) => {
        if (id === "a2") throw new Error("HTTP 409");
        deleted.push(id);
      },
    };
    expect(await deleteSupersededAttachments(client, "1", [{ remoteFilename: "old.png" }, { remoteFilename: "stuck.png" }, { remoteFilename: "gone.png" }])).toEqual([
      "orphaned attachment stuck.png (a2): HTTP 409",
    ]);
    expect(deleted).toEqual(["a1"]);
    const untouched = { listAttachments: async () => { throw new Error("no call expected"); }, deleteAttachment: async () => {} };
    expect(await deleteSupersededAttachments(untouched, "1", [])).toEqual([]);
  });
});

describe("batch item rollback", () => {
  // Regression: a page the rollback could not delete was dropped from the report
  // ("failed", no pages), so the orphan stayed in the space unnoticed.
  it("names the pages a failed rollback left behind", async () => {
    const deleted: string[] = [];
    const client = {
      deletePage: async (id: string) => {
        if (id === "2") throw new Error("HTTP 403");
        deleted.push(id);
      },
    };
    expect(await rollbackBatchItem(client, ["1", "2", "3"], new Error("readback mismatch"))).toEqual({
      error: "readback mismatch (rollback incomplete: page(s) 2 were not deleted and need manual cleanup)",
      orphanedPageIds: ["2"],
    });
    expect(deleted).toEqual(["3", "1"]);
    expect(await rollbackBatchItem(client, ["1"], new Error("readback mismatch"))).toEqual({ error: "readback mismatch", orphanedPageIds: [] });
  });
});
