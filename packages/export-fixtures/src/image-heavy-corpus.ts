/**
 * Deterministic image-heavy corpus (issue #118 Phase 0).
 *
 * Generates the "image-heavy" benchmark corpus from
 * `specs/issue-118-adaptive-browser-pdf-memory/PLAN.md`: at least 100 MiB of
 * aggregate realistic *compressed* PNG/JPEG at scale 1, with transparency,
 * repeated assets, and both inline and full-width placements — produced at
 * test time from `(seed, scale)` so no blob is ever committed.
 *
 * Determinism is the whole point, so the module ships its own pinned
 * encoders instead of using canvas, zlib bindings, or CompressionStream:
 *
 * - a baseline JPEG encoder (Annex K quantization/Huffman tables, 4:4:4,
 *   integer-reduced cosine constants — no runtime `Math.cos`/`sin`/`pow`,
 *   whose last-ulp results differ between JS engines);
 * - a PNG encoder with Paeth filtering and a fixed-Huffman DEFLATE with
 *   greedy LZ77 matching (RFC 1951), plus zlib wrapper and CRC/Adler32;
 * - a synchronous pure SHA-256 for the per-asset and manifest hashes.
 *
 * Content is photograph-like (multi-octave bilinear value noise, smooth
 * gradients) and screenshot-like (flat panels, text dashes) precisely so the
 * bytes *compress like real pages* — seeded per-pixel noise does not.
 *
 * Like `large-export-corpus.ts`, this module is IO-free and browser-safe.
 */
import type { ExportBlock, InlineNode } from "@atlcli/confluence/browser";
import { encodeJpeg, encodePng, sha256Hex } from "@atlcli/export-media";

export { sha256Hex };

export const IMAGE_HEAVY_CORPUS_SCHEMA = "atlcli.image-heavy-corpus/1" as const;
export const IMAGE_HEAVY_CORPUS_DEFAULT_SEED = 0x1837_c0de;

/** Aggregate unique compressed bytes required at scale 1 (plan corpus table). */
export const IMAGE_HEAVY_MIN_AGGREGATE_BYTES = 100 * 1024 * 1024;

export interface ImageHeavyCorpusOptions {
  seed?: number;
  /**
   * Linear dimension factor in (0, 1]. Pixel counts and therefore compressed
   * bytes scale ~quadratically; the aggregate target scales with `scale²` so
   * small-scale corpora stay cheap for unit tests while exercising the same
   * code paths.
   */
  scale?: number;
}

export type ImageHeavyAssetRole = "photo" | "screenshot" | "diagram" | "logo";

export interface ImageHeavyAsset {
  filename: string;
  mediaType: "image/jpeg" | "image/png";
  role: ImageHeavyAssetRole;
  width: number;
  height: number;
  alpha: boolean;
  bytes: Uint8Array;
  sha256: string;
}

export interface ImageHeavyManifestEntry {
  filename: string;
  mediaType: "image/jpeg" | "image/png";
  role: ImageHeavyAssetRole;
  width: number;
  height: number;
  alpha: boolean;
  byteLength: number;
  sha256: string;
  placements: number;
}

export interface ImageHeavyCorpusCounts {
  uniqueAssets: number;
  uniqueAssetBytes: number;
  jpegBytes: number;
  pngBytes: number;
  alphaAssets: number;
  chapters: number;
  blocks: number;
  placements: number;
  inlinePlacements: number;
  fullWidthPlacements: number;
  logoPlacements: number;
}

export interface ImageHeavyCorpus {
  schema: typeof IMAGE_HEAVY_CORPUS_SCHEMA;
  seed: number;
  scale: number;
  minAggregateBytes: number;
  assets: ImageHeavyAsset[];
  blocks: ExportBlock[];
  manifest: ImageHeavyManifestEntry[];
  /** Pinnable digest over the manifest (recipe version + every asset hash). */
  manifestSha256: string;
  counts: ImageHeavyCorpusCounts;
}

/* ------------------------------------------------------------------------- *
 * Seeded randomness (same generator family as large-export-corpus).
 * ------------------------------------------------------------------------- */

interface RandomSource {
  next(): number;
  int(maxExclusive: number): number;
}

function randomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b_79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    },
    int(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
  };
}






/* ------------------------------------------------------------------------- *
 * Deterministic content synthesis.
 * ------------------------------------------------------------------------- */

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Multi-octave bilinear value noise in [0, 1] — smooth, photograph-like. */
function valueNoiseField(
  width: number,
  height: number,
  seed: number,
  octaves: Array<{ cell: number; weight: number }>
): Float64Array {
  const field = new Float64Array(width * height);
  let totalWeight = 0;
  for (const octave of octaves) totalWeight += octave.weight;
  for (let octaveIndex = 0; octaveIndex < octaves.length; octaveIndex += 1) {
    const { cell, weight } = octaves[octaveIndex]!;
    const latticeWidth = Math.ceil(width / cell) + 2;
    const latticeHeight = Math.ceil(height / cell) + 2;
    const random = randomSource((seed ^ Math.imul(octaveIndex + 1, 0x85eb_ca6b)) >>> 0);
    const lattice = new Float64Array(latticeWidth * latticeHeight);
    for (let i = 0; i < lattice.length; i += 1) lattice[i] = random.next();
    for (let y = 0; y < height; y += 1) {
      const gy = y / cell;
      const y0 = Math.floor(gy);
      const ty = smoothstep(gy - y0);
      for (let x = 0; x < width; x += 1) {
        const gx = x / cell;
        const x0 = Math.floor(gx);
        const tx = smoothstep(gx - x0);
        const i00 = lattice[y0 * latticeWidth + x0]!;
        const i10 = lattice[y0 * latticeWidth + x0 + 1]!;
        const i01 = lattice[(y0 + 1) * latticeWidth + x0]!;
        const i11 = lattice[(y0 + 1) * latticeWidth + x0 + 1]!;
        const top = i00 + (i10 - i00) * tx;
        const bottom = i01 + (i11 - i01) * tx;
        field[y * width + x]! += (top + (bottom - top) * ty) * (weight / totalWeight);
      }
    }
  }
  return field;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.floor(value);
}

/**
 * Photograph-like RGB content: layered smooth noise through a color ramp,
 * plus fine texture and sensor-style grain. The detail layers are what make
 * the JPEG land in a realistic 0.3–1.5 bytes/pixel band — perfectly smooth
 * gradients under-compress the corpus into uselessness, and pure per-pixel
 * noise over-compresses nothing at all.
 */
function photoPixels(width: number, height: number, seed: number): Uint8Array {
  // Smooth composition field: color blend and lighting.
  const base = valueNoiseField(width, height, seed, [
    { cell: Math.max(8, Math.floor(width / 4)), weight: 4 },
    { cell: Math.max(6, Math.floor(width / 12)), weight: 2 },
    { cell: Math.max(4, Math.floor(width / 40)), weight: 1 },
  ]);
  // Fine texture field: foliage/fabric-style luminance modulation. This is
  // where realistic JPEG bytes come from — coefficients must be large enough
  // to survive quantization, unlike faint grain.
  const detail = valueNoiseField(width, height, seed ^ 0x27d4_eb2f, [
    { cell: 6, weight: 1 },
    { cell: 3, weight: 1 },
    { cell: 2, weight: 0.8 },
  ]);
  // Medium-scale patch field thresholded into hard-edged regions (rocks,
  // shadows, foliage clumps): step edges carry high-frequency energy.
  const patches = valueNoiseField(width, height, seed ^ 0x165_667b1, [
    { cell: Math.max(6, Math.floor(width / 20)), weight: 1 },
    { cell: Math.max(4, Math.floor(width / 60)), weight: 0.5 },
  ]);
  const tint = randomSource(seed ^ 0x5bd1_e995);
  const skyR = 90 + tint.int(90);
  const skyG = 110 + tint.int(80);
  const skyB = 140 + tint.int(80);
  const groundR = 40 + tint.int(70);
  const groundG = 60 + tint.int(70);
  const groundB = 30 + tint.int(60);
  const pixels = new Uint8Array(width * height * 3);
  const centerX = width / 2;
  const centerY = height / 2;
  const maxDistance = centerX * centerX + centerY * centerY;
  let grainState = (seed ^ 0x9e37_79b9) >>> 0;
  for (let y = 0; y < height; y += 1) {
    const vertical = y / height;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const noise = base[index]!;
      const dx = x - centerX;
      const dy = y - centerY;
      const vignette = 1 - (0.28 * (dx * dx + dy * dy)) / maxDistance;
      const blend = Math.min(1, Math.max(0, vertical * 1.2 - 0.1 + (noise - 0.5) * 0.7));
      const patch = patches[index]!;
      const shading = patch > 0.62 ? 0.55 : patch < 0.34 ? 1.18 : 1;
      const texture = 1 + 0.4 * (detail[index]! - 0.5);
      const light = (0.55 + 0.7 * noise) * vignette * shading * texture;
      grainState = (Math.imul(grainState, 1_664_525) + 1_013_904_223) >>> 0;
      const grain = ((grainState >>> 24) & 0x1f) - 15.5;
      const offset = index * 3;
      pixels[offset] = clampByte((skyR + (groundR - skyR) * blend) * light + grain);
      pixels[offset + 1] = clampByte((skyG + (groundG - skyG) * blend) * light + grain);
      pixels[offset + 2] = clampByte((skyB + (groundB - skyB) * blend) * light + grain);
    }
  }
  return pixels;
}

function fillRect(
  pixels: Uint8Array,
  width: number,
  channels: number,
  x0: number,
  y0: number,
  rectWidth: number,
  rectHeight: number,
  color: number[]
): void {
  for (let y = y0; y < y0 + rectHeight; y += 1) {
    for (let x = x0; x < x0 + rectWidth; x += 1) {
      const offset = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) pixels[offset + c] = color[c]!;
    }
  }
}

/**
 * Screenshot-like RGB content: flat panels, header, sidebar, text dashes,
 * plus one textured "hero image" region — real page screenshots embed
 * photos/previews, and that region is what gives a screenshot PNG both its
 * realistic byte weight and a non-trivial decoded footprint.
 */
function screenshotPixels(width: number, height: number, seed: number): Uint8Array {
  const random = randomSource(seed);
  const pixels = new Uint8Array(width * height * 3);
  fillRect(pixels, width, 3, 0, 0, width, height, [248, 249, 251]);
  const headerHeight = Math.max(24, Math.floor(height * 0.07));
  fillRect(pixels, width, 3, 0, 0, width, headerHeight, [23, 43, 77]);
  const sidebarWidth = Math.max(32, Math.floor(width * 0.18));
  fillRect(pixels, width, 3, 0, headerHeight, sidebarWidth, height - headerHeight, [235, 237, 240]);
  const accent = [
    [38, 132, 255],
    [0, 135, 90],
    [222, 53, 11],
    [101, 84, 192],
  ][random.int(4)]!;

  const contentX = sidebarWidth + Math.floor(width * 0.03);
  const contentWidth = width - contentX - Math.floor(width * 0.03);

  // Hero image region under the header: duotone-textured, grainy.
  const heroHeight = Math.max(24, Math.floor(height * 0.24));
  const heroY = headerHeight + Math.floor(height * 0.03);
  const hero = valueNoiseField(contentWidth, heroHeight, seed ^ 0x4e60, [
    { cell: Math.max(8, Math.floor(contentWidth / 10)), weight: 2 },
    { cell: 4, weight: 1 },
    { cell: 2, weight: 0.6 },
  ]);
  let heroGrain = (seed ^ 0x00c0_ffee) >>> 0;
  for (let y = 0; y < heroHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      const value = hero[y * contentWidth + x]!;
      heroGrain = (Math.imul(heroGrain, 1_664_525) + 1_013_904_223) >>> 0;
      const grain = ((heroGrain >>> 26) & 0x07) - 3.5;
      const offset = ((heroY + y) * width + contentX + x) * 3;
      pixels[offset] = clampByte(40 + accent[0]! * value * 0.75 + grain);
      pixels[offset + 1] = clampByte(46 + accent[1]! * value * 0.75 + grain);
      pixels[offset + 2] = clampByte(58 + accent[2]! * value * 0.75 + grain);
    }
  }

  let cursorY = heroY + heroHeight + Math.floor(height * 0.02);
  while (cursorY < height - 40) {
    const panelHeight = Math.min(height - cursorY - 8, 60 + random.int(120));
    fillRect(pixels, width, 3, contentX, cursorY, contentWidth, panelHeight, [255, 255, 255]);
    fillRect(pixels, width, 3, contentX, cursorY, contentWidth, 2, [223, 225, 230]);
    fillRect(pixels, width, 3, contentX, cursorY + 8, Math.floor(contentWidth * 0.3), 10, accent);
    let lineY = cursorY + 28;
    while (lineY < cursorY + panelHeight - 12) {
      let dashX = contentX + 12;
      const lineEnd = contentX + contentWidth - 16 - random.int(Math.floor(contentWidth * 0.3));
      while (dashX < lineEnd) {
        const dashWidth = 12 + random.int(48);
        const clipped = Math.min(dashWidth, lineEnd - dashX);
        fillRect(pixels, width, 3, dashX, lineY, clipped, 6, [66, 82, 110]);
        dashX += clipped + 6 + random.int(10);
      }
      lineY += 16;
    }
    cursorY += panelHeight + Math.floor(height * 0.02);
  }
  return pixels;
}

/** Diagram-like RGBA content with a genuinely transparent background. */
function diagramPixels(width: number, height: number, seed: number): Uint8Array {
  const random = randomSource(seed);
  const pixels = new Uint8Array(width * height * 4); // alpha 0 everywhere first
  const nodeWidth = Math.max(48, Math.floor(width * 0.18));
  const nodeHeight = Math.max(32, Math.floor(height * 0.22));
  const laneY = [Math.floor(height * 0.18), Math.floor(height * 0.55)];
  const palette = [
    [222, 235, 255, 255],
    [212, 244, 230, 255],
    [255, 235, 213, 255],
    [234, 230, 255, 255],
  ];
  for (const y of laneY) {
    for (let column = 0; column < 3; column += 1) {
      const x = Math.floor(width * 0.08 + column * width * 0.32);
      // soft shadow: semi-transparent, exercises non-trivial alpha values
      fillRect(pixels, width, 4, x + 6, y + 6, nodeWidth, nodeHeight, [23, 43, 77, 96]);
      fillRect(pixels, width, 4, x, y, nodeWidth, nodeHeight, palette[random.int(4)]!);
      fillRect(pixels, width, 4, x, y, nodeWidth, 4, [23, 43, 77, 255]);
      if (column < 2) {
        const connectorY = y + Math.floor(nodeHeight / 2);
        fillRect(
          pixels, width, 4,
          x + nodeWidth, connectorY - 2, Math.floor(width * 0.32) - nodeWidth, 4,
          [23, 43, 77, 255]
        );
      }
    }
  }
  return pixels;
}

/** Small logo tile (RGBA) reused across every chapter for dedup pressure. */
function logoPixels(width: number, height: number, seed: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const random = randomSource(seed);
  const hueSeed = random.int(3);
  const color = [[0, 82, 204, 255], [0, 135, 90, 255], [101, 84, 192, 255]][hueSeed]!;
  fillRect(pixels, width, 4, 0, 0, width, height, [255, 255, 255, 0]);
  const bar = Math.floor(height / 5);
  fillRect(pixels, width, 4, 0, bar, width, bar, color);
  fillRect(pixels, width, 4, 0, bar * 3, Math.floor(width * 0.7), bar, [23, 43, 77, 255]);
  return pixels;
}

/* ------------------------------------------------------------------------- *
 * Corpus assembly.
 * ------------------------------------------------------------------------- */

function roundToBlocks(value: number): number {
  return Math.max(64, Math.floor(value / 8) * 8);
}

const FULL_SCALE = {
  photo: { width: 2400, height: 1792, quality: 88, count: 12 },
  screenshot: { width: 2200, height: 1400, count: 12 },
  diagram: { width: 2000, height: 1200, count: 6 },
  logo: { width: 400, height: 160 },
  maxTopUpPhotos: 64,
} as const;

export function generateImageHeavyCorpus(
  options: ImageHeavyCorpusOptions = {}
): ImageHeavyCorpus {
  const seed = (options.seed ?? IMAGE_HEAVY_CORPUS_DEFAULT_SEED) >>> 0;
  const scale = options.scale ?? 1;
  if (!(scale > 0 && scale <= 1)) {
    throw new Error("The image-heavy corpus scale must be in (0, 1].");
  }
  const minAggregateBytes = Math.ceil(IMAGE_HEAVY_MIN_AGGREGATE_BYTES * scale * scale);

  const photoWidth = roundToBlocks(FULL_SCALE.photo.width * scale);
  const photoHeight = roundToBlocks(FULL_SCALE.photo.height * scale);
  const screenshotWidth = roundToBlocks(FULL_SCALE.screenshot.width * scale);
  const screenshotHeight = roundToBlocks(FULL_SCALE.screenshot.height * scale);
  const diagramWidth = roundToBlocks(FULL_SCALE.diagram.width * scale);
  const diagramHeight = roundToBlocks(FULL_SCALE.diagram.height * scale);
  const logoWidth = roundToBlocks(FULL_SCALE.logo.width * Math.max(scale, 0.25));
  const logoHeight = roundToBlocks(FULL_SCALE.logo.height * Math.max(scale, 0.25));

  const assets: ImageHeavyAsset[] = [];
  let aggregateBytes = 0;

  const pushAsset = (asset: Omit<ImageHeavyAsset, "sha256">): void => {
    assets.push({ ...asset, sha256: sha256Hex(asset.bytes) });
    aggregateBytes += asset.bytes.byteLength;
  };

  for (let index = 0; index < FULL_SCALE.screenshot.count; index += 1) {
    const bytes = encodePng(
      screenshotPixels(screenshotWidth, screenshotHeight, seed ^ (0x51ee + index)),
      screenshotWidth, screenshotHeight, false
    );
    pushAsset({
      filename: `screenshot-${index + 1}.png`,
      mediaType: "image/png",
      role: "screenshot",
      width: screenshotWidth,
      height: screenshotHeight,
      alpha: false,
      bytes,
    });
  }
  for (let index = 0; index < FULL_SCALE.diagram.count; index += 1) {
    const bytes = encodePng(
      diagramPixels(diagramWidth, diagramHeight, seed ^ (0xd1a6 + index)),
      diagramWidth, diagramHeight, true
    );
    pushAsset({
      filename: `diagram-${index + 1}.png`,
      mediaType: "image/png",
      role: "diagram",
      width: diagramWidth,
      height: diagramHeight,
      alpha: true,
      bytes,
    });
  }
  pushAsset({
    filename: "corpus-logo.png",
    mediaType: "image/png",
    role: "logo",
    width: logoWidth,
    height: logoHeight,
    alpha: true,
    bytes: encodePng(logoPixels(logoWidth, logoHeight, seed ^ 0x1060), logoWidth, logoHeight, true),
  });

  // Photos carry the bulk of the aggregate; keep adding unique ones until the
  // scale-adjusted minimum is guaranteed, so the ≥100 MiB claim is enforced by
  // construction rather than by hoping the fixed counts land above it.
  let photoIndex = 0;
  while (
    photoIndex < FULL_SCALE.photo.count ||
    (aggregateBytes < minAggregateBytes && photoIndex < FULL_SCALE.photo.count + FULL_SCALE.maxTopUpPhotos)
  ) {
    const bytes = encodeJpeg(
      photoPixels(photoWidth, photoHeight, seed ^ (0xf070 + photoIndex * 7)),
      photoWidth, photoHeight, FULL_SCALE.photo.quality
    );
    pushAsset({
      filename: `photo-${photoIndex + 1}.jpg`,
      mediaType: "image/jpeg",
      role: "photo",
      width: photoWidth,
      height: photoHeight,
      alpha: false,
      bytes,
    });
    photoIndex += 1;
  }
  if (aggregateBytes < minAggregateBytes) {
    throw new Error(
      `The image-heavy corpus recipe cannot reach its aggregate minimum: ` +
        `${aggregateBytes} < ${minAggregateBytes} bytes after ${photoIndex} photos.`
    );
  }

  const photos = assets.filter((asset) => asset.role === "photo");
  const screenshots = assets.filter((asset) => asset.role === "screenshot");
  const diagrams = assets.filter((asset) => asset.role === "diagram");
  const logo = assets.find((asset) => asset.role === "logo")!;

  const placements = new Map<string, number>();
  const placed = (filename: string): string => {
    placements.set(filename, (placements.get(filename) ?? 0) + 1);
    return filename;
  };

  const blocks: ExportBlock[] = [];
  let inlinePlacements = 0;
  let fullWidthPlacements = 0;
  let logoPlacements = 0;
  const chapters = photos.length;
  for (let chapter = 0; chapter < chapters; chapter += 1) {
    const photo = photos[chapter]!;
    blocks.push({
      type: "heading",
      level: 1,
      content: [{ type: "text", text: `Image-heavy chapter ${chapter + 1}` }],
    });
    blocks.push({
      type: "image",
      source: { kind: "attachment", filename: placed(logo.filename) },
      alt: "Corpus logo",
    });
    logoPlacements += 1;
    blocks.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text:
            "Deterministic image-heavy corpus chapter exercising realistic " +
            "compressed media, repeats, and mixed placements.",
        },
      ],
    });
    blocks.push({
      type: "image",
      source: { kind: "attachment", filename: placed(photo.filename) },
      alt: `Photographic fixture ${chapter + 1}`,
    });
    fullWidthPlacements += 1;

    const screenshot = screenshots[chapter % screenshots.length]!;
    const inlineMedia: InlineNode = {
      type: "media",
      media: { filename: screenshot.filename },
      source: { kind: "attachment", filename: placed(screenshot.filename) },
      alt: `Inline screenshot ${chapter + 1}`,
    };
    blocks.push({
      type: "paragraph",
      content: [
        { type: "text", text: "Wrapped inline media " },
        inlineMedia,
        { type: "text", text: " inside running text keeps the inline path exercised." },
      ],
    });
    inlinePlacements += 1;

    if (chapter % 3 === 0) {
      const diagram = diagrams[Math.floor(chapter / 3) % diagrams.length]!;
      blocks.push({
        type: "image",
        source: { kind: "attachment", filename: placed(diagram.filename) },
        alt: `Transparent diagram ${chapter + 1}`,
      });
      fullWidthPlacements += 1;
    }
    if (chapter < chapters - 1) blocks.push({ type: "pageBreak" });
  }

  const manifest: ImageHeavyManifestEntry[] = assets.map((asset) => ({
    filename: asset.filename,
    mediaType: asset.mediaType,
    role: asset.role,
    width: asset.width,
    height: asset.height,
    alpha: asset.alpha,
    byteLength: asset.bytes.byteLength,
    sha256: asset.sha256,
    placements: placements.get(asset.filename) ?? 0,
  }));

  const manifestDescriptor =
    `${IMAGE_HEAVY_CORPUS_SCHEMA}|seed=${seed}|scale=${scale}|` +
    manifest
      .map(
        (entry) =>
          `${entry.filename}|${entry.mediaType}|${entry.width}x${entry.height}|` +
          `${entry.byteLength}|${entry.sha256}|${entry.placements}`
      )
      .join("|");
  const manifestSha256 = sha256Hex(new TextEncoder().encode(manifestDescriptor));

  const counts: ImageHeavyCorpusCounts = {
    uniqueAssets: assets.length,
    uniqueAssetBytes: aggregateBytes,
    jpegBytes: assets
      .filter((asset) => asset.mediaType === "image/jpeg")
      .reduce((total, asset) => total + asset.bytes.byteLength, 0),
    pngBytes: assets
      .filter((asset) => asset.mediaType === "image/png")
      .reduce((total, asset) => total + asset.bytes.byteLength, 0),
    alphaAssets: assets.filter((asset) => asset.alpha).length,
    chapters,
    blocks: blocks.length,
    placements: [...placements.values()].reduce((total, count) => total + count, 0),
    inlinePlacements,
    fullWidthPlacements,
    logoPlacements,
  };

  return {
    schema: IMAGE_HEAVY_CORPUS_SCHEMA,
    seed,
    scale,
    minAggregateBytes,
    assets,
    blocks,
    manifest,
    manifestSha256,
    counts,
  };
}

/** Resolve a corpus asset by attachment filename (throws on a miss). */
export function resolveImageHeavyAsset(
  corpus: ImageHeavyCorpus,
  filename: string
): { bytes: Uint8Array; mediaType: string; filename: string } {
  const asset = corpus.assets.find((candidate) => candidate.filename === filename);
  if (!asset) throw new Error(`Unknown image-heavy corpus asset: ${filename}`);
  return { bytes: asset.bytes, mediaType: asset.mediaType, filename: asset.filename };
}
