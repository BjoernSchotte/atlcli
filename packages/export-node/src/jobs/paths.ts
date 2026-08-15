import { homedir } from "node:os";
import { resolve } from "node:path";

/** Root of the private, versioned Node export-job state. */
export function exportJobStateDir(): string {
  const override = process.env.ATLCLI_EXPORT_JOBS_DIR?.trim();
  return resolve(override && override.length > 0 ? override : resolve(homedir(), ".atlcli", "export-jobs", "v1"));
}
