import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
const renderKit = resolve(spikeRoot, "render-kit");
const template = resolve(spikeRoot, "packed-consumer");
const temp = await mkdtemp(join(tmpdir(), "atlcli-astro-packed-consumer-"));
const tarballs = resolve(temp, "tarballs");
const consumer = resolve(temp, "consumer");
await mkdir(tarballs);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const packOutput = run("bun", ["pm", "pack", "--destination", tarballs], renderKit);
const tarballLine = packOutput.split(/\r?\n/u).find((line) => line.trim().endsWith(".tgz"));
if (!tarballLine) throw new Error(`render-kit pack did not report a tarball\n${packOutput}`);
const tarball = tarballLine.trim();
const listing = run("tar", ["-tzf", tarball], temp).split(/\r?\n/u).filter(Boolean);
if (listing.some((entry) => entry.includes("/src/"))) throw new Error("packed render kit contains src/");

await cp(template, consumer, { recursive: true });
const packagePath = resolve(consumer, "package.json");
const packageText = await readFile(packagePath, "utf8");
await writeFile(packagePath, packageText.replace("__ATLCLI_RENDER_KIT_TARBALL__", `../tarballs/${basename(tarball)}`));

run("bun", ["install"], consumer);
run("bun", ["run", "build"], consumer);

const html = await readFile(resolve(consumer, "dist/index.html"), "utf8");
for (const expected of [
  "Block model coverage",
  "Sizing matrix",
  "Dense table warning",
  "Legacy code header",
  "Preserved widget body.",
  "data-packed-consumer-override",
  "Safe external link",
  "Blocked unsafe link",
  "Template placeholder",
  "Inline media fallback",
  "Smart card proof",
  "Ordered from three",
  "Expanded details",
  "Layout column one",
  "Image unavailable proof",
  "Media file fallback",
  "Quoted content",
  "Unsupported inline content: futureInline",
  "Unsupported block: futureBlock",
  "data-atlcli-inline=\"unsafe-link\"",
  "--atlcli-content-accent:#6d28d9",
  "dir=\"ltr\"",
]) {
  if (!html.includes(expected)) throw new Error(`packed consumer output is missing ${expected}`);
}
for (const forbiddenHtml of ["javascript:alert(1)", "private-id"]) {
  if (html.includes(forbiddenHtml)) throw new Error(`packed consumer output leaked ${forbiddenHtml}`);
}
for (const forbidden of ["@astrojs/starlight", "@atlcli/confluence", "authorization", "node:fs"]) {
  if (listing.some((entry) => entry.toLowerCase().includes(forbidden))) {
    throw new Error(`packed render kit contains forbidden surface ${forbidden}`);
  }
}

console.log(JSON.stringify({
  schema: "atlcli.astro-packed-consumer-proof/1-t0",
  consumerDependencies: ["@atlcli/export-blocks-astro", "astro"],
  packedFiles: listing,
  output: "dist/index.html",
  temp: "<private>",
}, null, 2));
