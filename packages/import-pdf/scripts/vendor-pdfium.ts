#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PDFIUM_PACKAGE_VERSION = "2.15.0";
export const PDFIUM_RELEASE_COMMIT = "2cf7df3b594dfe46de2d85e6973ff50ea447a1ed";
export const PDFIUM_FORK_COMMIT = "cb29e78f2ba00c9298714d5f4a8bf7765f1e802f";
export const PDFIUM_WASM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8";
export const PDFIUM_WASM_BYTES = 4_633_788;
export const PDFIUM_NPM_INTEGRITY = "sha512-KgpRND2MYcdbhzb2EMb4WzWcJYrR0A6JXvhMv4WthEHKt6qmNo2v/MC68bpYvpveYT9GNnUnY/+TG5MpXY3pRw==";

const THIRD_PARTY_NOTICES = `# PDFium import runtime notices

AtlCLI distributes the exact WebAssembly binary from
\`@embedpdf/pdfium@2.15.0\`. The JavaScript wrapper is MIT-licensed; its
license is in \`LICENSE\`. PDFium is BSD-licensed and the package also carries
the Apache License 2.0 text; both are in \`LICENSE.pdfium\`.

Reviewed source identities:

- wrapper release: https://github.com/embedpdf/embed-pdf-viewer/releases/tag/v2.15.0
- wrapper release commit: \`2cf7df3b594dfe46de2d85e6973ff50ea447a1ed\`
- PDFium fork input: https://github.com/embedpdf/pdfium/tree/cb29e78f2ba00c9298714d5f4a8bf7765f1e802f

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
    releaseTag: "v2.15.0",
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
