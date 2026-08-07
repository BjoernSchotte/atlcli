import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  loadPdfTemplatePack,
  validatePdfOutput,
} from "@atlcli/pdf";
import { BUILTIN_PDF_DESIGN } from "@atlcli/pdf/internal";
import type { WikiPdfTemplateRecipeV1 } from "@atlcli/template-pack";

const CLI = fileURLToPath(
  new URL("../../../apps/cli/src/index.ts", import.meta.url)
);
const PAGE_ID = "99117004";
const TITLE = "ARCHITECTURE FOR RELIABLE DIGITAL DELIVERY";
const WEBSITE_LABEL = "systems.example";
const WEBSITE_URL = "https://systems.example/brief";
const LEGAL_NOTICE = "Example Systems GmbH · Berlin · Qualität";
const ORANGE = [231, 82, 4] as const;
const INK = [32, 42, 68] as const;
const WHITE = [255, 255, 255] as const;
const CYAN = [0, 212, 255] as const;
const RASTER_DPI = 144;
const MM_PER_POINT = 25.4 / 72;

const TITLE_FRAME = {
  leftMm: 22,
  topMm: 23.5,
  widthMm: (210 - 44) * 0.9,
  heightMm: 80,
  angleDeg: 43,
  stop: 50,
} as const;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Raster {
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface WordBox {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface Variant {
  cover?: boolean;
  closing?: boolean;
  stop?: number;
  closingAlign?: "left" | "center" | "right";
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pageFixture(origin: string): Record<string, unknown> {
  return {
    id: PAGE_ID,
    title: TITLE,
    space: { key: "DOCSY" },
    version: { number: 1, when: "2026-08-07T00:00:00.000Z" },
    ancestors: [],
    history: {
      createdDate: "2026-08-07T00:00:00.000Z",
      createdBy: { accountId: "fixture", displayName: "Fixture Author" },
      lastUpdated: {
        when: "2026-08-07T00:00:00.000Z",
        by: { accountId: "fixture", displayName: "Fixture Author" },
      },
    },
    metadata: { labels: { results: [] }, properties: {} },
    body: {
      storage: {
        value:
          "<h1>Compatibility proof</h1><p>Neutral synthetic body for the public atlcli PDF pipeline.</p>",
        representation: "storage",
      },
    },
    _links: { base: origin, webui: `/pages/${PAGE_ID}` },
  };
}

function recipe(name: string, variant: Variant = {}): WikiPdfTemplateRecipeV1 {
  const design = structuredClone(BUILTIN_PDF_DESIGN);
  design.features.cover.enabled = variant.cover ?? true;
  design.features.closingPage.enabled = variant.closing ?? true;
  design.features.header.enabled = false;
  design.features.footer.enabled = false;
  design.compositions = {
    cover: {
      kind: "type-cut",
      logo: "hide",
      metadataPosition: "bottom",
      typeCut: { angle: TITLE_FRAME.angleDeg, stop: variant.stop ?? TITLE_FRAME.stop },
    },
    closingPage: {
      kind: "brand-lockup",
      logo: "show",
      website: "show",
      legalNotice: "show",
      align: variant.closingAlign ?? "left",
    },
  };
  Object.assign(design.branding, {
    websiteLabel: WEBSITE_LABEL,
    websiteUrl: WEBSITE_URL,
    legalNotice: LEGAL_NOTICE,
  });
  Object.assign(design.tokens.colors, {
    coverTitleInk: "#202A44",
    coverTitleInverse: "#FFFFFF",
    closingPageBackground: "#E75204",
    closingBrandText: "#FFFFFF",
  });
  Object.assign(design.tokens.layout, {
    coverTopPad: "0mm",
    coverEyebrowGap: "0pt",
    coverTitleFrameHeight: `${TITLE_FRAME.heightMm}mm`,
    coverMetaBottomInset: "24mm",
    closingBrandBottomInset: "24mm",
    closingBrandBlockWidth: "92mm",
    closingBrandLogoWidth: "42mm",
    closingBrandLogoHeight: "18mm",
    closingBrandLogoGap: "8mm",
    closingBrandTextGap: "4mm",
  });
  Object.assign(design.typography.roles, {
    coverEyebrow: {
      font: "heading",
      size: "1pt",
      weight: "semibold",
      tracking: "0em",
    },
    coverTitle: { font: "heading", size: "38pt", weight: "bold" },
    coverTitleCompact: { font: "heading", size: "31pt", weight: "bold" },
    coverTitleMinimum: { font: "heading", size: "24pt", weight: "bold" },
    closingWebsite: {
      font: "heading",
      size: "14pt",
      weight: "semibold",
    },
    closingLegal: { font: "heading", size: "9pt", weight: "regular" },
  });
  return {
    schema: "wiki.pdf-template-recipe/v1",
    template: {
      id: `fixture.pipeline.${name}`,
      name: `Pipeline ${name}`,
      version: "1.0.0",
      compilerRange: ">=0.14 <0.15",
    },
    design,
    localization: structuredClone(BUILTIN_PDF_TEMPLATE_MANIFEST.localization!),
    assets: {
      "asset.coverBackground": {
        source: "assets/cover.svg",
        decorative: true,
      },
      "asset.logo": {
        source: "assets/logo.svg",
        decorative: false,
        alt: "Example Systems mark",
      },
    },
  };
}

function titleProjection(xMm: number, yMm: number): number {
  const angle = (TITLE_FRAME.angleDeg * Math.PI) / 180;
  const centeredX = xMm - (TITLE_FRAME.leftMm + TITLE_FRAME.widthMm / 2);
  const centeredY = yMm - (TITLE_FRAME.topMm + TITLE_FRAME.heightMm / 2);
  const span =
    TITLE_FRAME.widthMm * Math.abs(Math.cos(angle)) +
    TITLE_FRAME.heightMm * Math.abs(Math.sin(angle));
  return (
    centeredX * Math.cos(angle) +
    centeredY * Math.sin(angle) -
    (TITLE_FRAME.stop / 100 - 0.5) * span
  );
}

function edgeY(xMm: number): number {
  const angle = (TITLE_FRAME.angleDeg * Math.PI) / 180;
  const centerX = TITLE_FRAME.leftMm + TITLE_FRAME.widthMm / 2;
  const centerY = TITLE_FRAME.topMm + TITLE_FRAME.heightMm / 2;
  const span =
    TITLE_FRAME.widthMm * Math.abs(Math.cos(angle)) +
    TITLE_FRAME.heightMm * Math.abs(Math.sin(angle));
  const threshold = (TITLE_FRAME.stop / 100 - 0.5) * span;
  return centerY +
    (threshold - (xMm - centerX) * Math.cos(angle)) / Math.sin(angle);
}

function coverSvg(): string {
  const left = edgeY(0);
  const top = TITLE_FRAME.leftMm + TITLE_FRAME.widthMm / 2 +
    (TITLE_FRAME.topMm + TITLE_FRAME.heightMm / 2) *
      Math.tan((TITLE_FRAME.angleDeg * Math.PI) / 180);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297" viewBox="0 0 210 297"><rect width="210" height="297" fill="#FFFFFF"/><polygon points="0,${left.toFixed(4)} ${top.toFixed(4)},0 210,0 210,297 0,297" fill="#E75204"/></svg>`;
}

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24" viewBox="0 0 80 24"><rect width="80" height="24" rx="3" fill="#00D4FF"/></svg>';

async function runCli(cwd: string, args: readonly string[]): Promise<CliResult> {
  const spawned = Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, ...args],
    {
      cwd,
      env: {
        ...Bun.env,
        HOME: cwd,
        USERPROFILE: cwd,
        ATLCLI_API_TOKEN: "synthetic-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function writeVariant(
  directory: string,
  name: string,
  variant: Variant
): Promise<string> {
  const recipePath = join(directory, `${name}.yaml`);
  await writeFile(recipePath, `${JSON.stringify(recipe(name, variant), null, 2)}\n`);
  const pack = `${name}.wiki-pdf-template`;
  const built = await runCli(directory, [
    "pdf-template",
    "build",
    `${name}.yaml`,
    "--output",
    pack,
    "--json",
    "--no-log",
  ]);
  expect(built.exitCode, built.stderr).toBe(0);
  const result = JSON.parse(built.stdout) as {
    outputDigest: string;
    details: { catalogVersion: number; canonicalRevision: string };
  };
  const bytes = new Uint8Array(await readFile(join(directory, pack)));
  expect(digest(bytes)).toBe(result.outputDigest);
  expect(result.details).toMatchObject({
    catalogVersion: 2,
    canonicalRevision: "4",
  });
  const loaded = await loadPdfTemplatePack(bytes);
  expect(loaded.canonicalSource.revision).toBe("4");
  expect(loaded.manifest.capabilityCatalog?.version).toBe(2);
  expect(structuredClone(loaded.runtimeSnapshot)).toEqual(loaded.runtimeSnapshot);
  return pack;
}

async function exportVariant(
  directory: string,
  origin: string,
  name: string,
  pack: string
): Promise<Uint8Array> {
  const output = `${name}.pdf`;
  const exported = await runCli(directory, [
    "wiki",
    "export",
    PAGE_ID,
    "--format",
    "pdf",
    "--base-url",
    origin,
    "--auth-type",
    "bearer",
    "--allow-http",
    "--exported-at",
    "2026-08-07T00:00:00.000Z",
    "--template",
    pack,
    "--output",
    output,
    "--json",
  ]);
  expect(exported.exitCode, exported.stderr).toBe(0);
  expect(JSON.parse(exported.stdout)).toMatchObject({ format: "pdf" });
  return new Uint8Array(await readFile(join(directory, output)));
}

async function poppler(
  directory: string,
  command: "pdftotext" | "pdfinfo",
  args: readonly string[],
  pdf: Uint8Array
): Promise<string> {
  const input = join(directory, `poppler-${crypto.randomUUID()}.pdf`);
  await writeFile(input, pdf);
  try {
    const process = Bun.spawn([command, ...args, input, ...(command === "pdftotext" ? ["-"] : [])], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${command} failed: ${stderr}`);
    return stdout;
  } finally {
    await rm(input, { force: true });
  }
}

function parsePpm(bytes: Uint8Array): Raster {
  let offset = 0;
  const token = (): string => {
    while (offset < bytes.length) {
      if (bytes[offset] === 0x23) {
        while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      } else if (bytes[offset]! <= 0x20) {
        offset += 1;
      } else break;
    }
    const start = offset;
    while (offset < bytes.length && bytes[offset]! > 0x20) offset += 1;
    return new TextDecoder().decode(bytes.subarray(start, offset));
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

async function rasterPage(
  directory: string,
  pdf: Uint8Array,
  page: number
): Promise<Raster> {
  const input = join(directory, `raster-${crypto.randomUUID()}.pdf`);
  const prefix = join(directory, `raster-${crypto.randomUUID()}`);
  await writeFile(input, pdf);
  try {
    const process = Bun.spawn(
      [
        "pdftoppm",
        "-f",
        String(page),
        "-l",
        String(page),
        "-singlefile",
        "-r",
        String(RASTER_DPI),
        input,
        prefix,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stderr = new Response(process.stderr).text();
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`pdftoppm failed: ${await stderr}`);
    return parsePpm(new Uint8Array(await readFile(`${prefix}.ppm`)));
  } finally {
    await rm(input, { force: true });
    await rm(`${prefix}.ppm`, { force: true });
  }
}

function closeColor(
  pixels: Uint8Array,
  index: number,
  target: readonly [number, number, number],
  tolerance = 24
): boolean {
  return (
    Math.max(
      Math.abs(pixels[index]! - target[0]),
      Math.abs(pixels[index + 1]! - target[1]),
      Math.abs(pixels[index + 2]! - target[2])
    ) <= tolerance
  );
}

function colorPoints(
  raster: Raster,
  target: readonly [number, number, number]
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < raster.pixels.length; index += 3) {
    if (!closeColor(raster.pixels, index, target)) continue;
    const pixel = index / 3;
    points.push({ x: pixel % raster.width, y: Math.floor(pixel / raster.width) });
  }
  return points;
}

function parseWordBoxes(xml: string): WordBox[] {
  const words: WordBox[] = [];
  const pattern =
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/gu;
  for (const match of xml.matchAll(pattern)) {
    words.push({
      text: match[5]!,
      xMin: Number(match[1]),
      yMin: Number(match[2]),
      xMax: Number(match[3]),
      yMax: Number(match[4]),
    });
  }
  return words;
}

function assertTitleTracksDiagonal(raster: Raster, words: readonly WordBox[]): void {
  const titleWords = new Set(TITLE.split(" "));
  const boxes = words.filter(({ text }) => titleWords.has(text));
  expect(boxes.length).toBe(TITLE.split(" ").length);
  let ink = 0;
  let correctlyPlacedInk = 0;
  let inverse = 0;
  const inkProjections: number[] = [];
  const inverseProjections: number[] = [];
  for (const box of boxes) {
    const xMin = Math.max(0, Math.floor((box.xMin / 72) * RASTER_DPI));
    const xMax = Math.min(raster.width - 1, Math.ceil((box.xMax / 72) * RASTER_DPI));
    const yMin = Math.max(0, Math.floor((box.yMin / 72) * RASTER_DPI));
    const yMax = Math.min(raster.height - 1, Math.ceil((box.yMax / 72) * RASTER_DPI));
    for (let y = yMin; y <= yMax; y += 1) {
      for (let x = xMin; x <= xMax; x += 1) {
        const index = (y * raster.width + x) * 3;
        const projection = titleProjection(
          (x / raster.width) * 210,
          (y / raster.height) * 297
        );
        if (closeColor(raster.pixels, index, INK)) {
          ink += 1;
          inkProjections.push(projection);
          if (projection < 0) correctlyPlacedInk += 1;
        }
        if (projection >= 0 && closeColor(raster.pixels, index, WHITE, 18)) {
          inverse += 1;
          inverseProjections.push(projection);
        }
      }
    }
  }
  expect(ink).toBeGreaterThan(150);
  expect(inverse).toBeGreaterThan(100);
  expect(correctlyPlacedInk / ink).toBeGreaterThan(0.88);
  expect(Math.max(...inkProjections)).toBeGreaterThan(-8);
  expect(Math.min(...inverseProjections)).toBeLessThan(8);
}

function assertClosingRaster(raster: Raster): void {
  const orange = colorPoints(raster, ORANGE);
  const cyan = colorPoints(raster, CYAN);
  expect(orange.length / (raster.width * raster.height)).toBeGreaterThan(0.94);
  expect(cyan.length).toBeGreaterThan(500);
  expect(Math.max(...cyan.map(({ x }) => x))).toBeLessThan(raster.width * 0.55);
  expect(Math.min(...cyan.map(({ y }) => y))).toBeGreaterThan(raster.height * 0.55);
}

function assertLeftClosingWords(words: readonly WordBox[]): void {
  const website = words.find(({ text }) => text === WEBSITE_LABEL);
  expect(website).toBeDefined();
  expect(website!.xMin * MM_PER_POINT).toBeGreaterThan(15);
  expect(website!.xMin * MM_PER_POINT).toBeLessThan(50);
  expect(website!.yMin * MM_PER_POINT).toBeGreaterThan(200);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

export function registerTemplateCompositionV4PipelineTests(): void {
  describe("revision-4 public atlcli PDF export pipeline", () => {
    it("builds YAML packs and proves page, text, link, raster, and negative controls", async () => {
      const directory = await mkdtemp(join(tmpdir(), "atlcli-v4-pipeline-"));
      const assets = join(directory, "assets");
      await mkdir(assets);
      await Bun.write(join(assets, "cover.svg"), coverSvg());
      await Bun.write(join(assets, "logo.svg"), LOGO_SVG);
      let server: ReturnType<typeof Bun.serve> | undefined;
      try {
        server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === `/rest/api/content/${PAGE_ID}`) {
              return Response.json(pageFixture(server!.url.origin));
            }
            return Response.json(
              { message: `No fixture route for ${pathname}` },
              { status: 404 }
            );
          },
        });

        const packs = {
          both: await writeVariant(directory, "both", {}),
          noClosing: await writeVariant(directory, "no-closing", { closing: false }),
          noCover: await writeVariant(directory, "no-cover", { cover: false }),
          neither: await writeVariant(directory, "neither", {
            cover: false,
            closing: false,
          }),
          shiftedCut: await writeVariant(directory, "shifted-cut", { stop: 35 }),
          shiftedClosing: await writeVariant(directory, "shifted-closing", {
            closingAlign: "right",
          }),
        };
        const pdfs = {
          both: await exportVariant(directory, server.url.origin, "both", packs.both),
          noClosing: await exportVariant(
            directory,
            server.url.origin,
            "no-closing",
            packs.noClosing
          ),
          noCover: await exportVariant(
            directory,
            server.url.origin,
            "no-cover",
            packs.noCover
          ),
          neither: await exportVariant(
            directory,
            server.url.origin,
            "neither",
            packs.neither
          ),
          shiftedCut: await exportVariant(
            directory,
            server.url.origin,
            "shifted-cut",
            packs.shiftedCut
          ),
          shiftedClosing: await exportVariant(
            directory,
            server.url.origin,
            "shifted-closing",
            packs.shiftedClosing
          ),
        };

        const inspection = validatePdfOutput(pdfs.both);
        const bodyPages = validatePdfOutput(pdfs.neither).pageCount;
        expect(inspection).toMatchObject({
          tagged: true,
          hasOutline: true,
        });
        expect(inspection.embeddedFontFiles).toBeGreaterThan(0);
        expect(inspection.pageCount).toBe(bodyPages + 2);
        expect(validatePdfOutput(pdfs.noClosing).pageCount).toBe(
          inspection.pageCount - 1
        );
        expect(validatePdfOutput(pdfs.noCover).pageCount).toBe(
          inspection.pageCount - 1
        );

        const layout = await poppler(directory, "pdftotext", ["-layout"], pdfs.both);
        const normalized = layout.replace(/\s+/gu, " ").trim();
        const pages = layout.split("\f").filter((page) => page.trim().length > 0);
        expect(occurrences(normalized, WEBSITE_LABEL)).toBe(1);
        expect(occurrences(normalized, LEGAL_NOTICE)).toBe(1);
        const coverText = pages[0]!.replace(/\s+/gu, " ").trim();
        const coverTokens = coverText.split(/\s+/u);
        const closingTokens = pages.at(-1)!.split(/\s+/u);
        for (const word of TITLE.split(" ")) {
          expect(coverTokens.filter((token) => token === word)).toHaveLength(1);
          expect(closingTokens).not.toContain(word);
        }
        expect(pages.at(-1)!).toContain(WEBSITE_LABEL);
        expect(pages.at(-1)!).toContain(LEGAL_NOTICE);

        const links = await poppler(directory, "pdfinfo", ["-url"], pdfs.both);
        const urls = links.match(/https?:\/\/\S+/gu) ?? [];
        expect(urls).toContain(WEBSITE_URL);
        expect(new Set(urls)).toEqual(new Set([WEBSITE_URL]));

        const bbox = parseWordBoxes(
          await poppler(
            directory,
            "pdftotext",
            ["-f", "1", "-l", "1", "-bbox-layout"],
            pdfs.both
          )
        );
        const versionLabel = bbox.find(({ text }) => text === "VERSION");
        expect(versionLabel).toBeDefined();
        expect(versionLabel!.yMin).toBeGreaterThan(650);
        const cover = await rasterPage(directory, pdfs.both, 1);
        assertTitleTracksDiagonal(cover, bbox);
        expect(colorPoints(cover, CYAN)).toHaveLength(0);

        const closingPage = inspection.pageCount;
        const closing = await rasterPage(directory, pdfs.both, closingPage);
        assertClosingRaster(closing);
        const closingWords = parseWordBoxes(
          await poppler(
            directory,
            "pdftotext",
            [
              "-f",
              String(closingPage),
              "-l",
              String(closingPage),
              "-bbox-layout",
            ],
            pdfs.both
          )
        );
        assertLeftClosingWords(closingWords);

        const shiftedCutCover = await rasterPage(directory, pdfs.shiftedCut, 1);
        expect(() => assertTitleTracksDiagonal(shiftedCutCover, bbox)).toThrow();
        const shiftedClosingWords = parseWordBoxes(
          await poppler(
            directory,
            "pdftotext",
            [
              "-f",
              String(closingPage),
              "-l",
              String(closingPage),
              "-bbox-layout",
            ],
            pdfs.shiftedClosing
          )
        );
        expect(() => assertLeftClosingWords(shiftedClosingWords)).toThrow();
      } finally {
        server?.stop(true);
        await rm(directory, { recursive: true, force: true });
      }
    }, 360_000);
  });
}
