/**
 * Regression: the panel's scan must never be stale (spec 004 E2E finding).
 *
 * The store used to persist the placeholder scan "captured at upload time", and
 * the mount effect read it straight back. That made a DERIVED value drift from
 * the logic that produced it: once gap G1 closed and
 * `$scroll.pageowner.fullName` became supported, every already-uploaded template
 * kept serving the old "will be empty" verdict from IndexedDB — while the
 * export, which always re-scans the bytes, resolved the placeholder. The panel
 * is the promise and the export is the delivery; they disagreed.
 *
 * `loadCurrentTemplate` is the pure core of that mount effect (both
 * collaborators injected), so the rule is testable against a REAL in-memory
 * IndexedDB with no DOM.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { loadCurrentTemplate } from "../../entrypoints/sidepanel/TemplateSection.js";
import { getTemplate, putTemplate, type StoredTemplate } from "../../utils/docx/template-store.js";
import { scanTemplate } from "../../utils/docx/scan.js";
import { buildDocx, para } from "./fixtures.js";

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
});

function storeBytes(): { record: StoredTemplate; bytes: Uint8Array } {
  const bytes = buildDocx({
    body: para("$scroll.title") + para("$scroll.pageowner.fullName") + para("$scroll.content"),
  });
  return {
    bytes,
    record: {
      id: "current",
      name: "mayflower.docx",
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      uploadedAt: Date.now(),
    },
  };
}

describe("loadCurrentTemplate — the scan is derived, never restored", () => {
  it("re-derives the scan even when the record carries a stale one", async () => {
    const { record } = storeBytes();
    // Simulate a template uploaded BEFORE G1 closed: the record still carries the
    // scan that the old code froze in, claiming pageowner would be empty.
    const legacy = {
      ...record,
      scan: {
        supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
        unsupported: [
          {
            base: "$scroll.pageowner.fullName",
            status: "unsupported",
            count: 1,
            raw: ["$scroll.pageowner.fullName"],
            reason: "page owner is not modeled (Gap G1)",
          },
        ],
        never: [],
        parts: ["word/document.xml"],
        hasContentPlaceholder: true,
      },
    } as unknown as StoredTemplate;
    await putTemplate(legacy, factory);

    const current = await loadCurrentTemplate(
      () => getTemplate("current", factory),
      async () => scanTemplate
    );

    expect(current).not.toBeNull();
    // The CURRENT classification wins: pageowner is supported since G1 closed.
    expect(current!.scan.supported.map((h) => h.base)).toContain("$scroll.pageowner.fullName");
    expect(current!.scan.unsupported.map((h) => h.base)).not.toContain("$scroll.pageowner.fullName");
    // And the stale reason string is gone for good.
    const reasons = current!.scan.unsupported.map((h) => h.reason ?? "");
    expect(reasons.join(" ")).not.toContain("page owner is not modeled");
  });

  it("returns null and never loads the scanner when nothing is stored", async () => {
    let loaded = 0;
    const current = await loadCurrentTemplate(
      () => getTemplate("current", factory),
      async () => {
        loaded += 1;
        return scanTemplate;
      }
    );
    expect(current).toBeNull();
    // The lazy-load contract: no template → the heavy scan chunk is never fetched.
    expect(loaded).toBe(0);
  });

  it("carries the stored name, timestamp and bytes through unchanged", async () => {
    const { record, bytes } = storeBytes();
    await putTemplate(record, factory);

    const current = await loadCurrentTemplate(
      () => getTemplate("current", factory),
      async () => scanTemplate
    );

    expect(current!.name).toBe("mayflower.docx");
    expect(current!.uploadedAt).toBe(record.uploadedAt);
    expect(new Uint8Array(current!.bytes).byteLength).toBe(bytes.byteLength);
  });
});
