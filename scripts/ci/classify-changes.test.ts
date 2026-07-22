import { describe, expect, it } from "bun:test";
import { classifyChanges } from "./classify-changes.js";

describe("classifyChanges", () => {
  it("routes published documentation without product gates", () => {
    expect(classifyChanges(["src/content/docs/contributing.md"])).toEqual({
      code: false,
      consumer: false,
      docs: true,
    });
  });

  it("keeps plans and root prose out of product and site builds", () => {
    expect(classifyChanges(["specs/export-expansion/012-ci/PLAN.md", "README.md"])).toEqual({
      code: false,
      consumer: false,
      docs: false,
    });
  });

  it("routes package documentation through product and consumer gates", () => {
    expect(classifyChanges(["packages/docx/README.md"])).toEqual({
      code: true,
      consumer: true,
      docs: false,
    });
  });

  it("routes root dependency changes through every dependent gate", () => {
    expect(classifyChanges(["bun.lock"])).toEqual({ code: true, consumer: true, docs: true });
  });

  it("fails open for workflow and unknown top-level paths", () => {
    expect(classifyChanges([".github/workflows/ci.yml"])).toEqual({ code: true, consumer: true, docs: true });
    expect(classifyChanges(["new-runtime/config.toml"])).toEqual({ code: true, consumer: true, docs: true });
  });

  it("runs every gate for manual, scheduled, or indeterminate changes", () => {
    expect(classifyChanges([], true)).toEqual({ code: true, consumer: true, docs: true });
    expect(classifyChanges([])).toEqual({ code: true, consumer: true, docs: true });
  });

  it("unions independent route decisions", () => {
    expect(classifyChanges(["src/content/docs/index.md", "apps/cli/src/index.ts"])).toEqual({
      code: true,
      consumer: false,
      docs: true,
    });
  });
});
