/**
 * Opt-in local table-structure model for PDF import: Table Transformer
 * (Microsoft, MIT) as ONNX, run by onnxruntime-node.
 *
 * Neither the weights nor the runtime are dependencies of AtlCLI. The
 * explicit `atlcli models pull table-transformer` downloads both into the
 * models directory with pinned digests; the runtime is imported dynamically
 * only when an import asks for `--table-model table-transformer`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodePngRaster, type DecodedRaster } from "@atlcli/export-media";
import type {
  PdfNormalizedRect,
  PdfTableImageProposalV1,
  PdfTableStructureProposerV1,
} from "@atlcli/import-pdf";

export const TABLE_TRANSFORMER = Object.freeze({
  name: "table-transformer",
  source: "https://huggingface.co/Xenova/table-transformer-structure-recognition",
  revision: "5387550de655512721e1b88e4e42117001ba4813",
  license: "MIT (microsoft/table-transformer-structure-recognition, ONNX conversion by Xenova)",
  variants: {
    fp32: { file: "onnx/model.onnx", sha256: "2c90a63298df61006a45267932f47b345a8b104ce53fd504eacf11aee3c05a41", bytes: 115_811_109 },
    quantized: { file: "onnx/model_quantized.onnx", sha256: "c11f4033da75e9c4d41c403ef356e89caa0a37a7d111b55461e7d5ba856bb6b6", bytes: 30_158_413 },
  },
  runtime: [
    {
      name: "onnxruntime-common",
      tarball: "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.30.0.tgz",
      integrity: "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
    },
    {
      name: "onnxruntime-node",
      tarball: "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz",
      integrity: "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==",
    },
  ],
} as const);

export type TableModelVariant = keyof typeof TABLE_TRANSFORMER.variants;
export type TableModelDevice = "auto" | "cpu" | "gpu";

export function modelsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.ATLCLI_MODELS_DIR?.trim() || join(os.homedir(), ".atlcli", "models");
}

export function tableModelPath(variant: TableModelVariant, root = modelsDirectory()): string {
  return join(root, TABLE_TRANSFORMER.name, TABLE_TRANSFORMER.revision, basename(TABLE_TRANSFORMER.variants[variant].file));
}

export function tableRuntimeDirectory(root = modelsDirectory()): string {
  return join(root, "runtime", "onnxruntime-1.30.0");
}

/** The installed variant, preferring full precision. */
export function installedTableModel(root = modelsDirectory()): { variant: TableModelVariant; path: string } | null {
  for (const variant of ["fp32", "quantized"] as const) {
    const path = tableModelPath(variant, root);
    if (existsSync(path)) return { variant, path };
  }
  return null;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Writes `bytes` to `target` only after the digest check, via a temporary file. */
async function placeVerified(target: string, bytes: Uint8Array): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const temporary = `${target}.partial-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

export interface TableModelPullResult {
  modelPath: string;
  runtimeDirectory: string;
  downloadedBytes: number;
}

/**
 * Downloads the pinned weights and the pinned onnxruntime packages. Each file
 * is verified against its digest before it is written; a mismatch writes
 * nothing.
 */
export async function pullTableTransformer(options: {
  variant: TableModelVariant;
  root?: string;
  fetchImpl?: typeof fetch;
  extract?: (tarball: string, target: string) => Promise<void>;
}): Promise<TableModelPullResult> {
  const root = options.root ?? modelsDirectory();
  const fetchImpl = options.fetchImpl ?? fetch;
  const variant = TABLE_TRANSFORMER.variants[options.variant];
  let downloadedBytes = 0;
  const modelPath = tableModelPath(options.variant, root);
  if (!existsSync(modelPath)) {
    const bytes = await download(`${TABLE_TRANSFORMER.source}/resolve/${TABLE_TRANSFORMER.revision}/${variant.file}`, fetchImpl);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== variant.sha256) throw new Error(`Model digest mismatch: expected ${variant.sha256}, got ${digest}.`);
    await placeVerified(modelPath, bytes);
    downloadedBytes += bytes.byteLength;
  }
  const runtime = tableRuntimeDirectory(root);
  for (const pkg of TABLE_TRANSFORMER.runtime) {
    const target = join(runtime, "node_modules", pkg.name);
    if (existsSync(join(target, "package.json"))) continue;
    const bytes = await download(pkg.tarball, fetchImpl);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== pkg.integrity) throw new Error(`Runtime package ${pkg.name} integrity mismatch.`);
    const scratch = await mkdtemp(join(os.tmpdir(), "atlcli-runtime-"));
    try {
      const tarball = join(scratch, "package.tgz");
      await writeFile(tarball, bytes);
      await mkdir(target, { recursive: true });
      await (options.extract ?? extractTarball)(tarball, target);
      await pruneForeignBinaries(target);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    downloadedBytes += bytes.byteLength;
  }
  return { modelPath, runtimeDirectory: runtime, downloadedBytes };
}

/** The runtime package ships binaries for every platform; keep this one's. */
export async function pruneForeignBinaries(packageDirectory: string, platform = process.platform, arch = process.arch): Promise<void> {
  const bin = join(packageDirectory, "bin");
  if (!existsSync(bin)) return;
  for (const napi of await readdir(bin)) {
    for (const os of await readdir(join(bin, napi))) {
      if (os !== platform) {
        await rm(join(bin, napi, os), { recursive: true, force: true });
        continue;
      }
      for (const cpu of await readdir(join(bin, napi, os))) {
        if (cpu !== arch) await rm(join(bin, napi, os, cpu), { recursive: true, force: true });
      }
    }
  }
}

async function extractTarball(tarball: string, target: string): Promise<void> {
  // npm tarballs hold one top-level "package/" directory.
  const result = Bun.spawnSync(["tar", "-xzf", tarball, "-C", target, "--strip-components=1"], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Cannot extract ${basename(tarball)}: ${result.stderr.toString().trim()}`);
}

// ---------------------------------------------------------------------------
// Inference: pure pre- and postprocessing, then the onnxruntime shell.
// ---------------------------------------------------------------------------

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;
/** Table Transformer resizes the longest edge to 1000 pixels. */
const LONGEST_EDGE = 1000;
/** Class ids of the structure model (id2label). */
const CLASS = { column: 1, row: 2, columnHeader: 3, spanningCell: 5, noObject: 6 } as const;
export const TABLE_MODEL_SCORE_THRESHOLD = 0.5;

/** Bilinear resize to a 1000-pixel longest edge and ImageNet normalization, CHW float32. */
export function preprocessTableImage(raster: DecodedRaster): { data: Float32Array; width: number; height: number } {
  const scale = LONGEST_EDGE / Math.max(raster.width, raster.height);
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const channels = raster.pixels.length / (raster.width * raster.height);
  const data = new Float32Array(3 * width * height);
  const sample = (x: number, y: number, channel: number) => {
    const value = raster.pixels[(y * raster.width + x) * channels + channel]!;
    // Composite transparent pixels on white, as a page is.
    if (channels === 4) {
      const alpha = raster.pixels[(y * raster.width + x) * 4 + 3]! / 255;
      return value * alpha + 255 * (1 - alpha);
    }
    return value;
  };
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(raster.height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(raster.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(raster.width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(raster.width - 1, x0 + 1);
      const fx = sourceX - x0;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = sample(x0, y0, channel) * (1 - fx) + sample(x1, y0, channel) * fx;
        const bottom = sample(x0, y1, channel) * (1 - fx) + sample(x1, y1, channel) * fx;
        data[channel * width * height + y * width + x] = ((top * (1 - fy) + bottom * fy) / 255 - MEAN[channel]!) / STD[channel]!;
      }
    }
  }
  return { data, width, height };
}

function overlapRatio(a: PdfNormalizedRect, b: PdfNormalizedRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return (width * height) / Math.min(a.width * a.height, b.width * b.height);
}

/** Keeps the higher-scoring box of two that mostly cover each other. */
function suppress(boxes: Array<{ box: PdfNormalizedRect; score: number }>): PdfNormalizedRect[] {
  const kept: Array<{ box: PdfNormalizedRect; score: number }> = [];
  for (const candidate of [...boxes].sort((a, b) => b.score - a.score)) {
    if (!kept.some((other) => overlapRatio(other.box, candidate.box) > 0.5)) kept.push(candidate);
  }
  return kept.map((entry) => entry.box);
}

/** Model outputs (DETR logits and centre-size boxes) to an image-relative proposal. */
export function decodeTableTransformerOutput(
  logits: Float32Array,
  boxes: Float32Array,
  threshold = TABLE_MODEL_SCORE_THRESHOLD,
): PdfTableImageProposalV1 {
  const classes = logits.length / (boxes.length / 4);
  const found = new Map<number, Array<{ box: PdfNormalizedRect; score: number }>>();
  for (let query = 0; query < boxes.length / 4; query += 1) {
    const row = logits.subarray(query * classes, query * classes + classes);
    const maximum = Math.max(...row);
    const exps = Array.from(row, (value) => Math.exp(value - maximum));
    const total = exps.reduce((sum, value) => sum + value, 0);
    let best = 0;
    for (let index = 1; index < classes; index += 1) if (exps[index]! > exps[best]!) best = index;
    const score = exps[best]! / total;
    if (best === CLASS.noObject || score < threshold) continue;
    const [cx, cy, w, h] = boxes.subarray(query * 4, query * 4 + 4);
    const box = { x: Math.max(0, cx! - w! / 2), y: Math.max(0, cy! - h! / 2), width: w!, height: h! };
    found.set(best, [...(found.get(best) ?? []), { box, score }]);
  }
  return {
    rows: suppress(found.get(CLASS.row) ?? []),
    columns: suppress(found.get(CLASS.column) ?? []),
    columnHeaders: suppress(found.get(CLASS.columnHeader) ?? []),
    spanningCells: suppress(found.get(CLASS.spanningCell) ?? []),
  };
}

interface OrtModule {
  InferenceSession: { create(path: string, options: { executionProviders: string[] }): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

/** The runtime from the models directory, or an existing installation. */
async function loadOnnxRuntime(root: string): Promise<OrtModule> {
  const pulled = join(tableRuntimeDirectory(root), "node_modules", "onnxruntime-node");
  if (existsSync(join(pulled, "package.json"))) {
    const manifest = JSON.parse(await readFile(join(pulled, "package.json"), "utf8")) as { main?: string };
    return await import(pathToFileURL(join(pulled, manifest.main ?? "dist/index.js")).href) as OrtModule;
  }
  try {
    // A non-literal specifier keeps the bundler from resolving the package.
    const specifier = "onnxruntime-node";
    return await import(specifier) as OrtModule;
  } catch {
    throw new Error("The table model runtime is not installed. Run `atlcli models pull table-transformer`.");
  }
}

export function executionProviders(device: TableModelDevice, platform = process.platform): string[] {
  if (device !== "gpu") return ["cpu"];
  if (platform === "darwin") return ["coreml", "cpu"];
  if (platform === "win32") return ["dml", "cpu"];
  return ["cuda", "cpu"];
}

export async function createTableTransformerProposer(options: { device: TableModelDevice; root?: string }): Promise<PdfTableStructureProposerV1> {
  const root = options.root ?? modelsDirectory();
  const model = installedTableModel(root);
  if (!model) throw new Error("The table model is not installed. Run `atlcli models pull table-transformer`.");
  const ort = await loadOnnxRuntime(root);
  const session = await ort.InferenceSession.create(model.path, { executionProviders: executionProviders(options.device) });
  return {
    id: `table-transformer@${TABLE_TRANSFORMER.revision.slice(0, 12)}:${model.variant}`,
    async propose(request) {
      const raster = decodePngRaster(request.image.bytes);
      if (!raster) return null;
      const input = preprocessTableImage(raster);
      const output = await session.run({
        [session.inputNames[0]!]: new ort.Tensor("float32", input.data, [1, 3, input.height, input.width]),
      });
      return decodeTableTransformerOutput(output.logits!.data as Float32Array, output.pred_boxes!.data as Float32Array);
    },
  };
}
