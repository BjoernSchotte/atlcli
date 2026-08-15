/**
 * Isolated T0 feasibility proof for canonical composition revision 4.
 *
 * This is deliberately not an atlcli export acceptance test. It sends a
 * neutral, hand-written Typst probe through the real BrowserPdfCompiler with
 * the repository-pinned Typst-WASM and font bundle. T7/T8 must separately
 * prove the public YAML-build and `wiki export --format pdf --template` paths.
 *
 * Typst 0.15.1 renders gradient.linear(...).sharp(2) as a stable hard cut, so
 * the production renderer may use that smaller formulation. The title is one
 * content value and is emitted once; measuring it at three sizes does not add
 * duplicate PDF text objects.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_RUNTIME_ASSETS,
  type PdfCompileResult,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler, PDF_BROWSER_COMPILER_VERSION } from "./index.js";
import { registerTemplateCompositionV4PipelineTests } from "./template-composition-v4-pipeline.test.js";

const PINNED_COMPILER = "typst.ts 0.8.0-rc3.typst0151.1 / Typst 0.15.1";
const decoder = new TextDecoder();
const TITLE_INK = [224, 0, 32] as const;
const TITLE_INVERSE = [0, 82, 204] as const;
const RASTER_DPI = 72;

interface TitleFixture {
  name: string;
  title: string;
  expectedLines: number;
  expectedTier: "display" | "compact" | "minimum";
}

interface Ppm {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface ColorPoint {
  x: number;
  y: number;
}

const FITTING_FIXTURES: readonly TitleFixture[] = [
  {
    name: "one-line",
    title: "FOCUSED SYSTEMS",
    expectedLines: 1,
    expectedTier: "display",
  },
  {
    name: "two-line",
    title: "ARCHITECTURE FOR RELIABLE DIGITAL DELIVERY",
    expectedLines: 2,
    expectedTier: "compact",
  },
  {
    name: "three-line",
    title: "ENGINEERING RESILIENT PLATFORMS FOR SUSTAINABLE DIGITAL OPERATIONS AT SCALE",
    expectedLines: 3,
    expectedTier: "minimum",
  },
] as const;

const OVERLONG_TITLE = Array.from(
  { length: 16 },
  (_, index) => `UNBOUNDED-${String(index + 1).padStart(2, "0")}`,
).join(" ");

let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer(),
  );
}

function typstString(value: string): string {
  return JSON.stringify(value);
}

function sourceFor(
  title: string,
  expectedTier: TitleFixture["expectedTier"] | "overflow",
  titleFrameShiftMm = 0,
): string {
  return `#set page(width: 210mm, height: 297mm, margin: 0pt, fill: white)
#set text(font: "Source Sans 3", fill: rgb("#20232a"))

#let meta-title = [#${typstString(title)}]
#let frame-width = 146mm
#let frame-height = 35mm
#let title-leading = 0.86em
#let title-tiers = (
  (name: "display", size: 44pt),
  (name: "compact", size: 34pt),
  (name: "minimum", size: 24pt),
)

// Neutral synthetic geometry: a pale straight-edged field makes the intended
// diagonal visible without embedding a customer or brand asset.
#place(top + left, dx: 25mm, dy: 31mm, polygon(
  (0mm, 56mm),
  (146mm, 0mm),
  (146mm, 56mm),
  fill: rgb("#f0f2f5"),
))

#let title-block(size, fill: rgb("#20232a"), fixed: false) = block(
  width: frame-width,
  height: if fixed { frame-height } else { auto },
  inset: 0pt,
)[
  #set text(size: size, weight: "bold", tracking: -0.02em, fill: fill)
  #set par(leading: title-leading)
  #meta-title
]

#context {
  let fits(tier) = {
    let bounds = measure(title-block(tier.size))
    bounds.width <= frame-width and bounds.height <= frame-height
  }
  let selected = title-tiers.find(fits)
  assert(
    selected != none,
    message: "TYPE_CUT_TITLE_OVERFLOW: title does not fit coverTitleMinimum in the fixed cover frame",
  )
  assert(
    selected.name == ${typstString(expectedTier)},
    message: "TYPE_CUT_TIER_MISMATCH: expected ${expectedTier}",
  )

  // .sharp(2) is the T0-selected Typst 0.15.1 formulation. Keeping the
  // gradient relative to this fixed parent frame makes its cut independent of
  // line wrapping while the one title content value is rendered exactly once.
  let title-fill = gradient.linear(
    rgb("#e00020"),
    rgb("#0052cc"),
    angle: 68deg,
    relative: "parent",
  ).sharp(2)

  place(
    top + left,
    dx: ${25 + titleFrameShiftMm}mm,
    dy: 42mm,
    title-block(selected.size, fill: title-fill, fixed: true),
  )
}

#place(bottom + left, dx: 25mm, dy: -22mm, block[
  #set text(size: 10pt)
  #link("https://example.invalid/type-cut")[example.invalid/type-cut]
  #linebreak()
  © Example Systems GmbH · Zürich · Qualität
])
`;
}

function bundle(main: string): PdfSourceBundle {
  return {
    main,
    template: "",
    assets: [],
    sourceMap: [],
    notes: [],
  };
}

function errors(result: PdfCompileResult): PdfCompileResult["diagnostics"] {
  return result.diagnostics.filter(({ severity }) => severity === "error");
}

async function compile(source: string): Promise<PdfCompileResult> {
  return compiler.compile(bundle(source));
}

async function extractedText(pdf: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-type-cut-text-"));
  try {
    const input = join(directory, "proof.pdf");
    await Bun.write(input, pdf);
    const process = Bun.spawn(["pdftotext", "-layout", input, "-"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(process.stdout).text();
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(`pdftotext failed: ${await new Response(process.stderr).text()}`);
    }
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parsePpm(bytes: Uint8Array): Ppm {
  let offset = 0;
  const token = (): string => {
    while (offset < bytes.length) {
      if (bytes[offset] === 0x23) {
        while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      } else if (bytes[offset]! <= 0x20) {
        offset += 1;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < bytes.length && bytes[offset]! > 0x20) offset += 1;
    return decoder.decode(bytes.subarray(start, offset));
  };
  expect(token()).toBe("P6");
  const width = Number(token());
  const height = Number(token());
  expect(token()).toBe("255");
  while (offset < bytes.length && bytes[offset]! <= 0x20) offset += 1;
  const pixels = bytes.subarray(offset);
  expect(pixels).toHaveLength(width * height * 3);
  return { width, height, pixels };
}

async function rasterPage(pdf: Uint8Array): Promise<Ppm> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-type-cut-raster-"));
  try {
    const input = join(directory, "proof.pdf");
    const prefix = join(directory, "cover");
    await Bun.write(input, pdf);
    const process = Bun.spawn(
      [
        "pdftoppm",
        "-f",
        "1",
        "-singlefile",
        "-r",
        String(RASTER_DPI),
        input,
        prefix,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exit = await process.exited;
    if (exit !== 0) {
      throw new Error(`pdftoppm failed: ${await new Response(process.stderr).text()}`);
    }
    const ppm = (await readdir(directory)).find((name) => name === "cover.ppm");
    if (!ppm) throw new Error("pdftoppm did not produce cover.ppm");
    return parsePpm(
      new Uint8Array(await Bun.file(join(directory, ppm)).arrayBuffer()),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function colorPoints(page: Ppm, target: readonly [number, number, number]): ColorPoint[] {
  const points: ColorPoint[] = [];
  for (let index = 0; index < page.pixels.length; index += 3) {
    const distance = Math.max(
      Math.abs(page.pixels[index]! - target[0]),
      Math.abs(page.pixels[index + 1]! - target[1]),
      Math.abs(page.pixels[index + 2]! - target[2]),
    );
    if (distance <= 26) {
      const pixel = index / 3;
      points.push({ x: pixel % page.width, y: Math.floor(pixel / page.width) });
    }
  }
  return points;
}

function mixedTitleColorCount(page: Ppm): number {
  let count = 0;
  for (let index = 0; index < page.pixels.length; index += 3) {
    const red = page.pixels[index]!;
    const green = page.pixels[index + 1]!;
    const blue = page.pixels[index + 2]!;
    if (red > 48 && blue > 48 && green < 48) count += 1;
  }
  return count;
}

/**
 * The 68deg gradient's center cut is a descending diagonal in the fixed title
 * frame. The score projects raster coordinates onto its normal; a correct cut
 * puts almost all red samples below the threshold and blue samples above it.
 */
function assertHardDiagonalBoundary(page: Ppm): void {
  const red = colorPoints(page, TITLE_INK);
  const blue = colorPoints(page, TITLE_INVERSE);
  expect(red.length).toBeGreaterThan(120);
  expect(blue.length).toBeGreaterThan(120);

  const frame = {
    left: Math.round((25 / 210) * page.width),
    top: Math.round((42 / 297) * page.height),
    width: Math.round((146 / 210) * page.width),
    height: Math.round((35 / 297) * page.height),
  };
  const angle = (68 * Math.PI) / 180;
  const projected = ({ x, y }: ColorPoint): number => {
    const centeredX = x - (frame.left + frame.width / 2);
    const centeredY = y - (frame.top + frame.height / 2);
    const span = frame.width * Math.abs(Math.cos(angle)) +
      frame.height * Math.abs(Math.sin(angle));
    return (centeredX * Math.cos(angle) + centeredY * Math.sin(angle)) / span;
  };
  const redCorrect = red.filter((point) => projected(point) < 0).length / red.length;
  const blueCorrect = blue.filter((point) => projected(point) >= 0).length / blue.length;
  expect(redCorrect).toBeGreaterThan(0.9);
  expect(blueCorrect).toBeGreaterThan(0.9);
  // Poppler antialiasing creates a narrow mixed fringe even for a hard vector
  // transition; keeping it under 5% rules out a visibly interpolated fill.
  expect(mixedTitleColorCount(page) / (red.length + blue.length)).toBeLessThan(0.05);
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function titleLineCount(text: string, title: string): number {
  const words = title.split(/\s+/u);
  return text
    .split(/\r?\n/u)
    .filter((line) => words.some((word) => line.includes(word)))
    .length;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`),
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
}, 120_000);

afterAll(async () => {
  await compiler?.reset();
});

describe("canonical composition revision 4 Typst primitives", () => {
  it("uses the repository-pinned real BrowserPdfCompiler", () => {
    expect(compiler.version).toBe(PINNED_COMPILER);
    expect(PDF_BROWSER_COMPILER_VERSION).toBe(PINNED_COMPILER);
  });

  for (const fixture of FITTING_FIXTURES) {
    it(`fits and extracts the ${fixture.name} title once at the ${fixture.expectedTier} tier`, async () => {
      const result = await compile(sourceFor(fixture.title, fixture.expectedTier));
      expect(errors(result)).toEqual([]);
      expect(result.pdf).toBeDefined();
      const layoutText = await extractedText(result.pdf!);
      const text = normalized(layoutText);
      expect(titleLineCount(layoutText, fixture.title)).toBe(fixture.expectedLines);
      expect(occurrences(text, fixture.title)).toBe(1);
      expect(text).toContain("example.invalid/type-cut");
      expect(text).toContain("© Example Systems GmbH · Zürich · Qualität");
    }, 120_000);
  }

  it("fails an overlong title through the explicit minimum-tier guard", async () => {
    const result = await compile(sourceFor(OVERLONG_TITLE, "overflow"));
    expect(result.pdf).toBeUndefined();
    const messages = errors(result).map(({ message }) => message).join("\n");
    expect(messages).toContain("TYPE_CUT_TITLE_OVERFLOW");
    expect(messages.toLowerCase()).not.toContain("panic");
  }, 120_000);

  it("renders a stable hard diagonal and proves a shifted-cut negative control", async () => {
    const fixture = FITTING_FIXTURES[2]!;
    const result = await compile(sourceFor(fixture.title, fixture.expectedTier));
    expect(errors(result)).toEqual([]);
    const page = await rasterPage(result.pdf!);
    assertHardDiagonalBoundary(page);

    // Move the fixed title frame, and therefore its parent-relative hard cut,
    // 30mm away from the synthetic geometry while keeping the oracle fixed.
    // A source-only assertion could not prove that this visible misalignment
    // is rejected; the independently rasterized negative PDF does.
    const shifted = await compile(
      sourceFor(fixture.title, fixture.expectedTier, 30),
    );
    expect(errors(shifted)).toEqual([]);
    const shiftedPage = await rasterPage(shifted.pdf!);
    expect(() => assertHardDiagonalBoundary(shiftedPage)).toThrow();
  }, 120_000);
});

registerTemplateCompositionV4PipelineTests();
