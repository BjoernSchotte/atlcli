import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "src", "styles.css");
const destination = resolve(packageRoot, "dist", "styles.css");
const componentSource = resolve(packageRoot, "src", "components");
const componentDestination = resolve(packageRoot, "dist", "components");

await mkdir(dirname(destination), { recursive: true });
await rm(destination, { force: true });
await cp(source, destination);
await rm(componentDestination, { recursive: true, force: true });
await cp(componentSource, componentDestination, { recursive: true });
