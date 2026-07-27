import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDF_RUNTIME_ASSETS } from "@atlcli/pdf/browser";
import {
  scanHarnessOutput,
  scanHarnessText,
  validateHarnessInventory,
  type OutputArtifact,
} from "../scripts/check-output.js";

describe("harness output content policy", () => {
  it.each([
    ["Node specifier", `import x from "node:os";`],
    ["Bun specifier", `require("bun:sqlite")`],
    ["Buffer global", `Buffer.from("x")`],
    ["process global", `process.env.SECRET`],
    ["CommonJS require", `require("left-pad")`],
    ["dynamic Function", `new Function("return 1")`],
    ["eval", `eval("1")`],
    ["remote import", `import "https://cdn.example/runtime.js"`],
    ["remote Worker", `new Worker("https://cdn.example/runtime.js")`],
    ["extension API", `chrome.runtime.sendMessage({})`],
    ["extension URL", `"chrome-extension://abc/page.html"`],
    ["WXT runtime", `import "wxt/browser"`],
    ["extension message", `"pdf:compile"`],
    ["root-relative HTML", `<script src="/assets/app.js"></script>`],
    ["root-relative CSS", `url(/assets/font.ttf)`],
    ["root-relative Worker", `new Worker("/assets/worker.js")`],
    ["root-relative asset literal", `const wasm = "/assets/compiler.wasm"`],
    ["Oniguruma engine", `findNextOnigScannerMatch(scanner, input)`],
    ["Oniguruma WASM loader", `throw new Error("Must invoke loadWasm first.")`],
    ["aggregate Shiki singleton", `const marker = bundle_full_exports`],
    ["aggregate Shiki language map", `import "shiki/langs"`],
    ["aggregate Shiki theme map", `import "shiki/themes"`],
  ])("rejects %s", (_label, source) => {
    expect(scanHarnessText(source).length).toBeGreaterThan(0);
  });

  it("allows local relative assets and non-executable document links", () => {
    expect(scanHarnessText(`import "./app.js"; const pdfLink = "https://atlcli.sh/";`)).toEqual([]);
  });

  it("allows Node keyword names inside an inert Shiki grammar payload", () => {
    const grammar =
      'Object.freeze(JSON.parse(`{"scopeName":"source.coffee","match":"__filename|__dirname"}`))';
    expect(scanHarnessText(grammar)).toEqual([]);
  });

  it("names the exact built file containing a seeded leak", () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-harness-scan-"));
    try {
      writeFileSync(join(root, "entry.js"), `new Worker("/assets/worker.js")`);
      const findings = scanHarnessOutput(root);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("entry.js");
      expect(findings[0]!.findings.some((finding) => finding.includes("/assets/worker.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function completeInventory(): OutputArtifact[] {
  const artifacts: OutputArtifact[] = [
    { path: "index.html", size: 100 },
    { path: "assets/pdf-worker-abc.js", size: 100 },
    { path: "assets/typst_ts_web_compiler_bg-abc.wasm", size: 25_000_000 },
    {
      path: "assets/JetBrainsMono-Regular-abc.ttf",
      size: 273_900,
      sha256: "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f",
    },
  ];
  for (const font of PDF_RUNTIME_ASSETS.fonts) {
    const extension = font.fileName.slice(font.fileName.lastIndexOf("."));
    const stem = font.fileName.slice(0, -extension.length);
    artifacts.push({ path: `assets/${stem}-abc${extension}`, size: 100, sha256: font.sha256 });
  }
  for (const license of PDF_RUNTIME_ASSETS.licenses) {
    const extension = license.fileName.slice(license.fileName.lastIndexOf("."));
    const stem = license.fileName.slice(0, -extension.length);
    artifacts.push({ path: `assets/${stem}-abc${extension}`, size: 100 });
  }
  artifacts.push({ path: "assets/LICENSE-abc", size: 100 });
  return artifacts;
}

describe("harness runtime inventory", () => {
  it("accepts one complete manifest-matching runtime", () => {
    expect(validateHarnessInventory(completeInventory())).toEqual([]);
  });

  it("names a missing font and a checksum mismatch", () => {
    const [font] = PDF_RUNTIME_ASSETS.fonts;
    const missing = completeInventory().filter((artifact) => !artifact.path.includes(font!.fileName.split(".")[0]!));
    expect(validateHarnessInventory(missing).join("\n")).toContain(font!.fileName);

    const tampered = completeInventory().map((artifact) =>
      artifact.path.includes(font!.fileName.split(".")[0]!) ? { ...artifact, sha256: "tampered" } : artifact,
    );
    expect(validateHarnessInventory(tampered).join("\n")).toContain("SHA-256");
  });

  it("requires one pinned DOCX code font", () => {
    const missing = completeInventory().filter(
      (artifact) => !artifact.path.includes("JetBrainsMono-Regular"),
    );
    expect(validateHarnessInventory(missing).join("\n")).toContain("DOCX code font");

    const duplicate = [
      ...completeInventory(),
      {
        path: "assets/JetBrainsMono-Regular-duplicate.ttf",
        size: 273_900,
        sha256: "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f",
      },
    ];
    expect(validateHarnessInventory(duplicate).join("\n")).toContain(
      "expected exactly one artifact",
    );
  });

  it("rejects an emitted Oniguruma engine chunk by inventory", () => {
    const inventory = [
      ...completeInventory(),
      { path: "assets/engine-oniguruma-seeded.js", size: 6_000 },
    ];
    expect(validateHarnessInventory(inventory).join("\n")).toContain(
      "Oniguruma engine",
    );
  });

  it("rejects Oniguruma WASM and aggregate Shiki catalogue chunks", () => {
    const inventory = [
      ...completeInventory(),
      { path: "assets/onig-seeded.wasm", size: 20_000 },
      { path: "assets/langs-seeded.js", size: 6_000 },
    ];
    const issues = validateHarnessInventory(inventory).join("\n");
    expect(issues).toContain("Oniguruma WASM");
    expect(issues).toContain("aggregate Shiki catalogue");
  });
});
