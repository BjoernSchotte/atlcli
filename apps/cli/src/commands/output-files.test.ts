import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputFiles, parseSize } from "./output-files.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atlcli-out-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("OutputFiles", () => {
  it("writes through a temporary file and keeps the file on close", async () => {
    const out = new OutputFiles(join(root, "reports"));
    const h = await out.openFile("a/b.txt");
    out.write(h, "héllo ");
    out.write(h, "world\n");
    expect(await readdir(join(root, "reports", "a"))).toEqual([expect.stringMatching(/^\.b\.txt\.atlcli-tmp-/)]);
    const view = out.close(h);
    expect(view).toEqual({ path: "a/b.txt", bytes: 13, sha256: sha("héllo world\n") });
    expect(await readFile(join(root, "reports", "a", "b.txt"), "utf8")).toBe("héllo world\n");
    expect(await readdir(join(root, "reports", "a"))).toEqual(["b.txt"]);
    expect(out.written).toEqual([view]);
  });

  it("leaves an existing file unchanged when a run is aborted", async () => {
    await writeFile(join(root, "keep.txt"), "old");
    const out = new OutputFiles(root);
    const h = await out.openFile("keep.txt");
    out.write(h, "new");
    out.abort();
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("old");
    expect(await readdir(root)).toEqual(["keep.txt"]);
  });

  it("drops only the files of the scope that failed", async () => {
    const out = new OutputFiles(root);
    const a = out.scope();
    const b = out.scope();
    const ha = await a.port.outputOpen!("a.txt");
    const hb = await b.port.outputOpen!("b.txt");
    await a.port.outputWrite!(ha, "A");
    await b.port.outputWrite!(hb, "B");
    expect(a.unclosed()).toEqual(["a.txt"]);
    a.abort();
    await b.port.outputClose!(hb);
    expect(await readdir(root)).toEqual(["b.txt"]);
    await expect(b.port.outputWrite!(ha, "x")).rejects.toThrow(/another run/);
  });

  it("stops at the size limit and drops what was open", async () => {
    const out = new OutputFiles(root, 10);
    const h = await out.openFile("big.txt");
    out.write(h, "12345");
    expect(() => out.write(h, "678901")).toThrow(/exceed 10 bytes.*--max-output/);
    expect(await readdir(root)).toEqual([]);
  });

  it("writes each path once and at most 50 files", async () => {
    const out = new OutputFiles(root);
    out.close(await out.openFile("x.txt"));
    await expect(out.openFile("x.txt")).rejects.toThrow(/already written/);
    for (let i = 1; i < 50; i++) out.close(await out.openFile(`f${i}.txt`));
    await expect(out.openFile("one-too-many.txt")).rejects.toThrow(/at most 50/);
  });

  it("refuses links: a linked directory leading outside and a link as the file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "atlcli-outside-"));
    try {
      await symlink(outside, join(root, "escape"));
      await writeFile(join(outside, "target.txt"), "secret");
      await symlink(join(outside, "target.txt"), join(root, "link.txt"));
      const out = new OutputFiles(root);
      await expect(out.openFile("escape/x.txt")).rejects.toThrow(/outside the output directory/);
      await expect(out.openFile("escape/new/deeper/x.txt")).rejects.toThrow(/outside the output directory/);
      await expect(out.openFile("link.txt")).rejects.toThrow(/symbolic link/);
      expect(await readdir(outside)).toEqual(["target.txt"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("renders a template in chunks into the file with the built-in variables", async () => {
    const out = new OutputFiles(root, undefined, "work");
    const h = await out.openFile("r.md");
    out.write(h, "# Report\n");
    const warnings = await out.render(h, "{% for i in items %}\n- {{ i }} ({{ profile }})\n{% endfor %}\n{{ missing }}", {
      vars: { items: [1, 2] },
      now: "2026-10-26T09:00:00.000Z",
      strict: false,
      lines: true,
      templates: {},
    });
    out.close(h);
    expect(await readFile(join(root, "r.md"), "utf8")).toBe("# Report\n- 1 (work)\n- 2 (work)\n{{ missing }}");
    expect(warnings).toEqual([{ code: "unresolved", message: "Unresolved {{ missing }}", unit: "r.md", line: 4, column: 0 }]);
    const strict = await out.openFile("s.md");
    await expect(out.render(strict, "{{ missing }}", { vars: {}, now: "2026-10-26T09:00:00.000Z", strict: true, lines: true, templates: {} })).rejects.toThrow(
      /Unresolved/,
    );
  });

  it("keeps a directory it may not write into out of reach", async () => {
    await mkdir(join(root, "dir.txt"));
    const out = new OutputFiles(root);
    await expect(out.openFile("dir.txt")).rejects.toThrow(/is a directory/);
  });
});

it("parseSize reads 512k, 300m, 2g and bytes", () => {
  expect(parseSize("512k")).toBe(512 * 1024);
  expect(parseSize("300M")).toBe(300 * 1024 ** 2);
  expect(parseSize("2g")).toBe(2 * 1024 ** 3);
  expect(parseSize("1000")).toBe(1000);
  expect(parseSize("lots")).toBeUndefined();
});
