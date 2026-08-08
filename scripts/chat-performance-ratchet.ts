import {
  evaluateChatPerformanceRatchetV1,
  type ChatPerformanceRatchetPolicyV1,
} from "../packages/research/src/chat-agent/performance-ratchet.js";

interface ArgumentsV1 {
  beforePath: string;
  afterPath: string;
  policy: ChatPerformanceRatchetPolicyV1;
}

function nonNegativeInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

export function parseChatPerformanceRatchetArgumentsV1(argv: readonly string[]): ArgumentsV1 {
  const paths: string[] = [];
  const policy: ChatPerformanceRatchetPolicyV1 = {
    minimumCallReduction: 1,
    minimumFreshInputReductionPermille: 0,
    minimumDurationReductionPermille: 0,
    maximumFreshInputRegressionPermille: 100,
    maximumDurationRegressionPermille: 100,
  };
  const flags: Record<string, keyof ChatPerformanceRatchetPolicyV1> = {
    "--minimum-call-reduction": "minimumCallReduction",
    "--minimum-fresh-input-reduction-permille": "minimumFreshInputReductionPermille",
    "--minimum-duration-reduction-permille": "minimumDurationReductionPermille",
    "--maximum-fresh-input-regression-permille": "maximumFreshInputRegressionPermille",
    "--maximum-duration-regression-permille": "maximumDurationRegressionPermille",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const target = flags[argument];
    if (target) {
      policy[target] = nonNegativeInteger(argv[index + 1], argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    paths.push(argument);
  }
  if (paths.length !== 2) {
    throw new Error("Usage: bun scripts/chat-performance-ratchet.ts BEFORE.json AFTER.json [options]");
  }
  return { beforePath: paths[0]!, afterPath: paths[1]!, policy };
}

export async function runChatPerformanceRatchetV1(argv: readonly string[]): Promise<number> {
  const args = parseChatPerformanceRatchetArgumentsV1(argv);
  const [before, after] = await Promise.all([
    Bun.file(args.beforePath).json(),
    Bun.file(args.afterPath).json(),
  ]);
  const result = evaluateChatPerformanceRatchetV1(before, after, args.policy);
  console.log(JSON.stringify(result, null, 2));
  return result.accepted ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runChatPerformanceRatchetV1(Bun.argv.slice(2));
