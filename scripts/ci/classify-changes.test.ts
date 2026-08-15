import { describe, expect, it } from "bun:test";
import { classifyChanges, type CiRoutes } from "./classify-changes.js";

const narrow = (overrides: Partial<CiRoutes> = {}): CiRoutes => ({
  code: false,
  consumer: false,
  staticQuality: false,
  unitTests: false,
  packageContracts: false,
  astroPublishing: false,
  astroPlatform: false,
  pdfPlatform: false,
  browserHarness: false,
  docs: false,
  readmeMedia: false,
  researchPrivacy: true,
  ...overrides,
});

const all: CiRoutes = Object.fromEntries(
  Object.keys(narrow()).map((name) => [name, true]),
) as unknown as CiRoutes;

describe("classifyChanges", () => {
  const cases: Array<{ name: string; paths: string[]; expected: CiRoutes }> = [
    {
      name: "published documentation",
      paths: ["src/content/docs/contributing.md"],
      expected: narrow({ docs: true }),
    },
    {
      name: "plans plus root README",
      paths: ["specs/export-expansion/012-ci/PLAN.md", "README.md"],
      expected: narrow({ readmeMedia: true }),
    },
    {
      name: "CLI-only research code",
      paths: ["apps/cli/src/commands/research.ts"],
      expected: narrow({ code: true, staticQuality: true, unitTests: true }),
    },
    {
      name: "CLI PDF adapter",
      paths: ["apps/cli/src/commands/export-pdf.ts"],
      expected: narrow({
        code: true,
        staticQuality: true,
        unitTests: true,
        pdfPlatform: true,
      }),
    },
    {
      name: "Node export adapter",
      paths: ["packages/export-node/src/index.ts"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        pdfPlatform: true,
      }),
    },
    {
      name: "extension surface",
      paths: ["apps/extension/components/app/AppShell.tsx"],
      expected: narrow({
        code: true,
        staticQuality: true,
        unitTests: true,
        browserHarness: true,
      }),
    },
    {
      name: "research package",
      paths: ["packages/research/src/index.ts"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        browserHarness: true,
      }),
    },
    {
      name: "PDF package documentation",
      paths: ["packages/docx/README.md"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        pdfPlatform: true,
        browserHarness: true,
      }),
    },
    {
      name: "Astro publishing package",
      paths: ["packages/web-publish-astro/src/index.ts"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        astroPublishing: true,
        astroPlatform: true,
      }),
    },
    {
      name: "shared Confluence renderer",
      paths: ["packages/confluence/src/export-blocks.ts"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        astroPublishing: true,
        astroPlatform: true,
        pdfPlatform: true,
        browserHarness: true,
      }),
    },
    {
      name: "mixed docs and CLI",
      paths: ["src/content/docs/index.md", "apps/cli/src/index.ts"],
      expected: narrow({ code: true, staticQuality: true, unitTests: true, docs: true }),
    },
    {
      name: "README media",
      paths: ["README.md", "assets/readme/example.png", "assets/readme/reference.pdf"],
      expected: narrow({ readmeMedia: true }),
    },
    {
      name: "browser build script",
      paths: ["scripts/check-browser-build.ts"],
      expected: narrow({
        code: true,
        consumer: true,
        staticQuality: true,
        unitTests: true,
        packageContracts: true,
        browserHarness: true,
      }),
    },
  ];

  for (const { name, paths, expected } of cases) {
    it(`routes ${name}`, () => {
      expect(classifyChanges(paths)).toEqual(expected);
    });
  }

  it("fails open for global, workflow, and unknown paths", () => {
    for (const path of [
      "bun.lock",
      ".github/workflows/ci.yml",
      "new-runtime/config.toml",
      "assets/runtime/example.png",
      "assets/readme-preview/example.png",
    ]) {
      expect(classifyChanges([path]), path).toEqual(all);
    }
  });

  it("runs every gate for manual, scheduled, or indeterminate changes", () => {
    expect(classifyChanges([], true)).toEqual(all);
    expect(classifyChanges([])).toEqual(all);
  });

  it("unions independent capability closures", () => {
    expect(
      classifyChanges([
        "packages/web-publish-astro/src/index.ts",
        "apps/cli/src/commands/export-pdf.ts",
        "apps/extension/components/app/AppShell.tsx",
      ]),
    ).toEqual(narrow({
      code: true,
      consumer: true,
      staticQuality: true,
      unitTests: true,
      packageContracts: true,
      astroPublishing: true,
      astroPlatform: true,
      pdfPlatform: true,
      browserHarness: true,
    }));
  });

  it("normalizes repository-relative Windows paths", () => {
    expect(classifyChanges([".\\apps\\extension\\assets\\example.png"]))
      .toEqual(narrow({
        code: true,
        staticQuality: true,
        unitTests: true,
        browserHarness: true,
      }));
  });
});
