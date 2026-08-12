import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_EVIDENCE_ROOT, evaluateEvidencePolicy } from "./dev-release-evidence-policy";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = join(tmpdir(), `atlcli-evidence-policy-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(join(root, "evidence", "schemas"), { recursive: true });
  await cp(
    join(DEFAULT_EVIDENCE_ROOT, "evidence", "schemas", "task-proof.schema.json"),
    join(root, "evidence", "schemas", "task-proof.schema.json"),
  );
  await cp(
    join(DEFAULT_EVIDENCE_ROOT, "evidence", "schemas", "live-release-proof.schema.json"),
    join(root, "evidence", "schemas", "live-release-proof.schema.json"),
  );
  return root;
}

async function writeReceipt(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(root, "evidence", "DR-99-fixture.json"),
    JSON.stringify({
      schema: "atlcli.dev-release-task-proof/v1",
      task: "DR-99",
      recordedAt: "2026-08-12T00:00:00Z",
      privacy: { containsSecrets: false, containsTenantData: false },
      proof: { result: "success" },
      ...overrides,
    }),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dev-release evidence policy", () => {
  it("accepts every committed receipt and schema", async () => {
    expect(await evaluateEvidencePolicy()).toEqual([]);
  });

  it("rejects credential values and absolute home paths", async () => {
    const root = await fixture();
    await writeReceipt(root, {
      proof: {
        note: ["Bearer", "abcdefghijklmnopqrstuvwxyz123456"].join(" "),
        path: ["", "Users", "example", "build", "output"].join("/"),
      },
    });
    const reasons = (await evaluateEvidencePolicy(root)).map((issue) => issue.reason);
    expect(reasons).toContain("bearer credential");
    expect(reasons).toContain("macOS home path");
  });

  it("rejects sensitive semantic keys even when their values look harmless", async () => {
    const root = await fixture();
    await writeReceipt(root, { proof: { stdout: "success" } });
    const issues = await evaluateEvidencePolicy(root);
    expect(issues).toContainEqual(
      expect.objectContaining({ reason: "forbidden evidence key 'stdout'", location: "$.proof.stdout" }),
    );
  });

  it("rejects receipts that omit revision-bound proof fields", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "evidence", "DR-99-fixture.json"),
      JSON.stringify({ schema: "atlcli.dev-release-task-proof/v1" }),
    );
    expect((await evaluateEvidencePolicy(root)).some((issue) => issue.reason.startsWith("task receipt schema:"))).toBe(true);
  });
});
