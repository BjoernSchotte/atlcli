/** Build and execute the real-Chromium POST-QUEUE extension benchmark. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExportBaselineArgs } from "./export-baseline-contract.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_OUT = resolve(
  ROOT,
  "specs/export-expansion/013-isomorphic-export-jobs/baselines/chrome-post-queue.json",
);
const options = parseExportBaselineArgs(process.argv.slice(2));
const child = Bun.spawn(
  [process.execPath, "run", "--cwd", "apps/extension", "bench:export-jobs-chrome"],
  {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ATLCLI_EXPORT_JOB_BASELINE_PAGES: options.pages.join(","),
      ATLCLI_EXPORT_JOB_BASELINE_FORMATS: options.formats.join(","),
      ATLCLI_EXPORT_JOB_BASELINE_REPEAT: String(options.repeat),
      ATLCLI_EXPORT_JOB_BASELINE_SEED: String(options.seed),
      ATLCLI_EXPORT_JOB_BASELINE_OUT: resolve(options.out ?? DEFAULT_OUT),
    },
  },
);
process.exit(await child.exited);
