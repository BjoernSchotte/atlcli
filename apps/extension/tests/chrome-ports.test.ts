/**
 * The Chrome host adapters' own contract (spec 010 T5.2/T5.3/T5.6).
 *
 * `createChromePorts()` itself needs `chrome.runtime.getManifest()` and is
 * covered by the panel's own E2E; what is testable — and what has actually
 * broken — is everything around it:
 *
 *  1. the CAPABILITY list, which is the only switch turning a registered screen
 *     from "not available here, because…" into a working feature. Three
 *     complete features (preview, the template library, durable jobs) shipped
 *     invisible because their capability was not in this array;
 *  2. the template-library adapter's *lazy* site read, which is the difference
 *     between a per-tenant library and rows written under the `unknown-site`
 *     sentinel that match every tenant at once.
 *
 * `fake-indexeddb` throughout — a spec-complete in-memory IndexedDB, so the
 * `siteOrigin` scoping under test is the real key-path behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { buildDocx, para } from "@atlcli/docx/fixtures";
import { CHROME_CAPABILITIES } from "../entrypoints/sidepanel/ports/index.js";
import { chromeTemplateLibrary } from "../entrypoints/sidepanel/ports/templates.js";
import { createSiteContext } from "../entrypoints/sidepanel/ports/site-context.js";
import { idbTemplateLibrary } from "../utils/templates/library.js";
import { UNKNOWN_SITE_ORIGIN } from "../utils/docx/template-store.js";

const SITE_A = "https://tenant-a.atlassian.net";
const SITE_B = "https://other-tenant.atlassian.net";
const PAGE_A = `${SITE_A}/wiki/spaces/DOCSY/pages/1/Root`;

const realIndexedDb = globalThis.indexedDB;

beforeEach(() => {
  // `chromeTemplateLibrary` deliberately passes no `factory`, because the real
  // panel has none to pass; the ambient one is what it uses.
  globalThis.indexedDB = new IDBFactory() as unknown as IDBFactory;
});

afterEach(() => {
  globalThis.indexedDB = realIndexedDb;
});

function templateBytes(text: string): ArrayBuffer {
  const bytes = buildDocx({ body: para(text) + para("$scroll.content") });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("CHROME_CAPABILITIES", () => {
  it("advertises every capability whose implementation has landed", () => {
    // Ordered check, so a reviewer reading the diff sees exactly what turned on.
    expect([...CHROME_CAPABILITIES]).toEqual([
      "pdf-export",
      "docx-export",
      "docx-template-store",
      "pdf-preview",
      "template-library",
      "durable-jobs",
      "research",
      "settings-persistence",
    ]);
  });

  it("declares template-library, because the port is supplied", () => {
    // The pair that must move together: a screen gated on `template-library`
    // renders disabled without the capability, and throws without the port.
    expect(CHROME_CAPABILITIES).toContain("template-library");
    expect(typeof chromeTemplateLibrary(createSiteContext(PAGE_A)).listAll).toBe("function");
  });
});

describe("chromeTemplateLibrary reads the site at CALL time", () => {
  it("scopes a row to the site that was active when it was added, not at construction", async () => {
    // The panel opens before the page-context adapter has resolved a tab: this
    // is the state that used to bake in `undefined`.
    const site = createSiteContext(null);
    const port = chromeTemplateLibrary(site);

    site.set(PAGE_A);
    const added = await port.add({ name: "handbook.docx", bytes: templateBytes("A") });
    expect(added.id).toBeTruthy();

    // Scoped to SITE_A…
    expect(await port.listAll("docx")).toHaveLength(1);

    // …and invisible to another tenant. A row captured at construction time
    // would carry the `unknown-site` sentinel, which `belongsToSite` matches for
    // EVERY site — so this assertion is what separates a per-tenant library from
    // a cross-tenant leak (and from the resolution conflicts wave 1 had to fix).
    const otherTenant = idbTemplateLibrary({ siteOrigin: SITE_B });
    expect(await otherTenant.listAll("docx")).toHaveLength(0);

    const stored = await idbTemplateLibrary({ siteOrigin: SITE_A }).listAll("docx");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.siteOrigin).toBe(SITE_A);
    expect(stored[0]!.siteOrigin).not.toBe(UNKNOWN_SITE_ORIGIN);
  });

  it("follows the site when the user switches tab", async () => {
    const site = createSiteContext(PAGE_A);
    const port = chromeTemplateLibrary(site);
    await port.add({ name: "a.docx", bytes: templateBytes("A") });

    site.set(`${SITE_B}/wiki/spaces/X/pages/9/Other`);
    expect(await port.listAll("docx")).toHaveLength(0);
    await port.add({ name: "b.docx", bytes: templateBytes("B") });
    expect((await port.listAll("docx")).map((entry) => entry.fileName)).toEqual(["b.docx"]);

    site.set(PAGE_A);
    expect((await port.listAll("docx")).map((entry) => entry.fileName)).toEqual(["a.docx"]);
  });

  it("round-trips the active selection and the settings values", async () => {
    const port = chromeTemplateLibrary(createSiteContext(PAGE_A));
    const entry = await port.add({ name: "handbook.docx", bytes: templateBytes("A") });

    await port.setActiveTemplateId("docx", undefined, entry.id);
    expect(await port.getActiveTemplateId("docx")).toBe(entry.id);

    expect(await port.readSettings("docx", undefined, entry.id)).toEqual({});
    await port.writeSettings("docx", undefined, entry.id, { headerText: "Handbook", toc: true });
    expect(await port.readSettings("docx", undefined, entry.id)).toEqual({
      headerText: "Handbook",
      toc: true,
    });

    // Bytes come back integrity-checked by the library, not re-derived here.
    expect((await port.getBytes(entry)).byteLength).toBeGreaterThan(0);

    await port.remove(entry.recordKey);
    expect(await port.listAll("docx")).toHaveLength(0);
  });

  it("assigns a space override without mutating the global row", async () => {
    const port = chromeTemplateLibrary(createSiteContext(PAGE_A));
    const global = await port.add({ name: "handbook.docx", bytes: templateBytes("A") });
    const override = await port.assignToSpace(global, "DOCSY");

    // Same logical id, different physical row — that is what makes
    // "space beats global" resolvable and reversible.
    expect(override.id).toBe(global.id);
    expect(override.recordKey).not.toBe(global.recordKey);
    expect((await port.listAll("docx")).map((entry) => entry.scope).sort()).toEqual([
      "global",
      "space",
    ]);
  });
});
