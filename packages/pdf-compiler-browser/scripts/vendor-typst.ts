#!/usr/bin/env bun
/**
 * Vendor the provenance-bound typst.ts fork distribution into this package.
 *
 * The fork removes dynamic function construction at its Rust/WASM binding
 * source, so atlcli no longer patches generated JavaScript. Vendoring still
 * makes the exact direct glue, WASM, declarations, licence, and provenance
 * available to every packed consumer without resolving a runtime dependency.
 *
 * Why `vendor/` is NOT committed to git: the wasm is ~28 MB — committing it
 * (and re-committing on every typst.ts upgrade) would permanently bloat the
 * repository. Instead this script reproduces `vendor/` deterministically from
 * the repo's installed (already-patched) node_modules, pinned by sha256. It
 * runs as part of this package's `build` and `prepack`, so both the turbo
 * build graph and packed tarballs always contain a verified copy. The
 * regeneration source therefore stays the immutable fork package selected by
 * the `@myriaddreamin/...` devDependency.
 *
 * NOTE: upstream's `pkg/wasm-pack-shim.mjs` is deliberately NOT vendored —
 * it contains a dynamic-import escape hatch. Our compiler imports the glue
 * directly and passes WASM bytes/URLs explicitly.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TYPST_PACKAGE_VERSION = "0.8.0-rc3.typst0151.1";
export const TYPST_TS_SOURCE_COMMIT = "2ff4a660328415013d739fe69e12b2f06f12ed82";
export const TYPST_CORE_VERSION = "0.15.1";
export const TYPST_CORE_COMMIT = "301531fcfc4cb7ba9d688aa8a0738e8a6372c122";

export const VENDOR_DIR = fileURLToPath(
  new URL("../vendor/typst-ts-web-compiler/", import.meta.url),
);
export const VENDORED_PKG_DIR = join(VENDOR_DIR, "pkg");
export const VENDORED_MJS = join(VENDORED_PKG_DIR, "typst_ts_web_compiler.mjs");
export const VENDORED_WASM = join(VENDORED_PKG_DIR, "typst_ts_web_compiler_bg.wasm");

/**
 * SHA-256 pins copied from the fork package's PROVENANCE.json. Re-vendoring a
 * new fork commit requires reviewing the source delta and updating all pins.
 */
export const TYPST_VENDOR_PINS: Readonly<Record<string, string>> = Object.freeze({
  "typst_ts_web_compiler.mjs":
    "542926574dc2659de3fcb34b3e286f8aa1fc42f7a91d19d6e0fd2a123bf3753a",
  "typst_ts_web_compiler.d.ts":
    "0e9c80a098df748d1a3a40b0485e51f98808d78e7a7851b8414f436379661cb9",
  "typst_ts_web_compiler_bg.wasm":
    "39d2ce3cda6cc41ed267a8dd641a358785bca65c99df39bdd55574f7f688cd27",
  "typst_ts_web_compiler_bg.wasm.d.ts":
    "3a54e348147d1704a07832f0fa5ab6ade4a0f7b2ac5cd17520214a30e4d4b6b7",
});

/** Files copied from upstream `pkg/` (wasm-pack-shim.mjs deliberately excluded). */
export const TYPST_VENDOR_FILES = [
  "typst_ts_web_compiler.mjs",
  "typst_ts_web_compiler.d.ts",
  "typst_ts_web_compiler_bg.wasm",
  "typst_ts_web_compiler_bg.wasm.d.ts",
] as const;

interface ForkProvenance {
  schema?: string;
  source?: { repository?: string; commit?: string; upstreamBase?: string };
  typstCore?: { officialVersion?: string; forkCommit?: string };
  files?: Record<string, { sha256?: string }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether a vendored file is binary (must never be line-ending normalized).
 * Only the wasm is binary; the glue/`.d.ts` companions are text.
 */
function isBinaryVendorFile(name: string): boolean {
  return name.endsWith(".wasm");
}

/**
 * LF-normalize the bytes of a TEXT vendored file so the pinned sha256 is
 * platform-independent. If an extracted package carries CRLF on Windows —
 * e.g. a contributor with `core.autocrlf=true` — the bytes would otherwise
 * differ from the fork package's LF-computed pin.
 * Normalizing on BOTH write and hash makes the shipped file and the pin LF on
 * every platform. The wasm is binary and is returned byte-for-byte untouched.
 * The source package and its provenance remain the authority for the pins.
 */
export function normalizeVendorBytes(name: string, bytes: Uint8Array): Uint8Array {
  if (isBinaryVendorFile(name)) return bytes;
  const normalized = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
  return new Uint8Array(Buffer.from(normalized, "utf8"));
}

/**
 * Verify an existing vendor directory: exact files and provenance present,
 * SHA-256 pins matching, and no executable string-to-code constructs.
 */
export function verifyVendoredTypst(vendorDir: string = VENDOR_DIR): void {
  const pkgDir = join(vendorDir, "pkg");
  for (const name of TYPST_VENDOR_FILES) {
    const path = join(pkgDir, name);
    if (!existsSync(path)) {
      throw new Error(`vendor-typst: missing vendored file ${path} — run the vendor script.`);
    }
    const pin = TYPST_VENDOR_PINS[name];
    if (pin) {
      const actual = sha256(normalizeVendorBytes(name, readFileSync(path)));
      if (actual !== pin) {
        throw new Error(
          `vendor-typst: sha256 mismatch for ${path}: expected ${pin}, got ${actual}. ` +
            `The vendored copy is stale or tampered — re-run the vendor script (and if the ` +
            `fork artifact changed, review its source and update TYPST_VENDOR_PINS).`,
        );
      }
    }
  }

  const glue = readFileSync(join(pkgDir, "typst_ts_web_compiler.mjs"), "utf8");
  const bannedExecutableForms: ReadonlyArray<readonly [string, RegExp]> = [
    ["new Function", /\bnew\s+Function\s*\(/],
    ["direct Function call", /(?:^|[=(:,;]\s*)Function\s*\(/m],
    ["eval", /(?:^|[^\w$.])eval\s*\(/m],
  ];
  for (const [name, pattern] of bannedExecutableForms) {
    if (pattern.test(glue)) {
      throw new Error(`vendor-typst: vendored glue contains banned ${name}.`);
    }
  }
  if (glue.includes("new URL('typst_ts_web_compiler_bg.wasm', import.meta.url)")) {
    throw new Error("vendor-typst: vendored glue implicitly locates the WASM binary.");
  }

  for (const name of ["LICENSE", "NOTICE", "PROVENANCE.json"]) {
    if (!existsSync(join(vendorDir, name))) {
      throw new Error(`vendor-typst: missing ${name} in ${vendorDir} — run the vendor script.`);
    }
  }
  if (existsSync(join(pkgDir, "wasm-pack-shim.mjs"))) {
    throw new Error("vendor-typst: wasm-pack-shim.mjs must not be redistributed.");
  }

  const provenance = JSON.parse(
    readFileSync(join(vendorDir, "PROVENANCE.json"), "utf8"),
  ) as ForkProvenance;
  if (
    provenance.schema !== "typst-ts.web-compiler-package-provenance/1" ||
    provenance.source?.repository !== "https://github.com/BjoernSchotte/typst.ts" ||
    provenance.source.commit !== TYPST_TS_SOURCE_COMMIT ||
    provenance.typstCore?.officialVersion !== TYPST_CORE_VERSION ||
    provenance.typstCore.forkCommit !== TYPST_CORE_COMMIT
  ) {
    throw new Error("vendor-typst: fork provenance does not match the pinned source/runtime.");
  }
  for (const [name, expected] of Object.entries(TYPST_VENDOR_PINS)) {
    if (provenance.files?.[`pkg/${name}`]?.sha256 !== expected) {
      throw new Error(`vendor-typst: provenance hash for ${name} does not match its pin.`);
    }
  }
}

export interface EnsureVendoredTypstResult {
  vendorDir: string;
  refreshed: boolean;
}

/**
 * Idempotently (re)produce `vendor/typst-ts-web-compiler/` from the repo's
 * installed fork distribution and verify it.
 */
export async function ensureVendoredTypst(): Promise<EnsureVendoredTypstResult> {
  try {
    verifyVendoredTypst();
    return { vendorDir: VENDOR_DIR, refreshed: false };
  } catch {
    // fall through and (re)vendor
  }

  // Resolve the installed (patched) upstream package from this package's
  // context — it is a devDependency of @atlcli/pdf-compiler-browser.
  const sourceMjs = fileURLToPath(
    import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs"),
  );
  const sourcePkgDir = dirname(sourceMjs);
  const sourceRoot = dirname(sourcePkgDir);

  const upstreamManifest = JSON.parse(
    readFileSync(join(sourceRoot, "package.json"), "utf8"),
  ) as { version?: string; license?: string };
  if (upstreamManifest.version !== TYPST_PACKAGE_VERSION) {
    throw new Error(
      `vendor-typst: installed @myriaddreamin/typst-ts-web-compiler is ` +
        `${upstreamManifest.version}, expected ${TYPST_PACKAGE_VERSION}. Review the fork delta and ` +
        `update the source and artifact pins before vendoring a new version.`,
    );
  }
  if (upstreamManifest.license !== "Apache-2.0") {
    throw new Error(
      `vendor-typst: upstream license changed (${upstreamManifest.license}) — review before vendoring.`,
    );
  }

  mkdirSync(VENDORED_PKG_DIR, { recursive: true });
  for (const name of TYPST_VENDOR_FILES) {
    // LF-normalize text files (leave WASM untouched) so the vendored copy
    // matches the fork provenance on every platform.
    writeFileSync(
      join(VENDORED_PKG_DIR, name),
      normalizeVendorBytes(name, readFileSync(join(sourcePkgDir, name))),
    );
  }

  for (const name of ["LICENSE", "NOTICE", "PROVENANCE.json"]) {
    writeFileSync(join(VENDOR_DIR, name), readFileSync(join(sourceRoot, name)));
  }

  verifyVendoredTypst();
  return { vendorDir: VENDOR_DIR, refreshed: true };
}

if (import.meta.main) {
  const { vendorDir, refreshed } = await ensureVendoredTypst();
  console.log(
    refreshed
      ? `vendor-typst: vendored fork package ${TYPST_PACKAGE_VERSION} into ${vendorDir}`
      : `vendor-typst: verified fork package ${TYPST_PACKAGE_VERSION} in ${vendorDir}`,
  );
}
