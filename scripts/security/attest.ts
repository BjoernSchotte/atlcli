#!/usr/bin/env bun
/**
 * HEAD-bound security attestation artifact (spec 011, PDF/UA + Security).
 *
 * Emits `security-attestation.json`: a small, machine-checkable summary of the
 * security-relevant state of ONE commit, produced on every push to `main` and
 * on release tags (`.github/workflows/security-attestation.yml`) and uploaded
 * as a CI artifact. A future release-gate job can `needs:` on it instead of
 * re-deriving the same facts.
 *
 * ## The one design rule: never attest to something unverified
 *
 * Every field is either a fact this script actually established, or `null`.
 * `null` means "not determined in this environment" and is NEVER collapsed to
 * `false`/`true` for convenience — an attestation whose fields silently degrade
 * to a passing-looking value is worse than no attestation, because a reader
 * cannot tell a real check from an absent one. `checks[]` records, per field,
 * why it holds the value it does. This matters most today, when the veraPDF
 * binary is not yet pinned or available on any runner: the honest output is
 * `veraPdfDigestOk: null` with a stated reason, not `true`.
 *
 * ## Relationship to spec 009
 *
 * 009-package-publishing owns the canonical release sign-off schema; this
 * object is that schema's embedded `security` sub-object, not a competing file
 * (spec 011 PLAN, "HEAD-bound security attestation artifact"). Registry publish
 * — and with it 009's schema — is deferred pending the product-rename decision,
 * so this artifact stands alone for now and is NOT wired as a hard publish
 * gate. What prevents an npm publish today is 009's fail-closed publish
 * classification, not this file.
 *
 * Run: `bun scripts/security/attest.ts [--out <path>] [--review-note <text>]`
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");

const VERAPDF_BASELINE = "scripts/verapdf/baseline.json";
const VERAPDF_LOCK = resolve(REPO_ROOT, "scripts/verapdf/verapdf.lock.json");
const M1_ACCEPTANCE = resolve(REPO_ROOT, "scripts/bench/out/m1-acceptance.json");

/**
 * The conformance page whose "known rule gaps" section describes the baseline.
 * The 011 plan requires the two to move together ("update the page in the same
 * PR whenever the baseline changes"); {@link checkBaselineDocsSync} is the
 * enforcement that rule otherwise lacks.
 */
const ACCESSIBILITY_DOCS = "src/content/docs/reference/pdf-accessibility.md";

/** Default `securityReviewNote` when the caller supplies none. */
export const DEFAULT_REVIEW_NOTE =
  "T4.7 security review scope: SVG active-content policy, template/font archive " +
  "budgets, link-scheme policy, compiler execution budget. See the security " +
  "review section of CONTRIBUTING and the spec 011 PLAN.";

/**
 * A single determination, so a reader can distinguish "checked and passed"
 * from "could not check" without reading this source file.
 */
export interface AttestationCheck {
  field: string;
  status: "ok" | "failed" | "indeterminate";
  detail: string;
}

/** Baseline movement between the previous commit and HEAD. */
export interface VeraPdfBaselineDelta {
  /** Baseline keys (`fixture::ruleId`) present at HEAD but not at the parent. */
  added: string[];
  /** Keys present at the parent but gone at HEAD (the baseline shrank). */
  removed: string[];
  /** Keys whose `failureCount`/`locationsDigest` changed. */
  changed: string[];
}

export interface SecurityAttestation {
  /** The commit this attestation is bound to. */
  commit: string;
  /** The commit's own committer date (ISO 8601) — reproducible, unlike "now". */
  date: string;
  /** Whether the pinned veraPDF binary matched its recorded sha256. */
  veraPdfDigestOk: boolean | null;
  /** How the veraPDF baseline moved in this commit. */
  veraPdfBaselineDelta: VeraPdfBaselineDelta | null;
  securityReviewNote: string;
  /** Whether the M1 acceptance run passed (both engines byte-deterministic). */
  m1AcceptanceOk: boolean | null;
  checks: AttestationCheck[];
}

function git(args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Diff two veraPDF baselines. Pure so the delta logic is testable without a
 * repository — the git plumbing that supplies the two sides is separate.
 */
export function diffBaselines(
  before: Record<string, { failureCount?: number; locationsDigest?: string }>,
  after: Record<string, { failureCount?: number; locationsDigest?: string }>
): VeraPdfBaselineDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(after)) {
    const prior = before[key];
    if (!prior) {
      added.push(key);
      continue;
    }
    const now = after[key]!;
    if (prior.failureCount !== now.failureCount || prior.locationsDigest !== now.locationsDigest) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push(key);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Verify the veraPDF binary against its recorded sha256 pin.
 *
 * `null` (indeterminate) when either side is missing — the lock file has not
 * been authored yet (it needs a runner that actually has veraPDF), and no local
 * binary means nothing to hash. Neither absence is evidence of a good digest.
 */
export function checkVeraPdfDigest(options: {
  lockPath?: string;
  /** Injectable for tests; defaults to a `which verapdf` lookup. */
  resolveBinary?: () => string | null;
} = {}): { ok: boolean | null; detail: string } {
  const lock = readJson(options.lockPath ?? VERAPDF_LOCK) as { sha256?: string; path?: string } | null;
  if (!lock?.sha256) {
    return {
      ok: null,
      detail:
        "no scripts/verapdf/verapdf.lock.json with a sha256 pin — the pin is authored on a runner " +
        "that has veraPDF (spec 011 PDF/UA, still pending); nothing to verify against",
    };
  }
  const resolveBinary =
    options.resolveBinary ??
    (() => {
      const found = Bun.spawnSync(["which", "verapdf"], { stderr: "pipe" });
      return found.exitCode === 0 ? found.stdout.toString().trim() : null;
    });
  const binary = resolveBinary();
  if (!binary || !existsSync(binary)) {
    return { ok: null, detail: "veraPDF binary not present on this runner; digest not verifiable here" };
  }
  const actual = sha256(readFileSync(binary));
  return actual === lock.sha256
    ? { ok: true, detail: `veraPDF binary at ${binary} matches the pinned sha256` }
    : { ok: false, detail: `veraPDF binary sha256 ${actual} does NOT match the pinned ${lock.sha256}` };
}

/**
 * Read Lane-D's M1 acceptance record if a prior CI step produced one.
 *
 * Deliberately reads the artifact rather than running the corpus: an
 * attestation script that also ran a multi-minute benchmark would conflate
 * "recording a result" with "producing one", and a flaky compile would then
 * look like a failed attestation.
 */
export function readM1Acceptance(path = M1_ACCEPTANCE): { ok: boolean | null; detail: string } {
  const record = readJson(path) as
    | { docx?: { cli?: { deterministic?: boolean } }; pdf?: { cli?: { deterministic?: boolean } } }
    | null;
  if (!record) {
    return {
      ok: null,
      detail: `no M1 acceptance record at ${path.replace(REPO_ROOT + "/", "")} — run \`bun run bench:m1\` first`,
    };
  }
  const docx = record.docx?.cli?.deterministic;
  const pdf = record.pdf?.cli?.deterministic;
  if (typeof docx !== "boolean" || typeof pdf !== "boolean") {
    return { ok: null, detail: "M1 acceptance record is present but has no determinism verdicts" };
  }
  return {
    ok: docx && pdf,
    detail: `M1 acceptance: DOCX deterministic=${docx}, PDF deterministic=${pdf}`,
  };
}

/**
 * Enforce the plan's "update the page in the same PR whenever the baseline
 * changes" rule (spec 011). Pure over the two facts, so the policy is testable
 * without a repository.
 *
 * Only a MOVED baseline can fail this: an unchanged baseline says nothing about
 * whether the docs needed touching, so it stays `ok`.
 */
export function checkBaselineDocsSync(input: {
  delta: VeraPdfBaselineDelta | null;
  /** Repo-relative paths changed by the commit under attestation. */
  changedFiles: string[] | null;
}): { status: AttestationCheck["status"]; detail: string } {
  if (!input.delta) return { status: "indeterminate", detail: "no baseline delta to check against" };
  const moved =
    input.delta.added.length + input.delta.removed.length + input.delta.changed.length;
  if (moved === 0) return { status: "ok", detail: "veraPDF baseline unchanged — no docs update owed" };
  if (!input.changedFiles) {
    return { status: "indeterminate", detail: "could not list this commit's changed files" };
  }
  return input.changedFiles.includes(ACCESSIBILITY_DOCS)
    ? { status: "ok", detail: `baseline moved and ${ACCESSIBILITY_DOCS} was updated with it` }
    : {
        status: "failed",
        detail:
          `the veraPDF baseline moved (${moved} key(s)) but ${ACCESSIBILITY_DOCS} was not updated — ` +
          "its 'Known veraPDF rule gaps' section now describes a baseline that no longer exists",
      };
}

/** Baseline delta between HEAD and its first parent. */
export function veraPdfBaselineDeltaForHead(): { delta: VeraPdfBaselineDelta | null; detail: string } {
  const head = readJson(resolve(REPO_ROOT, VERAPDF_BASELINE)) as Record<string, never> | null;
  if (!head) return { delta: null, detail: "scripts/verapdf/baseline.json is absent or unparseable" };
  const parentRaw = git(["show", `HEAD~1:${VERAPDF_BASELINE}`]);
  if (parentRaw === null) {
    // A root commit, a shallow clone, or the file not existing at HEAD~1.
    return {
      delta: null,
      detail: "no HEAD~1 copy of scripts/verapdf/baseline.json (root/shallow commit, or newly added)",
    };
  }
  let parent: Record<string, never>;
  try {
    parent = JSON.parse(parentRaw);
  } catch {
    return { delta: null, detail: "HEAD~1 copy of the veraPDF baseline is unparseable" };
  }
  const delta = diffBaselines(parent, head);
  const total = delta.added.length + delta.removed.length + delta.changed.length;
  return {
    delta,
    detail:
      total === 0
        ? "veraPDF baseline unchanged in this commit"
        : `veraPDF baseline moved: +${delta.added.length} / -${delta.removed.length} / ~${delta.changed.length}`,
  };
}

export function buildAttestation(options: { reviewNote?: string } = {}): SecurityAttestation {
  const checks: AttestationCheck[] = [];

  const commit = git(["rev-parse", "HEAD"]) ?? "unknown";
  // The commit's own date, not wall-clock: re-running this script on the same
  // commit must produce the same bytes, or the artifact cannot be compared.
  const date = git(["show", "-s", "--format=%cI", "HEAD"]) ?? new Date(0).toISOString();

  const digest = checkVeraPdfDigest();
  checks.push({
    field: "veraPdfDigestOk",
    status: digest.ok === null ? "indeterminate" : digest.ok ? "ok" : "failed",
    detail: digest.detail,
  });

  const baseline = veraPdfBaselineDeltaForHead();
  checks.push({
    field: "veraPdfBaselineDelta",
    status: baseline.delta === null ? "indeterminate" : "ok",
    detail: baseline.detail,
  });

  // The plan's own rule that otherwise had no enforcement: a moved baseline
  // must be accompanied by a docs update, or the conformance page silently
  // describes rule gaps that no longer match reality.
  const docsSync = checkBaselineDocsSync({
    delta: baseline.delta,
    changedFiles: git(["diff", "--name-only", "HEAD~1", "HEAD"])?.split("\n").filter(Boolean) ?? null,
  });
  checks.push({ field: "veraPdfBaselineDocsSync", status: docsSync.status, detail: docsSync.detail });

  const m1 = readM1Acceptance();
  checks.push({
    field: "m1AcceptanceOk",
    status: m1.ok === null ? "indeterminate" : m1.ok ? "ok" : "failed",
    detail: m1.detail,
  });

  return {
    commit,
    date,
    veraPdfDigestOk: digest.ok,
    veraPdfBaselineDelta: baseline.delta,
    securityReviewNote: options.reviewNote ?? DEFAULT_REVIEW_NOTE,
    m1AcceptanceOk: m1.ok,
    checks,
  };
}

/**
 * Exit code policy: a determined FAILURE (a digest mismatch, a failed M1 run)
 * exits non-zero; an indeterminate field never does. The artifact is a record,
 * not a gate — but it must not stay silent about a check that actually failed.
 */
export function hasDeterminedFailure(attestation: SecurityAttestation): boolean {
  return attestation.checks.some((check) => check.status === "failed");
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const out = resolve(REPO_ROOT, argValue("--out") ?? "security-attestation.json");
  const reviewNote = argValue("--review-note");
  const attestation = buildAttestation(reviewNote ? { reviewNote } : {});
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(attestation, null, 2)}\n`);
  for (const check of attestation.checks) {
    process.stdout.write(`attest: ${check.field} = ${check.status} (${check.detail})\n`);
  }
  process.stdout.write(`attest: wrote ${out} for commit ${attestation.commit.slice(0, 12)}\n`);
  if (hasDeterminedFailure(attestation)) {
    process.stdout.write("attest: at least one check FAILED\n");
    process.exit(1);
  }
}
