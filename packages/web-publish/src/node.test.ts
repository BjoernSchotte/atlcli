import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PublicationFileReadErrorV1,
  readBoundedPublicationJsonV1,
} from "./node.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-web-publish-"));
  roots.push(root);
  const file = join(root, "publication.json");
  await writeFile(file, '{"schema":"fixture"}', { mode: 0o600 });
  return { root, file };
}

describe("@atlcli/web-publish/node bounded JSON reader", () => {
  test("reads a regular bounded JSON file", async () => {
    const { file } = await fixture();
    expect(await readBoundedPublicationJsonV1(file, { maxBytes: 1_024 }))
      .toEqual({ schema: "fixture" });
  });

  test("rejects oversized and symlink inputs before parsing", async () => {
    const { root, file } = await fixture();
    await expect(readBoundedPublicationJsonV1(file, { maxBytes: 4 }))
      .rejects.toBeInstanceOf(PublicationFileReadErrorV1);
    const link = join(root, "linked.json");
    await symlink(file, link);
    await expect(readBoundedPublicationJsonV1(link))
      .rejects.toMatchObject({ kind: "symlink" });
  });

  test("rejects invalid byte budgets", async () => {
    const { file } = await fixture();
    await expect(readBoundedPublicationJsonV1(file, { maxBytes: 0 }))
      .rejects.toBeInstanceOf(RangeError);
  });
});
