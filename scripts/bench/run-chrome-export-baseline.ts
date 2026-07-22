/** Build and execute the real-headless-Chrome PRE-QUEUE baseline. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExportBaselineArgs } from "./export-baseline-contract.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_OUT = resolve(
  ROOT,
  "specs/export-expansion/013-isomorphic-export-jobs/baselines/chrome-pre-queue.json",
);
const options = parseExportBaselineArgs(process.argv.slice(2));
const child = Bun.spawn(
  [process.execPath, "run", "--cwd", "apps/extension", "bench:export-baseline-chrome"],
  {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ATLCLI_EXPORT_BASELINE_PAGES: options.pages.join(","),
      ATLCLI_EXPORT_BASELINE_FORMATS: options.formats.join(","),
      ATLCLI_EXPORT_BASELINE_REPEAT: String(options.repeat),
      ATLCLI_EXPORT_BASELINE_SEED: String(options.seed),
      ATLCLI_EXPORT_BASELINE_OUT: resolve(options.out ?? DEFAULT_OUT),
      ATLCLI_EXPORT_BASELINE_RESUME: process.argv.includes("--resume") ? "1" : "0",
    },
  },
);
process.exit(await child.exited);
