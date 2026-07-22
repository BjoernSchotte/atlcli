import { beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { DocxExportJobRequestV1 } from "@atlcli/export-jobs";
import type { StoredPdfJobMeta } from "../../utils/pdf/job-store.js";
import { listExtensionExportActivity } from "../../utils/export-jobs/activity.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";

globalThis.IDBKeyRange = IDBKeyRange;

const OUTER = "123e4567-e89b-42d3-a456-426614174000";
const LEGACY = "223e4567-e89b-42d3-a456-426614174000";
let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function request(id = OUTER): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin: "https://site.atlassian.net",
      locator: { kind: "space-key", spaceKey: "DOCS" },
      scope: { kind: "space" },
    },
    authRef: "profile:default",
    displayName: "Common DOCX",
    createdAt: 20,
    priority: "interactive",
    output: { policy: "collect" },
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" },
    options: { embedImages: true, resolveMacros: true },
  };
}

function legacy(overrides: Partial<StoredPdfJobMeta> = {}): StoredPdfJobMeta {
  return {
    id: LEGACY,
    sourceIdentity: "https://site.atlassian.net/wiki/spaces/DOCS|1|1",
    createdAt: 10,
    status: "complete",
    inputBytes: 0,
    outputBytes: 3,
    kind: "export",
    siteOrigin: "https://site.atlassian.net",
    title: "Legacy PDF",
    ...overrides,
  };
}

describe("transitional extension Activity", () => {
  it("dual-reads common and visible legacy rows with collision-proof keys", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory });
    await catalog.create({ request: request() });
    const rows = await listExtensionExportActivity({
      listCommon: catalog.list.bind(catalog),
      listLegacyBridges: catalog.listLegacyBridges.bind(catalog),
      listLegacyPdf: async () => [legacy({ id: OUTER })],
    });
    expect(rows.map((row) => row.key)).toEqual([`common:${OUTER}`, `legacy-pdf:${OUTER}`]);
  });

  it("hides a private legacy compiler record behind its common outer job", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 20 });
    await catalog.create({ request: request() });
    await catalog.claimNext({ ownerId: "offscreen", now: 20, leaseDurationMs: 100 });
    await catalog.putLegacyBridge({ legacyJobId: LEGACY, outerJobId: OUTER, outerLeaseEpoch: 1, hidden: true, createdAt: 20 });
    const rows = await listExtensionExportActivity({
      listCommon: catalog.list.bind(catalog),
      listLegacyBridges: catalog.listLegacyBridges.bind(catalog),
      listLegacyPdf: async () => [legacy({
        activityVisibility: "private",
        parentJobId: OUTER,
        parentLeaseEpoch: 1,
      })],
    });
    expect(rows.map((row) => row.key)).toEqual([`common:${OUTER}`]);
  });

  it("derives a legacy row site origin from its source identity", async () => {
    const rows = await listExtensionExportActivity({
      listCommon: async () => [],
      listLegacyBridges: async () => [],
      listLegacyPdf: async () => [legacy({
        siteOrigin: undefined,
        sourceIdentity: "https://old.atlassian.net/wiki/spaces/DOCS|1|1",
      })],
    });

    expect(rows[0]?.siteOrigin).toBe("https://old.atlassian.net");
  });

  it("keeps common history visible when the legacy database cannot be read", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory });
    await catalog.create({ request: request() });
    const rows = await listExtensionExportActivity({
      listCommon: catalog.list.bind(catalog),
      listLegacyBridges: catalog.listLegacyBridges.bind(catalog),
      listLegacyPdf: async () => { throw new Error("legacy database blocked"); },
    });
    expect(rows.map((row) => row.key)).toEqual([`common:${OUTER}`]);
  });
});
