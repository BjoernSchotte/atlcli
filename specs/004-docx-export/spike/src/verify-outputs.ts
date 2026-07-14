/**
 * Opens every produced .docx and ASSERTS real results in the XML — not "no
 * exception thrown". Checks placeholder replacement (body + header + footer),
 * image media parts + relationships, callout fill, colored code runs, and the
 * absence of leftover `$scroll.` literals.
 *
 * Run: bun run src/verify-outputs.ts
 */
import PizZip from "pizzip";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "..", "out");

let failures = 0;
function check(label: string, cond: boolean, evidence = ""): void {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${label}${evidence ? `  (${evidence})` : ""}`);
}

function load(file: string) {
  const zip = new PizZip(readFileSync(join(outDir, file)));
  const text = (n: string) => zip.file(n)?.asText() ?? "";
  const names = Object.keys(zip.files);
  return { zip, text, names };
}

function mediaAndRels(z: ReturnType<typeof load>) {
  const media = z.names.filter((n) => n.startsWith("word/media/") && !n.endsWith("/"));
  const rels = z.text("word/_rels/document.xml.rels");
  // Image relationship ids (Id may be "rId7" or engine-specific like "img1").
  const imageRelIds = new Set(
    [...rels.matchAll(/<Relationship\b[^>]*\/>/g)]
      .filter((m) => /Type="[^"]*\/image"/.test(m[0]))
      .map((m) => /Id="([^"]+)"/.exec(m[0])?.[1] ?? ""),
  );
  const blips = [...z.text("word/document.xml").matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)].map((m) => m[1]);
  const blipsResolve = blips.length > 0 && blips.every((id) => imageRelIds.has(id));
  return { mediaCount: media.length, imageRels: imageRelIds.size, blipCount: blips.length, blipsResolve };
}

console.log("\n=== docx-templates-native.docx (native IMAGE + literal XML) ===");
{
  const z = load("docx-templates-native.docx");
  const doc = z.text("word/document.xml");
  const m = mediaAndRels(z);
  check("3 image media parts embedded", m.mediaCount === 3, `media=${m.mediaCount}`);
  check("image relationships present", m.imageRels >= 3, `imageRels=${m.imageRels}`);
  check("drawing blips resolve to image rels", m.blipCount >= 3 && m.blipsResolve, `blips=${m.blipCount}`);
  check("callout fill (DEEBFF) injected via literal XML", doc.includes('w:fill="DEEBFF"'));
  check("colored code run (A31515) injected via literal XML", doc.includes('w:val="A31515"'));
  check("document.xml is well-formed (balanced w:p)", balanced(doc, "w:p"));
}

console.log("\n=== docxtemplater-native.docx (free rawxml + self-built image module) ===");
{
  const z = load("docxtemplater-native.docx");
  const doc = z.text("word/document.xml");
  const m = mediaAndRels(z);
  check("3 image media parts embedded (self-built module)", m.mediaCount === 3, `media=${m.mediaCount}`);
  check("image relationships present (self-built module)", m.imageRels >= 3, `imageRels=${m.imageRels}`);
  check("png content-type declared", z.text("[Content_Types].xml").includes('Extension="png"'));
  check("drawing blips resolve to image rels", m.blipCount >= 3 && m.blipsResolve, `blips=${m.blipCount}`);
  check("callout fill (FFFAE6) injected via free rawxml", doc.includes('w:fill="FFFAE6"'));
  check("colored code run (098658) injected via free rawxml", doc.includes('w:val="098658"'));
  check("document.xml is well-formed (balanced w:p)", balanced(doc, "w:p"));
}

console.log("\n=== customer-preprocessed.docx (shared $scroll.* preprocessor path) ===");
{
  const z = load("customer-preprocessed.docx");
  const doc = z.text("word/document.xml");
  const hdr = z.names.filter((n) => /header\d*\.xml$/.test(n)).map(z.text).join("\n");
  const ftr = z.names.filter((n) => /footer\d*\.xml$/.test(n)).map(z.text).join("\n");
  const m = mediaAndRels(z);

  check("body: $scroll.title replaced", doc.includes("Q3 Architecture Overview"));
  check("body: $scroll.space.name replaced", doc.includes("Engineering Docs"));
  check("body: $scroll.pagelabels replaced", doc.includes("architecture, review"));
  check("body: $scroll.content replaced with content zoo", doc.includes("full feature zoo"));
  check("HEADER: $scroll.title replaced", hdr.includes("Q3 Architecture Overview"));
  check("HEADER: $scroll.exportdate replaced", hdr.includes("14.07.2026"));
  check("FOOTER: $scroll.exporter.fullName replaced", ftr.includes("Björn Schotte"));
  check("no $scroll. literal remains in body", !doc.includes("$scroll."), leftovers(doc));
  check("no $scroll. literal remains in header", !hdr.includes("$scroll."), leftovers(hdr));
  check("no $scroll. literal remains in footer", !ftr.includes("$scroll."), leftovers(ftr));

  check("3 content images embedded as media parts", m.mediaCount === 3, `media=${m.mediaCount}`);
  check("content image relationships present", m.imageRels >= 3, `imageRels=${m.imageRels}`);
  check("content image blips resolve to rels", m.blipCount >= 3 && m.blipsResolve, `blips=${m.blipCount}`);
  check("callout box present (DEEBFF)", doc.includes('w:fill="DEEBFF"'));
  check("merged table gridSpan present", doc.includes('<w:gridSpan w:val="3"/>'));
  check("colored code run present (A31515)", doc.includes('w:val="A31515"'));
  check("heading styles present (Heading4)", doc.includes('w:val="Heading4"'));
  check("document.xml well-formed (balanced w:p)", balanced(doc, "w:p"));
}

function balanced(xml: string, tag: string): boolean {
  // Match only real <w:p> tags (excludes <w:pPr>, <w:pStyle/>, <w:pgSz/> …):
  // the char right after the tag name must be whitespace, "/", or ">".
  const openOrSelf = xml.match(new RegExp(`<${tag}(?=[\\s/>])[^>]*>`, "g")) || [];
  const selfClose = openOrSelf.filter((t) => t.endsWith("/>")).length;
  const open = openOrSelf.length - selfClose;
  const close = (xml.match(new RegExp(`</${tag}>`, "g")) || []).length;
  return open === close;
}

function leftovers(xml: string): string {
  const hits = [...new Set([...xml.matchAll(/\$scroll\.[a-zA-Z.]+/g)].map((m) => m[0]))];
  return hits.length ? `leftover: ${hits.join(", ")}` : "";
}

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
