import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyVendoredPdfium } from "../scripts/vendor-pdfium.js";

const packageRoot = resolve(import.meta.dir, "..");
const reviewedPdfiumFunctions = [
  "FPDFAction_GetType",
  "FPDFAction_GetURIPath",
  "FPDFAnnot_GetLink",
  "FPDFAnnot_GetRect",
  "FPDFAnnot_GetSubtype",
  "FPDFBookmark_GetDest",
  "FPDFBookmark_GetFirstChild",
  "FPDFBookmark_GetNextSibling",
  "FPDFBookmark_GetTitle",
  "FPDFCatalog_IsTagged",
  "FPDFDest_GetDestPageIndex",
  "FPDFDoc_GetAttachmentCount",
  "FPDFDoc_GetJavaScriptActionCount",
  "FPDFFormObj_CountObjects",
  "FPDFFormObj_GetObject",
  "FPDFImageObj_GetImageDataDecoded",
  "FPDFImageObj_GetImagePixelSize",
  "FPDFLink_GetAction",
  "FPDFPageObj_GetBounds",
  "FPDFPageObj_GetMarkedContentID",
  "FPDFPageObj_GetType",
  "FPDFPath_CountSegments",
  "FPDFPath_GetDrawMode",
  "FPDFPage_CloseAnnot",
  "FPDFPage_CountObjects",
  "FPDFPage_GetAnnot",
  "FPDFPage_GetAnnotCount",
  "FPDFPage_GetArtBox",
  "FPDFPage_GetBleedBox",
  "FPDFPage_GetCropBox",
  "FPDFPage_GetMediaBox",
  "FPDFPage_GetObject",
  "FPDFPage_GetRotation",
  "FPDFPage_GetTrimBox",
  "FPDFText_ClosePage",
  "FPDFText_CountChars",
  "FPDFText_GetCharAngle",
  "FPDFText_GetCharBox",
  "FPDFText_GetFontSize",
  "FPDFText_GetFontWeight",
  "FPDFText_GetTextObject",
  "FPDFText_GetUnicode",
  "FPDFText_HasUnicodeMapError",
  "FPDFText_IsGenerated",
  "FPDFText_IsHyphen",
  "FPDFText_LoadPage",
  "FPDF_CloseDocument",
  "FPDF_ClosePage",
  "FPDF_CountNamedDests",
  "FPDF_DestroyLibrary",
  "FPDF_GetFormType",
  "FPDF_GetLastError",
  "FPDF_GetPageBoundingBox",
  "FPDF_GetPageCount",
  "FPDF_GetPageHeightF",
  "FPDF_GetPageLabel",
  "FPDF_GetPageWidthF",
  "FPDF_LoadMemDocument64",
  "FPDF_LoadPage",
  "FPDF_StructElement_Attr_CountChildren",
  "FPDF_StructElement_Attr_GetBooleanValue",
  "FPDF_StructElement_Attr_GetChildAtIndex",
  "FPDF_StructElement_Attr_GetCount",
  "FPDF_StructElement_Attr_GetName",
  "FPDF_StructElement_Attr_GetNumberValue",
  "FPDF_StructElement_Attr_GetStringValue",
  "FPDF_StructElement_Attr_GetType",
  "FPDF_StructElement_Attr_GetValue",
  "FPDF_StructElement_CountChildren",
  "FPDF_StructElement_GetActualText",
  "FPDF_StructElement_GetAltText",
  "FPDF_StructElement_GetAttributeAtIndex",
  "FPDF_StructElement_GetAttributeCount",
  "FPDF_StructElement_GetChildAtIndex",
  "FPDF_StructElement_GetChildMarkedContentID",
  "FPDF_StructElement_GetID",
  "FPDF_StructElement_GetLang",
  "FPDF_StructElement_GetMarkedContentID",
  "FPDF_StructElement_GetMarkedContentIdAtIndex",
  "FPDF_StructElement_GetMarkedContentIdCount",
  "FPDF_StructElement_GetTitle",
  "FPDF_StructElement_GetType",
  "FPDF_StructTree_Close",
  "FPDF_StructTree_CountChildren",
  "FPDF_StructTree_GetChildAtIndex",
  "FPDF_StructTree_GetForPage",
  "PDFiumExt_Init",
] as const;

describe("@atlcli/import-pdf production boundary", () => {
  it("pins PDFium exactly, owns the local asset, and has no PDF.js dependency", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      atlcli?: { publish?: string };
    };
    expect(manifest.dependencies?.["@embedpdf/pdfium"]).toBe("2.15.0");
    expect(manifest.dependencies?.["pdfjs-dist"]).toBeUndefined();
    expect(manifest.exports?.["./wasm"]).toBe("./vendor/pdfium.wasm");
    expect(manifest.atlcli?.publish).toBe("public-0.x");
    expect(() => verifyVendoredPdfium(resolve(packageRoot, "vendor"))).not.toThrow();
  });

  it("keeps browser production source free of Node, PDF.js, URLs, and host globals", async () => {
    const files = (await readdir(import.meta.dir, { recursive: true }))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "node.ts");
    const source = (await Promise.all(files.map((name) =>
      readFile(resolve(import.meta.dir, name), "utf8"),
    ))).join("\n");
    expect(source).not.toMatch(/from ["'](?:node:|bun:|pdfjs-dist|@atlcli\/import-docx|@atlcli\/confluence)/);
    expect(source).not.toContain("DEFAULT_PDFIUM_WASM_URL");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("new Worker");
    expect(source).not.toContain("chrome.");
    expect(source).not.toContain("@forge/");
  });

  it("ships the reviewed WASM import allowlist without a network import", async () => {
    const bytes = await readFile(resolve(packageRoot, "vendor/pdfium.wasm"));
    const module = await WebAssembly.compile(bytes);
    const modules = [...new Set(WebAssembly.Module.imports(module).map((entry) => entry.module))].sort();
    expect(modules).toEqual(["env", "wasi_snapshot_preview1"]);
  });

  it("calls only the reviewed public PDFium function allowlist", async () => {
    const adapterSource = await readFile(resolve(import.meta.dir, "adapter/pdfium.ts"), "utf8");
    const calls = [...adapterSource.matchAll(/\bmodule!?\.(FPDF[A-Za-z0-9_]+|PDFiumExt_Init)\b/gu)]
      .map((match) => match[1]!)
      .filter((name, index, all) => all.indexOf(name) === index)
      .sort();
    expect(calls).toEqual([...reviewedPdfiumFunctions].sort());
    expect(adapterSource).not.toMatch(/\bEPDF_[A-Za-z0-9_]+\b/u);

    const declarations = await readFile(
      resolve(packageRoot, "../../node_modules/@embedpdf/pdfium/dist/vendor/functions.d.ts"),
      "utf8",
    );
    for (const name of reviewedPdfiumFunctions) expect(declarations).toContain(`${name}:`);
  });
});
