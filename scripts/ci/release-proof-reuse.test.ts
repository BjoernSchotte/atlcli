import { describe, expect, it } from "bun:test";
import { onlyReleaseBookkeeping, provesPreflight } from "./release-proof-reuse.js";

describe("provesPreflight", () => {
  const ok = (name: string) => ({ name, status: "completed", conclusion: "success" });
  const full = [
    ok("Product quality / Linux typecheck, browser checks, build, and package contracts"),
    ok("Product quality / Linux Bun tests (general-1)"),
    ok("Product quality / Astro platform (minimum-astro, ubuntu-latest, Node 22.23.4)"),
    { name: "Browser evidence / jobs", status: "completed", conclusion: "skipped" },
  ];

  it("needs typecheck, Bun tests and the Astro lane, all completed and passing", () => {
    expect(provesPreflight(full)).toBe(true);
    expect(provesPreflight(full.filter((r) => !r.name.includes("Astro")))).toBe(false);
    expect(provesPreflight([...full, { name: "Product quality / Linux Bun tests (general-2)", status: "in_progress", conclusion: null }])).toBe(false);
    expect(provesPreflight([...full, { name: "Browser evidence / jobs", status: "completed", conclusion: "failure" }])).toBe(false);
    expect(provesPreflight([])).toBe(false);
  });
});

const pkg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "atlcli", version: "2026.10.7", scripts: { test: "x" }, ...extra }, null, 2);

describe("onlyReleaseBookkeeping", () => {
  it("accepts a version bump plus changelog", () => {
    expect(onlyReleaseBookkeeping(["CHANGELOG.md", "package.json"], pkg(), pkg({ version: "2026.10.8" }))).toBe(true);
    expect(onlyReleaseBookkeeping(["CHANGELOG.md"], undefined, undefined)).toBe(true);
    expect(onlyReleaseBookkeeping([], pkg(), pkg())).toBe(true);
  });

  it("rejects any other file", () => {
    expect(onlyReleaseBookkeeping(["CHANGELOG.md", "apps/cli/src/index.ts"], pkg(), pkg())).toBe(false);
    expect(onlyReleaseBookkeeping(["apps/cli/package.json"], pkg(), pkg())).toBe(false);
    expect(onlyReleaseBookkeeping(["bun.lock", "package.json"], pkg(), pkg({ version: "2026.10.8" }))).toBe(false);
  });

  it("rejects package.json changes beyond the version", () => {
    expect(onlyReleaseBookkeeping(["package.json"], pkg(), pkg({ version: "2026.10.8", scripts: { test: "y" } }))).toBe(false);
    expect(onlyReleaseBookkeeping(["package.json"], pkg(), pkg({ dependencies: { left: "1" } }))).toBe(false);
  });

  it("rejects unreadable package.json", () => {
    expect(onlyReleaseBookkeeping(["package.json"], undefined, pkg())).toBe(false);
    expect(onlyReleaseBookkeeping(["package.json"], "{", pkg())).toBe(false);
  });
});
