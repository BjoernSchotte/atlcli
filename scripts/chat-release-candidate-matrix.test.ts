import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1,
  finalizeChatReleaseCandidateProofV1,
  finalizeChatReleaseCandidateRunV1,
  fingerprintChatReleaseCandidateManifestV1,
  parseChatReleaseCandidateMatrixV1,
  type ChatReleaseCandidateProofV1,
} from "../packages/research/src/chat-agent/release-candidate-matrix.js";
import {
  parseChatReleaseCandidateMatrixArgumentsV1,
  runChatReleaseCandidateMatrixV1,
} from "./chat-release-candidate-matrix.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("release-candidate matrix CLI", () => {
  test("accepts one explicit receipt and rejects ambiguous input", () => {
    expect(parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt",
      "/private/tmp/release-candidate-matrix.json",
    ])).toEqual({ kind: "validate", receiptPath: "/private/tmp/release-candidate-matrix.json" });
    expect(parseChatReleaseCandidateMatrixArgumentsV1([
      "--output", "/private/tmp/release-candidate-matrix.json",
      "--proof", "/private/tmp/runtime-proof.json",
      "--proof", "/private/tmp/packed-proof.json",
    ])).toEqual({
      kind: "assemble",
      outputPath: "/private/tmp/release-candidate-matrix.json",
      proofPaths: ["/private/tmp/runtime-proof.json", "/private/tmp/packed-proof.json"],
    });
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([])).toThrow("Usage");
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt", "/private/tmp/a.json", "extra",
    ])).toThrow("Usage");
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt", "relative/matrix.json",
    ])).toThrow("absolute");
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([
      "--output", "/private/tmp/matrix.json",
      "--proof", "/private/tmp/proof.json",
      "--proof", "/private/tmp/proof.json",
    ])).toThrow("unique");
  });

  test("returns non-zero for an incomplete receipt", async () => {
    const path = `/private/tmp/chat-release-candidate-${crypto.randomUUID()}.json`;
    await Bun.write(path, JSON.stringify({
      schema: "atlcli.chat-release-candidate-matrix/v1",
      generatedAt: "2026-08-09T12:00:00.000Z",
      proofs: [],
    }));
    const original = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await runChatReleaseCandidateMatrixV1(["--receipt", path])).toBe(1);
    } finally {
      console.log = original;
      console.error = originalError;
      await Bun.file(path).delete();
    }
  });

  test("assembles and validates one passing revision-bound receipt from all proof inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlcli-chat-release-matrix-"));
    temporaryDirectories.push(directory);
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
    }).trim();
    const manifestFingerprint = await fingerprintChatReleaseCandidateManifestV1();
    const producedAt = new Date().toISOString();
    const proofs: ChatReleaseCandidateProofV1[] = [];

    for (const requirement of CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1) {
      const pairs = requirement.requiredRuns ?? requirement.requiredCaseIds!.flatMap((caseId) =>
        requirement.requiredVariants.map((variant) => ({ caseId, variant }))
      );
      const runs = await Promise.all(pairs.map(async ({ caseId, variant }) =>
        finalizeChatReleaseCandidateRunV1({
          schema: "atlcli.chat-release-candidate-run/v1",
          caseId,
          variant,
          status: "passed",
          checks: requirement.requiredChecks.map((check) => ({ check, status: "passed" as const })),
          failureCodes: [],
          measurements: {
            durationMs: 1,
            ...(requirement.maximumCostMicros ? { costMicros: 1 } : {}),
          },
        })
      ));
      proofs.push(await finalizeChatReleaseCandidateProofV1({
        proofId: requirement.proofId,
        producer: requirement.producer,
        producedAt,
        sourceRevision,
        manifestFingerprint,
        runs,
      }));
    }

    const proofPaths: string[] = [];
    for (const proof of proofs) {
      const path = join(directory, `${proof.proofId}.json`);
      await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
      proofPaths.push(path);
    }
    const outputPath = join(directory, "matrix.json");
    const original = console.log;
    console.log = () => {};
    try {
      expect(await runChatReleaseCandidateMatrixV1([
        "--output", outputPath,
        ...proofPaths.flatMap((path) => ["--proof", path]),
      ])).toBe(0);
    } finally {
      console.log = original;
    }
    const matrix = parseChatReleaseCandidateMatrixV1(JSON.parse(await readFile(outputPath, "utf8")));
    expect(matrix.proofs).toHaveLength(CHAT_RELEASE_CANDIDATE_REQUIREMENTS_V1.length);
    expect(matrix.proofs.map((proof) => proof.proofId)).toEqual(
      [...matrix.proofs.map((proof) => proof.proofId)].sort(),
    );
  });
});
