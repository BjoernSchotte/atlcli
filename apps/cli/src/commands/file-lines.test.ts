import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinesFormat } from "@atlcli/script-runtime";
import { parseCsvRecord, readLinesPage } from "./file-lines.js";
import { createCliScriptPort } from "./script-port.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const page = (text: string, format: LinesFormat, o: Partial<{ eof: boolean; max: number }> = {}) =>
  readLinesPage(bytes(text), { format, eof: o.eof ?? true, max: o.max ?? 1000, line: 0, start: true });

describe("readLinesPage", () => {
  it("splits text lines (CRLF too) and keeps empty lines in between", () => {
    expect(page("a\r\n\nb\n", "text")).toEqual({ items: ["a", "", "b"], consumed: 6, lines: 3 });
    expect(page("a\nb", "text").items).toEqual(["a", "b"]);
  });

  it("stops before an incomplete record when the file goes on", () => {
    expect(page("a\nbc", "text", { eof: false })).toEqual({ items: ["a"], consumed: 2, lines: 1 });
    expect(page("a\nb\nc\n", "text", { max: 2 })).toEqual({ items: ["a", "b"], consumed: 4, lines: 2 });
  });

  it("reads CSV records whose quoted fields hold commas, quotes and line breaks; drops a BOM", () => {
    const csv = '﻿key,text\r\nA-1,"say ""hi"", then\nleave"\r\n\r\nA-2,\r\n';
    const r = page(csv, "csv");
    expect(r.items).toEqual([["key", "text"], ["A-1", 'say "hi", then\nleave'], ["A-2", ""]]);
    expect(r.lines).toBe(5);
    expect(page('a,"open\nstill', "csv", { eof: false }).items).toEqual([]);
  });

  it("parses JSON Lines and names the line of a broken one", () => {
    expect(page('{"a":1}\n\n[2]\n', "jsonl").items).toEqual([{ a: 1 }, [2]]);
    expect(() => page('{"a":1}\n{nope}\n', "jsonl")).toThrow(/line 2 is not valid JSON/);
  });

  it("parseCsvRecord keeps empty fields", () => {
    expect(parseCsvRecord(",a,,")).toEqual(["", "a", "", ""]);
  });
});

describe("fileLines through the CLI port", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlcli-lines-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const none = (): never => {
    throw new Error("unused");
  };

  it("pages through a file larger than one window with cursors", async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `K-${i},"note ${i}\nsecond line",${"x".repeat(50)}`);
    await writeFile(join(dir, "big.csv"), `key,note,pad\n${rows.join("\n")}\n`);
    const port = createCliScriptPort(none, none, "https://x.atlassian.net", { profileName: "t", outDir: dir });
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await port.fileLines!("big.csv", { format: "csv", limit: 1000, ...(cursor ? { cursor } : {}) });
      seen.push(...r.items);
      cursor = r.cursor;
      pages++;
    } while (cursor);
    expect(seen).toHaveLength(30_001);
    expect(seen[1]).toEqual(["K-0", "note 0\nsecond line", "x".repeat(50)]);
    expect(seen.at(-1)).toEqual(["K-29999", "note 29999\nsecond line", "x".repeat(50)]);
    expect(pages).toBe(31);
  });

  it("refuses paths outside the directory and names the file of a broken line", async () => {
    await writeFile(join(dir, "bad.jsonl"), '{"a":1}\nnope\n');
    const port = createCliScriptPort(none, none, "https://x.atlassian.net", { profileName: "t", outDir: dir });
    await expect(port.fileLines!("bad.jsonl", { format: "jsonl", limit: 10 })).rejects.toThrow("bad.jsonl: line 2 is not valid JSON");
    await expect(port.fileLines!("../x", { format: "text", limit: 10 })).rejects.toThrow();
  });
});
