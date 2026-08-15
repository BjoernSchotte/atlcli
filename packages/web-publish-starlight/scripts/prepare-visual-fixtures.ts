import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(packageRoot, "../..");

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (await process.exited !== 0) throw new Error(`Failed: ${command.join(" ")}`);
}

await run(["bun", "run", "build", "--filter=@atlcli/export-blocks-astro"], workspaceRoot);
await run(["bun", "run", "build", "--filter=@atlcli/web-publish-starlight"], workspaceRoot);
await run(["bun", "run", "build"], resolve(packageRoot, "fixtures/starlight"));
await run(["bun", "run", "build"], resolve(packageRoot, "fixtures/plain-experience"));
