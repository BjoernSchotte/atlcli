import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import {
  ADF_BASELINE_PATH,
  ADF_SCHEMA_PATH,
  ADF_STAGE0_EXTENSIONS_PATH,
  canonicalJson,
  checkObservedCloud,
  checkPinned,
  checkUpstream,
  classifySchemaDrift,
  extractTarFile,
  fetchBounded,
  inventoryAdfSchema,
  propagationFindings,
  schemaHashes,
  verifyPackageIntegrity,
  type AdfUpstreamBaseline,
} from "./adf-drift.js";

function schemaWith(definitions: Record<string, unknown>): Record<string, unknown> {
  return { description: "synthetic schema", definitions };
}

function typedDefinition(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "object",
    properties: { type: { enum: [type] } },
    required: ["type"],
    additionalProperties: false,
    ...extra,
  };
}

function tarWithFile(path: string, body: string): Uint8Array {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(path), 0);
  header.set(new TextEncoder().encode("0000644\0"), 100);
  header.set(new TextEncoder().encode("0000000\0"), 108);
  header.set(new TextEncoder().encode("0000000\0"), 116);
  header.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
  header.set(new TextEncoder().encode("00000000000\0"), 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.set(new TextEncoder().encode("ustar\0"), 257);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  const data = new TextEncoder().encode(body);
  const tar = new Uint8Array(512 + Math.ceil(data.length / 512) * 512 + 1024);
  tar.set(header, 0);
  tar.set(data, 512);
  return new Uint8Array(gzipSync(tar));
}

describe("ADF pinned drift guard", () => {
  test("the committed snapshot, inventory, coverage, and fixtures agree", async () => {
    const report = await checkPinned();
    expect(report.ok).toBe(true);
    expect(report.fixturesChecked).toBe(4);
    expect(report.inventory.nodes).toHaveLength(43);
    expect(report.inventory.marks).toHaveLength(17);
  });

  test("distinguishes raw formatting changes from canonical semantic changes", async () => {
    const raw = await readFile(ADF_SCHEMA_PATH, "utf8");
    const reformatted = `${JSON.stringify(JSON.parse(raw), null, 4)}\n`;
    const before = schemaHashes(raw);
    const after = schemaHashes(reformatted);
    expect(after.rawSha256).not.toBe(before.rawSha256);
    expect(after.canonicalSha256).toBe(before.canonicalSha256);
  });

  test("canonical JSON sorts object keys without reordering arrays", () => {
    expect(canonicalJson({ z: 1, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":1}');
  });

  test("detects changed definitions even when node and mark counts are unchanged", () => {
    const before = schemaWith({
      paragraph_node: typedDefinition("paragraph"),
      strong_mark: typedDefinition("strong"),
    });
    const after = structuredClone(before);
    (after.definitions as Record<string, Record<string, unknown>>).paragraph_node.description = "changed";
    expect(inventoryAdfSchema(before).nodes).toEqual(inventoryAdfSchema(after).nodes);
    expect(classifySchemaDrift(before, after)).toContainEqual({
      classification: "definition-changed",
      detail: "Definition paragraph_node changed.",
    });
  });

  test("classifies tightened and relaxed required constraints", () => {
    const base = schemaWith({
      paragraph_node: typedDefinition("paragraph", { required: ["type"] }),
    });
    const tightened = schemaWith({
      paragraph_node: typedDefinition("paragraph", { required: ["type", "content"] }),
    });
    const relaxed = schemaWith({
      paragraph_node: typedDefinition("paragraph", { required: [] }),
    });
    expect(classifySchemaDrift(base, tightened)[0]?.classification).toBe("constraint-tightened");
    expect(classifySchemaDrift(base, relaxed)[0]?.classification).toBe("constraint-relaxed");
  });

  test("a schema update creates an explicit added-node coverage diff", () => {
    const before = schemaWith({ paragraph_node: typedDefinition("paragraph") });
    const after = schemaWith({
      paragraph_node: typedDefinition("paragraph"),
      future_node: typedDefinition("future"),
    });
    expect(classifySchemaDrift(before, after)).toContainEqual({
      classification: "node-added",
      detail: "future",
    });
  });

  test("reports package/CDN propagation disagreement independently of counts", () => {
    const first = JSON.stringify(schemaWith({ paragraph_node: typedDefinition("paragraph") }));
    const second = JSON.stringify(schemaWith({ paragraph_node: typedDefinition("paragraph", { description: "changed" }) }));
    expect(propagationFindings([
      { name: "package", raw: first },
      { name: "cdn", raw: second },
    ])).toEqual([{
      classification: "propagation-mismatch",
      detail: "Schema sources disagree: package, cdn.",
    }]);
  });

  test("follows only bounded HTTPS redirects on approved hosts", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://go.atlassian.com/adf-json-schema") {
        return new Response(null, {
          status: 307,
          headers: { location: "https://unpkg.com/versioned-schema.json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await fetchBounded("https://go.atlassian.com/adf-json-schema", {
      fetch: fakeFetch,
      maxBytes: 100,
      retries: 0,
    });
    expect(calls).toEqual([
      "https://go.atlassian.com/adf-json-schema",
      "https://unpkg.com/versioned-schema.json",
    ]);
    expect(result.redirects).toEqual(["https://go.atlassian.com/adf-json-schema"]);

    await expect(fetchBounded("https://example.invalid/schema", {
      fetch: fakeFetch,
      maxBytes: 100,
      retries: 0,
    })).rejects.toThrow(/refused URL/);
  });

  test("verifies npm integrity and extracts the schema without writing the tarball", () => {
    const archive = tarWithFile("package/dist/json-schema/v1/full.json", "synthetic-schema");
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    expect(verifyPackageIntegrity(archive, integrity)).toBe(true);
    expect(new TextDecoder().decode(extractTarFile(
      archive,
      "package/dist/json-schema/v1/full.json",
    ))).toBe("synthetic-schema");
  });

  test("the online checker is read-only with respect to the committed pin", async () => {
    const [baselineRaw, schemaRaw] = await Promise.all([
      readFile(ADF_BASELINE_PATH, "utf8"),
      readFile(ADF_SCHEMA_PATH, "utf8"),
    ]);
    const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
    const report = await checkUpstream({
      observe: async () => ({
        packageVersion: baseline.package.version,
        packageMetadata: baseline.package,
        canonicalSchema: schemaRaw,
        versionedSchema: schemaRaw,
        packageSchema: schemaRaw,
        stage0Schema: await readFile(ADF_STAGE0_EXTENSIONS_PATH, "utf8"),
        canonicalRedirects: [baseline.canonicalUrl],
        canonicalFinalUrl: baseline.resolvedVersionedUrl,
        referenceIndex: baseline.referenceIndex,
        restContractOk: true,
      }),
    });
    expect(report.ok).toBe(true);
    expect(await readFile(ADF_BASELINE_PATH, "utf8")).toBe(baselineRaw);
    expect(await readFile(ADF_SCHEMA_PATH, "utf8")).toBe(schemaRaw);
  });

  test("the online checker detects Stage-0 extension definition drift independently", async () => {
    const [baselineRaw, schemaRaw, stage0Raw] = await Promise.all([
      readFile(ADF_BASELINE_PATH, "utf8"),
      readFile(ADF_SCHEMA_PATH, "utf8"),
      readFile(ADF_STAGE0_EXTENSIONS_PATH, "utf8"),
    ]);
    const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
    const stage0 = JSON.parse(stage0Raw) as {
      definitions: Record<string, Record<string, unknown>>;
    };
    stage0.definitions.extensionFrame_node!.changedConstraint = true;
    const observation = async () => ({
      packageVersion: baseline.package.version,
      packageMetadata: baseline.package,
      canonicalSchema: schemaRaw,
      versionedSchema: schemaRaw,
      packageSchema: schemaRaw,
      stage0Schema: JSON.stringify(stage0),
      canonicalRedirects: [baseline.canonicalUrl],
      canonicalFinalUrl: baseline.resolvedVersionedUrl,
      referenceIndex: baseline.referenceIndex,
      restContractOk: true,
    });

    const report = await checkUpstream({ observe: observation });

    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual({
      classification: "definition-changed",
      detail: "Pinned Stage-0 multi-bodied extension definitions changed.",
    });
  });

  test("the optional observed-Cloud check skips cleanly without credentials", async () => {
    const report = await checkObservedCloud({ env: {} });
    expect(report).toMatchObject({ ok: true, skipped: true, classification: "no-drift" });
  });

  test("the singular observed-Cloud page secret remains a fallback when the plural secret is empty", async () => {
    let fetched = false;
    const [baselineRaw, schemaRaw] = await Promise.all([
      readFile(ADF_BASELINE_PATH, "utf8"),
      readFile(ADF_SCHEMA_PATH, "utf8"),
    ]);
    const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
    const report = await checkObservedCloud({
      env: {
        ADF_WATCH_BASE_URL: "https://tenant.example.invalid",
        ADF_WATCH_EMAIL: "fixture@example.invalid",
        ADF_WATCH_API_TOKEN: "fixture-token",
        ADF_WATCH_PAGE_IDS: "",
        ADF_WATCH_PAGE_ID: "legacy-opaque-fixture",
      },
      fetch: async () => {
        fetched = true;
        return new Response(JSON.stringify({
          version: { number: 1 },
          body: {
            atlas_doc_format: {
              representation: "atlas_doc_format",
              value: JSON.stringify({ version: 1, type: "doc", content: [] }),
            },
          },
        }), { status: 200 });
      },
      observeSchema: async () => ({
        packageVersion: baseline.package.version,
        packageMetadata: baseline.package,
        canonicalSchema: schemaRaw,
        versionedSchema: schemaRaw,
        packageSchema: schemaRaw,
        stage0Schema: await readFile(ADF_STAGE0_EXTENSIONS_PATH, "utf8"),
        canonicalRedirects: [baseline.canonicalUrl],
        canonicalFinalUrl: baseline.resolvedVersionedUrl,
        referenceIndex: baseline.referenceIndex,
        restContractOk: true,
      }),
    });
    expect(fetched).toBe(true);
    expect(report).toMatchObject({ ok: true, skipped: false, pageCount: 1 });
    expect(JSON.stringify(report)).not.toContain("legacy-opaque-fixture");
  });

  test("observed-Cloud aggregates retained pages against pinned and current schemas without content or identifiers", async () => {
    const [baselineRaw, schemaRaw] = await Promise.all([
      readFile(ADF_BASELINE_PATH, "utf8"),
      readFile(ADF_SCHEMA_PATH, "utf8"),
    ]);
    const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
    const sentinels = ["RAW-CONTENT-ONE-MUST-NOT-SURVIVE", "RAW-CONTENT-TWO-MUST-NOT-SURVIVE"];
    const opaqueIds = ["opaque-fixture-one", "opaque-fixture-two"];
    const fetchedPaths: string[] = [];
    const report = await checkObservedCloud({
      env: {
        ADF_WATCH_BASE_URL: "https://tenant.example.invalid",
        ADF_WATCH_EMAIL: "fixture@example.invalid",
        ADF_WATCH_API_TOKEN: "fixture-token",
        ADF_WATCH_PAGE_IDS: opaqueIds.join(","),
      },
      fetch: async (input) => {
        const url = new URL(String(input));
        fetchedPaths.push(url.pathname);
        const second = url.pathname.endsWith(opaqueIds[1]!);
        return new Response(JSON.stringify({
          id: second ? opaqueIds[1] : opaqueIds[0],
          version: { number: second ? 3 : 7 },
          body: {
            atlas_doc_format: {
              representation: "atlas_doc_format",
              value: JSON.stringify({
                version: 1,
                type: "doc",
                content: second
                  ? [
                    { type: "rule" },
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: sentinels[1], marks: [{ type: "code" }] }],
                    },
                  ]
                  : [{
                    type: "paragraph",
                    content: [{ type: "text", text: sentinels[0], marks: [{ type: "strong" }] }],
                  }],
              }),
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      observeSchema: async () => ({
        packageVersion: baseline.package.version,
        packageMetadata: baseline.package,
        canonicalSchema: schemaRaw,
        versionedSchema: schemaRaw,
        packageSchema: schemaRaw,
        stage0Schema: await readFile(ADF_STAGE0_EXTENSIONS_PATH, "utf8"),
        canonicalRedirects: [baseline.canonicalUrl],
        canonicalFinalUrl: baseline.resolvedVersionedUrl,
        referenceIndex: baseline.referenceIndex,
        restContractOk: true,
      }),
    });
    expect(report).toMatchObject({
      ok: true,
      skipped: false,
      pageCount: 2,
      pageVersions: [3, 7],
      pinnedSchemaValid: true,
      currentSchemaValid: true,
      nodeTypes: ["doc", "paragraph", "rule", "text"],
      markTypes: ["code", "strong"],
    });
    expect(fetchedPaths).toHaveLength(2);
    const serialized = JSON.stringify(report);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    for (const opaqueId of opaqueIds) expect(serialized).not.toContain(opaqueId);
    expect(serialized).not.toContain("fixture-token");
    expect(serialized).not.toContain("tenant.example.invalid");
  });

  test("observed-Cloud bounds the secret-backed fixture set without echoing references", async () => {
    const pageIds = Array.from({ length: 17 }, (_, index) => `opaque-${index}`);
    const report = await checkObservedCloud({
      env: {
        ADF_WATCH_BASE_URL: "https://tenant.example.invalid",
        ADF_WATCH_EMAIL: "fixture@example.invalid",
        ADF_WATCH_API_TOKEN: "fixture-token",
        ADF_WATCH_PAGE_IDS: pageIds.join(","),
      },
    });
    expect(report).toMatchObject({
      ok: false,
      skipped: false,
      classification: "watch-unavailable",
    });
    const serialized = JSON.stringify(report);
    for (const pageId of pageIds) expect(serialized).not.toContain(pageId);
  });

  test("observed-Cloud reports a current-schema constraint mismatch independently of the pinned schema", async () => {
    const [baselineRaw, schemaRaw] = await Promise.all([
      readFile(ADF_BASELINE_PATH, "utf8"),
      readFile(ADF_SCHEMA_PATH, "utf8"),
    ]);
    const baseline = JSON.parse(baselineRaw) as AdfUpstreamBaseline;
    const currentSchema = JSON.parse(schemaRaw) as {
      definitions: Record<string, {
        required?: string[];
        properties?: { attrs?: { required?: string[] } };
      }>;
    };
    const paragraph = currentSchema.definitions.paragraph_node!;
    paragraph.required = ["type", "attrs"];
    paragraph.properties!.attrs!.required = ["localId"];
    const report = await checkObservedCloud({
      env: {
        ADF_WATCH_BASE_URL: "https://tenant.example.invalid",
        ADF_WATCH_EMAIL: "fixture@example.invalid",
        ADF_WATCH_API_TOKEN: "fixture-token",
        ADF_WATCH_PAGE_IDS: "opaque-fixture",
      },
      fetch: async () => new Response(JSON.stringify({
        version: { number: 1 },
        body: {
          atlas_doc_format: {
            representation: "atlas_doc_format",
            value: JSON.stringify({
              version: 1,
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "private" }] }],
            }),
          },
        },
      }), { status: 200 }),
      observeSchema: async () => ({
        packageVersion: "candidate-test",
        packageMetadata: baseline.package,
        canonicalSchema: JSON.stringify(currentSchema),
        versionedSchema: JSON.stringify(currentSchema),
        packageSchema: JSON.stringify(currentSchema),
        stage0Schema: await readFile(ADF_STAGE0_EXTENSIONS_PATH, "utf8"),
        canonicalRedirects: [baseline.canonicalUrl],
        canonicalFinalUrl: baseline.resolvedVersionedUrl,
        referenceIndex: baseline.referenceIndex,
        restContractOk: true,
      }),
    });
    expect(report).toMatchObject({
      ok: false,
      classification: "definition-changed",
      pinnedSchemaValid: true,
      currentSchemaValid: false,
    });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(JSON.stringify(report)).not.toContain("opaque-fixture");
  });

  test("the weekly workflow is schedule/manual only and remains outside release gates", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/adf-drift-watch.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain('cron: "23 5 * * 1"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s*(push|pull_request):/);
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("ADF_WATCH_PAGE_IDS: ${{ secrets.ADF_WATCH_PAGE_IDS }}");

    const reusableQuality = await readFile(
      new URL("../.github/workflows/reusable-quality.yml", import.meta.url),
      "utf8",
    );
    expect(reusableQuality).toContain("bun run check:adf-pinned");

    for (const release of ["release.yml", "release-cli.yml", "release-core.yml"]) {
      const releaseWorkflow = await readFile(
        new URL(`../.github/workflows/${release}`, import.meta.url),
        "utf8",
      );
      expect(releaseWorkflow).not.toContain("adf-drift-watch");
    }
  });
});
