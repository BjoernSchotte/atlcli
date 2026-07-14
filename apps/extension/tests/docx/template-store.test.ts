/**
 * Template store round-trip against a REAL in-memory IndexedDB
 * (`fake-indexeddb`) — spec-complete transactions/cursors, not a stub. Each test
 * gets a fresh factory for isolation.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  putTemplate,
  type StoredTemplate,
} from "../../utils/docx/template-store.js";
import { buildDocx, para } from "./fixtures.js";
import { scanTemplate } from "../../utils/docx/scan.js";

let factory: IDBFactory;

beforeEach(() => {
  // Fresh database per test.
  factory = new IDBFactory();
});

function makeStored(id: string, name: string): StoredTemplate {
  const bytes = buildDocx({ body: para("$scroll.title") + para("$scroll.content") });
  const scan = scanTemplate(bytes);
  return {
    id,
    name,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    uploadedAt: Date.now(),
    scan,
  };
}

describe("template store (fake-indexeddb)", () => {
  it("persists a template and reads it back across reopen", async () => {
    const stored = makeStored("current", "mayflower.docx");
    await putTemplate(stored, factory);

    const back = await getTemplate("current", factory);
    expect(back).toBeDefined();
    expect(back!.name).toBe("mayflower.docx");
    expect(back!.scan.supported.map((h) => h.base)).toContain("$scroll.title");
    // Bytes survive the round-trip and re-unzip.
    const reBytes = new Uint8Array(back!.bytes);
    expect(reBytes.byteLength).toBe(new Uint8Array(stored.bytes).byteLength);
    expect(scanTemplate(reBytes).hasContentPlaceholder).toBe(true);
  });

  it("replaces an existing template in the same slot", async () => {
    await putTemplate(makeStored("current", "old.docx"), factory);
    await putTemplate(makeStored("current", "new.docx"), factory);
    const back = await getTemplate("current", factory);
    expect(back!.name).toBe("new.docx");
    const all = await listTemplates(factory);
    expect(all.length).toBe(1);
  });

  it("deletes a template", async () => {
    await putTemplate(makeStored("current", "gone.docx"), factory);
    await deleteTemplate("current", factory);
    expect(await getTemplate("current", factory)).toBeUndefined();
    expect(await listTemplates(factory)).toHaveLength(0);
  });

  it("returns undefined for a missing template", async () => {
    expect(await getTemplate("nope", factory)).toBeUndefined();
  });
});
