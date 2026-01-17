import { OutputOptions, output } from "@atlcli/core";

const REPO_URL = "https://github.com/BjoernSchotte/atlcli";

export async function handleHelloworld(
  _args: string[],
  _flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  output(`Hello dear user, thank you that you use me! Star me at ${REPO_URL}`, opts);
}
