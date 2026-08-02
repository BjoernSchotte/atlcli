import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experience = process.argv[2] ?? "starlight";
const spikeRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = resolve(spikeRoot, `sites/${experience}/dist`);
const manifestPath = process.argv[3]
  ? resolve(process.cwd(), process.argv[3])
  : resolve(spikeRoot, `evidence/${experience}-final-manifest.json`);
const bundlePath = process.env.ATLCLI_T0_BUNDLE
  ? resolve(process.env.ATLCLI_T0_BUNDLE)
  : resolve(spikeRoot, "fixtures/publication.json");

async function filesUnder(root) {
  const result = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  await walk(root);
  return result.sort();
}

const files = await filesUnder(outputRoot);
const output = [];
for (const absolute of files) {
  const bytes = await readFile(absolute);
  output.push({
    path: relative(outputRoot, absolute).split("\\").join("/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const forbiddenPwaFiles = output
  .map((entry) => entry.path)
  .filter((path) => /(^|\/)(?:manifest\.webmanifest|sw\.js|service-worker\.js)$/u.test(path));
if (forbiddenPwaFiles.length > 0) {
  throw new Error(`V1 emitted deferred PWA files: ${forbiddenPwaFiles.join(", ")}`);
}

const bundleBytes = await readFile(bundlePath);
const bundle = JSON.parse(bundleBytes.toString("utf8"));
const pagefindEntryPath = resolve(outputRoot, "pagefind/pagefind-entry.json");
const pagefind = experience === "starlight"
  ? JSON.parse(await readFile(pagefindEntryPath, "utf8"))
  : null;
const searchLanguages = pagefind
  ? Object.fromEntries(Object.entries(pagefind.languages)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, value]) => [language, {
        wasm: value.wasm,
        pageCount: value.page_count,
      }]))
  : null;
const pages = output
  .map((entry) => entry.path)
  .filter((path) => path === "404.html" || path === "index.html" || path.endsWith("/index.html"))
  .map((path) => path === "index.html" ? "/" : path === "404.html" ? "/404" : `/${path.slice(0, -"index.html".length)}`)
  .sort();

const semantic = {
  schema: "atlcli.static-publication-manifest/1-t0",
  experience,
  base: "/docs/",
  bundle: {
    schema: bundle.schema,
    revision: bundle.revision,
    sha256: createHash("sha256").update(bundleBytes).digest("hex"),
  },
  pages,
  search: pagefind && {
    provider: "pagefind",
    version: pagefind.version,
    languages: searchLanguages,
  },
  pwa: "deferred-not-emitted",
};
const manifest = {
  ...semantic,
  semanticDigest: createHash("sha256").update(JSON.stringify(semantic)).digest("hex"),
  artifactDigest: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
  output,
};

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  manifest: relative(spikeRoot, manifestPath).split("\\").join("/"),
  semanticDigest: manifest.semanticDigest,
  artifactDigest: manifest.artifactDigest,
  pages: pages.length,
  outputFiles: output.length,
  searchLanguages: pagefind ? Object.keys(pagefind.languages).sort() : [],
  pwa: manifest.pwa,
}, null, 2));
