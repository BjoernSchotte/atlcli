import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "@atlcli/core";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  loadPdfTemplatePack,
} from "@atlcli/pdf";
import { BUILTIN_PDF_DESIGN } from "@atlcli/pdf/internal";
import type { TemplateGeneratedPackCompilerV1 } from "@atlcli/pdf-template-authoring";
import type { WikiPdfTemplateRecipeV1 } from "@atlcli/template-pack";
import { stringify } from "yaml";
import {
  executePdfTemplateCommand,
  pdfTemplateHelp,
  presentPdfTemplateResult,
  type PdfTemplateCliDependencies,
  type PdfTemplateCliResultV1,
} from "./pdf-template.js";
import {
  PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES,
  PdfTemplateYamlError,
  classifyPdfTemplateInput,
  materializePdfTemplateYamlRecipe,
  parsePdfTemplateRecipeYaml,
  writePdfTemplateRecipeArchive,
} from "./pdf-template-yaml.js";

const encoder = new TextEncoder();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlcli-yaml-recipe-"));
  roots.push(root);
  return root;
}

function recipe(): WikiPdfTemplateRecipeV1 {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.compositions = {
    cover: {
      kind: "type-cut",
      logo: "show",
      typeCut: { angle: 43, stop: 64 },
    },
    closingPage: {
      kind: "brand-lockup",
      logo: "show",
      website: "show",
      legalNotice: "show",
      align: "left",
    },
  };
  Object.assign(design.branding, {
    websiteLabel: "systems.example",
    websiteUrl: "https://systems.example/services",
    legalNotice: "Example Systems GmbH · Berlin · Qualität 🧪",
  });
  Object.assign(design.tokens.colors, {
    coverTitleInverse: "#FFFFFF",
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(design.tokens.layout, {
    coverTitleFrameHeight: "92mm",
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "92mm",
    closingBrandLogoWidth: "42mm",
    closingBrandLogoHeight: "18mm",
    closingBrandLogoGap: "8mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(design.typography.roles, {
    coverTitleCompact: {
      font: "body",
      size: "25pt",
      weight: "semibold",
    },
    coverTitleMinimum: {
      font: "body",
      size: "19pt",
      weight: "semibold",
    },
    closingWebsite: {
      font: "heading",
      size: "14pt",
      weight: "semibold",
    },
    closingLegal: {
      font: "heading",
      size: "9pt",
      weight: "regular",
    },
  });
  return {
    schema: "wiki.pdf-template-recipe/v1",
    template: {
      id: "fixture.cli-v4",
      name: "CLI V4",
      version: "1.0.0",
      compilerRange: ">=0.14 <0.15",
    },
    design,
    localization: structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.localization!),
    assets: {
      "asset.coverBackground": {
        source: "visuals/cover.svg",
        decorative: true,
      },
      "asset.logo": {
        source: "visuals/logo.svg",
        decorative: false,
        alt: "Example Systems",
      },
    },
  };
}

const compiler: TemplateGeneratedPackCompilerV1 = {
  async compile({ packBytes }) {
    return { digest: await sha256Hex(packBytes), pageCount: 3 };
  },
};

async function writeRecipe(
  root: string,
  extension: ".yaml" | ".yml" = ".yaml",
  value: WikiPdfTemplateRecipeV1 = recipe()
): Promise<string> {
  await mkdir(join(root, "visuals"), { recursive: true });
  await Bun.write(
    join(root, "visuals", "cover.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297"><path fill="#E75204" d="M0 0h210v297H0z"/></svg>'
  );
  await Bun.write(
    join(root, "visuals", "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><path fill="#FFFFFF" d="M0 0h80v24H0z"/></svg>'
  );
  const path = join(root, `template${extension}`);
  await writeFile(path, stringify(value));
  return path;
}

function dependencies(cwd: string): PdfTemplateCliDependencies {
  return {
    cwd,
    stdinIsTTY: false,
    stderrIsTTY: false,
    columns: 80,
    noColor: true,
    unicode: false,
    locale: "en",
    prompt: async () => "",
    onProgress: () => {},
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    createPreviewCompiler: async () => {
      throw new Error("not used by recipe builds");
    },
    createGeneratedPackCompiler: () => compiler,
  };
}

function expectYamlError(run: () => unknown, pattern: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PdfTemplateYamlError);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected PdfTemplateYamlError");
}

describe("strict PDF template recipe YAML", () => {
  it("keeps the downloadable documentation recipe machine-valid", async () => {
    const documented = fileURLToPath(
      new URL(
        "../../../../public/examples/pdf-template-recipe/recipe.yaml",
        import.meta.url
      )
    );
    const parsed = parsePdfTemplateRecipeYaml(await readFile(documented, "utf8"));
    expect(parsed.schema).toBe("wiki.pdf-template-recipe/v1");
    const materialized = await materializePdfTemplateYamlRecipe({
      recipePath: documented,
      compiler,
    });
    expect(materialized.manifest.canonicalSource?.revision).toBe("4");
    expect(materialized.manifest.capabilityCatalog?.version).toBe(2);
  });

  it("rejects malformed YAML, duplicate keys, custom tags, aliases, and multiple documents", () => {
    expectYamlError(() => parsePdfTemplateRecipeYaml("schema: ["), /line 1/u);
    expectYamlError(
      () => parsePdfTemplateRecipeYaml("schema: one\nschema: two\n"),
      /Map keys must be unique|duplicate/iu
    );
    expectYamlError(
      () => parsePdfTemplateRecipeYaml("schema: !unsafe value\n"),
      /tag/iu
    );
    expectYamlError(
      () => parsePdfTemplateRecipeYaml("first: &copy { value: 1 }\nsecond: *copy\n"),
      /aliases are disabled/iu
    );
    expectYamlError(
      () => parsePdfTemplateRecipeYaml("first: &copy { value: 1 }\n"),
      /anchors and aliases are disabled/iu
    );
    expectYamlError(
      () =>
        parsePdfTemplateRecipeYaml(
          "defaults: &defaults { value: 1 }\nmerged:\n  <<: *defaults\n"
        ),
      /aliases are disabled|merge/iu
    );
    expectYamlError(
      () => parsePdfTemplateRecipeYaml("---\na: 1\n---\nb: 2\n"),
      /exactly one document/iu
    );
  });

  it("reports normalized semantic paths for unknown fields and closing copy constraints", () => {
    const unknown = structuredClone(recipe()) as WikiPdfTemplateRecipeV1 & {
      unexpected?: boolean;
    };
    unknown.unexpected = true;
    expectYamlError(
      () => parsePdfTemplateRecipeYaml(stringify(unknown)),
      /recipe\.unexpected/iu
    );

    const invalidUrl = structuredClone(recipe());
    invalidUrl.design.branding.websiteUrl = "http://systems.example";
    expectYamlError(
      () => parsePdfTemplateRecipeYaml(stringify(invalidUrl)),
      /branding\.websiteUrl/iu
    );

    const missingLegal = structuredClone(recipe());
    delete missingLegal.design.branding.legalNotice;
    expectYamlError(
      () => parsePdfTemplateRecipeYaml(stringify(missingLegal)),
      /branding\.legalNotice/iu
    );
  });

  it("enforces the documented YAML byte budget before parsing", () => {
    expectYamlError(
      () =>
        parsePdfTemplateRecipeYaml(
          `#${"x".repeat(PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES + 1)}`
        ),
      /exceeds/iu
    );
  });
});

describe("PDF template recipe filesystem adapter", () => {
  it("materializes .yaml and .yml recipes deterministically", async () => {
    const yamlRoot = await workspace();
    const ymlRoot = await workspace();
    const yaml = await writeRecipe(yamlRoot, ".yaml");
    const yml = await writeRecipe(ymlRoot, ".yml");
    expect(await classifyPdfTemplateInput(yaml)).toBe("recipe");
    expect(await classifyPdfTemplateInput(yml)).toBe("recipe");
    const first = await materializePdfTemplateYamlRecipe({
      recipePath: yaml,
      compiler,
    });
    const warm = await materializePdfTemplateYamlRecipe({
      recipePath: yaml,
      compiler,
    });
    const parity = await materializePdfTemplateYamlRecipe({
      recipePath: yml,
      compiler,
    });
    expect(first.packDigest).toBe(warm.packDigest);
    expect(first.packDigest).toBe(parity.packDigest);
    expect(Array.from(first.bytes)).toEqual(Array.from(parity.bytes));
  });

  it("rejects traversal, escaping symlinks, and oversized assets before hashing", async () => {
    const traversalRoot = await workspace();
    const traversing = recipe();
    traversing.assets["asset.logo"]!.source = "../outside.svg";
    const traversalPath = join(traversalRoot, "template.yaml");
    await writeFile(traversalPath, stringify(traversing));
    await expect(
      materializePdfTemplateYamlRecipe({ recipePath: traversalPath, compiler })
    ).rejects.toThrow(/safe relative portable path/iu);

    const symlinkRoot = await workspace();
    const outside = await workspace();
    await Bun.write(
      join(outside, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"></svg>'
    );
    await symlink(outside, join(symlinkRoot, "visuals"));
    const symlinkRecipe = recipe();
    symlinkRecipe.assets = {
      "asset.logo": symlinkRecipe.assets["asset.logo"]!,
    };
    symlinkRecipe.design.compositions!.cover = {
      kind: "standard",
      logo: "show",
    };
    const symlinkPath = join(symlinkRoot, "template.yaml");
    await writeFile(symlinkPath, stringify(symlinkRecipe));
    await expect(
      materializePdfTemplateYamlRecipe({ recipePath: symlinkPath, compiler })
    ).rejects.toThrow(/symbolic link/iu);

    const budgetRoot = await workspace();
    const budgetPath = await writeRecipe(budgetRoot);
    await truncate(join(budgetRoot, "visuals", "logo.svg"), 25 * 1024 * 1024 + 1);
    await expect(
      materializePdfTemplateYamlRecipe({ recipePath: budgetPath, compiler })
    ).rejects.toThrow(/per-file byte budget/iu);
  });

  it("publishes atomically without clobbering an existing output", async () => {
    const root = await workspace();
    const output = join(root, "brand.wiki-pdf-template");
    await writePdfTemplateRecipeArchive(output, encoder.encode("first"));
    await expect(
      writePdfTemplateRecipeArchive(output, encoder.encode("second"))
    ).rejects.toThrow(/Refusing to overwrite/iu);
    expect(await readFile(output, "utf8")).toBe("first");
  });
});

describe("pdf-template recipe CLI dispatch", () => {
  it("builds and validates a recipe with redacted deterministic JSON fields", async () => {
    const root = await workspace();
    await writeRecipe(root);
    const deps = dependencies(root);
    const built = await executePdfTemplateCommand(
      ["build", "template.yaml"],
      { output: "brand.wiki-pdf-template", json: true },
      deps
    );
    const validated = await executePdfTemplateCommand(
      ["validate", "template.yaml"],
      { json: true },
      deps
    );
    expect(built.outputDigest).toBe(validated.outputDigest);
    expect(built.details).toMatchObject({
      recipePath: "template.yaml",
      catalogVersion: 2,
      canonicalRevision: "4",
      packDigest: built.outputDigest,
      pageCount: 3,
    });
    expect(await classifyPdfTemplateInput(join(root, "brand.wiki-pdf-template"))).toBe(
      "unsupported"
    );
    const json = JSON.stringify(built);
    expect(json).not.toContain(resolve(root));
    expect(json).not.toContain("visuals/logo.svg");
    expect(json).not.toContain("Example Systems GmbH");
    expect(
      presentPdfTemplateResult(built, {
        width: 80,
        details: false,
        color: false,
        unicode: false,
        locale: "en",
      })
    ).toContain("archive: brand.wiki-pdf-template");
  });

  it("keeps review and undo project-only and documents the declarative boundary", async () => {
    const root = await workspace();
    await writeRecipe(root);
    for (const command of ["import", "review", "preview", "undo", "pack"] as const) {
      await expect(
        executePdfTemplateCommand(
          [command, "template.yaml"],
          command === "pack" ? { output: "x.wiki-pdf-template" } : {},
          dependencies(root)
        )
      ).rejects.toThrow(/direct declarative builds.*no DOCX decision history/iu);
    }
    const help = pdfTemplateHelp();
    expect(help).toContain("pdf-template build ./template.yaml");
    expect(help).toContain("aliases, merge");
    expect(help).toContain("10,000 nodes");
  });

  it("emits stable ATLCLI_ERR_VALIDATION JSON with YAML location", async () => {
    const root = await workspace();
    await writeFile(join(root, "broken.yaml"), "schema: one\nschema: two\n");
    const runner = resolve(import.meta.dir, "../index.ts");
    const process = Bun.spawn(
      [
        "bun",
        "--conditions=development",
        "run",
        runner,
        "pdf-template",
        "build",
        "broken.yaml",
        "--output",
        "out.wiki-pdf-template",
        "--json",
        "--no-log",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(5);
    const result = JSON.parse(stdout) as PdfTemplateCliResultV1;
    expect(result.diagnostics[0]?.code).toBe("ATLCLI_ERR_VALIDATION");
    expect(result.diagnostics[0]?.technical).toMatch(/line 2, column 1/iu);
    expect(result.diagnostics[0]?.message).not.toContain(resolve(root));
  }, 30_000);

  it("builds a loadable pack through the public atlcli command and pinned compiler", async () => {
    const root = await workspace();
    await writeRecipe(root);
    const runner = resolve(import.meta.dir, "../index.ts");
    const process = Bun.spawn(
      [
        "bun",
        "--conditions=development",
        "run",
        runner,
        "pdf-template",
        "build",
        "template.yaml",
        "--output",
        "public.wiki-pdf-template",
        "--json",
        "--no-log",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout) as PdfTemplateCliResultV1;
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({
      recipePath: "template.yaml",
      catalogVersion: 2,
      canonicalRevision: "4",
    });
    const packBytes = new Uint8Array(
      await readFile(join(root, "public.wiki-pdf-template"))
    );
    const loaded = await loadPdfTemplatePack(packBytes);
    expect(loaded.canonicalSource.revision).toBe("4");
    expect(await sha256Hex(packBytes)).toBe(result.outputDigest!);
  }, 120_000);
});
