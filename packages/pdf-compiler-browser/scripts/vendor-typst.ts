#!/usr/bin/env bun
/**
 * Vendor the PATCHED typst.ts wasm glue into this package (spec 009,
 * Special cases).
 *
 * Why vendoring: the repo hardens `@myriaddreamin/typst-ts-web-compiler`'s
 * wasm-bindgen glue via Bun `patchedDependencies` (replacing both
 * `new Function(...)` call sites with an allowlist that throws on any
 * unexpected dynamic function body — no `unsafe-eval`). That patch mechanism
 * only exists for THIS repo's install: an external consumer installing the
 * package from a tarball would silently get the unpatched, eval-carrying
 * glue. Vendoring the patched files into `@atlcli/pdf-compiler-browser`
 * fails closed: consumers always receive the patched glue.
 *
 * Why `vendor/` is NOT committed to git: the wasm is ~28 MB — committing it
 * (and re-committing on every typst.ts upgrade) would permanently bloat the
 * repository. Instead this script reproduces `vendor/` deterministically from
 * the repo's installed (already-patched) node_modules, pinned by sha256. It
 * runs as part of this package's `build` and `prepack`, so both the turbo
 * build graph and packed tarballs always contain a verified copy. The
 * regeneration source therefore stays: the `@myriaddreamin/...` devDependency
 * plus the root `patchedDependencies` entry / `patches/` file.
 *
 * NOTE: upstream's `pkg/wasm-pack-shim.mjs` is deliberately NOT vendored —
 * it contains its own `new Function('m', 'return import(m)')` escape hatch
 * (Node-only wasm loading). Our compiler imports the glue module directly
 * and passes wasm bytes/URLs explicitly, so the shim is dead weight with an
 * eval-shaped footgun.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The pinned upstream version — must match the devDependency and the patch. */
export const TYPST_UPSTREAM_VERSION = "0.7.0";

/** Marker string the CSP patch injects into both hardened call sites. */
export const PATCH_MARKER = "Blocked unexpected dynamic function";

/** Minimum number of marker occurrences expected in the patched glue. */
export const PATCH_MARKER_COUNT = 2;

export const VENDOR_DIR = fileURLToPath(
  new URL("../vendor/typst-ts-web-compiler/", import.meta.url),
);
export const VENDORED_PKG_DIR = join(VENDOR_DIR, "pkg");
export const VENDORED_MJS = join(VENDORED_PKG_DIR, "typst_ts_web_compiler.mjs");
export const VENDORED_WASM = join(VENDORED_PKG_DIR, "typst_ts_web_compiler_bg.wasm");

/**
 * sha256 pins. The `.mjs` pin is the hash of the PATCHED glue (upstream file
 * after `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch`); the
 * wasm is upstream-pristine. Re-vendoring a new typst.ts version means
 * re-validating the patch against the new glue and updating these pins.
 */
export const TYPST_VENDOR_PINS: Readonly<Record<string, string>> = Object.freeze({
  "typst_ts_web_compiler.mjs":
    "245e8dd52ce65c7249f5f082f20b60c7a53a5ba3c2a9ee7b4fcbd366a7315d3e",
  "typst_ts_web_compiler_bg.wasm":
    "1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd",
});

/** Files copied from upstream `pkg/` (wasm-pack-shim.mjs deliberately excluded). */
export const TYPST_VENDOR_FILES = [
  "typst_ts_web_compiler.mjs",
  "typst_ts_web_compiler.d.ts",
  "typst_ts_web_compiler_bg.wasm",
  "typst_ts_web_compiler_bg.wasm.d.ts",
] as const;

const NOTICE_TEXT = `typst.ts web compiler (typst_ts_web_compiler)
Copyright (c) Myriad-Dreamin and the typst.ts contributors
https://github.com/Myriad-Dreamin/typst.ts

Upstream package: @myriaddreamin/typst-ts-web-compiler@${TYPST_UPSTREAM_VERSION}
License: Apache-2.0 (see the LICENSE file in this directory).

Local modification (atlcli spec 009 / CSP hardening): the wasm-bindgen glue
(typst_ts_web_compiler.mjs) is patched to replace both dynamic
\`new Function(...)\` call sites with a static allowlist of the closures the
wasm actually requests; any unexpected dynamic function body throws
("${PATCH_MARKER} ..."). See
patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch in the atlcli
repository for the exact diff. upstream's pkg/wasm-pack-shim.mjs is not
redistributed (it carries its own dynamic-import escape hatch and is unused
by this package).
`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify an existing vendor directory: files present, patch markers present
 * in the glue, sha256 pins matching. Throws with a precise message otherwise.
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
      const actual = sha256(readFileSync(path));
      if (actual !== pin) {
        throw new Error(
          `vendor-typst: sha256 mismatch for ${path}: expected ${pin}, got ${actual}. ` +
            `The vendored copy is stale or tampered — re-run the vendor script (and if the ` +
            `upstream version changed, re-validate the patch and update TYPST_VENDOR_PINS).`,
        );
      }
    }
  }

  const glue = readFileSync(join(pkgDir, "typst_ts_web_compiler.mjs"), "utf8");
  const markers = glue.split(PATCH_MARKER).length - 1;
  if (markers < PATCH_MARKER_COUNT) {
    throw new Error(
      `vendor-typst: patched glue must contain the CSP patch marker "${PATCH_MARKER}" at least ` +
        `${PATCH_MARKER_COUNT} times, found ${markers} — the vendored glue is NOT the patched build.`,
    );
  }
  if (glue.includes("new Function(")) {
    throw new Error(
      `vendor-typst: vendored glue still contains a "new Function(" call site — patch not applied.`,
    );
  }

  for (const name of ["LICENSE", "NOTICE"]) {
    if (!existsSync(join(vendorDir, name))) {
      throw new Error(`vendor-typst: missing ${name} in ${vendorDir} — run the vendor script.`);
    }
  }
}

export interface EnsureVendoredTypstResult {
  vendorDir: string;
  refreshed: boolean;
}

/**
 * Idempotently (re)produce `vendor/typst-ts-web-compiler/` from the repo's
 * installed, patched `@myriaddreamin/typst-ts-web-compiler` and verify it.
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
  if (upstreamManifest.version !== TYPST_UPSTREAM_VERSION) {
    throw new Error(
      `vendor-typst: installed @myriaddreamin/typst-ts-web-compiler is ` +
        `${upstreamManifest.version}, expected ${TYPST_UPSTREAM_VERSION}. Update the pins and ` +
        `re-validate the patch before vendoring a new version.`,
    );
  }
  if (upstreamManifest.license !== "Apache-2.0") {
    throw new Error(
      `vendor-typst: upstream license changed (${upstreamManifest.license}) — review before vendoring.`,
    );
  }

  const sourceGlue = readFileSync(sourceMjs, "utf8");
  if (sourceGlue.split(PATCH_MARKER).length - 1 < PATCH_MARKER_COUNT) {
    throw new Error(
      `vendor-typst: the installed upstream glue does not carry the CSP patch — ` +
        `run \`bun install\` at the repo root so patchedDependencies applies ` +
        `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch first.`,
    );
  }

  mkdirSync(VENDORED_PKG_DIR, { recursive: true });
  for (const name of TYPST_VENDOR_FILES) {
    writeFileSync(join(VENDORED_PKG_DIR, name), readFileSync(join(sourcePkgDir, name)));
  }

  // Apache-2.0 license text: upstream's npm tarball ships none, but both the
  // upstream project and this repo are Apache-2.0 — reuse the repo root
  // LICENSE (the exact file the extension/harness already bundle as the
  // compiler license, see PDF_RUNTIME_ASSETS.compilerLicense).
  const repoRootLicense = fileURLToPath(new URL("../../../LICENSE", import.meta.url));
  writeFileSync(join(VENDOR_DIR, "LICENSE"), readFileSync(repoRootLicense));
  writeFileSync(join(VENDOR_DIR, "NOTICE"), NOTICE_TEXT);

  verifyVendoredTypst();
  return { vendorDir: VENDOR_DIR, refreshed: true };
}

if (import.meta.main) {
  const { vendorDir, refreshed } = await ensureVendoredTypst();
  console.log(
    refreshed
      ? `vendor-typst: vendored patched typst.ts ${TYPST_UPSTREAM_VERSION} into ${vendorDir}`
      : `vendor-typst: verified existing vendored typst.ts ${TYPST_UPSTREAM_VERSION} in ${vendorDir}`,
  );
}
