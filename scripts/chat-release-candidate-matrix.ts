import { isAbsolute, resolve } from "node:path";
import {
  evaluateChatReleaseCandidateMatrixV1,
} from "../packages/research/src/chat-agent/release-candidate-matrix.js";

export interface ChatReleaseCandidateMatrixArgumentsV1 {
  receiptPath: string;
}

export function parseChatReleaseCandidateMatrixArgumentsV1(
  argv: readonly string[],
): ChatReleaseCandidateMatrixArgumentsV1 {
  if (argv.length !== 2 || argv[0] !== "--receipt" || !argv[1]?.trim()) {
    throw new Error(
      "Usage: bun scripts/chat-release-candidate-matrix.ts --receipt /absolute/path/to/matrix.json",
    );
  }
  if (!isAbsolute(argv[1])) {
    throw new Error("--receipt must be an absolute path.");
  }
  const receiptPath = resolve(argv[1]);
  return { receiptPath };
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
    const value = await Bun.file(args.receiptPath).json();
    const result = await evaluateChatReleaseCandidateMatrixV1(value, {
      expectedSourceRevision: await readCurrentSourceRevisionV1(),
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
