import { rm } from "node:fs/promises";
import { join } from "node:path";

/** Prepare registry metadata with this Bun version, then prove a clean offline install. */
export async function installPackedConsumerOffline(
  directory: string,
  run: (command: string[], cwd: string) => Promise<unknown>,
): Promise<void> {
  // A frozen workspace install caches tarballs, but need not cache the registry
  // manifests needed by a new consumer (Bun 1.4 enforces --offline strictly).
  await run(["bun", "install", "--ignore-scripts"], directory);
  await rm(join(directory, "node_modules"), { recursive: true, force: true });
  await run(["bun", "install", "--offline", "--frozen-lockfile"], directory);
}
