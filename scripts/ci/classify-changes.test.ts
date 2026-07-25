import { describe, expect, it } from "bun:test";
import { classifyChanges } from "./classify-changes.js";

describe("classifyChanges", () => {
  it("routes published documentation without product gates", () => {
    expect(classifyChanges(["src/content/docs/contributing.md"])).toEqual({
      code: false,
      consumer: false,
      docs: true,
      readmeMedia: false,
    });
  });

  it("keeps plans and root prose out of product and site builds", () => {
    expect(classifyChanges(["specs/export-expansion/012-ci/PLAN.md", "README.md"])).toEqual({
      code: false,
      consumer: false,
      docs: false,
      readmeMedia: true,
    });
  });

  it("routes package documentation through product and consumer gates", () => {
    expect(classifyChanges(["packages/docx/README.md"])).toEqual({
      code: true,
      consumer: true,
      docs: false,
      readmeMedia: false,
    });
  });

  it("routes root dependency changes through every dependent gate", () => {
    expect(classifyChanges(["bun.lock"])).toEqual({
      code: true,
      consumer: true,
      docs: true,
      readmeMedia: false,
    });
  });

  it("fails open for workflow and unknown top-level paths", () => {
    expect(classifyChanges([".github/workflows/ci.yml"])).toEqual({
      code: true,
      consumer: true,
      docs: true,
      readmeMedia: true,
    });
    expect(classifyChanges(["new-runtime/config.toml"])).toEqual({
      code: true,
      consumer: true,
      docs: true,
      readmeMedia: true,
    });
  });

  it("runs every gate for manual, scheduled, or indeterminate changes", () => {
    expect(classifyChanges([], true)).toEqual({ code: true, consumer: true, docs: true, readmeMedia: true });
    expect(classifyChanges([])).toEqual({ code: true, consumer: true, docs: true, readmeMedia: true });
  });

  it("unions independent route decisions", () => {
    expect(classifyChanges(["src/content/docs/index.md", "apps/cli/src/index.ts"])).toEqual({
      code: true,
      consumer: false,
      docs: true,
      readmeMedia: false,
    });
  });

  it("routes only the exact README media prefix through its lightweight gate", () => {
    expect(
      classifyChanges([
        "README.md",
        "assets/readme/example.png",
        "assets/readme/reference.pdf",
      ])
    ).toEqual({ code: false, consumer: false, docs: false, readmeMedia: true });

    expect(classifyChanges(["assets/runtime/example.png"])).toEqual({
      code: true,
      consumer: true,
      docs: true,
      readmeMedia: true,
    });
    expect(classifyChanges(["assets/readme-preview/example.png"])).toEqual({
      code: true,
      consumer: true,
      docs: true,
      readmeMedia: true,
    });
  });

  it("keeps product-owned assets on product gates", () => {
    expect(classifyChanges(["apps/extension/assets/example.png"])).toEqual({
      code: true,
      consumer: false,
      docs: false,
      readmeMedia: false,
    });
  });
});
