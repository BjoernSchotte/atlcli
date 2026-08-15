import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  evaluateChatReleaseCandidateMatrixV1,
  finalizeChatReleaseCandidateMatrixV1,
  fingerprintChatReleaseCandidateManifestV1,
  parseChatReleaseCandidateProofV1,
} from "../packages/research/src/chat-agent/release-candidate-matrix.js";

export type ChatReleaseCandidateMatrixArgumentsV1 =
  | { kind: "validate"; receiptPath: string }
  | { kind: "assemble"; outputPath: string; proofPaths: string[] };

function absolutePath(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new Error(`${option} requires an absolute path.`);
  if (!isAbsolute(value)) throw new Error(`${option} must be an absolute path.`);
  return resolve(value);
}

export function parseChatReleaseCandidateMatrixArgumentsV1(
  argv: readonly string[],
): ChatReleaseCandidateMatrixArgumentsV1 {
  if (argv.length === 2 && argv[0] === "--receipt") {
    return { kind: "validate", receiptPath: absolutePath(argv[1], "--receipt") };
  }

  let outputPath: string | undefined;
  const proofPaths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--output") outputPath = absolutePath(value, "--output");
    else if (option === "--proof") proofPaths.push(absolutePath(value, "--proof"));
    else {
      throw new Error(
        "Usage: bun scripts/chat-release-candidate-matrix.ts --output /absolute/path/to/matrix.json --proof /absolute/path/to/proof.json [--proof ...]",
      );
    }
    index += 1;
  }
  if (!outputPath || proofPaths.length === 0) {
    throw new Error(
      "Usage: bun scripts/chat-release-candidate-matrix.ts --output /absolute/path/to/matrix.json --proof /absolute/path/to/proof.json [--proof ...]",
    );
  }
  if (new Set(proofPaths).size !== proofPaths.length) {
    throw new Error("--proof paths must be unique.");
  }
  return { kind: "assemble", outputPath, proofPaths };
}

async function readCurrentSourceRevisionV1(): Promise<string> {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Unable to resolve current source revision: ${stderr.trim()}`);
  return stdout.trim();
}

export async function runChatReleaseCandidateMatrixV1(
  argv: readonly string[],
): Promise<number> {
  try {
    const args = parseChatReleaseCandidateMatrixArgumentsV1(argv);
    const sourceRevision = await readCurrentSourceRevisionV1();
    const value = args.kind === "validate"
      ? await Bun.file(args.receiptPath).json()
      : await (async () => {
          const proofs = await Promise.all(args.proofPaths.map(async (path) =>
            parseChatReleaseCandidateProofV1(await Bun.file(path).json())
          ));
          const matrix = await finalizeChatReleaseCandidateMatrixV1({
            generatedAt: new Date().toISOString(),
            sourceRevision,
            manifestFingerprint: await fingerprintChatReleaseCandidateManifestV1(),
            proofs,
          });
          await writeFile(args.outputPath, `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600 });
          return matrix;
        })();
    const result = await evaluateChatReleaseCandidateMatrixV1(value, {
      expectedSourceRevision: sourceRevision,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runChatReleaseCandidateMatrixV1(Bun.argv.slice(2));
}
