/**
 * The template library UI (spec 010 T5.2, BASELINE-DESIGN B2).
 *
 * Driven against the **real** v2 store over `fake-indexeddb` — the library
 * adapter, `resolveTemplate`'s precedence, and the sha256 verification are all
 * the shipping code, not stand-ins. Only the DOCX *engine* (`scan`) is a fake,
 * because classifying real template bytes is `packages/docx`'s test, not this
 * one's.
 *
 * Three properties are the reason this screen exists at all:
 *
 *  - **A sha256 mismatch is a hard error.** Bytes that no longer hash to what
 *    the catalog entry promised must never be exported under that entry's name.
 *  - **"Assign to current space" creates a new entry** carrying the source
 *    entry's logical id, so deleting the override falls back to the global one.
 *    Mutating the global row in place would make that fallback impossible.
 *  - **The list is filtered by engine and site**, so a Typst entry never shows
 *    up in a Word template picker.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { IDBFactory } from "fake-indexeddb";
import type { ScanResult } from "@atlcli/docx/scan";
import { TemplateLibraryPanel } from "../components/export/TemplateLibraryPanel.js";
import { I18nProvider } from "../utils/i18n/context.js";
import { idbTemplateLibrary, type IdbTemplateLibrary } from "../utils/templates/library.js";
import { openTemplateDb } from "../utils/docx/template-store.js";
import type { DocxExportPort, TemplateLibraryPort } from "../utils/ports/index.js";
import { createReactHarness } from "./react-harness.js";

const dom = createReactHarness();

beforeEach(() => dom.setup());
afterEach(() => dom.teardown());
afterAll(() => {
  expect(dom.leakedGlobals()).toEqual([]);
});

const SITE = "https://example.atlassian.net";

const SCAN: ScanResult = {
  supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
  stylerefStyleNames: [],
};

function scanner(scan: ScanResult = SCAN): Pick<DocxExportPort, "scan"> {
  return { async scan() { return scan; } };
}

function bytes(fill: number, length = 32): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer as ArrayBuffer;
}

function freshLibrary(): { library: IdbTemplateLibrary; factory: IDBFactory } {
  const factory = new IDBFactory();
  return { library: idbTemplateLibrary({ factory, siteOrigin: SITE }), factory };
}

async function renderPanel(
  library: TemplateLibraryPort,
  options: { spaceKey?: string | null; scan?: ScanResult | null } = {}
): Promise<void> {
  await dom.render(
    <I18nProvider locale="en">
      <TemplateLibraryPanel
        library={library}
        scanner={options.scan === null ? null : scanner(options.scan ?? SCAN)}
        spaceKey={options.spaceKey === undefined ? "DOCSY" : options.spaceKey}
      />
    </I18nProvider>
  );
  await dom.flush();
}

describe("the library list", () => {
  it("says so when there is nothing stored yet", async () => {
    const { library } = freshLibrary();
    await renderPanel(library);
    expect(dom.maybeFind("template-library-empty")).not.toBeNull();
    expect(dom.maybeFind("template-library-list")).toBeNull();
  });

  it("lists name, scope badge and upload date, and marks the active entry", async () => {
    const { library } = freshLibrary();
    const entry = await library.add({
      name: "mayflower.docx",
      bytes: bytes(1),
      uploadedAt: Date.UTC(2026, 6, 21),
    });
    await library.setActiveTemplateId("docx", "DOCSY", entry.id);

    await renderPanel(library);

    const row = dom.find(`template-row-${entry.recordKey}`);
    expect(row.textContent).toContain("mayflower.docx");
    expect(row.textContent).toContain("2026-07-21");
    expect(dom.find("template-row-scope").textContent).toBe("Global");
    expect(dom.maybeFind("template-row-active")).not.toBeNull();
  });

  it("filters by engine — a Typst entry never appears in the Word list", async () => {
    const { library } = freshLibrary();
    await library.add({ name: "word.docx", bytes: bytes(1), engine: "docx" });
    await library.add({ name: "book.typ", bytes: bytes(2), engine: "typst" });

    await renderPanel(library);

    const list = dom.find("template-library-list");
    expect(list.textContent).toContain("word.docx");
    expect(list.textContent).not.toContain("book.typ");
  });

  it("filters by site — another Atlassian site's DOCSY template stays hidden", async () => {
    const factory = new IDBFactory();
    await idbTemplateLibrary({ factory, siteOrigin: "https://other.atlassian.net" }).add({
      name: "theirs.docx",
      bytes: bytes(3),
    });
    const mine = idbTemplateLibrary({ factory, siteOrigin: SITE });
    await mine.add({ name: "mine.docx", bytes: bytes(4) });

    await renderPanel(mine);

    const list = dom.find("template-library-list");
    expect(list.textContent).toContain("mine.docx");
    expect(list.textContent).not.toContain("theirs.docx");
  });
});

describe("upload, activate, delete", () => {
  it("activates a different entry and moves the badge", async () => {
    const { library } = freshLibrary();
    const first = await library.add({ name: "one.docx", bytes: bytes(1) });
    const second = await library.add({ name: "two.docx", bytes: bytes(2) });
    await library.setActiveTemplateId("docx", "DOCSY", first.id);

    await renderPanel(library);
    await dom.click(`template-activate-${second.recordKey}`);

    expect(await library.getActiveTemplateId("docx", "DOCSY")).toBe(second.id);
    expect(dom.find(`template-row-${second.recordKey}`).textContent).toContain("Active");
  });

  it("deletes one physical row and leaves the rest", async () => {
    const { library } = freshLibrary();
    const first = await library.add({ name: "one.docx", bytes: bytes(1) });
    const second = await library.add({ name: "two.docx", bytes: bytes(2) });

    await renderPanel(library);
    await dom.click(`template-delete-${first.recordKey}`);

    expect(dom.maybeFind(`template-row-${first.recordKey}`)).toBeNull();
    expect(dom.maybeFind(`template-row-${second.recordKey}`)).not.toBeNull();
  });
});

describe("the scan verdict is re-derived on read, never persisted", () => {
  it("classifies the stored bytes on demand", async () => {
    const { library } = freshLibrary();
    const entry = await library.add({ name: "one.docx", bytes: bytes(1) });

    await renderPanel(library);
    // Nothing is classified until the bytes are actually read back.
    expect(dom.html()).not.toContain("$scroll.title");

    await dom.click(`template-verify-${entry.recordKey}`);
    expect(dom.html()).toContain("$scroll.title");
  });

  it("surfaces an engine rejection as the row's own error", async () => {
    const { library } = freshLibrary();
    const entry = await library.add({ name: "one.docx", bytes: bytes(1) });

    const rejecting: Pick<DocxExportPort, "scan"> = {
      async scan() {
        const error = new Error("That zip isn't a Word document.") as Error & { kind: string };
        error.kind = "not-word";
        throw error;
      },
    };
    await dom.render(
      <I18nProvider locale="en">
        <TemplateLibraryPanel library={library} scanner={rejecting} spaceKey="DOCSY" />
      </I18nProvider>
    );
    await dom.flush();
    await dom.click(`template-verify-${entry.recordKey}`);

    expect(dom.find(`template-row-error-${entry.recordKey}`).textContent).toContain(
      "isn't a Word document"
    );
  });
});

describe("a sha256 mismatch is a hard error, never a silent fallback", () => {
  it("refuses the bytes and tells the user to re-upload", async () => {
    const { library, factory } = freshLibrary();
    const entry = await library.add({ name: "one.docx", bytes: bytes(1) });

    // Tamper with the stored bytes behind the library's back — the exact
    // situation the integrity check exists for (a corrupted profile, a
    // half-written record, or an extension writing into the same database).
    const db = await openTemplateDb(factory, { siteOrigin: SITE });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("templates", "readwrite");
      const request = tx.objectStore("templates").get(entry.recordKey);
      request.onsuccess = () => {
        const record = request.result as { bytes: ArrayBuffer };
        record.bytes = bytes(9);
        tx.objectStore("templates").put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await renderPanel(library);
    await dom.click(`template-verify-${entry.recordKey}`);

    const error = dom.find(`template-row-error-${entry.recordKey}`).textContent ?? "";
    expect(error).toContain("template was modified, re-upload");
    // No other entry's bytes were served in its place.
    expect(dom.html()).not.toContain("$scroll.title");
  });
});

describe("assign to space creates a new entry, and deleting it falls back", () => {
  it("keeps the global row untouched and lets the override win, then fall back", async () => {
    const { library } = freshLibrary();
    const global = await library.add({ name: "corporate.docx", bytes: bytes(1) });

    await renderPanel(library);
    await dom.click(`template-assign-${global.recordKey}`);

    // Two physical rows now share one logical id.
    const rows = await library.listAll("docx");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(rows.find((r) => r.scope === "global")?.recordKey).toBe(global.recordKey);

    const override = rows.find((r) => r.scope === "space")!;
    expect(override.spaceKey).toBe("DOCSY");
    // The shared, pure resolver picks the space entry — the panel adds no rules.
    expect((await library.resolve(global.id, "docx", "DOCSY"))?.recordKey).toBe(
      override.recordKey
    );

    // Deleting the override falls straight back to the global entry.
    await dom.click(`template-delete-${override.recordKey}`);
    expect((await library.resolve(global.id, "docx", "DOCSY"))?.recordKey).toBe(
      global.recordKey
    );
    expect(dom.maybeFind(`template-row-${global.recordKey}`)).not.toBeNull();
  });

  it("disables assign when no page (and therefore no space) is open", async () => {
    const { library } = freshLibrary();
    const entry = await library.add({ name: "corporate.docx", bytes: bytes(1) });

    await renderPanel(library, { spaceKey: null });

    const button = dom.find(`template-assign-${entry.recordKey}`) as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "Open a page in a space to assign a template to it."
    );
  });

  it("disables assign for a row already scoped to this space", async () => {
    const { library } = freshLibrary();
    const global = await library.add({ name: "corporate.docx", bytes: bytes(1) });
    const override = await library.assignToSpace(global, "DOCSY");

    await renderPanel(library);

    const already = dom.find(
      `template-assign-${override.recordKey}`
    ) as unknown as HTMLButtonElement;
    expect(already.disabled).toBe(true);
    const globalButton = dom.find(
      `template-assign-${global.recordKey}`
    ) as unknown as HTMLButtonElement;
    expect(globalButton.disabled).toBe(false);
  });
});

describe("scope of the library", () => {
  it("offers no PDF template upload — only .docx", async () => {
    const { library } = freshLibrary();
    await renderPanel(library);

    const input = dom.find("template-library-file") as unknown as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe(".docx");
    expect(dom.find("template-library").textContent).toContain(
      "PDF uses the built-in atlcli document design"
    );
  });
});
