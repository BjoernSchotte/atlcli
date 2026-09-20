import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const encoder = new TextEncoder();

type PdfObject = string | Uint8Array;

interface UnresolvedStructKidSpec {
  unresolved: true;
}

type StructKidSpec = number | StructNodeSpec | UnresolvedStructKidSpec;

interface StructNodeSpec {
  role: string;
  page: number;
  kids?: StructKidSpec[];
  alt?: string;
  actualText?: string;
  attributes?: Record<string, string | number>;
}

interface LinkSpec {
  rect: [number, number, number, number];
  target: string;
}

interface PageSpec {
  content: string[];
  structures?: StructNodeSpec[];
  links?: LinkSpec[];
  form?: boolean;
}

interface DocumentSpec {
  title: string;
  tagged: boolean;
  pages: PageSpec[];
}

class DeterministicPdfWriter {
  readonly #objects: Array<PdfObject | undefined> = [undefined];

  reserve(): number {
    this.#objects.push(undefined);
    return this.#objects.length - 1;
  }

  set(id: number, body: PdfObject): void {
    if (id <= 0 || id >= this.#objects.length) throw new Error(`invalid object id ${id}`);
    if (this.#objects[id] !== undefined) throw new Error(`object ${id} already assigned`);
    this.#objects[id] = body;
  }

  stream(content: string, dictionary = ""): number {
    const id = this.reserve();
    const bytes = encoder.encode(`${content.trimEnd()}\n`);
    const prefix = encoder.encode(`<< /Length ${bytes.byteLength}${dictionary ? ` ${dictionary}` : ""} >>\nstream\n`);
    const suffix = encoder.encode("endstream");
    const body = new Uint8Array(prefix.byteLength + bytes.byteLength + suffix.byteLength);
    body.set(prefix, 0);
    body.set(bytes, prefix.byteLength);
    body.set(suffix, prefix.byteLength + bytes.byteLength);
    this.set(id, body);
    return id;
  }

  finish(rootId: number, infoId: number): Uint8Array {
    const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")];
    const offsets: number[] = [0];
    let offset = parts[0]!.byteLength;
    for (let id = 1; id < this.#objects.length; id += 1) {
      const value = this.#objects[id];
      if (value === undefined) throw new Error(`object ${id} was reserved but not assigned`);
      const body = typeof value === "string" ? encoder.encode(value) : value;
      const header = encoder.encode(`${id} 0 obj\n`);
      const footer = encoder.encode("\nendobj\n");
      offsets[id] = offset;
      parts.push(header, body, footer);
      offset += header.byteLength + body.byteLength + footer.byteLength;
    }
    const xrefOffset = offset;
    const xref = [
      `xref\n0 ${this.#objects.length}\n`,
      "0000000000 65535 f \n",
      ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
      `trailer\n<< /Size ${this.#objects.length} /Root ${rootId} 0 R /Info ${infoId} 0 R /ID [<41544C434C495155414C495459303031> <41544C434C495155414C495459303031>] >>\n`,
      `startxref\n${xrefOffset}\n%%EOF\n`,
    ].join("");
    parts.push(encoder.encode(xref));
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let cursor = 0;
    for (const part of parts) {
      result.set(part, cursor);
      cursor += part.byteLength;
    }
    return result;
  }
}

function pdfString(value: string): string {
  return `(${value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}

function utf16Hex(value: string): string {
  const units = [0xfeff, ...Array.from(value).flatMap((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) return [codePoint];
    const adjusted = codePoint - 0x10000;
    return [0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff)];
  })];
  return `<${units.map((unit) => unit.toString(16).padStart(4, "0")).join("").toUpperCase()}>`;
}

function refs(ids: readonly number[]): string {
  return `[${ids.map((id) => `${id} 0 R`).join(" ")}]`;
}

function contentText(
  role: string,
  mcid: number | null,
  text: string,
  x: number,
  y: number,
  options: { font?: "F1" | "F2"; size?: number; actualText?: string } = {},
): string {
  const properties = [mcid === null ? "" : `/MCID ${mcid}`, options.actualText ? `/ActualText ${utf16Hex(options.actualText)}` : ""]
    .filter(Boolean)
    .join(" ");
  return `/${role} ${properties ? `<< ${properties} >>` : ""} BDC BT /${options.font ?? "F1"} ${options.size ?? 11} Tf ${x} ${y} Td ${pdfString(text)} Tj ET EMC`;
}

function plainText(text: string, x: number, y: number, font: "F1" | "F2" = "F1", size = 11): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`;
}

function buildDocument(spec: DocumentSpec): Uint8Array {
  const writer = new DeterministicPdfWriter();
  const catalogId = writer.reserve();
  const pagesId = writer.reserve();
  const infoId = writer.reserve();
  const fontRegularId = writer.reserve();
  const fontBoldId = writer.reserve();
  const pageIds = spec.pages.map(() => writer.reserve());
  const contentIds = spec.pages.map((page) => writer.stream(page.content.join("\n")));
  const formIds = spec.pages.map((page) => page.form
    ? writer.stream("q 0.10 0.30 0.55 RG 2 w 0 0 120 60 re S Q", "/Type /XObject /Subtype /Form /BBox [0 0 120 60] /Resources << >>")
    : null);
  const annotationIds = spec.pages.map((page) => (page.links ?? []).map(() => writer.reserve()));

  const structRootId = spec.tagged ? writer.reserve() : null;
  const parentTreeId = spec.tagged ? writer.reserve() : null;
  const nodeIds = new Map<StructNodeSpec, number>();
  const parentIds = new Map<StructNodeSpec, number>();
  const mcidOwners = spec.pages.map(() => new Map<number, number>());

  const allocateNode = (node: StructNodeSpec, parentId: number): void => {
    const id = writer.reserve();
    nodeIds.set(node, id);
    parentIds.set(node, parentId);
    for (const kid of node.kids ?? []) {
      if (typeof kid === "number") mcidOwners[node.page]!.set(kid, id);
      else if (!("unresolved" in kid)) allocateNode(kid, id);
    }
  };
  if (structRootId !== null) {
    for (const page of spec.pages) {
      for (const node of page.structures ?? []) allocateNode(node, structRootId);
    }
  }

  writer.set(fontRegularId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  writer.set(fontBoldId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  writer.set(infoId, [
    "<<",
    `/Title ${pdfString(spec.title)}`,
    "/Author (AtlCLI neutral fixture generator)",
    "/Subject (Synthetic PDF import quality evidence)",
    "/Creator (AtlCLI deterministic Bun fixture generator)",
    "/Producer (AtlCLI deterministic Bun fixture generator)",
    ">>",
  ].join(" "));

  spec.pages.forEach((page, pageIndex) => {
    const annotations = annotationIds[pageIndex]!;
    for (const [index, link] of (page.links ?? []).entries()) {
      writer.set(annotations[index]!, [
        "<< /Type /Annot /Subtype /Link",
        `/Rect [${link.rect.join(" ")}]`,
        "/Border [0 0 0]",
        `/A << /S /URI /URI ${pdfString(link.target)} >> >>`,
      ].join(" "));
    }
    const resources = [
      `/Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >>`,
      formIds[pageIndex] === null ? "" : `/XObject << /Fm1 ${formIds[pageIndex]} 0 R >>`,
    ].filter(Boolean).join(" ");
    writer.set(pageIds[pageIndex]!, [
      `<< /Type /Page /Parent ${pagesId} 0 R`,
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}]`,
      `/Resources << ${resources} >>`,
      `/Contents ${contentIds[pageIndex]} 0 R`,
      annotations.length > 0 ? `/Annots ${refs(annotations)}` : "",
      spec.tagged ? `/StructParents ${pageIndex}` : "",
      ">>",
    ].filter(Boolean).join(" "));
  });
  writer.set(pagesId, `<< /Type /Pages /Count ${pageIds.length} /Kids ${refs(pageIds)} >>`);

  if (structRootId !== null && parentTreeId !== null) {
    for (const [node, id] of nodeIds) {
      const kidParts = (node.kids ?? []).map((kid) => {
        if (typeof kid === "number") return String(kid);
        if ("unresolved" in kid) return "null";
        return `${nodeIds.get(kid)} 0 R`;
      });
      const attributes = node.attributes
        ? `/A << /O /Layout ${Object.entries(node.attributes).map(([key, value]) => `/${key} ${typeof value === "number" ? value : pdfString(value)}`).join(" ")} >>`
        : "";
      writer.set(id, [
        "<< /Type /StructElem",
        `/S /${node.role}`,
        `/P ${parentIds.get(node)} 0 R`,
        `/Pg ${pageIds[node.page]} 0 R`,
        kidParts.length === 0 ? "" : `/K ${kidParts.length === 1 ? kidParts[0] : `[${kidParts.join(" ")}]`}`,
        node.alt ? `/Alt ${utf16Hex(node.alt)}` : "",
        node.actualText ? `/ActualText ${utf16Hex(node.actualText)}` : "",
        attributes,
        ">>",
      ].filter(Boolean).join(" "));
    }
    const topLevelIds = spec.pages.flatMap((page) => (page.structures ?? []).map((node) => nodeIds.get(node)!));
    const parentNums = mcidOwners.flatMap((owners, pageIndex) => {
      const maxMcid = Math.max(-1, ...owners.keys());
      const ownerRefs = Array.from({ length: maxMcid + 1 }, (_, mcid) => {
        const owner = owners.get(mcid);
        return owner === undefined ? "null" : `${owner} 0 R`;
      });
      return [`${pageIndex}`, `[${ownerRefs.join(" ")}]`];
    });
    writer.set(parentTreeId, `<< /Nums [${parentNums.join(" ")}] >>`);
    writer.set(structRootId, [
      "<< /Type /StructTreeRoot",
      `/K ${refs(topLevelIds)}`,
      `/ParentTree ${parentTreeId} 0 R`,
      `/ParentTreeNextKey ${spec.pages.length}`,
      ">>",
    ].join(" "));
  }

  writer.set(catalogId, [
    `<< /Type /Catalog /Pages ${pagesId} 0 R`,
    spec.tagged ? `/StructTreeRoot ${structRootId} 0 R /MarkInfo << /Marked true >> /Lang (en-US)` : "",
    ">>",
  ].filter(Boolean).join(" "));
  return writer.finish(catalogId, infoId);
}

function taggedFragmentedFixture(): Uint8Array {
  const orderedSpan: StructNodeSpec = { role: "Span", page: 0, kids: [2] };
  return buildDocument({
    title: "Neutral Tagged Fragment Evidence",
    tagged: true,
    pages: [{
      links: [{ rect: [108, 730, 154, 747], target: "https://example.com/neutral-harbor" }],
      content: [
        contentText("H1", 0, "Neutral Harbor Evidence", 72, 775, { font: "F2", size: 20 }),
        contentText("P", 3, "remain clear.", 160, 735),
        contentText("P", 1, "Harbor", 72, 735),
        contentText("Span", 2, "signals", 112, 735, { font: "F2" }),
        "/P <</MCID 4>> BDC BT /F1 11 Tf 72 700 Td (Seasonal coor-) Tj 0 -16 Td (dination stays stable.) Tj ET EMC",
        contentText("Span", 5, "RTL", 72, 645, { actualText: "مرحبا بالميناء" }),
        contentText("Span", 6, "CJK", 180, 645, { actualText: "港の信号" }),
        contentText("Span", 7, "office", 260, 645, { actualText: "oﬃce" }),
        contentText("P", 8, "German Umlaute: Aepfel, Oel, Ufer.", 72, 615, { actualText: "German Umlaute: Äpfel, Öl, Ufer." }),
        plainText("Localized unmarked repair note.", 72, 570),
      ],
      structures: [
        { role: "H1", page: 0, kids: [0] },
        { role: "P", page: 0, kids: [1, orderedSpan, 3] },
        { role: "P", page: 0, kids: [4] },
        {
          role: "P",
          page: 0,
          kids: [
            { role: "Span", page: 0, kids: [5], actualText: "مرحبا بالميناء" },
            { role: "Span", page: 0, kids: [6], actualText: "港の信号" },
            { role: "Span", page: 0, kids: [7], actualText: "oﬃce" },
          ],
        },
        { role: "P", page: 0, kids: [8], actualText: "German Umlaute: Äpfel, Öl, Ufer." },
      ],
    }],
  });
}

function taggedStructuresFixture(): Uint8Array {
  const headerRow: StructNodeSpec = {
    role: "TR",
    page: 0,
    kids: [
      { role: "TH", page: 0, kids: [0] },
      { role: "TH", page: 0, kids: [1] },
    ],
  };
  const bodyRow: StructNodeSpec = {
    role: "TR",
    page: 0,
    kids: [
      { role: "TD", page: 0, kids: [2] },
      { role: "TD", page: 0, kids: [3] },
    ],
  };
  const footerRow: StructNodeSpec = {
    role: "TR",
    page: 0,
    kids: [
      { role: "TD", page: 0, kids: [4] },
      { role: "TD", page: 0, kids: [5] },
    ],
  };
  const nestedList: StructNodeSpec = {
    role: "L",
    page: 0,
    kids: [{
      role: "LI",
      page: 0,
      kids: [
        { role: "Lbl", page: 0, kids: [10] },
        { role: "LBody", page: 0, kids: [{ role: "P", page: 0, kids: [11] }] },
      ],
    }],
  };
  const directTable: StructNodeSpec = {
    role: "Table",
    page: 0,
    kids: [{
      role: "TR",
      page: 0,
      kids: [
        { role: "TD", page: 0, kids: [12] },
        { role: "TD", page: 0, kids: [13] },
      ],
    }],
  };
  return buildDocument({
    title: "Neutral Tagged Structure Evidence",
    tagged: true,
    pages: [{
      form: true,
      content: [
        contentText("TH", 0, "Zone", 72, 770, { font: "F2" }),
        contentText("TH", 1, "Signal", 220, 770, { font: "F2" }),
        contentText("TD", 2, "North", 72, 745),
        contentText("TD", 3, "Clear", 220, 745),
        contentText("TD", 4, "Summary", 72, 720),
        contentText("TD", 5, "Stable", 220, 720),
        contentText("Lbl", 6, "1.", 72, 665),
        contentText("P", 7, "Inspect the northern marker.", 92, 665),
        contentText("P", 8, "Record a second paragraph.", 92, 645),
        contentText("Lbl", 10, "a.", 108, 620),
        contentText("P", 11, "Verify the nested reading.", 128, 620),
        contentText("TD", 12, "East", 72, 555),
        contentText("TD", 13, "Watch", 220, 555),
        "/Figure <</MCID 14>> BDC q 1 0 0 1 72 430 cm /Fm1 Do Q EMC",
      ],
      structures: [
        {
          role: "Table",
          page: 0,
          kids: [
            { role: "THead", page: 0, kids: [headerRow] },
            { role: "TBody", page: 0, kids: [bodyRow] },
            { role: "TFoot", page: 0, kids: [footerRow] },
          ],
        },
        {
          role: "L",
          page: 0,
          kids: [{
            role: "LI",
            page: 0,
            kids: [
              { role: "Lbl", page: 0, kids: [6] },
              { role: "LBody", page: 0, kids: [{ role: "P", page: 0, kids: [7] }, { role: "P", page: 0, kids: [8] }, nestedList] },
            ],
          }],
        },
        directTable,
        { role: "Figure", page: 0, kids: [14], alt: "Neutral outlined harbor marker" },
      ],
    }],
  });
}

function taggedNegativeFixture(): Uint8Array {
  const malformedNestedTable: StructNodeSpec = {
    role: "Table",
    page: 0,
    kids: [{ role: "TR", page: 0, kids: [{ role: "TD", page: 0, kids: [1, { role: "Table", page: 0, kids: [{ role: "TR", page: 0, kids: [{ role: "TD", page: 0, kids: [2] }] }] }] }] }],
  };
  const incompatibleList: StructNodeSpec = {
    role: "L",
    page: 0,
    kids: [{
      role: "LI",
      page: 0,
      kids: [{
        role: "LBody",
        page: 0,
        kids: [
          { role: "P", page: 0, kids: [3] },
          { role: "L", page: 0, kids: [{ role: "LI", page: 0, kids: [{ role: "LBody", page: 0, kids: [{ role: "P", page: 0, kids: [4] }] }] }] },
          { role: "L", page: 0, kids: [{ role: "LI", page: 0, kids: [{ role: "LBody", page: 0, kids: [{ role: "P", page: 0, kids: [5] }] }] }] },
        ],
      }],
    }],
  };
  return buildDocument({
    title: "Neutral Tagged Negative Evidence",
    tagged: true,
    pages: [{
      content: [
        contentText("H2", 0, "Explicit negative structures", 72, 775, { font: "F2", size: 16 }),
        contentText("TD", 1, "Outer", 72, 720),
        contentText("TD", 2, "Nested", 220, 700),
        contentText("P", 3, "Multiple nested lists stay explicit.", 72, 650),
        contentText("P", 4, "First nested branch.", 92, 625),
        contentText("P", 5, "Second nested branch.", 92, 600),
        plainText("North residual.", 30, 810),
        plainText("South residual.", 450, 45),
        plainText("West residual.", 30, 420),
        plainText("East residual.", 450, 420),
      ],
      structures: [
        { role: "H2", page: 0, kids: [0] },
        malformedNestedTable,
        incompatibleList,
      ],
    }],
  });
}

function untaggedFixture(): Uint8Array {
  return buildDocument({
    title: "Neutral Untagged Quality Evidence",
    tagged: false,
    pages: [{
        links: [{ rect: [176, 647, 214, 662], target: "https://example.com/neutral-river" }],
        content: [
          plainText("Neutral Geometry Evidence", 72, 775, "F2", 20),
          plainText("River", 72, 735),
          plainText("markers", 105, 735, "F2"),
          plainText("remain stable.", 150, 735),
          plainText("Wrapped routes continue", 72, 700),
          plainText("safely without explicit breaks.", 72, 684),
          plainText("Punctuation", 72, 650),
          plainText(",", 130, 650),
          plainText("brackets", 136, 650),
          plainText("and links stay attached.", 180, 650),
          plainText("Authored north-east remains hard-hyphenated.", 72, 615),
          plainText("Neutral Script Boundaries", 72, 565, "F2", 16),
          contentText("Span", null, "RTL", 72, 530, { actualText: "مرحبا بالميناء" }),
          contentText("Span", null, "CJK", 72, 500, { actualText: "港の信号" }),
          contentText("Span", null, "office", 72, 470, { actualText: "oﬃce" }),
          "/Span << /ActualText <FEFF0053006500610073006F006E0061006C00200063006F006F007200640069006E006100740069006F006E00200073007400610079007300200073007400610062006C0065002E> >> BDC BT /F1 11 Tf 72 430 Td (Seasonal coor-) Tj 0 -16 Td (dination stays stable.) Tj ET EMC",
        ],
      }],
  });
}

export const CORE_FIXTURES = {
  "independent-fragmented-tagged.pdf": taggedFragmentedFixture,
  "independent-structures-tagged.pdf": taggedStructuresFixture,
  "independent-negative-tagged.pdf": taggedNegativeFixture,
  "independent-fragmented-untagged.pdf": untaggedFixture,
} as const;

export function generateCoreFixtures(): Record<keyof typeof CORE_FIXTURES, Uint8Array> {
  return Object.fromEntries(
    Object.entries(CORE_FIXTURES).map(([name, generate]) => [name, generate()]),
  ) as Record<keyof typeof CORE_FIXTURES, Uint8Array>;
}

/** Runtime-only malformed structure probe; intentionally not part of the committed PDF corpus. */
export function generateUnresolvedStructureKidProbe(): Uint8Array {
  return buildDocument({
    title: "Neutral Unresolved Structure Probe",
    tagged: true,
    pages: [{
      content: [
        contentText("P", 0, "Neutral", 72, 775),
        contentText("P", 1, "evidence.", 115, 775),
      ],
      structures: [{ role: "P", page: 0, kids: [0, { unresolved: true }, 1] }],
    }],
  });
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output");
  const outputDirectory = resolve(outputFlag >= 0 ? process.argv[outputFlag + 1] ?? "" : import.meta.dir);
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, bytes] of Object.entries(generateCoreFixtures())) {
    await writeFile(resolve(outputDirectory, name), bytes);
  }
  process.stdout.write(`generated ${Object.keys(CORE_FIXTURES).length} deterministic neutral PDF fixtures\n`);
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) await main();
