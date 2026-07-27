import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const workflow = (name: string) => readFile(join(WORKFLOW_DIR, name), "utf8");
const workflowNames = async () =>
  (await readdir(WORKFLOW_DIR)).filter((entry) => entry.endsWith(".yml"));

/** Body of an indented YAML block, ending at the next key of the same depth. */
const block = (source: string, header: RegExp, indent: number): string | null => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => new RegExp(`^ {${indent}}\\S`).test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

/** The `pull_request:` trigger body of a workflow, or null when it has none. */
const pullRequestTrigger = (source: string): string | null => {
  const triggers = block(source, /^on:\s*$/, 0);
  return triggers === null ? null : block(triggers, /^ {2}pull_request:\s*$/, 2);
};

/** Contents of a YAML `run: |` literal, with its body indentation removed. */
const yamlLiteral = (source: string, header: RegExp): string | null => {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const indent = lines[start]!.match(/^ */)![0].length;
  const bodyIndent = indent + 2;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^ */)![0].length <= indent) break;
    body.push(line.startsWith(" ".repeat(bodyIndent)) ? line.slice(bodyIndent) : "");
  }
  return body.join("\n");
};

const requiredGateEnv = {
  CHANGES: "success",
  CODE_REQUIRED: "true",
  CONSUMER_REQUIRED: "true",
  DOCS_REQUIRED: "true",
  README_MEDIA_REQUIRED: "true",
  EVENT_NAME: "pull_request",
  DOCS: "success",
  README_MEDIA: "success",
  TEST: "success",
  CONSUMER: "success",
  MACOS: "success",
  WINDOWS: "success",
  BROWSER: "success",
};

function runRequiredGate(
  script: string,
  overrides: Partial<typeof requiredGateEnv> = {},
): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${script}`], {
    env: { ...process.env, ...requiredGateEnv, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

describe("CI workflow policy", () => {
  it("keeps one stable required check around selectively skipped jobs", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --full");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --null");
    expect(ci).toContain("name: required");
    expect(ci).toContain("if: always()");
    expect(ci).toContain("uses: ./.github/workflows/reusable-quality.yml");
    expect(ci).toContain("uses: ./.github/workflows/reusable-consumer-smoke.yml");
    const readmeMedia = ci.slice(ci.indexOf("  readme-media:"), ci.indexOf("  test:"));
    expect(readmeMedia).toContain("needs: changes");
    expect(readmeMedia).toContain("if: needs.changes.outputs.readmeMedia == 'true'");
    expect(readmeMedia).toContain("bun run check:readme-media");
    const required = ci.slice(ci.indexOf("  required:"));
    expect(required).toContain("- readme-media");
    expect(required).toContain("CODE_REQUIRED: ${{ needs.changes.outputs.code }}");
    expect(required).toContain("CONSUMER_REQUIRED: ${{ needs.changes.outputs.consumer }}");
    expect(required).toContain("DOCS_REQUIRED: ${{ needs.changes.outputs.docs }}");
    expect(required).toContain("README_MEDIA_REQUIRED: ${{ needs.changes.outputs.readmeMedia }}");
    expect(required).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(required).toContain('require_result "Product quality" "$CODE_REQUIRED" "$TEST"');
    expect(required).toContain('require_result "Pinned consumer smoke" "$CONSUMER_REQUIRED" "$CONSUMER"');
    expect(required).toContain('require_result "Documentation" "$DOCS_SELECTED" "$DOCS"');
  });

  it("accepts skipped jobs only when their route is genuinely unselected", async () => {
    const ci = await workflow("ci.yml");
    const required = ci.slice(ci.indexOf("  required:"));
    const script = yamlLiteral(required, /^ {8}run: \|$/);
    expect(script).not.toBeNull();

    expect(runRequiredGate(script!).exitCode).toBe(0);
    expect(
      runRequiredGate(script!, {
        CODE_REQUIRED: "false",
        CONSUMER_REQUIRED: "false",
        DOCS_REQUIRED: "true",
        README_MEDIA_REQUIRED: "false",
        TEST: "skipped",
        CONSUMER: "skipped",
        MACOS: "skipped",
        WINDOWS: "skipped",
        BROWSER: "skipped",
        README_MEDIA: "skipped",
      }).exitCode,
    ).toBe(0);

    // Main pushes intentionally delegate docs build/deploy to docs.yml.
    expect(runRequiredGate(script!, { EVENT_NAME: "push", DOCS: "skipped" }).exitCode).toBe(0);

    for (const overrides of [
      { TEST: "skipped" },
      { CONSUMER: "skipped" },
      { DOCS: "skipped" },
      { MACOS: "skipped" },
      { WINDOWS: "skipped" },
      { BROWSER: "skipped" },
      { README_MEDIA: "skipped" },
      { CHANGES: "skipped" },
      { CODE_REQUIRED: "false", TEST: "success" },
    ]) {
      const result = runRequiredGate(script!, overrides);
      expect(result.exitCode, `unexpectedly accepted ${JSON.stringify(overrides)}`).not.toBe(0);
      expect(result.output).toContain("::error::");
    }
  });

  it("cancels superseded PR work but retains main and scheduled evidence", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).toMatch(/schedule:\n\s+# Full unfiltered drift guard/);
  });

  it("revalidates a pull request when it leaves draft", async () => {
    const ci = await workflow("ci.yml");
    const trigger = pullRequestTrigger(ci);
    expect(trigger).not.toBeNull();
    expect(trigger).toContain("types: [opened, synchronize, reopened, ready_for_review]");
  });

  it("spells out the same trigger types on every pull_request workflow", async () => {
    for (const name of await workflowNames()) {
      const trigger = pullRequestTrigger(await workflow(name));
      if (trigger === null) continue;
      const types = trigger.match(/^\s*types:\s*\[(.+)\]\s*$/m);
      expect(types, `${name} inherits the default pull_request types`).not.toBeNull();
      const listed = types![1]!.split(",").map((entry) => entry.trim());
      for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
        expect(listed, `${name} does not listen for ${action}`).toContain(action);
      }
    }
  });

  it("runs the browser gate in parallel with product quality", async () => {
    const ci = await workflow("ci.yml");
    const browser = ci.slice(ci.indexOf("  browser-export-harness:"), ci.indexOf("  required:"));
    expect(browser).toContain("needs: changes");
    expect(browser).not.toContain("needs: test");
  });

  it("builds the packed MV3 extension once before both prebuilt browser suites", async () => {
    const ci = await workflow("ci.yml");
    const extension = JSON.parse(await readFile(join(REPO_ROOT, "apps/extension/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const browser = ci.slice(ci.indexOf("  browser-export-harness:"), ci.indexOf("  required:"));

    expect(browser.match(/bun run --cwd apps\/extension build/g)).toHaveLength(1);
    expect(browser).toContain("test:worker-extension-browser:prebuilt");
    expect(browser).toContain("test:jobs-extension-browser:prebuilt");
    expect(browser).not.toMatch(/test:(?:worker|jobs)-extension-browser\s*$/m);

    // Local commands remain self-contained; CI alone opts into the prebuilt
    // variants after its one explicit build.
    expect(extension.scripts["pretest:worker-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:jobs-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["test:worker-extension-browser"]).toBe(
      "bun run test:worker-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:jobs-extension-browser"]).toBe(
      "bun run test:jobs-extension-browser:prebuilt",
    );
  });

  it("keeps four complete blocking Bun shards with unique reports and a fail-closed aggregate", async () => {
    const reusable = await workflow("reusable-quality.yml");
    const staticQuality = block(reusable, /^ {2}static-quality:\s*$/, 2);
    const tests = block(reusable, /^ {2}tests:\s*$/, 2);
    const attestation = block(reusable, /^ {2}security-attestation:\s*$/, 2);
    const complete = block(reusable, /^ {2}quality-complete:\s*$/, 2);

    expect(staticQuality).not.toBeNull();
    expect(staticQuality).toContain("bun run typecheck");
    expect(staticQuality).toContain("bun run check:browser");
    expect(staticQuality).toContain("bun run build");
    expect(staticQuality).toContain("bun run check:extension-output");
    expect(staticQuality).not.toContain("bun run test");

    expect(tests).not.toBeNull();
    expect(tests).toContain("fail-fast: false");
    expect(tests).toContain("shard: [1, 2, 3, 4]");
    expect(tests).toContain('bun run test --shard="${SHARD}/4"');
    expect(tests).toContain("--reporter=junit");
    expect(tests).toContain("--reporter-outfile=\"$JUNIT_FILE\"");
    expect(tests).toContain("TEST_EXIT=${PIPESTATUS[0]}");
    expect(tests).toContain("0 fail");
    expect(tests).toContain("if: always()");
    expect(tests).toContain("bun-test-shard-${{ matrix.shard }}.xml");
    expect(tests).toContain("bun-test-shard-${{ matrix.shard }}.log");
    expect(tests).not.toContain("continue-on-error:");

    expect(attestation).not.toBeNull();
    expect(attestation).toContain("needs: [static-quality, tests]");
    expect(attestation).toContain("if: inputs.emit_security_attestation");
    expect(attestation).toContain("fetch-depth: 2");
    expect(attestation).toContain("attestation.commit !== process.env.GITHUB_SHA");
    expect(attestation).toContain("security-attestation-${{ github.sha }}");

    expect(complete).not.toBeNull();
    expect(complete).toContain("if: always()");
    expect(complete).toContain("needs: [static-quality, tests, security-attestation]");
    expect(complete).toContain('[[ "$STATIC_QUALITY" != "success" ]]');
    expect(complete).toContain('[[ "$TESTS" != "success" ]]');
    expect(complete).toContain(
      '[[ "$ATTESTATION_REQUIRED" == "true" && "$ATTESTATION" != "success" ]]',
    );
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
