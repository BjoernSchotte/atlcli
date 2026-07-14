/**
 * The content payload matching PLAN §2.1's feature list, expressed as OOXML
 * fragments. Images are added per-output-zip (they need relationship parts),
 * so this module exposes the non-image body and the image specs separately.
 *
 * We are testing the ENGINES, not the converter, so this is a hand-authored
 * structured payload rather than converter output.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type PizZip from "pizzip";
import {
  addImageRel,
  calloutBox,
  coloredCodeBlock,
  heading,
  imageDrawing,
  mergedTable,
  nestedList,
  paragraph,
  paragraphWithLink,
  statusBadge,
} from "./ooxml";

const fixDir = join(import.meta.dir, "..", "fixtures");

const imageSpecs = [
  { file: "img-red.png", w: 120, h: 80, name: "Red block" },
  { file: "img-green.png", w: 100, h: 100, name: "Green block" },
  { file: "img-blue.png", w: 160, h: 60, name: "Blue block" },
];

/** Body OOXML NOT needing image rels (headings, callouts, table, lists, code…). */
export function staticBodyFragments(): string[] {
  return [
    heading(1, "1. Introduction"),
    paragraph("This fixture exercises the full feature zoo for the DOCX engine spike."),
    heading(2, "1.1 Text and links"),
    paragraphWithLink("See the ", "atlcli repository", "https://github.com/example/atlcli", " for details."),
    statusBadge("IN PROGRESS", "FFF0B3", "974F0C"),
    heading(2, "1.2 Callouts"),
    calloutBox("info", "Info", "This is an informational callout rendered as a styled single-cell table."),
    calloutBox("note", "Note", "Notes use a purple accent border."),
    calloutBox("warning", "Warning", "Warnings use an amber accent border."),
    calloutBox("tip", "Tip", "Tips use a green accent border."),
    heading(2, "1.3 Lists"),
    nestedList([
      { text: "First top-level item", level: 0, ordered: false },
      { text: "Nested unordered item", level: 1, ordered: false },
      { text: "Deeper nested item", level: 2, ordered: false },
      { text: "Ordered step one", level: 0, ordered: true },
      { text: "Ordered step two", level: 0, ordered: true },
    ]),
    heading(2, "1.4 Table with merged cells"),
    mergedTable(),
    heading(3, "1.4.1 Code block (colored runs)"),
    coloredCodeBlock([
      { text: "const", color: "0000FF" },
      { text: " x ", color: "000000" },
      { text: "=", color: "000000" },
      { text: " ", color: "000000" },
      { text: '"hello"', color: "A31515" },
      { text: ";", color: "000000" },
    ]),
    heading(4, "1.4.1.1 Deep heading level 4"),
    paragraph("Heading level 4 verifies multi-level style mapping."),
  ];
}

/** Append the 3 image paragraphs into `zip`, returning their OOXML. */
export function imageBodyFragments(zip: PizZip, startDocPrId = 1000): string[] {
  return imageSpecs.map((spec, i) => {
    const png = readFileSync(join(fixDir, spec.file));
    const relId = addImageRel(zip, png);
    return imageDrawing(relId, spec.w, spec.h, spec.name, startDocPrId + i);
  });
}

/** Full raw-OOXML body string, injecting images into the given zip. */
export function buildBodyOoxml(zip: PizZip): string {
  const parts = [
    ...staticBodyFragments(),
    heading(2, "1.5 Images"),
    ...imageBodyFragments(zip),
  ];
  return parts.join("");
}
