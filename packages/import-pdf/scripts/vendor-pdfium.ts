#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PDFIUM_PACKAGE_VERSION = "2.15.1";
export const PDFIUM_RELEASE_COMMIT = "176ec6daac51458c9e80733b9c92a66a3bc5e2d1";
export const PDFIUM_FORK_COMMIT = "73a041a5c1aaffa09ebb64f1981ff501cb91a41c";
export const PDFIUM_WASM_SHA256 = "5e4cd023c3dad4a895b3571ca573d3fc51bac6de48360d95283134385b954eaa";
export const PDFIUM_WASM_BYTES = 4_646_932;
export const PDFIUM_NPM_INTEGRITY = "sha512-qDH4gEkGSQT0iM+07Hpm3LyvoB7PEFbW3Qyk6+LPkEYLJYfHagkHM1OzYlDq2EDOhJRguykTkzdMOT3/w27x5Q==";

const THIRD_PARTY_NOTICES = `# PDFium import runtime notices

AtlCLI distributes the exact WebAssembly binary from
\`@embedpdf/pdfium@2.15.1\`. The JavaScript wrapper is MIT-licensed; its
license is in \`LICENSE\`. PDFium is BSD-licensed and the package also carries
the Apache License 2.0 text; both are in \`LICENSE.pdfium\`.

Reviewed source identities:

- wrapper release: https://github.com/embedpdf/embed-pdf-viewer/releases/tag/v2.15.1
- wrapper release commit: \`176ec6daac51458c9e80733b9c92a66a3bc5e2d1\`
- PDFium fork input: https://github.com/embedpdf/pdfium/tree/73a041a5c1aaffa09ebb64f1981ff501cb91a41c

The upstream npm artifact does not include an SBOM or a complete transitive
third-party notice inventory. Production release review must reconcile the
PDFium fork's dependency/license inventory and security-fix lineage; this file
does not claim that the missing upstream materials exist.
`;

export const VENDOR_DIR = fileURLToPath(new URL("../vendor/", import.meta.url));
export const VENDORED_WASM = join(VENDOR_DIR, "pdfium.wasm");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"))));
}

export function verifyVendoredPdfium(vendorDir: string = VENDOR_DIR): void {
  const wasmPath = join(vendorDir, "pdfium.wasm");
  const licensePath = join(vendorDir, "LICENSE");
  const pdfiumLicensePath = join(vendorDir, "LICENSE.pdfium");
  const provenancePath = join(vendorDir, "PROVENANCE.json");
  const noticesPath = join(vendorDir, "THIRD_PARTY_NOTICES.md");
  for (const path of [wasmPath, licensePath, pdfiumLicensePath, provenancePath, noticesPath]) {
    if (!existsSync(path)) throw new Error(`vendor-pdfium: missing ${path}`);
  }
  const wasm = readFileSync(wasmPath);
  if (wasm.byteLength !== PDFIUM_WASM_BYTES || sha256(wasm) !== PDFIUM_WASM_SHA256) {
    throw new Error("vendor-pdfium: WASM size or digest mismatch");
  }
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
  if (
    provenance.schema !== "atlcli.pdfium-vendor-provenance/1" ||
    provenance.packageVersion !== PDFIUM_PACKAGE_VERSION ||
    provenance.npmIntegrity !== PDFIUM_NPM_INTEGRITY ||
    provenance.releaseCommit !== PDFIUM_RELEASE_COMMIT ||
    provenance.pdfiumForkCommit !== PDFIUM_FORK_COMMIT ||
    provenance.wasmSha256 !== PDFIUM_WASM_SHA256 ||
    provenance.noticeInventory !== "THIRD_PARTY_NOTICES.md"
  ) {
    throw new Error("vendor-pdfium: provenance does not match the reviewed identity tuple");
  }
  if (readFileSync(noticesPath, "utf8") !== THIRD_PARTY_NOTICES) {
    throw new Error("vendor-pdfium: third-party notice inventory drifted");
  }
}

export function ensureVendoredPdfium(): { vendorDir: string; refreshed: boolean } {
  try {
    verifyVendoredPdfium();
    return { vendorDir: VENDOR_DIR, refreshed: false };
  } catch {
    // Recreate only from the exact installed dependency, then verify.
  }
  const root = sourceRoot();
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
    license?: string;
  };
  if (manifest.version !== PDFIUM_PACKAGE_VERSION || manifest.license !== "MIT") {
    throw new Error(
      `vendor-pdfium: installed package identity changed (${manifest.version ?? "unknown"}, ${manifest.license ?? "unknown"})`,
    );
  }
  mkdirSync(VENDOR_DIR, { recursive: true });
  writeFileSync(VENDORED_WASM, readFileSync(join(root, "dist", "pdfium.wasm")));
  writeFileSync(join(VENDOR_DIR, "LICENSE"), readFileSync(join(root, "LICENSE")));
  writeFileSync(join(VENDOR_DIR, "LICENSE.pdfium"), readFileSync(join(root, "LICENSE.pdfium")));
  writeFileSync(join(VENDOR_DIR, "THIRD_PARTY_NOTICES.md"), THIRD_PARTY_NOTICES);
  writeFileSync(join(VENDOR_DIR, "PROVENANCE.json"), `${JSON.stringify({
    schema: "atlcli.pdfium-vendor-provenance/1",
    package: "@embedpdf/pdfium",
    packageVersion: PDFIUM_PACKAGE_VERSION,
    npmIntegrity: PDFIUM_NPM_INTEGRITY,
    releaseTag: "v2.15.1",
    releaseCommit: PDFIUM_RELEASE_COMMIT,
    pdfiumForkCommit: PDFIUM_FORK_COMMIT,
    wasmBytes: PDFIUM_WASM_BYTES,
    wasmSha256: PDFIUM_WASM_SHA256,
    buildFacts: { emscripten: "3.1.70", v8: false, xfa: false },
    noticeInventory: "THIRD_PARTY_NOTICES.md",
    gaps: ["upstream transitive third-party notice reconciliation", "SBOM", "fully reproducible source build"],
  }, null, 2)}\n`);
  verifyVendoredPdfium();
  return { vendorDir: VENDOR_DIR, refreshed: true };
}

if (import.meta.main) {
  const result = ensureVendoredPdfium();
  console.log(
    result.refreshed
      ? `vendor-pdfium: vendored ${PDFIUM_PACKAGE_VERSION} into ${result.vendorDir}`
      : `vendor-pdfium: verified ${PDFIUM_PACKAGE_VERSION} in ${result.vendorDir}`,
  );
}
