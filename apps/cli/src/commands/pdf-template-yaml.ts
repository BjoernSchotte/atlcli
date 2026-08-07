/**
 * Filesystem/YAML adapter for declarative PDF template recipes.
 *
 * This is the only layer allowed to interpret YAML or local recipe asset
 * paths. The PDF package receives a validated object plus resolved bytes.
 */
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { sha256Hex } from "@atlcli/core";
import {
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
} from "@atlcli/pdf";
import {
  materializePdfTemplateRecipeV1,
  type MaterializedPdfTemplateRecipeV1,
  type ResolvedPdfTemplateRecipeAssetV1,
} from "@atlcli/pdf/internal";
import type { TemplateGeneratedPackCompilerV1 } from "@atlcli/pdf-template-authoring";
import {
  MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES,
  migratePdfTemplateRecipeToTypst0151V1,
  validatePdfTemplateRecipeV1,
  type TemplateAssetMediaTypeV1,
  type WikiPdfTemplateRecipeV1,
} from "@atlcli/template-pack";
import {
  LineCounter,
  isAlias,
  isNode,
  isScalar,
  parseAllDocuments,
  stringify,
  visit,
  type Document,
  type ParsedNode,
} from "yaml";

export const PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES = 1024 * 1024;
export const PDF_TEMPLATE_RECIPE_MAX_YAML_NODES = 10_000;
export const PDF_TEMPLATE_RECIPE_MAX_YAML_DEPTH = 64;
export const PDF_TEMPLATE_RECIPE_MAX_SCALAR_CODE_POINTS = 262_144;

export type PdfTemplateInputKind =
  | "project"
  | "recipe"
  | "missing"
  | "unsupported";

export class PdfTemplateYamlError extends Error {
  constructor(
    readonly kind: "io" | "validation",
    message: string,
    readonly details: {
      path?: string;
      line?: number;
      column?: number;
    } = {}
  ) {
    super(message);
    this.name = "PdfTemplateYamlError";
  }
}

function failValidation(
  message: string,
  details: PdfTemplateYamlError["details"] = {}
): never {
  throw new PdfTemplateYamlError("validation", message, details);
}

function failIo(message: string): never {
  throw new PdfTemplateYamlError("io", message);
}

export async function classifyPdfTemplateInput(
  path: string
): Promise<PdfTemplateInputKind> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (info.isSymbolicLink()) return "unsupported";
  if (info.isDirectory()) return "project";
  const extension = extname(path).toLowerCase();
  if (info.isFile() && (extension === ".yaml" || extension === ".yml")) {
    return "recipe";
  }
  return "unsupported";
}

function position(
  lineCounter: LineCounter,
  offset: number | undefined
): { line?: number; column?: number } {
  if (offset === undefined) return {};
  const located = lineCounter.linePos(offset);
  return { line: located.line, column: located.col };
}

function parserMessage(
  message: string,
  details: { line?: number; column?: number }
): string {
  const location =
    details.line === undefined
      ? ""
      : ` at line ${details.line}, column ${details.column ?? 1}`;
  return `Invalid PDF template recipe YAML${location}: ${message}`;
}

function inspectYamlAst(
  document: Document.Parsed<ParsedNode, true>,
  lineCounter: LineCounter
): void {
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (!isNode(node)) return;
    nodes += 1;
    const located = position(lineCounter, node.range?.[0]);
    if (nodes > PDF_TEMPLATE_RECIPE_MAX_YAML_NODES) {
      failValidation(parserMessage("node budget exceeded", located), located);
    }
    if (path.length > PDF_TEMPLATE_RECIPE_MAX_YAML_DEPTH) {
      failValidation(parserMessage("nesting depth exceeded", located), located);
    }
    if (isAlias(node)) {
      const located = position(lineCounter, node.range?.[0]);
      failValidation(
        parserMessage("anchors and aliases are disabled", located),
        located
      );
    }
    if ("anchor" in node && typeof node.anchor === "string") {
      failValidation(
        parserMessage("anchors and aliases are disabled", located),
        located
      );
    }
    if (
      isScalar(node) &&
      typeof node.value === "string" &&
      [...node.value].length > PDF_TEMPLATE_RECIPE_MAX_SCALAR_CODE_POINTS
    ) {
      failValidation(parserMessage("scalar budget exceeded", located), located);
    }
  });
}

function semanticError(error: unknown): PdfTemplateYamlError {
  if (error instanceof PdfTemplateYamlError) return error;
  const path =
    error && typeof error === "object" && "path" in error
      ? String((error as { path?: unknown }).path ?? "") || undefined
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new PdfTemplateYamlError(
    "validation",
    `Invalid PDF template recipe${path ? ` at ${path}` : ""}: ${message}`,
    path ? { path } : {}
  );
}

/** Parse one bounded YAML 1.2/core document and validate the recipe contract. */
export function parsePdfTemplateRecipeYaml(
  source: string
): WikiPdfTemplateRecipeV1 {
  if (new TextEncoder().encode(source).byteLength > PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES) {
    failValidation(
      `PDF template recipe YAML exceeds ${PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES} bytes`
    );
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    customTags: [],
    merge: false,
    resolveKnownTags: false,
    uniqueKeys: true,
    stringKeys: true,
    strict: true,
    prettyErrors: false,
    lineCounter,
  });
  if (documents.length !== 1) {
    failValidation("PDF template recipe YAML must contain exactly one document");
  }
  const document = documents[0]!;
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) {
    const located = issue.linePos?.[0]
      ? { line: issue.linePos[0].line, column: issue.linePos[0].col }
      : position(lineCounter, issue.pos?.[0]);
    failValidation(parserMessage(issue.message, located), located);
  }
  inspectYamlAst(document, lineCounter);
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw semanticError(error);
  }
  try {
    return validatePdfTemplateRecipeV1(value);
  } catch (error) {
    throw semanticError(error);
  }
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function mediaTypeFor(path: string): TemplateAssetMediaTypeV1 {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      failValidation(`Recipe asset ${path} must use .png, .jpg, .jpeg, or .svg`);
  }
}

async function readRecipeFile(path: string): Promise<string> {
  const kind = await classifyPdfTemplateInput(path);
  if (kind !== "recipe") {
    if (kind === "missing") failIo(`PDF template recipe does not exist: ${path}`);
    failValidation(`PDF template recipe must be a non-symlink .yaml or .yml file`);
  }
  const info = await lstat(path);
  if (info.size > PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES) {
    failValidation(
      `PDF template recipe YAML exceeds ${PDF_TEMPLATE_RECIPE_MAX_YAML_BYTES} bytes`
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error) {
    if (error instanceof TypeError) {
      failValidation("PDF template recipe YAML must be valid UTF-8");
    }
    failIo(`Could not read PDF template recipe: ${path}`);
  }
}

async function resolveRecipeAssets(
  recipePath: string,
  recipe: WikiPdfTemplateRecipeV1
): Promise<Readonly<Record<string, ResolvedPdfTemplateRecipeAssetV1>>> {
  const recipeRoot = await realpath(dirname(recipePath));
  const pending: {
    slot: string;
    source: string;
    path: string;
    size: number;
    mediaType: TemplateAssetMediaTypeV1;
  }[] = [];
  let aggregate = 0;
  for (const [slot, declaration] of Object.entries(recipe.assets).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const unresolved = resolve(recipeRoot, declaration.source);
    if (!contained(recipeRoot, unresolved)) {
      failValidation(`Recipe asset ${slot} escapes the recipe directory`, {
        path: `recipe.assets.${slot}.source`,
      });
    }
    let directInfo;
    let canonical;
    try {
      directInfo = await lstat(unresolved);
      canonical = await realpath(unresolved);
    } catch {
      failValidation(`Recipe asset ${slot} could not be resolved`, {
        path: `recipe.assets.${slot}.source`,
      });
    }
    if (directInfo.isSymbolicLink() || !contained(recipeRoot, canonical)) {
      failValidation(`Recipe asset ${slot} escapes through a symbolic link`, {
        path: `recipe.assets.${slot}.source`,
      });
    }
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) {
      failValidation(`Recipe asset ${slot} must resolve to a regular file`, {
        path: `recipe.assets.${slot}.source`,
      });
    }
    if (info.size > PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxBytes) {
      failValidation(`Recipe asset ${slot} exceeds the per-file byte budget`, {
        path: `recipe.assets.${slot}.source`,
      });
    }
    aggregate += info.size;
    if (aggregate > MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES) {
      failValidation("Recipe assets exceed the aggregate byte budget", {
        path: "recipe.assets",
      });
    }
    pending.push({
      slot,
      source: declaration.source,
      path: canonical,
      size: info.size,
      mediaType: mediaTypeFor(declaration.source),
    });
  }

  const entries: [string, ResolvedPdfTemplateRecipeAssetV1][] = [];
  for (const asset of pending) {
    const bytes = new Uint8Array(await readFile(asset.path));
    if (bytes.byteLength !== asset.size) {
      failValidation(`Recipe asset ${asset.slot} changed while it was read`, {
        path: `recipe.assets.${asset.slot}.source`,
      });
    }
    entries.push([
      asset.slot,
      {
        slot: asset.slot,
        source: asset.source,
        mediaType: asset.mediaType,
        sha256: await sha256Hex(bytes),
        bytes,
      },
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export interface MaterializePdfTemplateYamlInputV1 {
  recipePath: string;
  compiler: TemplateGeneratedPackCompilerV1;
}

export async function materializePdfTemplateYamlRecipe(
  input: MaterializePdfTemplateYamlInputV1
): Promise<MaterializedPdfTemplateRecipeV1> {
  const absolute = resolve(input.recipePath);
  const source = await readRecipeFile(absolute);
  const recipe = parsePdfTemplateRecipeYaml(source);
  const resolvedAssets = await resolveRecipeAssets(absolute, recipe);
  try {
    return await materializePdfTemplateRecipeV1({
      recipe,
      resolvedAssets,
      compiler: input.compiler,
    });
  } catch (error) {
    throw semanticError(error);
  }
}

export async function migratePdfTemplateYamlRecipeToTypst0151(
  inputPath: string,
  outputPath: string
): Promise<WikiPdfTemplateRecipeV1> {
  const sourcePath = resolve(inputPath);
  const recipe = parsePdfTemplateRecipeYaml(await readRecipeFile(sourcePath));
  const migrated = migratePdfTemplateRecipeToTypst0151V1(recipe);
  const yaml = stringify(migrated, { lineWidth: 0 });
  await writeNoClobber(outputPath, new TextEncoder().encode(yaml), "recipe");
  return migrated;
}

async function writeNoClobber(
  outputPath: string,
  bytes: Uint8Array,
  kind: "archive" | "recipe"
): Promise<void> {
  const target = resolve(outputPath);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = resolve(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await link(temporary, target);
    published = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      failValidation(`Refusing to overwrite existing output ${outputPath}`);
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  if (!published) failIo(`Could not publish PDF template ${kind}: ${outputPath}`);
}

/** Atomically publish a verified archive without overwriting an existing file. */
export async function writePdfTemplateRecipeArchive(
  outputPath: string,
  bytes: Uint8Array
): Promise<void> {
  await writeNoClobber(outputPath, bytes, "archive");
}
