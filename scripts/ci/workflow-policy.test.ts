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
  PROOF_MODE: "required",
  STATIC_REQUIRED: "true",
  UNIT_REQUIRED: "true",
  ASTRO_REQUIRED: "true",
  CONSUMER_REQUIRED: "true",
  PDF_REQUIRED: "true",
  BROWSER_REQUIRED: "true",
  DOCS_REQUIRED: "true",
  README_MEDIA_REQUIRED: "true",
  EVENT_NAME: "pull_request",
  PRIVACY: "success",
  DOCS: "success",
  README_MEDIA: "success",
  DRAFT_QUALITY: "skipped",
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
  it("emits exactly one mode-named aggregate around selectively skipped jobs", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --full");
    expect(ci).toContain("bun scripts/ci/classify-changes.ts --null");
    expect(ci).toContain("bun scripts/ci/proof-mode.ts");
    expect(ci).toContain("name: ${{ needs.changes.outputs.aggregateStatusName }}");
    expect(ci).toContain("if: always()");
    expect(ci).toContain("uses: ./.github/workflows/reusable-quality.yml");
    expect(ci).toContain("uses: ./.github/workflows/reusable-consumer-smoke.yml");
    const readmeMedia = ci.slice(ci.indexOf("  readme-media:"), ci.indexOf("  test:"));
    expect(readmeMedia).toContain("needs: changes");
    expect(readmeMedia).toContain("if: needs.changes.outputs.readmeMedia == 'true'");
    expect(readmeMedia).toContain("bun run check:readme-media");
    const required = ci.slice(ci.indexOf("  required:"));
    expect(required).toContain("- research-privacy");
    expect(required).toContain("- readme-media");
    expect(required).toContain("PROOF_MODE: ${{ needs.changes.outputs.proofMode }}");
    expect(required).toContain("STATIC_REQUIRED: ${{ needs.changes.outputs.staticQuality }}");
    expect(required).toContain("UNIT_REQUIRED: ${{ needs.changes.outputs.unitTests }}");
    expect(required).toContain("ASTRO_REQUIRED: ${{ needs.changes.outputs.astroPlatform }}");
    expect(required).toContain("CONSUMER_REQUIRED: ${{ needs.changes.outputs.consumer }}");
    expect(required).toContain("PDF_REQUIRED: ${{ needs.changes.outputs.pdfPlatform }}");
    expect(required).toContain("BROWSER_REQUIRED: ${{ needs.changes.outputs.browserHarness }}");
    expect(required).toContain("DOCS_REQUIRED: ${{ needs.changes.outputs.docs }}");
    expect(required).toContain("README_MEDIA_REQUIRED: ${{ needs.changes.outputs.readmeMedia }}");
    expect(required).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(required).toContain('require_result "Tracked research privacy" "true" "$PRIVACY"');
    expect(required).toContain('require_result "Product quality" "$QUALITY_REQUIRED" "$TEST"');
    expect(required).toContain('require_result "Pinned consumer smoke" "$CONSUMER_REQUIRED" "$CONSUMER"');
    expect(required).toContain('require_result "Documentation" "$DOCS_SELECTED" "$DOCS"');
  });

  it("accepts only the exact gate result set selected by required, draft, or stale proof", async () => {
    const ci = await workflow("ci.yml");
    const required = ci.slice(ci.indexOf("  required:"));
    const script = yamlLiteral(required, /^ {8}run: \|$/);
    expect(script).not.toBeNull();

    expect(runRequiredGate(script!).exitCode).toBe(0);
    expect(
      runRequiredGate(script!, {
        STATIC_REQUIRED: "false",
        UNIT_REQUIRED: "false",
        ASTRO_REQUIRED: "false",
        CONSUMER_REQUIRED: "false",
        PDF_REQUIRED: "false",
        BROWSER_REQUIRED: "false",
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

    expect(
      runRequiredGate(script!, {
        PROOF_MODE: "draft-fast",
        DRAFT_QUALITY: "success",
        TEST: "skipped",
        CONSUMER: "skipped",
        MACOS: "skipped",
        WINDOWS: "skipped",
        BROWSER: "skipped",
      }).exitCode,
    ).toBe(0);

    expect(
      runRequiredGate(script!, {
        PROOF_MODE: "superseded",
        PRIVACY: "skipped",
        DOCS: "skipped",
        README_MEDIA: "skipped",
        DRAFT_QUALITY: "skipped",
        TEST: "skipped",
        CONSUMER: "skipped",
        MACOS: "skipped",
        WINDOWS: "skipped",
        BROWSER: "skipped",
      }).exitCode,
    ).toBe(0);

    for (const overrides of [
      { PRIVACY: "skipped" },
      { TEST: "skipped" },
      { CONSUMER: "skipped" },
      { DOCS: "skipped" },
      { MACOS: "skipped" },
      { WINDOWS: "skipped" },
      { BROWSER: "skipped" },
      { README_MEDIA: "skipped" },
      { CHANGES: "skipped" },
      {
        STATIC_REQUIRED: "false",
        UNIT_REQUIRED: "false",
        ASTRO_REQUIRED: "false",
        TEST: "success",
      },
      {
        PROOF_MODE: "draft-fast",
        DRAFT_QUALITY: "success",
        TEST: "success",
      },
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
    expect(ci).toContain("FULL_RUN: ${{ github.event_name == 'push'");
  });

  it("revalidates a pull request when it leaves draft", async () => {
    const ci = await workflow("ci.yml");
    const trigger = pullRequestTrigger(ci);
    expect(trigger).not.toBeNull();
    expect(trigger).toContain(
      "types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]",
    );
    expect(ci).toContain("pull.draft");
    expect(ci).toContain("pull.head.sha !== process.env.EXPECTED_HEAD_SHA");
  });

  it("is ready to run full proof for merge-queue candidates", async () => {
    const ci = await workflow("ci.yml");
    expect(ci).toContain("merge_group:");
    expect(ci).toContain("types: [checks_requested]");
    expect(ci).toContain("github.event.merge_group.base_sha");
    expect(ci).toContain("github.event.merge_group.head_sha");
    expect(ci).toContain("github.event_name == 'merge_group'");
    const required = block(ci, /^ {2}required:\s*$/, 2);
    expect(required).not.toBeNull();
    expect(required).toContain("name: ${{ needs.changes.outputs.aggregateStatusName }}");
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

  it("builds the packed MV3 extension once before all prebuilt browser suites", async () => {
    const ci = await workflow("ci.yml");
    const extension = JSON.parse(await readFile(join(REPO_ROOT, "apps/extension/package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const browser = ci.slice(ci.indexOf("  browser-export-harness:"), ci.indexOf("  required:"));

    expect(browser.match(/bun run --cwd apps\/extension build/g)).toHaveLength(1);
    expect(browser).toContain("test:worker-extension-browser:prebuilt");
    expect(browser).toContain("test:jobs-extension-browser:prebuilt");
    expect(browser).toContain("test:rovo-extension-browser:prebuilt");
    expect(browser).not.toMatch(/test:(?:worker|jobs|rovo)-extension-browser\s*$/m);

    // Local commands remain self-contained; CI alone opts into the prebuilt
    // variants after its one explicit build.
    expect(extension.scripts["pretest:worker-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:jobs-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:rovo-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["test:worker-extension-browser"]).toBe(
      "bun run test:worker-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:jobs-extension-browser"]).toBe(
      "bun run test:jobs-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:rovo-extension-browser"]).toBe(
      "bun run test:rovo-extension-browser:prebuilt",
    );
  });

  it("keeps system Chrome as a scheduled non-required neutral canary", async () => {
    const ci = await workflow("ci.yml");
    const canary = block(ci, /^ {2}browser-system-chrome-canary:\s*$/, 2);
    const required = block(ci, /^ {2}required:\s*$/, 2);
    expect(canary).not.toBeNull();
    expect(canary).toContain("continue-on-error: true");
    expect(canary).toContain("github.event_name == 'schedule'");
    expect(canary).toContain("ATLCLI_PLAYWRIGHT_CHANNEL: chrome");
    expect(canary).toContain("google-chrome --version");
    expect(canary).not.toContain("playwright@1.55.0 install");
    expect(required).not.toBeNull();
    expect(required).not.toContain("browser-system-chrome-canary");
  });

  it("uses Node 24 action runtimes and keeps the isolated Windows sink cacheless", async () => {
    const ci = await workflow("ci.yml");
    const reusable = await workflow("reusable-quality.yml");
    const workflows = `${ci}\n${reusable}`;
    const windowsSink = block(ci, /^ {2}pdf-sink-windows:\s*$/, 2);

    expect(workflows).toContain("actions/checkout@v7");
    expect(workflows).toContain("actions/setup-node@v7");
    expect(workflows).toContain("actions/github-script@v9");
    expect(workflows).toContain("actions/cache@v6");
    expect(workflows).toContain("actions/upload-artifact@v7");
    expect(workflows).toContain("actions/download-artifact@v8");
    expect(workflows).not.toMatch(
      /actions\/(?:checkout@v6|setup-node@v6|github-script@v8|cache(?:\/restore)?@v4|upload-artifact@v4|download-artifact@v5)/,
    );

    expect(windowsSink).not.toBeNull();
    expect(windowsSink).not.toContain("Restore Bun package cache");
    expect(windowsSink).not.toContain("actions/cache@");
  });

  it("keeps required quality branches parallel and removes duplicate publishing and aggregate tails", async () => {
    const reusable = await workflow("reusable-quality.yml");
    const staticQuality = block(reusable, /^ {2}static-quality:\s*$/, 2);
    const tests = block(reusable, /^ {2}tests:\s*$/, 2);
    const publishing = block(reusable, /^ {2}publishing-platform:\s*$/, 2);
    const latest = block(reusable, /^ {2}publishing-platform-latest:\s*$/, 2);
    const attestation = block(reusable, /^ {2}security-attestation:\s*$/, 2);
    const complete = block(reusable, /^ {2}quality-complete:\s*$/, 2);

    expect(staticQuality).not.toBeNull();
    expect(staticQuality).toContain("if: inputs.run_static_quality");
    expect(staticQuality).toContain("bun run typecheck");
    expect(staticQuality).toContain("bun run check:browser");
    expect(staticQuality).toContain("bun run build");
    expect(staticQuality).toContain("bun run check:extension-output");
    expect(staticQuality).not.toContain("bun run test");

    expect(tests).not.toBeNull();
    expect(tests).toContain("if: inputs.run_tests");
    expect(tests).toContain("fail-fast: false");
    expect(tests).toContain("shard: [1, 2, 3, 4]");
    expect(tests).toContain('bun run test --shard="${SHARD}/4"');
    expect(tests).toContain("--reporter=junit");
    expect(tests).toContain("--reporter-outfile=\"$JUNIT_FILE\"");
    expect(tests).toContain("TEST_EXIT=${PIPESTATUS[0]}");
    expect(tests).toContain("0 fail");
    expect(tests).toContain("if: always()");
    expect(tests).toContain("bun-test-shard-${{ matrix.shard }}.xml");
    expect(tests).toContain("Upload failed test shard log");
    expect(tests).toContain("if: failure()");
    expect(tests).toContain("bun-test-shard-${{ matrix.shard }}.log");
    expect(tests).not.toContain("continue-on-error:");

    expect(publishing).not.toBeNull();
    expect(publishing).toContain("if: inputs.run_astro_platform");
    expect(publishing).toContain("packages/web-publish-astro/src/astro-consumer.test.ts");
    expect(publishing).toContain("packages/web-publish-starlight/src/starlight-renderer.test.ts");
    expect(publishing).toContain('ATLCLI_CONSUMER_SMOKE: "1"');
    expect(publishing).toContain("minimum-astro");
    expect(publishing).toContain("windows-astro");
    expect(publishing).not.toContain("latest-astro-7");

    expect(latest).not.toBeNull();
    expect(latest).toContain("github.event_name == 'schedule'");
    expect(latest).toContain(
      "continue-on-error: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    );

    expect(attestation).not.toBeNull();
    expect(attestation).not.toContain("needs:");
    expect(attestation).toContain("if: inputs.emit_security_attestation");
    expect(attestation).toContain("fetch-depth: 2");
    expect(attestation).toContain("attestation.commit !== process.env.GITHUB_SHA");
    expect(attestation).toContain("security-attestation-${{ github.sha }}");

    expect(complete).toBeNull();
    expect(block(reusable, /^ {2}publishing:\s*$/, 2)).toBeNull();
  });

  it("keeps timing telemetry outside every required status dependency graph", async () => {
    const ci = await workflow("ci.yml");
    const telemetry = block(ci, /^ {2}telemetry:\s*$/, 2);
    const required = block(ci, /^ {2}required:\s*$/, 2);
    expect(telemetry).not.toBeNull();
    expect(telemetry).toContain("name: Non-required CI timing telemetry");
    expect(telemetry).toContain("needs: [changes, required]");
    expect(telemetry).toContain("if: always()");
    expect(telemetry).toContain("actions/download-artifact@v8");
    expect(telemetry).toContain("bun scripts/ci/telemetry-summary.ts");
    expect(required).not.toBeNull();
    expect(required).not.toContain("telemetry");

    for (const statusName of ["required", "draft-fast", "superseded"]) {
      const status = block(ci, new RegExp(`^ {2}${statusName}:\\s*$`), 2);
      if (status !== null) expect(status).not.toMatch(/needs:[^\n]*telemetry/);
    }
  });

  it("keeps duration-aware topology comparisons off pull requests", async () => {
    const comparison = await workflow("ci-topology-canary.yml");
    expect(comparison).not.toContain("pull_request:");
    for (const topology of [
      "general-2x1",
      "general-3x1",
      "general-2x2-workers",
    ]) {
      expect(comparison).toContain(topology);
    }
    expect(comparison).toContain("bun scripts/ci/test-lanes.ts --check");
    expect(comparison).toContain("bun scripts/ci/run-test-lane.ts");
    expect(comparison).toContain("shard: [1, 2, 3, 4]");
    expect(comparison).toContain("if: matrix.poppler");
    expect(comparison).toContain("if: matrix.fonts");
  });

  it("keeps the standalone security attestation dependency-free", async () => {
    const attestation = await workflow("security-attestation.yml");
    const source = await readFile(
      join(REPO_ROOT, "scripts", "security", "attest.ts"),
      "utf8",
    );
    const imports = [
      ...source.matchAll(
        /^\s*import\s+[^;\n]+?\s+from\s+["']([^"']+)["'];?\s*$/gm,
      ),
      ...source.matchAll(
        /^\s*import\(\s*["']([^"']+)["']\s*\)/gm,
      ),
    ].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
    expect(attestation).not.toContain("bun install --frozen-lockfile");
    expect(attestation).toContain("bun scripts/security/attest.ts");
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
