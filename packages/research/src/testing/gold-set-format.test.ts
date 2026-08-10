import { describe, expect, test } from "bun:test";
import type { AnySchemaObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixturesDir = resolve(
  import.meta.dir,
  "../../../../specs/host-agnostic-durable-research-agent/fixtures",
);
const schemaPath = resolve(fixturesDir, "research-gold-set-v1.schema.json");
const examplePath = resolve(fixturesDir, "research-gold-set-v1.synthetic.json");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat(
    "date-time",
    (value: string) => value.includes("T") && !Number.isNaN(Date.parse(value)),
  );
  ajv.addFormat("uri", (value: string) => {
    try {
      return new URL(value).href.length > 0;
    } catch {
      return false;
    }
  });
  return ajv.compile(readJson(schemaPath) as AnySchemaObject);
}

describe("private research gold-set format", () => {
  test("keeps the committed synthetic example valid against draft 2020-12", () => {
    const validate = validator();
    const example = readJson(examplePath);

    expect(validate(example), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("rejects non-HTTPS tenants, account identifiers, and escaping snapshot paths", () => {
    const validate = validator();
    const example = readJson(examplePath) as {
      scope: { siteOrigin: string };
      permissionContext: { accountFingerprint: string };
      sources: Array<{ snapshotPath?: string }>;
    };
    example.scope.siteOrigin = "http://example.atlassian.net";
    example.permissionContext.accountFingerprint = "person@example.com";
    example.sources[0]!.snapshotPath = "../outside.json";

    expect(validate(example)).toBe(false);
    expect(validate.errors?.map((error) => error.instancePath)).toEqual(
      expect.arrayContaining([
        "/scope/siteOrigin",
        "/permissionContext/accountFingerprint",
        "/sources/0/snapshotPath",
      ]),
    );
  });

  test("keeps every private artifact suffix ignored", () => {
    const ignore = readFileSync(resolve(import.meta.dir, "../../../../.gitignore"), "utf8");
    expect(ignore).toContain("/.atlcli-research-private/");
    expect(ignore).toContain("*.research-gold.private.json");
    expect(ignore).toContain("*.research-run.private.json");
    expect(ignore).toContain("*.research-report.private.md");
    expect(ignore).toContain("*.rovo-transcript.private.json");
  });
});
