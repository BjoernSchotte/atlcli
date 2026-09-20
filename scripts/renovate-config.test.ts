import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import config from "../renovate.json";

test("batching preserves major approval and isolates patched/runtime packages", () => {
  const rules = config.packageRules;
  const stable = rules[0]!;
  expect(stable.matchManagers).toEqual(["bun", "npm"]);
  expect(stable.matchUpdateTypes).toEqual(["minor", "patch"]);
  expect(stable.matchCurrentVersion).toBe(">=1.0.0");
  const majorIndex = rules.findIndex((rule) => rule.matchUpdateTypes?.includes("major"));
  const actionsIndex = rules.findIndex((rule) => rule.groupName === "GitHub Actions");
  expect(actionsIndex).toBeGreaterThan(majorIndex);
  expect(rules[majorIndex]!.dependencyDashboardApproval).toBe(true);
  expect(rules[majorIndex]!.groupName).toBeNull();
  expect(rules[actionsIndex]!.matchDepNames).toEqual(["actions/**"]);
  expect(rules[actionsIndex]!.matchPackageNames).toBeUndefined();
  expect(rules[actionsIndex]!.separateMajorMinor).toBe(false);
  expect(rules[actionsIndex]!.dependencyDashboardApproval).toBe(true);
  const webdav = rules.find((rule) => rule.matchPackageNames?.includes("webdav-server"))!;
  expect(webdav.groupName).toBeNull();
  expect(webdav.dependencyDashboardApproval).toBe(true);
  const playwright = rules.find((rule) => rule.matchPackageNames?.includes("@playwright/test"))!;
  expect(playwright.groupName).toBe("Playwright");
  expect(playwright.dependencyDashboardApproval).toBe(true);
});

test("research dependencies require approval before any update", () => {
  const rule = config.packageRules.find((rule) => rule.groupName === "LangChain and deepagents")!;
  for (const name of ["langchain", "langsmith", "deepagents", "@langchain/*"]) {
    expect(rule.matchPackageNames).toContain(name);
  }
  expect(rule.dependencyDashboardApproval).toBe(true);
});

test("Renovate extracts the release Bun pin and groups all runtime sources", () => {
  expect(config.enabledManagers).toEqual(expect.arrayContaining(["bun", "github-actions", "asdf", "custom.regex"]));
  const manager = config.customManagers[0]!;
  const workflow = readFileSync(new URL("../.github/workflows/reusable-release-artifacts.yml", import.meta.url), "utf8");
  const version = new RegExp(manager.matchStrings[0]!).exec(workflow)?.groups?.currentValue;
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(`bun@${version}`).toBe(manifest.packageManager);
  const rule = config.packageRules.at(-1)!;
  expect(rule.matchPackageNames).toEqual(expect.arrayContaining(["bun", "oven-sh/bun"]));
  expect(rule.groupName).toBe("Bun runtime");
  expect(rule.dependencyDashboardApproval).toBe(true);
});
