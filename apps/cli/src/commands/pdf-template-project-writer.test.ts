import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@atlcli/core";
import {
  PdfTemplateRuntimeMaterializer,
} from "@atlcli/pdf";
import {
  BUILTIN_PDF_DESIGN,
  PDF_TEMPLATE_CAPABILITIES_V1,
} from "@atlcli/pdf/internal";
import {
  TEMPLATE_DECISION_STATE_SCHEMA_V1,
  TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
  InMemoryTemplateAssetStore,
  TemplateProjectGenerationConflictError,
  buildGeneratedPdfTemplatePack,
  resolveTemplateLayers,
  type TemplateDecisionStateV1,
  type TemplateProjectBuildV1,
} from "@atlcli/pdf-template-authoring";
import {
  canonicalCapabilityJson,
  computeCapabilityCatalogDigest,
} from "@atlcli/template-pack";
import { templateProjectRepositoryContract } from "../../../../packages/pdf-template-authoring/test/repository-contract.js";
import {
  DirectoryTemplateAssetStore,
  DirectoryTemplateProjectRepository,
  PdfTemplateProjectFsError,
  copyAcceptedTemplateProjectAssets,
} from "./pdf-template-project-writer.js";
import {
  CliGeneratedPdfTemplateCompiler,
} from "./pdf-template-runtime.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const roots: string[] = [];
const baselineDesign = BUILTIN_PDF_DESIGN as unknown as Readonly<
  Record<string, unknown>
>;

async function temporaryRoot(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `atlcli-t7-${name}-`));
  roots.push(parent);
  return join(parent, "project");
}

afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

function decisions(value: string): TemplateDecisionStateV1 {
  return {
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: [
      {
        id: `override:${value}`,
        kind: "override",
        target: "branding.organizationName",
        value,
      },
    ],
    preview: {
      designReviewDigest: HASH_A,
      compatibilityProofDigest: HASH_A,
    },
  };
}

async function initializeProject(
  root: string,
  options: ConstructorParameters<typeof DirectoryTemplateProjectRepository>[1] = {}
) {
  const repository = new DirectoryTemplateProjectRepository(root, options);
  const generation = await repository.commit({
    projectId: "fs-project",
    expectedGeneration: null,
    analysisDigest: HASH_A,
    decisions: decisions("first"),
    snapshotDigest: HASH_A,
    privateIntake: { privateSource: "first" },
  });
  return { repository, generation };
}

describe("directory repository shared contract", () => {
  templateProjectRepositoryContract(async () => {
    const root = await temporaryRoot("contract");
    return new DirectoryTemplateProjectRepository(root);
  });
});

describe("atomic generation and lock safety", () => {
  test("keeps the old pointer before swap and verifies the new pointer after swap", async () => {
    const root = await temporaryRoot("faults");
    const { generation: first } = await initializeProject(root);

    const beforeSwap = new DirectoryTemplateProjectRepository(root, {
      fault: "after-generation-write",
    });
    await expect(
      beforeSwap.commit({
        projectId: "fs-project",
        expectedGeneration: first.generation,
        analysisDigest: HASH_B,
        decisions: decisions("before-swap"),
        snapshotDigest: HASH_B,
      })
    ).rejects.toThrow("Injected failure after generation write");
    expect(
      (await new DirectoryTemplateProjectRepository(root).read("fs-project"))
        .generation
    ).toBe(first.generation);

    const afterSwap = new DirectoryTemplateProjectRepository(root, {
      fault: "after-pointer-swap",
    });
    await expect(
      afterSwap.commit({
        projectId: "fs-project",
        expectedGeneration: first.generation,
        analysisDigest: HASH_B,
        decisions: decisions("after-swap"),
        snapshotDigest: HASH_B,
      })
    ).rejects.toThrow("Injected failure after pointer swap");
    const active = await new DirectoryTemplateProjectRepository(root).read(
      "fs-project"
    );
    expect(active.generation).not.toBe(first.generation);
    expect(active.decisions).toEqual(decisions("after-swap"));
  });

  test("allows exactly one writer from the same base and preserves foreign files", async () => {
    const root = await temporaryRoot("concurrent");
    const { generation: first } = await initializeProject(root);
    await writeFile(join(root, "FOREIGN.txt"), "keep me");
    const left = new DirectoryTemplateProjectRepository(root, {
      ownerId: () => "left",
    });
    const right = new DirectoryTemplateProjectRepository(root, {
      ownerId: () => "right",
    });
    const results = await Promise.allSettled([
      left.commit({
        projectId: "fs-project",
        expectedGeneration: first.generation,
        analysisDigest: HASH_B,
        decisions: decisions("left"),
      }),
      right.commit({
        projectId: "fs-project",
        expectedGeneration: first.generation,
        analysisDigest: HASH_B,
        decisions: decisions("right"),
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(
      rejected?.status === "rejected" &&
        (rejected.reason instanceof PdfTemplateProjectFsError ||
          rejected.reason instanceof TemplateProjectGenerationConflictError)
    ).toBe(true);
    expect(await readFile(join(root, "FOREIGN.txt"), "utf8")).toBe("keep me");
    expect((await readdir(join(root, "state"))).length).toBeGreaterThanOrEqual(2);
  });

  test("serializes preview mutations and rejects conflicting bytes", async () => {
    const root = await temporaryRoot("preview-concurrent");
    const { generation } = await initializeProject(root);
    const firstBytes = new TextEncoder().encode("first preview");
    const secondBytes = new TextEncoder().encode("second preview");
    const artifact = async (bytes: Uint8Array) => ({
      generation: generation.generation,
      purpose: "design-review" as const,
      snapshotDigest: HASH_A,
      digest: await sha256Hex(bytes),
      mediaType: "application/pdf" as const,
      byteLength: bytes.byteLength,
      pageCount: 1,
      regions: [
        { page: 1, region: "summary" as const },
        { page: 1, region: "baseline" as const },
        { page: 1, region: "current" as const },
      ],
      output: { kind: "bytes" as const, bytes },
    });
    const left = new DirectoryTemplateProjectRepository(root, {
      ownerId: () => "preview-left",
    });
    const right = new DirectoryTemplateProjectRepository(root, {
      ownerId: () => "preview-right",
    });
    const results = await Promise.allSettled([
      left.putPreview(
        "fs-project",
        await artifact(firstBytes)
      ),
      right.putPreview(
        "fs-project",
        await artifact(secondBytes)
      ),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1
    );
    const stored = await left.getPreview(
      "fs-project",
      generation.generation,
      "design-review"
    );
    expect(stored).toBeDefined();
    expect(
      [await sha256Hex(firstBytes), await sha256Hex(secondBytes)]
    ).toContain(stored!.digest);
  });

  test("recovers only an expired lock with an unchanged base, irrespective of PID reuse", async () => {
    const root = await temporaryRoot("stale-lock");
    const { generation: first } = await initializeProject(root);
    const lockPath = join(root, ".project.lock");
    await writeFile(
      lockPath,
      `${canonicalCapabilityJson({
        schema: "wiki.pdf-template-project-lock/v1",
        ownerId: "crashed-owner",
        pid: process.pid,
        acquiredAt: 0,
        expiresAt: 50,
        baseGeneration: first.generation,
      })}\n`
    );
    const recovered = await new DirectoryTemplateProjectRepository(root, {
      now: () => 100,
      ownerId: () => "replacement",
    }).commit({
      projectId: "fs-project",
      expectedGeneration: first.generation,
      analysisDigest: HASH_B,
      decisions: decisions("recovered"),
    });
    expect(recovered.parentGeneration).toBe(first.generation);

    await writeFile(
      lockPath,
      `${canonicalCapabilityJson({
        schema: "wiki.pdf-template-project-lock/v1",
        ownerId: "old-base",
        pid: 999_999,
        acquiredAt: 0,
        expiresAt: 50,
        baseGeneration: first.generation,
      })}\n`
    );
    const repository = new DirectoryTemplateProjectRepository(root, {
      now: () => 100,
    });
    await expect(
      repository.commit({
        projectId: "fs-project",
        expectedGeneration: recovered.generation,
        analysisDigest: HASH_B,
        decisions: decisions("must-not-win"),
      })
    ).rejects.toMatchObject({ code: "project-busy" });
    expect((await repository.read("fs-project")).generation).toBe(
      recovered.generation
    );
  });

  test("an active crash lock never changes state", async () => {
    const root = await temporaryRoot("active-lock");
    const { generation: first } = await initializeProject(root);
    await writeFile(
      join(root, ".project.lock"),
      `${canonicalCapabilityJson({
        schema: "wiki.pdf-template-project-lock/v1",
        ownerId: "active-owner",
        pid: process.pid,
        acquiredAt: 90,
        expiresAt: 200,
        baseGeneration: first.generation,
      })}\n`
    );
    const repository = new DirectoryTemplateProjectRepository(root, {
      now: () => 100,
    });
    await expect(
      repository.commit({
        projectId: "fs-project",
        expectedGeneration: first.generation,
        analysisDigest: HASH_B,
        decisions: decisions("blocked"),
      })
    ).rejects.toMatchObject({ code: "project-busy" });
    expect((await repository.read("fs-project")).generation).toBe(
      first.generation
    );
  });
});

describe("initialization, symlinks, and no-clobber behavior", () => {
  test("refuses every pre-existing initialization target without deleting it", async () => {
    for (const contents of [[], ["foreign.marker"]]) {
      const root = await temporaryRoot(`existing-${contents.length}`);
      await mkdir(root);
      for (const name of contents) {
        await writeFile(join(root, name), "foreign");
      }
      await expect(
        new DirectoryTemplateProjectRepository(root).commit({
          projectId: "fs-project",
          expectedGeneration: null,
          analysisDigest: HASH_A,
          decisions: decisions("initial"),
        })
      ).rejects.toBeDefined();
      expect(await readdir(root)).toEqual(contents);
    }
  });

  test("rejects tampered project markers without touching foreign entries", async () => {
    const root = await temporaryRoot("marker");
    await initializeProject(root);
    await writeFile(join(root, "FOREIGN.txt"), "keep");
    await writeFile(
      join(root, "project.json"),
      `${canonicalCapabilityJson({
        schema: "wiki.pdf-template-project/v1",
        projectId: "another-project",
      })}\n`
    );
    await expect(
      new DirectoryTemplateProjectRepository(root).read("fs-project")
    ).rejects.toMatchObject({ code: "corrupt-project" });
    expect(await readFile(join(root, "FOREIGN.txt"), "utf8")).toBe("keep");
  });

  test("refuses root, state, lock, intake, and accepted-asset symlinks", async () => {
    const target = await temporaryRoot("symlink-target");
    await mkdir(target);
    const rootLink = await temporaryRoot("symlink-root");
    await symlink(target, rootLink);
    await expect(
      new DirectoryTemplateProjectRepository(rootLink).commit({
        projectId: "fs-project",
        expectedGeneration: null,
        analysisDigest: HASH_A,
        decisions: decisions("root-link"),
      })
    ).rejects.toMatchObject({ code: "unsafe-entry" });

    const stateRoot = await temporaryRoot("symlink-state");
    const { generation: stateGeneration } = await initializeProject(stateRoot);
    await rm(join(stateRoot, "state"), { recursive: true });
    await symlink(target, join(stateRoot, "state"));
    await expect(
      new DirectoryTemplateProjectRepository(stateRoot).commit({
        projectId: "fs-project",
        expectedGeneration: stateGeneration.generation,
        analysisDigest: HASH_B,
        decisions: decisions("state-link"),
      })
    ).rejects.toMatchObject({ code: "unsafe-entry" });

    const lockRoot = await temporaryRoot("symlink-lock");
    const { generation: lockGeneration } = await initializeProject(lockRoot);
    const lockTarget = join(target, "lock");
    await writeFile(lockTarget, "foreign");
    await symlink(lockTarget, join(lockRoot, ".project.lock"));
    await expect(
      new DirectoryTemplateProjectRepository(lockRoot).commit({
        projectId: "fs-project",
        expectedGeneration: lockGeneration.generation,
        analysisDigest: HASH_B,
        decisions: decisions("lock-link"),
      })
    ).rejects.toMatchObject({ code: "unsafe-entry" });

    const intakeRoot = await temporaryRoot("symlink-intake");
    await initializeProject(intakeRoot);
    await mkdir(join(intakeRoot, ".intake"), { recursive: true });
    await symlink(target, join(intakeRoot, ".intake", "assets"));
    await expect(
      new DirectoryTemplateAssetStore(intakeRoot).put({
        sha256: await sha256Hex(new Uint8Array([1])),
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      })
    ).rejects.toMatchObject({ code: "unsafe-entry" });

    const acceptedRoot = await temporaryRoot("symlink-accepted");
    await initializeProject(acceptedRoot);
    await symlink(target, join(acceptedRoot, "assets"));
    const assetPath = `assets/asset.logo/${HASH_A}.png`;
    await expect(
      copyAcceptedTemplateProjectAssets(
        acceptedRoot,
        minimalBuild({ [assetPath]: new Uint8Array([1]) })
      )
    ).rejects.toMatchObject({ code: "unsafe-entry" });
  });

  test("keeps accepted assets content-addressed and never overwrites foreign bytes", async () => {
    const root = await temporaryRoot("assets");
    await initializeProject(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await sha256Hex(bytes);
    const store = new DirectoryTemplateAssetStore(root);
    const handle = await store.put({
      sha256: digest,
      mediaType: "image/png",
      bytes,
    });
    await store.verify(handle);
    expect(await store.get(handle)).toEqual(bytes);

    const path = `assets/asset.logo/${digest}.png`;
    expect(
      await copyAcceptedTemplateProjectAssets(
        root,
        minimalBuild({ [path]: bytes })
      )
    ).toEqual([path]);
    await writeFile(join(root, path), "modified");
    await expect(
      copyAcceptedTemplateProjectAssets(root, minimalBuild({ [path]: bytes }))
    ).rejects.toMatchObject({ code: "unsafe-entry" });
    expect(await store.get(handle)).toEqual(bytes);
  });
});

describe("private intake and real executable pack gate", () => {
  test("retains accepted private assets while replacing only private analysis data", async () => {
    const root = await temporaryRoot("reanalyze");
    const { repository, generation: first } = await initializeProject(root);
    const store = new DirectoryTemplateAssetStore(root);
    const bytes = new Uint8Array([9, 8, 7]);
    const digest = await sha256Hex(bytes);
    const handle = await store.put({
      sha256: digest,
      mediaType: "image/png",
      bytes,
    });
    const second = await repository.commit({
      projectId: "fs-project",
      expectedGeneration: first.generation,
      analysisDigest: HASH_B,
      decisions: decisions("first"),
      privateIntake: { privateSource: "reanalyzed" },
    });
    expect(await repository.readPrivateIntake(second.generation)).toEqual({
      privateSource: "reanalyzed",
    });
    expect(await store.get(handle)).toEqual(bytes);
    expect(await repository.readPrivateIntake(first.generation)).toEqual({
      privateSource: "first",
    });
  });

  test("compiles the exact generated canonical pack with pinned Typst-WASM", async () => {
    const digest = await computeCapabilityCatalogDigest(
      PDF_TEMPLATE_CAPABILITIES_V1
    );
    const snapshot = await resolveTemplateLayers({
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      catalogDigest: digest,
      baseline: {
        id: "editorial-indigo",
        version: "1",
        design: baselineDesign,
      },
      sourceDigest: HASH_A,
      decisions: {
        schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
        decisions: [],
        preview: {},
      },
      candidates: [],
      mappingVersion: "mapping-1",
    });
    const logoBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="110" viewBox="0 0 500 110"><rect width="500" height="110" fill="#4B57A3"/></svg>'
    );
    const logoDigest = await sha256Hex(logoBytes);
    const materialized = await new PdfTemplateRuntimeMaterializer().materialize(
      snapshot,
      [
        {
          slot: "asset.logo",
          sha256: logoDigest,
          mediaType: "image/svg+xml",
          bytes: logoBytes,
          accessibility: {
            decorative: false,
            alt: "Organization logo",
          },
          rendering: {
            kind: "candidate-placement",
            placement: {
              relativeTo: "margin",
              fit: "contain",
              x: "-1.94mm",
              y: "-0.423mm",
              width: "49.989mm",
              height: "11.342mm",
            },
          },
        },
      ]
    );
    expect(
      materialized.manifest.assets?.["asset.logo"]?.placement
    ).toEqual({
      relativeTo: "margin",
      fit: "contain",
      x: "-1.94mm",
      y: "-0.423mm",
      width: "49.989mm",
      height: "11.342mm",
    });
    expect(materialized.canonicalTypst).toContain(
      "logo-path != none and logo-placement != none"
    );
    const build: TemplateProjectBuildV1 = {
      schema: TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
      generation: HASH_A,
      snapshotDigest: snapshot.snapshotDigest,
      analysisJson: "{}\n",
      authoringSnapshotJson: `${canonicalCapabilityJson(snapshot)}\n`,
      runtimeSnapshotJson: `${canonicalCapabilityJson(
        materialized.runtimeSnapshot
      )}\n`,
      manifestJson: `${canonicalCapabilityJson(materialized.manifest)}\n`,
      manifest: materialized.manifest,
      canonicalTypst: materialized.canonicalTypst,
      files: materialized.files,
    };
    const compiler = new CliGeneratedPdfTemplateCompiler();
    try {
      const result = await buildGeneratedPdfTemplatePack(build, compiler);
      expect(result.bytes.byteLength).toBeGreaterThan(1_000);
      expect(result.compile.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.compile.pageCount).toBeGreaterThan(0);
    } finally {
      await compiler.reset();
    }
  });
});

function minimalBuild(
  assetFiles: Record<string, Uint8Array>
): TemplateProjectBuildV1 {
  return {
    schema: TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
    generation: HASH_A,
    snapshotDigest: HASH_A,
    analysisJson: "{}\n",
    authoringSnapshotJson: "{}\n",
    runtimeSnapshotJson: "{}\n",
    manifestJson: "{}\n",
    manifest: {} as TemplateProjectBuildV1["manifest"],
    canonicalTypst: "",
    files: {
      "atlcli.typ": new Uint8Array(),
      ...assetFiles,
    },
  };
}
