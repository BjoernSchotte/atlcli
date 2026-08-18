import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const workflow = (name: string) => readFile(join(WORKFLOW_DIR, name), "utf8");
const ciScript = (name: string) => readFile(join(REPO_ROOT, "scripts", "ci", name), "utf8");
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
  it("delegates the complete stable product bundle to the reusable artifact workflow", async () => {
    const release = await workflow("release.yml");
    const reusable = await workflow("reusable-release-artifacts.yml");
    expect(release).toContain("uses: ./.github/workflows/reusable-release-artifacts.yml");
    expect(release).toContain("release_attempt: ${{ steps.identity.outputs.release_attempt }}");
    expect(release).toContain('echo "release_attempt=$GITHUB_RUN_ATTEMPT"');
    expect(release).toContain("release_attempt: ${{ fromJSON(needs.resolve.outputs.release_attempt) }}");
    expect(release).toContain("security_attestation_artifact: security-attestation-${{ needs.resolve.outputs.source_sha }}-${{ github.run_id }}-${{ needs.resolve.outputs.release_attempt }}");
    expect(release).toContain("name: ${{ needs.artifacts.outputs.bundle_artifact }}");
    expect(release).toContain("scripts/ci/github-release-transaction.ts create-draft");
    expect(release).toContain("scripts/ci/github-release-transaction.ts download-draft");
    expect(release).toContain("scripts/ci/github-release-transaction.ts publish-draft");
    expect(release).toContain("scripts/ci/github-release-transaction.ts verify-published");
    expect(release).toContain("--channel stable");
    expect(release).not.toContain("softprops/action-gh-release");
    expect(release).not.toContain("source_eligibility_artifact:");

    expect(reusable).toContain("target: [linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64]");
    expect(reusable.match(/bash scripts\/ci\/install-frozen-dependencies\.sh/g)).toHaveLength(3);
    expect(reusable).toContain("bun scripts/release-artifacts.ts build");
    expect(reusable).toContain('--target "${{ matrix.target }}"');
    expect(reusable).toContain("--skip-extension");
    expect(reusable).toContain("--skip-cli");
    expect(reusable).toContain("release_attempt:");
    expect(reusable.match(/--run-attempt \"\$\{\{ inputs\.release_attempt \}\}\"/g)).toHaveLength(3);
    const extensionBuild = block(reusable, /^ {2}build-extension:\s*$/, 2);
    expect(extensionBuild).not.toBeNull();
    expect(extensionBuild).toContain("bun run fonts:ensure");
    expect(extensionBuild!.indexOf("bun run fonts:ensure")).toBeLessThan(
      extensionBuild!.indexOf("bun scripts/release-artifacts.ts build"),
    );
    expect(reusable).toContain("bun scripts/assemble-release-bundle.ts");
    expect(reusable).toContain("bun scripts/verify-release-artifacts.ts --dir bundle");
    expect(reusable).toContain("test:worker-extension-browser:prebuilt");
    for (const suite of ["jobs", "research", "rovo", "palette"]) {
      expect(reusable).not.toContain(`test:${suite}-extension-browser:prebuilt`);
    }
    const cleanup = "bun scripts/verify-release-artifacts.ts cleanup-extension --out bundle/extension";
    expect(reusable).toContain(cleanup);
    expect(reusable.indexOf(cleanup)).toBeLessThan(reusable.indexOf("- name: Upload exact release bundle"));
    expect(reusable).not.toContain("bun build apps/cli/src/index.ts");
    expect(reusable).not.toMatch(/^\s+(?:tar|zip)\s+/m);
  });

  it("prevents cross-run artifact collection and keeps build jobs read-only", async () => {
    const reusable = await workflow("reusable-release-artifacts.yml");
    expect(reusable).toMatch(/permissions:\n\s+contents: read/);
    expect(reusable).toContain("ref: ${{ inputs.source_sha }}");
    expect(reusable).toContain("${{ inputs.source_sha }}-${{ github.run_id }}-${{ inputs.release_attempt }}-cli-${{ matrix.target }}");
    expect(reusable).toContain("${{ inputs.source_sha }}-${{ github.run_id }}-${{ inputs.release_attempt }}-extension");
    expect(reusable).toContain("pattern: release-${{ inputs.channel }}-${{ inputs.source_sha }}-${{ github.run_id }}-${{ inputs.release_attempt }}-cli-*");
    expect(reusable).toContain("name=release-bundle-${{ inputs.channel }}-${{ inputs.source_sha }}-${{ github.run_id }}-${{ inputs.release_attempt }}");
    expect(reusable).toContain("release-verification-${{ inputs.channel }}-${{ inputs.source_sha }}-${{ github.run_id }}-${{ inputs.release_attempt }}");
    expect(reusable).not.toContain("${{ github.run_id }}-${{ github.run_attempt }}-cli-");
    expect(reusable).not.toContain("${{ github.run_id }}-${{ github.run_attempt }}-extension");
    expect(reusable).not.toContain("release-bundle-${{ inputs.channel }}-${{ inputs.source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(reusable).not.toMatch(/download-artifact@v8\n\s+with:\n\s+path:/);
    const fontCacheKey = "key: ${{ runner.os }}-pdf-fonts-v1-${{ hashFiles('packages/pdf/src/runtime-assets.ts', 'packages/pdf/scripts/ensure-fonts.ts') }}";
    expect(reusable.split("- name: Restore pinned PDF fonts")).toHaveLength(3);
    expect(reusable.split("uses: actions/cache@v6")).toHaveLength(3);
    expect(reusable.split(fontCacheKey)).toHaveLength(3);
  });

  it("uses one fail-closed scheduled and manual dev-release graph", async () => {
    const dev = await workflow("dev-release.yml");
    const triggers = block(dev, /^on:\s*$/, 0);
    expect(triggers).not.toBeNull();
    expect(triggers).toContain('cron: "17 2 * * *"');
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("source_sha:");
    expect(triggers).toContain("force_rebuild:");
    expect(triggers).toContain("publish_homebrew:");
    expect(triggers).toContain("rollback_from_tag:");
    expect(triggers).toMatch(/dry_run:\n[\s\S]*?default: true/);
    expect(triggers).not.toContain("pull_request:");
    expect(triggers).not.toContain("pull_request_target:");
    expect(triggers).not.toMatch(/^ {2}push:/m);
    expect(dev).toContain("group: dev-release");
    expect(dev).toContain("cancel-in-progress: false");
    expect(dev).toMatch(/^permissions:\n  contents: read/m);
    for (const name of [
      "resolve-source",
      "publication-decision",
      "eligible-source",
      "verify-published",
    ]) {
      expect(block(dev, new RegExp(`^ {2}${name}:\\s*$`), 2)).not.toContain("contents: write");
    }
    expect(block(dev, /^ {2}create-draft:\s*$/, 2)).toContain("contents: write");
    expect(block(dev, /^ {2}verify-downloaded-draft:\s*$/, 2)).toContain("contents: write");
    expect(block(dev, /^ {2}native-cli-consumer:\s*$/, 2)).toContain("contents: write");
    expect(block(dev, /^ {2}publish-draft:\s*$/, 2)).toContain("contents: write");
    const rollback = block(dev, /^ {2}rollback-unpublished-draft:\s*$/, 2);
    expect(rollback).toContain("contents: write");
    expect(rollback).toContain("always()");
    expect(rollback).toContain("needs.publish-draft.result != 'success'");
    expect(rollback).toContain("github-release-transaction.ts rollback-draft");
    expect(dev).not.toContain("id-token: write");
    expect(dev).not.toContain("attestations: write");
    expect(dev).not.toContain("softprops/action-gh-release");
    expect(dev).not.toContain("nightly-latest");
  });

  it("defaults manual dev releases to a complete mutation-free shadow graph", async () => {
    const dev = await workflow("dev-release.yml");
    const shadow = block(dev, /^ {2}shadow-plan:\s*$/, 2);
    const native = block(dev, /^ {2}shadow-native-cli-consumer:\s*$/, 2);
    const complete = block(dev, /^ {2}shadow-complete:\s*$/, 2);
    expect(shadow).not.toBeNull();
    expect(shadow).toContain("github.event_name == 'workflow_dispatch'");
    expect(shadow).toContain("inputs.dry_run");
    expect(shadow).toContain("permissions:\n      contents: read");
    expect(shadow).toContain("verify-release-artifacts.ts --dir bundle");
    expect(shadow).toContain("dev-release-shadow-plan.ts");
    expect(native).not.toBeNull();
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]) {
      expect(native).toContain(`target: ${target}`);
    }
    expect(native).toContain("verify-native-cli.ts");
    expect(complete).toContain("no tag, release, or Tap formula was written");
    for (const name of [
      "create-draft",
      "verify-downloaded-draft",
      "native-cli-consumer",
      "publish-draft",
      "verify-published",
      "publish-homebrew-dev",
    ]) {
      expect(block(dev, new RegExp(`^ {2}${name}:\\s*$`), 2)).toContain(
        "github.event_name == 'schedule' || inputs.dry_run == false",
      );
    }
  });

  it("ignores the manual UI ref and accepts only a full SHA reachable from origin/main", async () => {
    const dev = await workflow("dev-release.yml");
    const resolve = block(dev, /^ {2}resolve-source:\s*$/, 2);
    expect(resolve).not.toBeNull();
    expect(resolve).toContain("ref: main");
    expect(resolve).toContain("git rev-parse origin/main");
    expect(resolve).toContain('[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]');
    expect(resolve).toContain('git cat-file -e "$source_sha^{commit}"');
    expect(resolve).toContain('git merge-base --is-ancestor "$source_sha" origin/main');
    expect(resolve).toContain('git checkout --detach "$source_sha"');
    expect(resolve).not.toContain("github.ref");
    expect(resolve).toContain('test "$EVENT_NAME" = "workflow_dispatch"');
    expect(resolve).toContain('test -n "$source_sha"');
    expect(resolve).toContain('test "$source_sha" != "$main_sha"');
    expect(resolve).toContain('test "$FORCE_REBUILD" = "true"');
    expect(resolve).toContain('test "$PUBLISH_HOMEBREW" = "true"');
    expect(resolve).toContain('test "$DRY_RUN" = "false"');
    expect(resolve).toContain('[[ "$ROLLBACK_FROM_TAG" =~ ^dev-');
  });

  it("puts no-op inspection and green exact-SHA eligibility before every dev build", async () => {
    const dev = await workflow("dev-release.yml");
    const decision = block(dev, /^ {2}publication-decision:\s*$/, 2);
    const eligibility = block(dev, /^ {2}eligible-source:\s*$/, 2);
    const preflight = block(dev, /^ {2}preflight:\s*$/, 2);
    const artifacts = block(dev, /^ {2}artifacts:\s*$/, 2);
    expect(decision).not.toBeNull();
    expect(decision).toContain("needs: resolve-source");
    expect(decision).toContain("scripts/ci/dev-release-decision.ts");
    expect(decision).toContain('--force-rebuild "${{ inputs.force_rebuild || false }}"');
    expect(eligibility).not.toBeNull();
    expect(eligibility).toContain("needs: [resolve-source, publication-decision]");
    expect(eligibility).toContain("needs.publication-decision.outputs.decision == 'create'");
    expect(eligibility).toContain("actions: read");
    expect(eligibility).toContain("checks: read");
    expect(eligibility).toContain("contents: read");
    expect(eligibility).toContain("scripts/ci/release-eligibility.ts");
    expect(dev).toContain('--run-attempt "${{ needs.resolve-source.outputs.release_attempt }}"');
    expect(eligibility).toContain('--source-sha "${{ needs.resolve-source.outputs.source_sha }}"');
    expect(preflight).not.toBeNull();
    expect(preflight).toContain("needs: [resolve-source, publication-decision, eligible-source]");
    expect(preflight).toContain("source_sha: ${{ needs.resolve-source.outputs.source_sha }}");
    expect(preflight).toContain("run_static_quality: false");
    expect(preflight).toContain("run_tests: false");
    expect(preflight).toContain("run_astro_platform: false");
    expect(preflight).toContain("emit_security_attestation: true");
    expect(preflight).not.toContain("always()");
    expect(artifacts).not.toBeNull();
    expect(artifacts).toContain("needs: [resolve-source, publication-decision, eligible-source, preflight]");
    expect(eligibility).toContain("source-eligibility-${{ needs.resolve-source.outputs.source_sha }}-${{ github.run_id }}-${{ needs.resolve-source.outputs.release_attempt }}");
    expect(artifacts).toContain("security-attestation-${{ needs.resolve-source.outputs.source_sha }}-${{ github.run_id }}-${{ needs.resolve-source.outputs.release_attempt }}");
    expect(artifacts).toContain("source-eligibility-${{ needs.resolve-source.outputs.source_sha }}-${{ github.run_id }}-${{ needs.resolve-source.outputs.release_attempt }}");
    expect(artifacts).not.toContain("security-attestation-${{ needs.resolve-source.outputs.source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(artifacts).not.toContain("source-eligibility-${{ needs.resolve-source.outputs.source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(artifacts).not.toContain("always()");
  });

  it("binds every reusable quality checkout and attestation to the requested source SHA", async () => {
    const reusable = await workflow("reusable-quality.yml");
    const checkouts = reusable.match(/ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/g) ?? [];
    expect(checkouts).toHaveLength(6);
    expect(reusable).toContain("EXPECTED_SOURCE_SHA: ${{ inputs.source_sha || github.sha }}");
    expect(reusable).toContain("attestation.commit !== process.env.EXPECTED_SOURCE_SHA");
    expect(reusable).toContain("security-attestation-${{ inputs.source_sha || github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(reusable).toContain("Validate dev-release evidence schemas and privacy");
    expect(reusable).toContain("bun scripts/ci/dev-release-evidence-policy.ts");
  });

  it("retries only the frozen dependency install in quality and release producers", async () => {
    const quality = await workflow("reusable-quality.yml");
    const release = await workflow("reusable-release-artifacts.yml");
    const installer = await ciScript("install-frozen-dependencies.sh");

    expect(quality.match(/bash scripts\/ci\/install-frozen-dependencies\.sh/g)).toHaveLength(5);
    expect(release.match(/bash scripts\/ci\/install-frozen-dependencies\.sh/g)).toHaveLength(3);
    expect(installer).toContain("for attempt in 1 2 3; do");
    expect(installer).toContain("if bun install --frozen-lockfile; then");
    expect(installer).toContain('if [[ "$attempt" -eq 3 ]]; then');
    expect(installer).toContain('sleep "$((attempt * 5))"');
    expect(installer).not.toContain("bun install --no-progress");
  });

  it("publishes dev only through exclusive draft, downloaded proof, and publish jobs", async () => {
    const dev = await workflow("dev-release.yml");
    expect(dev).toContain("vars.DEV_RELEASE_SCHEDULE_ENABLED == 'true'");
    const create = block(dev, /^ {2}create-draft:\s*$/, 2);
    const verify = block(dev, /^ {2}verify-downloaded-draft:\s*$/, 2);
    const native = block(dev, /^ {2}native-cli-consumer:\s*$/, 2);
    const publish = block(dev, /^ {2}publish-draft:\s*$/, 2);
    const published = block(dev, /^ {2}verify-published:\s*$/, 2);
    expect(create).toContain("needs: [resolve-source, publication-decision, eligible-source, preflight, artifacts]");
    expect(create).toContain("contents: write");
    expect(create).toContain("github-release-transaction.ts create-draft");
    expect(create).toContain("verify-release-artifacts.ts --dir bundle");
    const devVerify = "bun scripts/verify-release-artifacts.ts --dir bundle > pre-upload-verification.json";
    const devCleanup = "bun scripts/verify-release-artifacts.ts cleanup-extension --out bundle/extension";
    expect(create).toContain(devVerify);
    expect(create).toContain(devCleanup);
    expect(create!.indexOf(devVerify)).toBeLessThan(create!.indexOf(devCleanup));
    expect(create!.indexOf(devCleanup)).toBeLessThan(
      create!.indexOf("github-release-transaction.ts create-draft"),
    );
    expect(verify).toContain("contents: write");
    expect(verify).toContain("GitHub exposes draft releases only to repository writers");
    expect(verify).toContain("github-release-transaction.ts download-draft");
    expect(verify).toContain("verify-release-artifacts.ts --dir downloaded");
    expect(verify).toContain("test:worker-extension-browser:prebuilt");
    for (const suite of ["jobs", "research", "rovo", "palette"]) {
      expect(verify).not.toContain(`test:${suite}-extension-browser:prebuilt`);
    }
    for (const [target, runner] of [
      ["linux-x64", "ubuntu-24.04"],
      ["linux-arm64", "ubuntu-24.04-arm"],
      ["darwin-x64", "macos-15-intel"],
      ["darwin-arm64", "macos-15"],
      ["windows-x64", "windows-2025"],
    ]) {
      expect(native).toContain(`target: ${target}`);
      expect(native).toContain(`runner: ${runner}`);
    }
    expect(native).toContain("github-release-transaction.ts download-native-asset");
    expect(native).toContain("verify-native-cli.ts");
    expect(native).toContain("contents: write");
    expect(native).toContain("not present while the downloaded CLI itself executes");
    expect(publish).toContain(
      "needs: [resolve-source, publication-decision, create-draft, verify-downloaded-draft, native-cli-consumer]",
    );
    expect(publish).toContain("contents: write");
    expect(publish).toContain("github-release-transaction.ts publish-draft");
    expect(published).toContain("contents: read");
    expect(published).toContain("github-release-transaction.ts verify-published");
    expect(published).toContain("verify-release-artifacts.ts --dir published-download");
    expect(dev.match(/contents: write/g)).toHaveLength(5);
    expect(dev).not.toContain("--clobber");
    expect(dev).toContain('gh release verify "$DEV_TAG"');
    expect(dev).toContain('gh release verify-asset "$DEV_TAG" published-download/build-metadata.json');
    expect(dev).toContain("github-release-attestation.json");
    expect(dev).toContain("github-release-asset-attestation.json");
    expect(dev).not.toContain("softprops/action-gh-release");
  });

  it("uses the same draft-first release transaction for stable", async () => {
    const stable = await workflow("release.yml");
    const create = block(stable, /^ {2}create-draft:\s*$/, 2);
    expect(create).toContain("contents: write");
    const stableVerify = "bun scripts/verify-release-artifacts.ts --dir release > pre-upload-verification.json";
    const stableCleanup = "bun scripts/verify-release-artifacts.ts cleanup-extension --out release/extension";
    expect(create).toContain(stableVerify);
    expect(create).toContain(stableCleanup);
    expect(create!.indexOf(stableVerify)).toBeLessThan(create!.indexOf(stableCleanup));
    expect(create!.indexOf(stableCleanup)).toBeLessThan(
      create!.indexOf("github-release-transaction.ts create-draft"),
    );
    const verify = block(stable, /^ {2}verify-downloaded-draft:\s*$/, 2);
    expect(verify).toContain("download-draft");
    expect(verify).toContain("test:worker-extension-browser:prebuilt");
    for (const suite of ["jobs", "research", "rovo", "palette"]) {
      expect(verify).not.toContain(`test:${suite}-extension-browser:prebuilt`);
    }
    const native = block(stable, /^ {2}native-cli-consumer:\s*$/, 2);
    expect(native).toContain("download-native-asset");
    expect(native).toContain("verify-native-cli.ts");
    const publish = block(stable, /^ {2}publish-draft:\s*$/, 2);
    expect(publish).toContain("needs: [resolve, create-draft, verify-downloaded-draft, native-cli-consumer]");
    expect(publish).toContain("publish-draft");
    expect(block(stable, /^ {2}verify-published:\s*$/, 2)).toContain("verify-published");
    expect(stable.match(/contents: write/g)).toHaveLength(2);
    expect(stable).not.toContain("--clobber");
    expect(stable).not.toContain("softprops/action-gh-release");
  });

  it("dispatches Homebrew dev only after public proof with a scoped short-lived app token", async () => {
    const dev = await workflow("dev-release.yml");
    const homebrew = block(dev, /^ {2}publish-homebrew-dev:\s*$/, 2);
    expect(homebrew).toContain(
      "needs: [resolve-source, publication-decision, create-draft, verify-published]",
    );
    expect(homebrew).toContain("github.event_name == 'schedule' || inputs.publish_homebrew");
    expect(homebrew).toContain("environment: dev-release");
    expect(homebrew).toContain("ref: main");
    expect(homebrew).not.toContain("ref: ${{ needs.resolve-source.outputs.source_sha }}");
    expect(homebrew).toContain("actions/create-github-app-token@v3");
    expect(homebrew).toContain("app-id: ${{ vars.HOMEBREW_TAP_APP_ID }}");
    expect(homebrew).toContain("private-key: ${{ secrets.HOMEBREW_TAP_APP_PRIVATE_KEY }}");
    expect(homebrew).toContain("repositories: homebrew-tap");
    expect(homebrew).toContain("permission-actions: write");
    expect(homebrew).toContain("permission-contents: read");
    expect(homebrew).toContain("homebrew-dev-dispatch.ts");
    expect(homebrew).toContain('--rollback-from-tag "${{ inputs.rollback_from_tag || \'\' }}"');
    expect(homebrew).toContain("HOMEBREW_TAP_TOKEN: ${{ steps.tap-token.outputs.token }}");
    expect(homebrew).not.toContain("contents: write");
    expect(homebrew).not.toContain("secrets.HOMEBREW_TAP_TOKEN");
    for (const name of [
      "resolve-source",
      "publication-decision",
      "eligible-source",
      "preflight",
      "artifacts",
      "create-draft",
      "verify-downloaded-draft",
      "native-cli-consumer",
      "publish-draft",
      "verify-published",
    ]) {
      expect(block(dev, new RegExp(`^ {2}${name}:\\s*$`), 2)).not.toContain("environment: dev-release");
    }
  });

  it("keeps retention dry-run read-only and rechecks fixed protection pointers before apply", async () => {
    const cleanup = await workflow("dev-release-cleanup.yml");
    const triggers = block(cleanup, /^on:\s*$/, 0);
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("proven_tag:");
    expect(triggers).not.toContain("schedule:");
    expect(cleanup).toMatch(/^permissions:\n  contents: read/m);
    const plan = block(cleanup, /^ {2}plan:\s*$/, 2);
    const apply = block(cleanup, /^ {2}apply:\s*$/, 2);
    expect(plan).not.toContain("contents: write");
    expect(plan).toContain("BjoernSchotte/homebrew-tap/HEAD/metadata/atlcli-dev.json");
    expect(plan).toContain("--retain-successful 14");
    expect(plan).toContain("--retain-days 30");
    expect(apply).toContain("if: inputs.apply && inputs.proven_tag != ''");
    expect(apply).toContain("contents: write");
    expect(apply).toContain('test "$stable_latest" = "$planned_stable"');
    expect(apply).toContain('test "$homebrew_tag" = "$planned_homebrew"');
    expect(apply).toContain('test "$PROVEN_TAG" = "$homebrew_tag"');
    expect(apply).toContain("--expected-plan plan/retention-plan.json");
    expect(apply).toContain("--apply");
  });

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

  it("uses bounded official Chrome for Testing Stable for the NVDA evidence lane", async () => {
    const nvda = await workflow("action-palette-nvda.yml");
    const harness = await readFile(
      join(REPO_ROOT, "apps", "extension", "tests", "palette", "screenreader", "nvda-windows.mjs"),
      "utf8",
    );

    expect(nvda).toContain("last-known-good-versions-with-downloads.json");
    expect(nvda).toContain("ATLCLI_BROWSER_EXECUTABLE_PATH");
    expect(nvda).toContain('ATLCLI_BROWSER_CHANNEL = "chrome-for-testing"');
    expect(nvda).not.toContain("& $chrome --version");
    expect(nvda).not.toContain("Start-Process -Wait -FilePath $nvda -ArgumentList \"--quit\"");
    expect(harness).toContain("NVDA_STAGE_TIMEOUT");
    expect(harness).toContain("process.exit(124)");
    expect(harness).toContain("failed-cleanup");
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

    expect(browser.match(/bun run build:extension/g)).toHaveLength(1);
    expect(browser).not.toContain("bun run --cwd apps/extension build");
    expect(browser).toContain("path: .turbo/cache");
    expect(browser).toContain("--source browser-harness");
    expect(browser).toContain("rm -rf .turbo/runs");
    for (const suite of ["worker", "jobs", "research", "rovo", "palette"]) {
      expect(browser).toContain(`test:${suite}-extension-browser:prebuilt`);
    }
    expect(browser).not.toMatch(/test:(?:worker|jobs|research|rovo|palette)-extension-browser\s*$/m);

    // Local commands remain self-contained; CI alone opts into the prebuilt
    // variants after its one explicit build.
    expect(extension.scripts["pretest:worker-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:jobs-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:rovo-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["pretest:palette-extension-browser"]).toBe("bun run build");
    expect(extension.scripts["test:worker-extension-browser"]).toBe(
      "bun run test:worker-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:jobs-extension-browser"]).toBe(
      "bun run test:jobs-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:rovo-extension-browser"]).toBe(
      "bun run test:rovo-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:palette-extension-browser"]).toBe(
      "bun run test:palette-extension-browser:prebuilt",
    );
    expect(extension.scripts["test:research-extension-browser:prebuilt"]).toContain(
      "../../node_modules/@playwright/test/cli.js",
    );
    expect(extension.scripts["test:research-extension-browser:prebuilt"]).toContain(
      "--conditions=development",
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

  it("uses Node 24 action runtimes and keeps Windows platform lanes cacheless", async () => {
    const ci = await workflow("ci.yml");
    const reusable = await workflow("reusable-quality.yml");
    const workflows = `${ci}\n${reusable}`;
    const windowsSink = block(ci, /^ {2}pdf-sink-windows:\s*$/, 2);
    const windowsAstro = block(reusable, /^ {2}publishing-platform-windows:\s*$/, 2);

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
    expect(windowsAstro).not.toBeNull();
    expect(windowsAstro).not.toContain("Restore Bun package cache");
    expect(windowsAstro).not.toContain("actions/cache@");
  });

  it("keeps required quality branches parallel and removes duplicate publishing and aggregate tails", async () => {
    const reusable = await workflow("reusable-quality.yml");
    const staticQuality = block(reusable, /^ {2}static-quality:\s*$/, 2);
    const tests = block(reusable, /^ {2}tests:\s*$/, 2);
    const publishing = block(reusable, /^ {2}publishing-platform:\s*$/, 2);
    const windows = block(reusable, /^ {2}publishing-platform-windows:\s*$/, 2);
    const latest = block(reusable, /^ {2}publishing-platform-latest:\s*$/, 2);
    const attestation = block(reusable, /^ {2}security-attestation:\s*$/, 2);
    const complete = block(reusable, /^ {2}quality-complete:\s*$/, 2);

    expect(staticQuality).not.toBeNull();
    expect(staticQuality).toContain("if: inputs.run_static_quality");
    expect(staticQuality).toContain("bun run typecheck");
    expect(staticQuality).toContain("bun run check:browser");
    expect(staticQuality).toContain("bun run build");
    expect(staticQuality).toContain("bun run check:extension-output");
    expect(staticQuality).toContain("bun scripts/ci/turbo-run-summary.ts");
    expect(staticQuality).toContain("--source static-quality");
    expect(staticQuality).toContain("turbo-summary-static-quality-");
    expect(staticQuality).toContain("path: .turbo/cache");
    expect(staticQuality).toContain("rm -rf .turbo/runs");
    expect(staticQuality).not.toContain("path: .turbo\n");
    expect(staticQuality).toContain("Validate duration-aware test inventory");
    expect(staticQuality).toContain("Run package contract tests against the warm build");
    expect(staticQuality).toContain("--group package-contract");
    expect(staticQuality).toContain("bun-test-junit-package-contract-${{ inputs.source_sha || github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(staticQuality!.indexOf("- name: Build")).toBeLessThan(
      staticQuality!.indexOf("Run package contract tests against the warm build"),
    );

    expect(tests).not.toBeNull();
    expect(tests).toContain("if: inputs.run_tests");
    expect(tests).toContain("fail-fast: false");
    for (const group of ["general-1", "general-2", "general-3", "pdf-typst"]) {
      expect(tests).toContain(`group: ${group}`);
    }
    expect(tests).toContain("bun scripts/ci/run-test-lane.ts");
    expect(tests).toContain("--topology general-3x1");
    expect(tests).toContain('if: matrix.poppler');
    expect(tests).toContain('if: matrix.fonts');
    expect(tests).not.toContain("fonts: false");
    expect(tests).not.toContain("--parallel=2");
    expect(tests).toContain("TEST_EXIT=${PIPESTATUS[0]}");
    expect(tests).toContain("0 fail");
    expect(tests).toContain("if: always()");
    expect(tests).toContain("bun-test-junit-${{ matrix.group }}-${{ inputs.source_sha || github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(tests).toContain("bun-test-${{ matrix.group }}.xml");
    expect(tests).toContain("Upload failed test lane log");
    expect(tests).toContain("if: failure()");
    expect(tests).toContain("bun-test-${{ matrix.group }}.log");
    expect(tests).not.toContain("continue-on-error:");

    expect(publishing).not.toBeNull();
    expect(publishing).toContain("if: inputs.run_astro_platform");
    expect(publishing).toContain("packages/web-publish-astro/src/astro-consumer.test.ts");
    expect(publishing).toContain("packages/web-publish-starlight/src/starlight-renderer.test.ts");
    expect(publishing).toContain('ATLCLI_CONSUMER_SMOKE: "1"');
    expect(publishing).toContain("minimum-astro");
    expect(publishing).not.toContain("windows-latest");
    expect(publishing).not.toContain("latest-astro-7");

    expect(windows).not.toBeNull();
    expect(windows).toContain("runs-on: windows-latest");
    expect(windows).toContain("github.event_name == 'schedule'");
    expect(windows).toContain("github.ref_type == 'tag'");
    expect(windows).toContain(
      "continue-on-error: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(windows).toContain("packages/web-publish-astro/src/astro-consumer.test.ts");
    expect(windows).toContain("packages/web-publish-starlight/src/starlight-renderer.test.ts");

    expect(latest).not.toBeNull();
    expect(latest).toContain("github.event_name == 'schedule'");
    expect(latest).toContain(
      "continue-on-error: ${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    );

    expect(attestation).not.toBeNull();
    expect(attestation).not.toContain("needs:");
    expect(attestation).toContain("if: inputs.emit_security_attestation");
    expect(attestation).toContain("fetch-depth: 2");
    expect(attestation).toContain("attestation.commit !== process.env.EXPECTED_SOURCE_SHA");
    expect(attestation).toContain("security-attestation-${{ inputs.source_sha || github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");

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
    expect(telemetry).toContain("pattern: bun-test-junit-*-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(telemetry).toContain("pattern: turbo-summary-*-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(telemetry).toContain("--turbo turbo-results");
    expect(telemetry).toContain("'general-3x1'");
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
    expect(comparison).toContain("actions/download-artifact@v8");
    expect(comparison).toContain("bun scripts/ci/test-timings.ts compare");
    expect(comparison).toContain("--legacy-namespace legacy-4-shard");
    expect(comparison).toContain("Prove exact identity, outcomes, and timing");
    expect(comparison).toContain("topology-comparison-${{ needs.plan.outputs.topology }}");
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
    expect(source).toContain(
      'const SECURITY_ATTESTATION_SCHEMA_ID = "atlcli.security-attestation/v1" as const;',
    );
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
    expect(release).toMatch(/resolve:[\s\S]*needs: preflight/);
    expect(release).toMatch(/artifacts:[\s\S]*needs: resolve/);
  });
});
