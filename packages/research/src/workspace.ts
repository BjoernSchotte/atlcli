import { ResearchContractError } from "./contracts.js";

export const RESEARCH_WORKSPACE_SCHEMA_V1 = "atlcli.research-workspace/v1" as const;
export const RESEARCH_ONE_SHOT_REQUEST_PATH_V1 = "/session/request.json" as const;

export interface ResearchWorkspace {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** Normalize and validate the portable virtual path contract. */
export function normalizeResearchWorkspacePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\u0000")) {
    throw new ResearchContractError("invalid-request", "Workspace path is invalid.");
  }
  const candidate = value.replaceAll("\\", "/");
  if (!candidate.startsWith("/")) throw new ResearchContractError("access-denied", "Workspace paths must be absolute virtual paths.");
  const parts = candidate.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") throw new ResearchContractError("access-denied", "Workspace path traversal is not allowed.");
    normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

/** Small deterministic browser/test backend; hosts may replace it with IndexedDB. */
export function createMemoryResearchWorkspace(): ResearchWorkspace {
  const files = new Map<string, string>();
  return {
    async readFile(path) {
      return files.get(normalizeResearchWorkspacePath(path));
    },
    async writeFile(path, contents) {
      const normalized = normalizeResearchWorkspacePath(path);
      if (typeof contents !== "string" || contents.length > 2_000_000) {
        throw new ResearchContractError("limit-exceeded", "Workspace file is too large.");
      }
      files.set(normalized, contents);
    },
    async remove(path) {
      const normalized = normalizeResearchWorkspacePath(path);
      for (const key of files.keys()) {
        if (key === normalized || key.startsWith(`${normalized}/`)) files.delete(key);
      }
    },
    async list(prefix = "/") {
      const normalized = normalizeResearchWorkspacePath(prefix);
      return [...files.keys()].filter((key) => key === normalized || key.startsWith(`${normalized}/`)).sort();
    },
  };
}
