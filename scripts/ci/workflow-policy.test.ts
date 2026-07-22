import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const workflow = (name: string) => readFile(join(REPO_ROOT, ".github", "workflows", name), "utf8");

describe("CI workflow policy", () => {
  it("keeps one stable required check around selectively skipped jobs", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --full");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --null");
    expect(ci).toContain("name: required");
    expect(ci).toContain("if: always()");
    expect(ci).toContain("uses: ./.github/workflows/reusable-quality.yml");
    expect(ci).toContain("uses: ./.github/workflows/reusable-consumer-smoke.yml");
  });

  it("cancels superseded PR work but retains main and scheduled evidence", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).toMatch(/schedule:\n\s+# Full unfiltered drift guard/);
  });

  it("runs the browser gate in parallel with product quality", async () => {
    const ci = await workflow("ci.yml");
    const browser = ci.slice(ci.indexOf("  browser-export-harness:"), ci.indexOf("  required:"));
    expect(browser).toContain("needs: changes");
    expect(browser).not.toContain("needs: test");
  });

  it("keeps the pinned consumer gate in CI and moves latest to a canary", async () => {
    const ci = await workflow("ci.yml");
    const canary = await workflow("consumer-smoke.yml");
    const reusable = await workflow("reusable-consumer-smoke.yml");
    expect(ci).toMatch(/consumer-smoke:[\s\S]*leg: pinned/);
    expect(canary).not.toContain("pull_request:");
    expect(canary).toMatch(/schedule:[\s\S]*leg: latest/);
    expect(reusable).toContain("continue-on-error: ${{ inputs.leg == 'latest' }}");
  });

  it("does not let a non-blocking benchmark mask M1 acceptance", async () => {
    const bench = await workflow("bench.yml");
    const benchmark = bench.slice(bench.indexOf("  benchmark:"), bench.indexOf("  m1-acceptance:"));
    const m1 = bench.slice(bench.indexOf("  m1-acceptance:"));
    expect(benchmark).toContain("continue-on-error: true");
    expect(m1).not.toContain("continue-on-error:");
    expect(m1).toContain("--require-cross-host");
  });

  it("keeps live Atlassian E2E out of remote CI", async () => {
    const workflows = await readdir(join(REPO_ROOT, ".github", "workflows"));
    expect(workflows).not.toContain("e2e-nightly.yml");
    for (const name of workflows.filter((entry) => entry.endsWith(".yml"))) {
      const source = await workflow(name);
      expect(source).not.toContain("ATLCLI_E2E_API_TOKEN");
      expect(source).not.toContain("ATLCLI_E2E_PROFILE");
    }
  });

  it("grants Pages write permissions only to the deploy job", async () => {
    const docs = await workflow("docs.yml");
    const build = docs.slice(0, docs.indexOf("  deploy:"));
    const deploy = docs.slice(docs.indexOf("  deploy:"));
    expect(build).not.toContain("pages: write");
    expect(build).not.toContain("id-token: write");
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
    expect(docs).toContain("cancel-in-progress: true");
  });

  it("blocks release builds on the shared SHA-bound preflight", async () => {
    const release = await workflow("release.yml");
    expect(release).toMatch(/preflight:[\s\S]*emit_security_attestation: true/);
    expect(release).toMatch(/build:\n\s+needs: preflight/);
  });
});
