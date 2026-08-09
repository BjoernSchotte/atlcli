import { resolve } from "node:path";
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
  const receiptPath = resolve(argv[1]);
  if (!receiptPath.startsWith("/")) {
    throw new Error("--receipt must resolve to an absolute path.");
  }
  return { receiptPath };
}

export async function runChatReleaseCandidateMatrixV1(
  argv: readonly string[],
): Promise<number> {
  const args = parseChatReleaseCandidateMatrixArgumentsV1(argv);
  const value = await Bun.file(args.receiptPath).json();
  const result = evaluateChatReleaseCandidateMatrixV1(value);
  console.log(JSON.stringify(result, null, 2));
  return result.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await runChatReleaseCandidateMatrixV1(Bun.argv.slice(2));
}
