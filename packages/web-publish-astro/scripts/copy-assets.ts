import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "dist", "components");
await mkdir(dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(resolve(root, "src", "components"), destination, { recursive: true });
