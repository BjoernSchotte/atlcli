import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface DigestEntry {
  path: string;
  sha256: string;
  bytes?: number;
}

interface QualityManifest {
  authoringSources: DigestEntry[];
  fixtures: DigestEntry[];
}

const manifestPath = resolve(import.meta.dir, "manifest.json");

async function digest(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(resolve(import.meta.dir, path));
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export async function updateManifest(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as QualityManifest;
  for (const source of manifest.authoringSources) {
    source.sha256 = (await digest(source.path)).sha256;
  }
  for (const fixture of manifest.fixtures) {
    const calculated = await digest(fixture.path);
    fixture.sha256 = calculated.sha256;
    fixture.bytes = calculated.bytes;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  await updateManifest();
  process.stdout.write("updated neutral PDF quality fixture manifest\n");
}
