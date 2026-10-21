/**
 * Optional local models: `atlcli models pull|list`.
 */
import { existsSync } from "node:fs";
import { ERROR_CODES, fail, getFlag, hasFlag, output, type OutputOptions } from "@atlcli/core";
import {
  TABLE_TRANSFORMER,
  installedTableModel,
  modelsDirectory,
  pullTableTransformer,
  tableModelPath,
  tableRuntimeDirectory,
  type TableModelVariant,
} from "../table-model.js";

export function modelsHelp(): string {
  return `atlcli models <command>

Optional local models. Nothing is downloaded unless you run \`pull\`.

Commands:
  pull table-transformer [--variant fp32|quantized]
      Download Table Transformer (${TABLE_TRANSFORMER.license})
      and the onnxruntime-node runtime it needs, with pinned digests.
      fp32: ${Math.round(TABLE_TRANSFORMER.variants.fp32.bytes / 1e6)} MB, quantized: ${Math.round(TABLE_TRANSFORMER.variants.quantized.bytes / 1e6)} MB, runtime: about 100 MB.
  list
      Show installed models and the runtime.

Use it with: atlcli wiki import <file.pdf> --table-model table-transformer [--table-model-device auto|cpu|gpu]

Environment:
  ATLCLI_MODELS_DIR   Models directory (default ~/.atlcli/models)
`;
}

export async function handleModels(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const [command, name] = args;
  if (hasFlag(flags, "help") || !command) {
    output(modelsHelp(), opts);
    return;
  }
  if (command === "list") {
    const installed = installedTableModel();
    const runtime = existsSync(tableRuntimeDirectory());
    const result = {
      directory: modelsDirectory(),
      models: [{
        name: TABLE_TRANSFORMER.name,
        revision: TABLE_TRANSFORMER.revision,
        installed: installed ? { variant: installed.variant, path: installed.path } : null,
      }],
      runtime: { name: "onnxruntime-node", version: "1.30.0", installed: runtime },
    };
    if (opts.json) output(result, opts);
    else {
      output(`Models directory: ${result.directory}`, opts);
      output(`  ${TABLE_TRANSFORMER.name}: ${installed ? `${installed.variant} (${installed.path})` : "not installed"}`, opts);
      output(`  onnxruntime-node 1.30.0: ${runtime ? "installed" : "not installed"}`, opts);
    }
    return;
  }
  if (command === "pull") {
    if (name !== TABLE_TRANSFORMER.name) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Unknown model ${JSON.stringify(name ?? "")}. Available: ${TABLE_TRANSFORMER.name}.`, {});
    }
    const variant = (getFlag(flags, "variant") ?? "fp32") as TableModelVariant;
    if (!(variant in TABLE_TRANSFORMER.variants)) {
      fail(opts, 1, ERROR_CODES.VALIDATION, "--variant must be fp32 or quantized.", {});
    }
    if (!opts.json) output(`Downloading ${TABLE_TRANSFORMER.name} (${variant}) and onnxruntime-node into ${modelsDirectory()} ...`, opts);
    try {
      const result = await pullTableTransformer({ variant });
      if (opts.json) output({ ...result, variant, path: tableModelPath(variant) }, opts);
      else output(`Installed. Downloaded ${Math.round(result.downloadedBytes / 1e6)} MB.\n  model: ${result.modelPath}\n  runtime: ${result.runtimeDirectory}`, opts);
    } catch (error) {
      fail(opts, 1, ERROR_CODES.API, (error as Error).message, {});
    }
    return;
  }
  fail(opts, 1, ERROR_CODES.VALIDATION, `Unknown models command ${JSON.stringify(command)}.`, {});
}
