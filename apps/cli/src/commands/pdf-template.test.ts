import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "@atlcli/core";
import { validatePdfOutput } from "@atlcli/pdf";
import type {
  TemplateImportProgressEventV1,
  TemplatePreviewCompiler,
  TemplatePreviewRequestV1,
} from "@atlcli/pdf-template-authoring";
import {
  DEFAULT_PDF_TEMPLATE_CLI_COPY,
  PdfTemplateCliError,
  executePdfTemplateCommand,
  pdfTemplateHelp,
  presentPdfTemplateResult,
  renderPdfTemplateMessage,
  validatePdfTemplateCliCopyCoverage,
  type PdfTemplateCliDependencies,
  type PdfTemplateCliResultV1,
} from "./pdf-template.js";
import {
  DirectoryTemplateProjectRepository,
  readTemplateProjectIdentity,
} from "./pdf-template-project-writer.js";
import {
  anchorDrawing,
  imageRelationships,
  png,
  visualDocx,
  wordDocument,
} from "../../../../packages/docx-template-intake/src/visual-test-support.js";

const FIXTURE = resolve(
  import.meta.dir,
  "../../../../packages/docx-template-intake/src/fixtures/neutral-generated-python-docx-1.2.0.docx"
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlcli PDF ü space-"));
  roots.push(root);
  return root;
}

function previewCompiler(): TemplatePreviewCompiler {
  return {
    async render(request: TemplatePreviewRequestV1) {
      const bytes = new TextEncoder().encode(
        `%PDF-1.7\n${request.purpose}\n${request.snapshotDigest}\n%%EOF`
      );
      const regions =
        request.purpose === "design-review"
          ? (["summary", "baseline", "current"] as const)
          : request.purpose === "asset-contact-sheet"
            ? (["asset-grid"] as const)
            : (["feature-zoo"] as const);
      return {
        digest: await sha256Hex(bytes),
        mediaType: "application/pdf" as const,
        byteLength: bytes.byteLength,
        pageCount: request.purpose === "design-review" ? 2 : 1,
        regions: regions.map((region, index) => ({
          page: request.purpose === "design-review" && index > 0 ? 2 : 1,
          region,
        })),
        output: { kind: "bytes" as const, bytes },
      };
    },
  };
}

function dependencies(
  cwd: string,
  options: {
    stdinIsTTY?: boolean;
    stderrIsTTY?: boolean;
    prompts?: readonly string[];
  } = {}
): {
  value: PdfTemplateCliDependencies;
  progress: TemplateImportProgressEventV1[];
  prompts: string[];
} {
  const progress: TemplateImportProgressEventV1[] = [];
  const questions: string[] = [];
  const answers = [...(options.prompts ?? [])];
  return {
    progress,
    prompts: questions,
    value: {
      cwd,
      stdinIsTTY: options.stdinIsTTY ?? false,
      stderrIsTTY: options.stderrIsTTY ?? false,
      columns: 80,
      noColor: true,
      unicode: false,
      locale: "en",
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "q";
      },
      onProgress: (event) => progress.push(event),
      readBytes: async (path) => new Uint8Array(await readFile(path)),
      createPreviewCompiler: async () => previewCompiler(),
      createGeneratedPackCompiler: () => ({
        async compile({ packBytes }) {
          return {
            digest: await sha256Hex(packBytes),
            pageCount: 3,
          };
        },
      }),
    },
  };
}

async function importProject(
  cwd: string,
  options: { metadataOnly?: boolean } = {}
): Promise<{
  result: PdfTemplateCliResultV1;
  project: string;
  deps: ReturnType<typeof dependencies>;
}> {
  const deps = dependencies(cwd);
  const result = await executePdfTemplateCommand(
    ["import", FIXTURE],
    options.metadataOnly ? { "metadata-only": true } : {},
    deps.value
  );
  return {
    result,
    project: join(
      cwd,
      "neutral-generated-python-docx-1.2.0-pdf-template"
    ),
    deps,
  };
}

async function completeReview(
  cwd: string,
  project: string,
  deps: ReturnType<typeof dependencies>
): Promise<PdfTemplateCliResultV1> {
  let status = await executePdfTemplateCommand(
    ["status", project],
    {},
    deps.value
  );
  if (
    status.view?.availableActions.some(
      ({ kind, enabled }) => kind === "apply-ready" && enabled
    )
  ) {
    status = await executePdfTemplateCommand(
      ["review", project],
      { "apply-ready": true },
      deps.value
    );
  }
  const flags: Record<string, boolean> = {};
  if (
    status.view?.availableActions.some(
      ({ kind, enabled }) =>
        kind === "keep-current-for-remaining" && enabled
    )
  ) {
    flags["keep-current-for-remaining"] = true;
  }
  if (
    status.view?.availableActions.some(
      ({ kind, enabled }) => kind === "acknowledge-inventory" && enabled
    )
  ) {
    flags["acknowledge-unsupported"] = true;
  }
  return Object.keys(flags).length
    ? executePdfTemplateCommand(["review", project], flags, deps.value)
    : status;
}

describe("pdf-template CLI discovery and presentation", () => {
  test("help leads with the four business steps and separates expert commands", () => {
    const help = pdfTemplateHelp();
    const importAt = help.indexOf("1. import");
    const reviewAt = help.indexOf("2. review");
    const previewAt = help.indexOf("3. preview");
    const buildAt = help.indexOf("4. build");
    const expertAt = help.indexOf("Expert and automation commands");
    expect(importAt).toBeGreaterThan(0);
    expect(reviewAt).toBeGreaterThan(importAt);
    expect(previewAt).toBeGreaterThan(reviewAt);
    expect(buildAt).toBeGreaterThan(previewAt);
    expect(expertAt).toBeGreaterThan(buildAt);
    expect(help).toContain("--policy suggest-only");
    expect(help).toContain("local project's ignored .intake");
    expect(help).toContain('"wiki template" manages Confluence');
    expect(help).not.toContain("--all");
  });

  test("renders the frozen T0 first-import transcript without technical ids", () => {
    const view = {
      schema: "wiki.pdf-template-import-view/v1" as const,
      generation: "a".repeat(64),
      stage: "review-required" as const,
      summary: {
        readyToApply: 12,
        needsReview: 4,
        cannotTransfer: 3,
        blockers: 0,
        unanswered: 16,
      },
      sections: [],
      diagnostics: [],
      availableActions: [],
      nextActions: ["action:apply-ready"],
      preview: {
        designReview: "missing" as const,
        compatibilityProof: "missing" as const,
      },
    };
    const text = presentPdfTemplateResult(
      {
        schema: "atlcli.pdf-template-result/1",
        command: "import",
        ok: true,
        exitCode: 0,
        projectPath: "./brand-pdf-template",
        view,
        diagnostics: [],
        nextActions: ["atlcli pdf-template review ./brand-pdf-template"],
        changedCount: 0,
        details: {
          sourceName: "brand.docx",
          baseline: "builtin.editorial-indigo",
        },
      },
      {
        width: 80,
        details: false,
        color: false,
        unicode: false,
        locale: "en",
      }
    );
    expect(text).toContain("Analyzed brand.docx");
    expect(text).toContain("12 design choices are ready to apply");
    expect(text).toContain("4 need your review");
    expect(text).toContain("3 Word features cannot be transferred");
    expect(text).toContain("No Word suggestions have been applied yet.");
    expect(text).toEndWith(
      "Next: atlcli pdf-template review ./brand-pdf-template"
    );
    expect(text).not.toMatch(/candidate:|typography\.roles|[a-f0-9]{64}/u);
  });

  test("covers every reachable code and provides a visible locale fallback", () => {
    expect(() =>
      validatePdfTemplateCliCopyCoverage(DEFAULT_PDF_TEMPLATE_CLI_COPY)
    ).not.toThrow();
    const { DOCX_CONCEPT_BODY: _removed, ...missing } =
      DEFAULT_PDF_TEMPLATE_CLI_COPY;
    expect(() => validatePdfTemplateCliCopyCoverage(missing)).toThrow(
      "DOCX_CONCEPT_BODY"
    );
    const {
      ATLCLI_PDF_TEMPLATE_METADATA_ONLY: _removedCli,
      ...missingCli
    } = DEFAULT_PDF_TEMPLATE_CLI_COPY;
    expect(() => validatePdfTemplateCliCopyCoverage(missingCli)).toThrow(
      "ATLCLI_PDF_TEMPLATE_METADATA_ONLY"
    );
    expect(
      renderPdfTemplateMessage("DOCX_CONCEPT_BODY", {}, "de")
    ).toBe("[DOCX_CONCEPT_BODY]");
  });

  test("keeps 80/120-column text readable without color or Unicode", () => {
    const result: PdfTemplateCliResultV1 = {
      schema: "atlcli.pdf-template-result/1",
      command: "status",
      ok: true,
      exitCode: 0,
      projectPath: "./brand-pdf-template",
      view: {
        schema: "wiki.pdf-template-import-view/v1",
        generation: "a".repeat(64),
        stage: "review-required",
        summary: {
          readyToApply: 12,
          needsReview: 4,
          cannotTransfer: 3,
          blockers: 1,
          unanswered: 16,
        },
        sections: [],
        diagnostics: [],
        availableActions: [],
        nextActions: ["action:apply-ready"],
        preview: {
          designReview: "missing",
          compatibilityProof: "missing",
        },
      },
      diagnostics: [],
      nextActions: ["atlcli pdf-template review ./brand-pdf-template"],
    };
    for (const width of [80, 120]) {
      const text = presentPdfTemplateResult(result, {
        width,
        details: false,
        color: false,
        unicode: false,
        locale: "en",
      });
      expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(
        width
      );
      expect(text).toContain("OK Review required");
      expect(text).not.toContain("\u001b");
    }
  });

  test("freezes every primary journey state at 80/120 columns with and without color", () => {
    type View = NonNullable<PdfTemplateCliResultV1["view"]>;
    const projectPath = "./brand-pdf-template";
    const view = (
      stage: View["stage"],
      overrides: Partial<View> = {}
    ): View => ({
      schema: "wiki.pdf-template-import-view/v1",
      generation: "a".repeat(64),
      stage,
      summary: {
        readyToApply: 2,
        needsReview: 1,
        cannotTransfer: 1,
        blockers: stage === "blocked" ? 1 : 0,
        unanswered: 1,
      },
      sections: [],
      diagnostics: [],
      availableActions: [],
      nextActions: [],
      preview: {
        designReview:
          stage === "ready-to-build" || stage === "built"
            ? "ready"
            : "missing",
        compatibilityProof:
          stage === "ready-to-build" || stage === "built"
            ? "ready"
            : "missing",
      },
      ...overrides,
    });
    const warning = (message: string): PdfTemplateCliResultV1["diagnostics"] => [
      {
        code: "ATLCLI_PDF_TEMPLATE_REVIEW_REQUIRED",
        severity: "warning",
        message,
        recoveryCommands: [
          `atlcli pdf-template review ${projectPath}`,
        ],
      },
    ];
    const ok = (
      command: string,
      stage: View["stage"],
      extra: Partial<PdfTemplateCliResultV1> = {}
    ): PdfTemplateCliResultV1 => ({
      schema: "atlcli.pdf-template-result/1",
      command,
      ok: true,
      exitCode: 0,
      projectPath,
      view: view(stage),
      diagnostics: [],
      nextActions: [`atlcli pdf-template review ${projectPath}`],
      ...extra,
    });
    const scenarios: Readonly<Record<string, PdfTemplateCliResultV1>> = {
      "first-import": ok("import", "review-required", {
        changedCount: 0,
        details: {
          sourceName: "brand.docx",
          baseline: "builtin.editorial-indigo",
        },
      }),
      "resumable-status": ok("status", "review-required"),
      "ready-change-review": ok("review", "review-required", {
        changedCount: 1,
        openCount: 2,
      }),
      "uncertain-review": ok("review", "review-required", {
        diagnostics: warning(
          "One design choice needs confirmation before it can be applied."
        ),
      }),
      "asset-review": ok("review", "review-required", {
        diagnostics: warning(
          "Confirm the graphic role, accessibility, and usage rights."
        ),
      }),
      "source-change-recovery": ok("reanalyze", "source-changed", {
        diagnostics: warning(
          "The Word source changed. Reanalyze it before continuing."
        ),
        nextActions: [
          "atlcli pdf-template reanalyze brand.docx --dir ./brand-pdf-template",
        ],
      }),
      "blocked-build": {
        schema: "atlcli.pdf-template-result/1",
        command: "build",
        ok: false,
        exitCode: 5,
        projectPath,
        diagnostics: [
          {
            code: "ATLCLI_ERR_VALIDATION",
            severity: "error",
            message:
              "Review items remain. The active draft was retained.",
            recoveryCommands: [
              `atlcli pdf-template review ${projectPath}`,
            ],
          },
        ],
        nextActions: [`atlcli pdf-template review ${projectPath}`],
      },
      "successful-preview": ok("preview", "ready-to-build", {
        outputs: {
          "design-review": "./proof/design-review.pdf",
          "compatibility-proof": "./proof/compatibility-proof.pdf",
        },
        nextActions: [`atlcli pdf-template build ${projectPath}`],
      }),
      "successful-build": ok("build", "built", {
        outputs: {
          archive: "./brand.wiki-pdf-template",
        },
        nextActions: [`atlcli wiki export 123 --format pdf --template ./brand.wiki-pdf-template --output ./brand.pdf`],
      }),
      undo: ok("undo", "ready-to-preview", {
        changedCount: 1,
        openCount: 0,
        details: {
          undoCommand: `atlcli pdf-template undo ${projectPath}`,
        },
        nextActions: [`atlcli pdf-template preview ${projectPath}`],
      }),
    };
    const matrix: Record<string, string> = {};
    const stripAnsi = (value: string): string =>
      value.replace(/\u001b\[[0-9;]*m/gu, "");
    for (const [scenario, result] of Object.entries(scenarios)) {
      for (const width of [80, 120]) {
        for (const color of [false, true]) {
          const rendered = presentPdfTemplateResult(result, {
            width,
            details: false,
            color,
            unicode: false,
            locale: "en",
          });
          const plain = stripAnsi(rendered);
          expect(
            Math.max(...plain.split("\n").map((line) => line.length)),
            `${scenario}/${width}/${color ? "color" : "plain"}`
          ).toBeLessThanOrEqual(width);
          expect(plain).toMatch(/(?:Next|Recover): atlcli /u);
          expect(rendered.includes("\u001b["), scenario).toBe(color);
          matrix[
            `${scenario}/${width}/${color ? "color" : "plain"}`
          ] = rendered;
        }
      }
    }
    expect(
      Object.entries(matrix)
        .map(([key, value]) => `=== ${key} ===\n${value}`)
        .join("\n\n")
    ).toMatchSnapshot();
  });

  test("human errors retain the draft once and keep the machine code behind details", () => {
    const result: PdfTemplateCliResultV1 = {
      schema: "atlcli.pdf-template-result/1",
      command: "build",
      ok: false,
      exitCode: 5,
      diagnostics: [
        {
          code: "ATLCLI_ERR_VALIDATION",
          severity: "error",
          message:
            "Review items remain. The active draft was retained.",
          recoveryCommands: [
            "atlcli pdf-template review ./brand-pdf-template",
          ],
        },
      ],
      nextActions: [
        "atlcli pdf-template review ./brand-pdf-template",
      ],
    };
    const ordinary = presentPdfTemplateResult(result, {
      width: 80,
      details: false,
      color: false,
      unicode: false,
      locale: "en",
    });
    expect(
      ordinary.match(/The active draft was retained\./gu)
    ).toHaveLength(1);
    expect(ordinary).toContain(
      "Recover: atlcli pdf-template review ./brand-pdf-template"
    );
    expect(ordinary).not.toContain("ATLCLI_ERR_VALIDATION");
    expect(
      presentPdfTemplateResult(result, {
        width: 80,
        details: true,
        color: false,
        unicode: false,
        locale: "en",
      })
    ).toContain("Code: ATLCLI_ERR_VALIDATION");
  });
});

describe("pdf-template CLI project journey", () => {
  test("imports deterministically in a path with spaces/Unicode and resumes unchanged", async () => {
    const firstRoot = await workspace();
    const secondRoot = await workspace();
    const first = await importProject(firstRoot);
    const second = await importProject(secondRoot);
    expect(first.result.ok).toBe(true);
    expect(first.result.changedCount).toBe(0);
    expect(first.result.view?.stage).toBe("review-required");
    expect(first.result.nextActions[0]).toContain("pdf-template review");
    expect(first.deps.progress.length).toBeGreaterThan(0);

    const firstId = await readTemplateProjectIdentity(first.project);
    const secondId = await readTemplateProjectIdentity(second.project);
    const firstGeneration = await new DirectoryTemplateProjectRepository(
      first.project
    ).read(firstId);
    const secondGeneration = await new DirectoryTemplateProjectRepository(
      second.project
    ).read(secondId);
    expect(firstGeneration.project?.decisions.decisions).toEqual([]);
    expect(firstGeneration.project?.baseline.id).toBe(
      "builtin.editorial-indigo"
    );
    expect(firstGeneration.generation).toBe(secondGeneration.generation);

    const status = await executePdfTemplateCommand(
      ["status", first.result.projectPath!],
      {},
      dependencies(firstRoot).value
    );
    expect(status.view?.stage).toBe(first.result.view?.stage);
    expect(status.view?.summary).toEqual(first.result.view?.summary);
    expect(status.view?.preview).toEqual(first.result.view?.preview);
    expect(status.nextActions).toEqual(first.result.nextActions);

    const generationBefore = firstGeneration.generation;
    await expect(
      executePdfTemplateCommand(
        ["analyze", FIXTURE],
        { dir: first.project },
        first.deps.value
      )
    ).rejects.toBeInstanceOf(Error);
    expect(
      (
        await new DirectoryTemplateProjectRepository(first.project).read(
          firstId
        )
      ).generation
    ).toBe(generationBefore);
  });

  test("non-interactive review never prompts or mutates without an explicit action", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const beforeId = await readTemplateProjectIdentity(imported.project);
    const before = await new DirectoryTemplateProjectRepository(
      imported.project
    ).read(beforeId);
    const deps = dependencies(root, {
      stdinIsTTY: false,
      stderrIsTTY: true,
      prompts: ["w"],
    });
    const result = await executePdfTemplateCommand(
      ["review", imported.project],
      {},
      deps.value
    );
    const after = await new DirectoryTemplateProjectRepository(
      imported.project
    ).read(beforeId);
    expect(result.ok).toBe(true);
    expect(result.diagnostics[0]?.code).toBe(
      "ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE"
    );
    expect(result.diagnostics[0]?.recoveryCommands).toContain(
      `atlcli pdf-template review ${imported.project} --apply-ready`
    );
    expect(deps.prompts).toEqual([]);
    expect(after.generation).toBe(before.generation);
  });

  test("covers stdin/stderr TTY, explicit non-interactive, and JSON no-prompt cases", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const before = await repository.read(id);
    const cases = [
      { stdinIsTTY: false, stderrIsTTY: true, flags: {} },
      { stdinIsTTY: true, stderrIsTTY: false, flags: {} },
      {
        stdinIsTTY: true,
        stderrIsTTY: true,
        flags: { "non-interactive": true },
      },
      {
        stdinIsTTY: true,
        stderrIsTTY: true,
        flags: { json: true },
      },
    ] as const;
    for (const entry of cases) {
      const deps = dependencies(root, {
        stdinIsTTY: entry.stdinIsTTY,
        stderrIsTTY: entry.stderrIsTTY,
        prompts: ["w"],
      });
      const result = await executePdfTemplateCommand(
        ["review", imported.project],
        { ...entry.flags },
        deps.value
      );
      expect(result.diagnostics[0]?.code).toBe(
        "ATLCLI_PDF_TEMPLATE_REVIEW_NON_INTERACTIVE"
      );
      expect(deps.prompts).toEqual([]);
    }
    expect((await repository.read(id)).generation).toBe(before.generation);
  });

  test("applies ready choices, writes explicit tombstones/acknowledgement, previews, builds, and undoes", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const reviewed = await completeReview(
      root,
      imported.project,
      imported.deps
    );
    expect(reviewed.view?.summary.unanswered).toBe(0);
    expect(reviewed.view?.stage).toBe("ready-to-preview");
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const reviewedGeneration = await repository.read(id);
    expect(
      reviewedGeneration.project?.decisions.decisions.some(
        ({ kind }) => kind === "use-baseline"
      )
    ).toBe(true);
    if (
      reviewedGeneration.project?.analysis.inventoryDiagnosticCodes.length
    ) {
      expect(
        reviewedGeneration.project.decisions.decisions.some(
          ({ kind }) => kind === "acknowledge-inventory"
        )
      ).toBe(true);
    }
    const reviewedText = presentPdfTemplateResult(reviewed, {
      width: 80,
      details: false,
      color: false,
      unicode: false,
      locale: "en",
    });
    const normalizedReviewedText = reviewedText.replace(/\s+/gu, " ");
    expect(reviewedText).toContain("OK Ready to preview");
    expect(reviewedText).toContain("Changed:");
    expect(normalizedReviewedText).toContain(`Project: ${imported.project}`);
    expect(reviewedText).toContain("Next: atlcli pdf-template preview");
    expect(normalizedReviewedText).toContain(
      `Undo: atlcli pdf-template undo ${imported.project}`
    );
    expect(
      (
        await executePdfTemplateCommand(
          ["status", imported.project],
          {},
          dependencies(root).value
        )
      ).view
    ).toEqual(reviewed.view);

    const previewed = await executePdfTemplateCommand(
      ["preview", imported.project],
      {},
      imported.deps.value
    );
    expect(previewed.view?.stage).toBe("ready-to-build");
    expect(previewed.outputs?.["design-review"]).toContain(
      "design-review.pdf"
    );
    expect(
      await stat(join(imported.project, "proof", "results.json"))
    ).toBeDefined();
    expect(
      (
        await executePdfTemplateCommand(
          ["status", imported.project],
          {},
          dependencies(root).value
        )
      ).view
    ).toEqual(previewed.view);

    const archive = join(root, "verified.wiki-pdf-template");
    const built = await executePdfTemplateCommand(
      ["build", imported.project],
      { output: archive },
      imported.deps.value
    );
    expect(built.view?.stage).toBe("built");
    expect((await stat(archive)).size).toBeGreaterThan(0);
    expect(
      (
        await executePdfTemplateCommand(
          ["status", imported.project],
          {},
          dependencies(root).value
        )
      ).view
    ).toEqual(built.view);
    await expect(
      executePdfTemplateCommand(
        ["build", imported.project],
        { output: archive },
        imported.deps.value
      )
    ).rejects.toBeInstanceOf(Error);

    const undone = await executePdfTemplateCommand(
      ["undo", imported.project],
      {},
      imported.deps.value
    );
    expect(undone.outputDigest).not.toBe(built.outputDigest);
    expect(undone.view?.preview.designReview).not.toBe("ready");
    expect(
      (await repository.listHistory(id)).length
    ).toBeGreaterThanOrEqual(5);
    expect(
      (
        await executePdfTemplateCommand(
          ["status", imported.project],
          {},
          dependencies(root).value
        )
      ).view
    ).toEqual(undone.view);
  }, 30_000);

  test("build names the recovery step for unanswered review and missing or stale previews", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    await expect(
      executePdfTemplateCommand(
        ["build", imported.project],
        { output: join(root, "too-early.wiki-pdf-template") },
        imported.deps.value
      )
    ).rejects.toMatchObject({
      recoveryActions: expect.arrayContaining(["review"]),
    });

    await completeReview(root, imported.project, imported.deps);
    await expect(
      executePdfTemplateCommand(
        ["build", imported.project],
        { output: join(root, "no-preview.wiki-pdf-template") },
        imported.deps.value
      )
    ).rejects.toMatchObject({
      code: "preview-required",
      recoveryActions: ["preview"],
    });

    await executePdfTemplateCommand(
      ["preview", imported.project],
      {},
      imported.deps.value
    );
    await executePdfTemplateCommand(
      ["set"],
      {
        dir: imported.project,
        target: "typography.roles.h1.size",
        value: '"21pt"',
      },
      imported.deps.value
    );
    await expect(
      executePdfTemplateCommand(
        ["pack", imported.project],
        { output: join(root, "stale-preview.wiki-pdf-template") },
        imported.deps.value
      )
    ).rejects.toMatchObject({
      recoveryActions: expect.arrayContaining(["preview"]),
    });

    const runner = resolve(import.meta.dir, "../index.ts");
    const process = Bun.spawn(
      [
        "bun",
        "--conditions=development",
        "run",
        runner,
        "pdf-template",
        "build",
        imported.project,
        "--output",
        join(root, "still-stale.wiki-pdf-template"),
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
    const failure = JSON.parse(stdout) as PdfTemplateCliResultV1;
    expect(failure.diagnostics[0]?.code).toBe("ATLCLI_ERR_VALIDATION");
    expect(failure.nextActions.length).toBeGreaterThan(0);
    expect(
      failure.nextActions.every(
        (action) =>
          action.includes(imported.project) && !action.includes("<project>")
      )
    ).toBe(true);
  }, 30_000);

  test("interactive review supports back, commits answered work on stop, and hides technical ids", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const deps = dependencies(root, {
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompts: ["s", "b", "w", "q"],
    });
    const result = await executePdfTemplateCommand(
      ["review", imported.project],
      {},
      deps.value
    );
    expect(result.changedCount).toBe(1);
    expect(result.details?.undoCommand).toBe(
      `atlcli pdf-template undo ${imported.project}`
    );
    const transcript = deps.prompts.join("\n");
    expect(transcript).toContain("Why this was suggested:");
    expect(transcript).toContain("Use Word value");
    expect(transcript).toContain("Keep current design");
    expect(deps.prompts.length).toBeGreaterThanOrEqual(4);
    expect(transcript).not.toMatch(/candidate:|typography\.roles/u);
    const initialItems =
      imported.result.view?.sections
        .flatMap(({ items }) => items)
        .filter(({ state }) => state === "ready" || state === "review") ?? [];
    for (const [promptIndex, itemIndex] of [
      [0, 0],
      [1, 1],
    ] as const) {
      const prompt = deps.prompts[promptIndex]!;
      const enabled = new Set(
        initialItems[itemIndex]?.actions
          .filter(({ enabled }) => enabled)
          .map(({ kind }) => kind) ?? []
      );
      expect(prompt.includes("Use Word value")).toBe(
        enabled.has("use-word-value")
      );
      expect(prompt.includes("Keep current design")).toBe(
        enabled.has("keep-current-design")
      );
      expect(prompt.includes("Customize")).toBe(enabled.has("customize"));
    }
  });

  test("SIGINT-style cancellation retains the active generation", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const before = await repository.read(id);
    const deps = dependencies(root, {
      stdinIsTTY: true,
      stderrIsTTY: true,
    });
    deps.value.prompt = async () => {
      throw new PdfTemplateCliError(
        "ATLCLI_ERR_CANCELLED",
        130,
        "Review was cancelled. The active draft was retained."
      );
    };
    await expect(
      executePdfTemplateCommand(
        ["review", imported.project],
        {},
        deps.value
      )
    ).rejects.toMatchObject({
      machineCode: "ATLCLI_ERR_CANCELLED",
      exitCode: 130,
    });
    expect((await repository.read(id)).generation).toBe(before.generation);
  });

  test("metadata-only status explains the required source reanalysis", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const status = await executePdfTemplateCommand(
      ["status", imported.project],
      {},
      imported.deps.value
    );
    expect(status.diagnostics[0]?.code).toBe(
      "ATLCLI_PDF_TEMPLATE_METADATA_ONLY"
    );
    expect(status.diagnostics[0]?.recoveryCommands[0]).toContain(
      "pdf-template reanalyze"
    );
  });

  test("reanalyze retains intent and reports deterministic staleness", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    await executePdfTemplateCommand(
      ["review", imported.project],
      { "apply-ready": true },
      imported.deps.value
    );
    const result = await executePdfTemplateCommand(
      ["reanalyze", FIXTURE],
      { dir: imported.project, "metadata-only": true },
      imported.deps.value
    );
    expect(result.details?.reconciliation).toBeDefined();
    expect(result.details?.undoCommand).toContain("pdf-template undo");
    const initialTarget = join(root, "unmarked");
    await expect(
      executePdfTemplateCommand(
        ["reanalyze", FIXTURE],
        { dir: initialTarget },
        imported.deps.value
      )
    ).rejects.toBeInstanceOf(Error);
  });

  test("real CLI preview writes tagged design/compatibility PDFs and JSONL progress", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    await completeReview(root, imported.project, imported.deps);
    const runner = resolve(import.meta.dir, "../index.ts");
    const process = Bun.spawn(
      [
        "bun",
        "--conditions=development",
        "run",
        runner,
        "pdf-template",
        "preview",
        imported.project,
        "--json",
        "--no-log",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`preview subprocess failed:\nstdout=${stdout}\nstderr=${stderr}`);
    }
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as PdfTemplateCliResultV1;
    expect(result.schema).toBe("atlcli.pdf-template-result/1");
    expect(result.view?.stage).toBe("ready-to-build");
    expect(stdout.trim().split("\n").filter((line) => line.startsWith("{")).length).toBe(
      1
    );
    for (const line of stderr.trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const name of ["design-review.pdf", "compatibility-proof.pdf"]) {
      const bytes = new Uint8Array(
        await readFile(join(imported.project, "proof", name))
      );
      const inspection = validatePdfOutput(bytes);
      expect(inspection.tagged).toBe(true);
      expect(inspection.pageCount).toBeGreaterThan(0);
    }
    const proof = JSON.parse(
      await readFile(
        join(imported.project, "proof", "results.json"),
        "utf8"
      )
    ) as {
      compilerVersion: string;
      generation: string;
      artifacts: readonly { regions: readonly unknown[] }[];
    };
    expect(proof.compilerVersion).toBe("typst-wasm-pinned-0.14");
    expect(result.view).toBeDefined();
    expect(proof.generation).toBe(result.view!.generation);
    expect(proof.artifacts.every(({ regions }) => regions.length > 0)).toBe(
      true
    );
  }, 30_000);
});

describe("pdf-template CLI expert validation", () => {
  test("rejects unknown, duplicate, bare, and conflicting flags without mutation", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const before = await repository.read(id);
    const cases: Record<string, string | boolean | string[]>[] = [
      { all: true },
      { dir: [imported.project, imported.project] },
      { dir: true },
      { "accept-safe": true, "accept-recommended": true, dir: imported.project },
    ];
    for (const flags of cases) {
      await expect(
        executePdfTemplateCommand(
          flags["accept-safe"]
            ? ["decide"]
            : ["status", imported.project],
          flags,
          imported.deps.value
        )
      ).rejects.toMatchObject({
        machineCode: "ATLCLI_ERR_USAGE",
        exitCode: 1,
      } satisfies Partial<PdfTemplateCliError>);
    }
    expect((await repository.read(id)).generation).toBe(before.generation);
  });

  test("set validates path/type/bounds and clear commands affect only their decision class", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    const set = await executePdfTemplateCommand(
      ["set"],
      {
        dir: imported.project,
        target: "typography.roles.h1.size",
        value: '"20pt"',
      },
      imported.deps.value
    );
    expect(set.changedCount).toBe(1);
    for (const [target, value] of [
      ["unknown.path", '"x"'],
      ["typography.roles.h1.size", "42"],
      ["tokens.contrast.minimum", "999"],
    ]) {
      await expect(
        executePdfTemplateCommand(
          ["set"],
          { dir: imported.project, target, value },
          imported.deps.value
        )
      ).rejects.toBeInstanceOf(Error);
    }
    const cleared = await executePdfTemplateCommand(
      ["clear-override"],
      { dir: imported.project, target: "typography.roles.h1.size" },
      imported.deps.value
    );
    expect(cleared.changedCount).toBe(1);
    await executePdfTemplateCommand(
      ["clear-optional"],
      { dir: imported.project, target: "branding.organizationName" },
      imported.deps.value
    );
    const id = await readTemplateProjectIdentity(imported.project);
    const project = (
      await new DirectoryTemplateProjectRepository(imported.project).read(id)
    ).project!;
    expect(
      project.decisions.decisions.some(
        ({ kind }) => kind === "clear-optional"
      )
    ).toBe(true);
    expect(
      project.decisions.decisions.some(({ kind }) => kind === "override")
    ).toBe(false);
  });

  test("use-baseline and reset-group round-trip without changing overrides", async () => {
    const root = await workspace();
    const imported = await importProject(root, { metadataOnly: true });
    await executePdfTemplateCommand(
      ["set"],
      {
        dir: imported.project,
        target: "branding.organizationName",
        value: '"Neutral organization"',
      },
      imported.deps.value
    );
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const current = (await repository.read(id)).project!;
    const candidate = current.analysis.candidates[0]!;
    await executePdfTemplateCommand(
      ["decide"],
      {
        dir: imported.project,
        group: candidate.group.id,
        "use-baseline": true,
      },
      imported.deps.value
    );
    let project = (await repository.read(id)).project!;
    expect(
      project.decisions.decisions.some(
        ({ kind }) => kind === "use-baseline"
      )
    ).toBe(true);
    expect(
      project.decisions.decisions.some(({ kind }) => kind === "override")
    ).toBe(true);
    await executePdfTemplateCommand(
      ["decide"],
      {
        dir: imported.project,
        group: candidate.group.id,
        "reset-group": true,
      },
      imported.deps.value
    );
    project = (await repository.read(id)).project!;
    expect(
      project.decisions.decisions.some(
        ({ kind }) => kind === "use-baseline"
      )
    ).toBe(false);
    expect(
      project.decisions.decisions.some(({ kind }) => kind === "override")
    ).toBe(true);
  });

  test("safe and recommended expert policies materialize distinct sets", async () => {
    const safeRoot = await workspace();
    const recommendedRoot = await workspace();
    const safe = await importProject(safeRoot, { metadataOnly: true });
    const recommended = await importProject(recommendedRoot, {
      metadataOnly: true,
    });
    await executePdfTemplateCommand(
      ["decide"],
      { dir: safe.project, "accept-safe": true },
      safe.deps.value
    );
    await executePdfTemplateCommand(
      ["decide"],
      { dir: recommended.project, "accept-recommended": true },
      recommended.deps.value
    );
    const safeId = await readTemplateProjectIdentity(safe.project);
    const recommendedId = await readTemplateProjectIdentity(
      recommended.project
    );
    const safeCount = (
      await new DirectoryTemplateProjectRepository(safe.project).read(safeId)
    ).project!.decisions.decisions.filter(
      ({ kind }) => kind === "accept-candidate"
    ).length;
    const recommendedCount = (
      await new DirectoryTemplateProjectRepository(
        recommended.project
      ).read(recommendedId)
    ).project!.decisions.decisions.filter(
      ({ kind }) => kind === "accept-candidate"
    ).length;
    expect(safeCount).toBeGreaterThan(0);
    expect(recommendedCount).toBeGreaterThan(safeCount);
    expect(pdfTemplateHelp()).not.toContain("recommendation action");
  });

  test("asset acceptance requires role, rights, accessibility, and exactly one placement", async () => {
    const root = await workspace();
    const source = join(root, "visual.docx");
    const width = 11_906 * 635;
    const height = 16_838 * 635;
    await writeFile(
      source,
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rPage", {
            width,
            height,
            behindDoc: true,
          })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
        ),
        documentRelationships: imageRelationships([
          { id: "rPage", target: "media/page.png" },
        ]),
        entries: { "word/media/page.png": png(800, 600) },
      })
    );
    const deps = dependencies(root);
    const result = await executePdfTemplateCommand(
      ["import", source],
      {},
      deps.value
    );
    const imported = {
      result,
      project: join(root, "visual-pdf-template"),
      deps,
    };
    const assetItem = imported.result.view?.sections
      .flatMap(({ items }) => items)
      .find((item) =>
        item.actions.some(
          ({ kind, enabled }) => kind === "review-asset" && enabled
        )
      );
    expect(assetItem).toBeDefined();
    const candidate = assetItem!.details.candidateIds[0]!;
    const id = await readTemplateProjectIdentity(imported.project);
    const repository = new DirectoryTemplateProjectRepository(imported.project);
    const before = await repository.read(id);
    const base = {
      dir: imported.project,
      candidate,
      "accept-asset": true,
      role: "logo",
      "slot-default": true,
    };
    const { role: _role, ...withoutRole } = base;
    const { "slot-default": _placement, ...withoutPlacement } = base;
    for (const invalid of [
      base,
      {
        ...withoutRole,
        "rights-confirmed": true,
        meaningful: true,
        alt: "Neutral fixture graphic",
      },
      {
        ...base,
        "rights-confirmed": true,
      },
      {
        ...withoutPlacement,
        "rights-confirmed": true,
        meaningful: true,
        alt: "Neutral fixture graphic",
      },
      {
        ...base,
        "rights-confirmed": true,
        meaningful: true,
        alt: "Neutral fixture graphic",
        "custom-placement": "{}",
      },
      {
        ...base,
        "rights-confirmed": true,
        decorative: true,
        alt: "conflict",
      },
    ]) {
      await expect(
        executePdfTemplateCommand(
          ["decide"],
          invalid,
          imported.deps.value
        )
      ).rejects.toMatchObject({ machineCode: "ATLCLI_ERR_USAGE" });
    }
    expect((await repository.read(id)).generation).toBe(before.generation);

    const accepted = await executePdfTemplateCommand(
      ["decide"],
      {
        ...base,
        "rights-confirmed": true,
        meaningful: true,
        alt: "Neutral fixture graphic",
      },
      imported.deps.value
    );
    expect(accepted.changedCount).toBe(1);
    const project = (await repository.read(id)).project!;
    const assetDecision = project.decisions.decisions.find(
      ({ kind }) => kind === "accept-asset"
    );
    expect(assetDecision).toMatchObject({
      kind: "accept-asset",
      role: "asset.logo",
      useConfirmed: true,
      rightsConfirmed: true,
      accessibility: {
        decorative: false,
        alt: "Neutral fixture graphic",
      },
      rendering: { kind: "slot-default" },
    });
    expect(assetDecision?.kind).toBe("accept-asset");
    if (assetDecision?.kind === "accept-asset") {
      expect(assetDecision.assetSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(project.assetHandles[assetDecision.assetSha256]).toMatchObject({
        sha256: assetDecision.assetSha256,
        mediaType: "image/png",
      });
    }
  });

  test("stable one-column Word logo coordinates can be accepted into the template", async () => {
    const root = await workspace();
    const source = join(root, "positioned-logo.docx");
    await writeFile(
      source,
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rLogo", {
            horizontal: "column",
            vertical: "page",
            horizontalOffset: -69_850,
            verticalOffset: 899_160,
            width: 1_799_590,
            height: 408_305,
            rotation: 0,
          })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:num="1"/></w:sectPr>`
        ),
        documentRelationships: imageRelationships([
          { id: "rLogo", target: "media/logo.png" },
        ]),
        entries: { "word/media/logo.png": png(500, 110) },
      })
    );
    const deps = dependencies(root);
    const imported = await executePdfTemplateCommand(
      ["import", source],
      {},
      deps.value
    );
    const projectDir = join(root, "positioned-logo-pdf-template");
    const assetItem = imported.view?.sections
      .flatMap(({ items }) => items)
      .find(
        (item) =>
          item.labelCode === "DOCX_CONCEPT_VISUAL_ASSET" &&
          item.actions.some(
            ({ kind, enabled }) => kind === "review-asset" && enabled
          )
      );
    expect(assetItem).toBeDefined();

    await executePdfTemplateCommand(
      ["decide"],
      {
        dir: projectDir,
        candidate: assetItem!.details.candidateIds[0]!,
        "accept-asset": true,
        role: "logo",
        "rights-confirmed": true,
        meaningful: true,
        alt: "Organization logo",
        "use-candidate-placement": true,
      },
      deps.value
    );

    const id = await readTemplateProjectIdentity(projectDir);
    const project = (
      await new DirectoryTemplateProjectRepository(projectDir).read(id)
    ).project!;
    expect(
      project.decisions.decisions.find(
        ({ kind }) => kind === "accept-asset"
      )
    ).toMatchObject({
      role: "asset.logo",
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
    });
  });

  test("layout-dependent graphic placement cannot be frozen as a candidate placement", async () => {
    const root = await workspace();
    const source = join(root, "layout-dependent.docx");
    await writeFile(
      source,
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rLayout", {
            horizontal: "paragraph",
            vertical: "line",
          })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
        ),
        documentRelationships: imageRelationships([
          { id: "rLayout", target: "media/layout.png" },
        ]),
        entries: { "word/media/layout.png": png(320, 180) },
      })
    );
    const deps = dependencies(root);
    const imported = await executePdfTemplateCommand(
      ["import", source],
      {},
      deps.value
    );
    const project = join(root, "layout-dependent-pdf-template");
    const assetItem = imported.view?.sections
      .flatMap(({ items }) => items)
      .find(
        (item) =>
          item.labelCode === "DOCX_CONCEPT_VISUAL_ASSET" &&
          item.details.candidateIds.length > 0
      );
    expect(assetItem).toBeDefined();
    await expect(
      executePdfTemplateCommand(
        ["decide"],
        {
          dir: project,
          candidate: assetItem!.details.candidateIds[0]!,
          "accept-asset": true,
          role: "logo",
          "rights-confirmed": true,
          decorative: true,
          "use-candidate-placement": true,
        },
        deps.value
      )
    ).rejects.toMatchObject({
      machineCode: "ATLCLI_ERR_USAGE",
      message: expect.stringContaining("no stable candidate placement"),
    });
  });

  test("interactive asset review shows the contact sheet before separate confirmations", async () => {
    const root = await workspace();
    const source = join(root, "visual-review.docx");
    const width = 11_906 * 635;
    const height = 16_838 * 635;
    await writeFile(
      source,
      visualDocx({
        document: wordDocument(
          `${anchorDrawing("rPage", {
            width,
            height,
            behindDoc: true,
          })}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
        ),
        documentRelationships: imageRelationships([
          { id: "rPage", target: "media/page.png" },
        ]),
        entries: { "word/media/page.png": png(800, 600) },
      })
    );
    const importDeps = dependencies(root);
    const imported = await executePdfTemplateCommand(
      ["import", source],
      {},
      importDeps.value
    );
    const project = join(root, "visual-review-pdf-template");
    const nonAssetOpen =
      imported.view?.sections
        .flatMap(({ items }) => items)
        .filter(
          (item) =>
            ["ready", "review"].includes(item.state) &&
            !item.actions.some(
              ({ kind, enabled }) => kind === "review-asset" && enabled
            )
        ).length ?? 0;
    const reviewDeps = dependencies(root, {
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompts: [
        ...Array.from({ length: nonAssetOpen }, () => "k"),
        "y",
        "page-background",
        "YES",
        "d",
        "d",
      ],
    });
    const reviewed = await executePdfTemplateCommand(
      ["review", project],
      {},
      reviewDeps.value
    );
    expect(reviewed.changedCount).toBeGreaterThanOrEqual(1);
    expect(
      reviewDeps.prompts.find((question) =>
        question.includes("Contact sheet:")
      )
    ).toContain(
      "Contact sheet: proof/asset-contact-sheet.pdf"
    );
    const roleIndex = reviewDeps.prompts.findIndex((question) =>
      question.startsWith("Role")
    );
    expect(roleIndex).toBeGreaterThan(0);
    expect(reviewDeps.prompts[roleIndex + 1]).toContain("right to use");
    expect(reviewDeps.prompts[roleIndex + 2]).toContain("Accessibility");
    expect(reviewDeps.prompts[roleIndex + 3]).toContain("Placement");
    expect(
      await stat(join(project, "proof", "asset-contact-sheet.pdf"))
    ).toBeDefined();
    const id = await readTemplateProjectIdentity(project);
    const state = (
      await new DirectoryTemplateProjectRepository(project).read(id)
    ).project!;
    expect(
      state.decisions.decisions.find(
        ({ kind }) => kind === "accept-asset"
      )
    ).toMatchObject({
      role: "asset.pageBackground",
      rightsConfirmed: true,
      accessibility: { decorative: true },
      rendering: { kind: "slot-default" },
    });
  });
});
