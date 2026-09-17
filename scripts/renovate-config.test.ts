import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import config from "../renovate.json";

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
