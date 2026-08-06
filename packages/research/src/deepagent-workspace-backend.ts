import {
  createNamespacedResearchWorkspace,
  normalizeResearchWorkspacePath,
  researchWorkspacePathMatchesPrefix,
  type ResearchWorkspace,
} from "./workspace.js";

/**
 * The model-visible route of the durable research workspace. The host owns
 * every other workspace path (evidence, reports, checkpoints, and diagnostics)
 * and never exposes it through the DeepAgentsJS filesystem tools.
 */
export const RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1 = "/workspace" as const;
export const RESEARCH_DEEPAGENT_PLAN_PATH_V1 =
  `${RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1}/plan.md` as const;
export const RESEARCH_DEEPAGENT_SCRATCH_ROUTE_V1 =
  `${RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1}/scratch` as const;
/** Host-only durable storage used by DeepAgentsJS summarization middleware. */
export const RESEARCH_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1 =
  "/.atlcli/deepagents-summarization/v1" as const;
/** The native middleware's own virtual path; it is not model-accessible. */
export const RESEARCH_DEEPAGENT_SUMMARIZATION_HISTORY_PREFIX_V1 =
  "/conversation_history" as const;

const MAXIMUM_LISTED_FILES_V1 = 512;
const MAXIMUM_GREP_MATCHES_V1 = 512;

interface FileInfo {
  path: string;
  is_dir?: boolean;
  size?: number;
  modified_at?: string;
}

interface LsResult {
  error?: string;
  files?: FileInfo[];
}

interface ReadResult {
  error?: string;
  content?: string;
  mimeType?: string;
}

interface ReadRawResult {
  error?: string;
  data?: {
    content: string;
    mimeType: string;
    created_at: string;
    modified_at: string;
  };
}

interface WriteResult {
  error?: string;
  path?: string;
  filesUpdate?: null;
}

interface EditResult extends WriteResult {
  occurrences?: number;
}

interface DeleteResult {
  error?: string;
  path?: string;
}

interface GrepResult {
  error?: string;
  matches?: Array<{ path: string; line: number; text: string }>;
}

interface GlobResult {
  error?: string;
  files?: FileInfo[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedAgentPath(path: string): string {
  return normalizeResearchWorkspacePath(path || "/");
}

function workspacePath(agentPath: string): string {
  const normalized = normalizedAgentPath(agentPath);
  return normalized === "/"
    ? RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1
    : `${RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1}${normalized}`;
}

function agentPath(path: string): string | undefined {
  if (!researchWorkspacePathMatchesPrefix(path, RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1)) {
    return undefined;
  }
  const suffix = path.slice(RESEARCH_DEEPAGENT_WORKSPACE_ROUTE_V1.length);
  return suffix || "/";
}

function textSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Glob matcher covering DeepAgentsJS' documented `*`, `**`, and `?` patterns. */
function globMatches(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replaceAll("**", "\\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function directEntries(paths: readonly string[], directory: string): FileInfo[] {
  const normalizedDirectory = normalizedAgentPath(directory);
  const prefix = normalizedDirectory === "/" ? "/" : `${normalizedDirectory}/`;
  const directories = new Set<string>();
  const files: FileInfo[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const remaining = path.slice(prefix.length);
    if (!remaining) continue;
    const slash = remaining.indexOf("/");
    if (slash >= 0) {
      directories.add(`${prefix}${remaining.slice(0, slash + 1)}`);
    } else {
      files.push({ path, is_dir: false });
    }
  }
  return [
    ...files,
    ...[...directories].sort().map((path) => ({ path, is_dir: true, size: 0, modified_at: "" })),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * A native DeepAgentsJS BackendProtocolV2 implementation over the portable,
 * per-session ResearchWorkspace. It is routed by `CompositeBackend` below
 * `/workspace`, so the agent gets a durable virtual scratchpad but no direct
 * path to evidence, reports, checkpoint blobs, browser APIs, or the local OS.
 */
export class ResearchDeepAgentWorkspaceBackendV1 {
  readonly #workspace: ResearchWorkspace;

  constructor(workspace: ResearchWorkspace) {
    this.#workspace = workspace;
  }

  async #paths(prefix = "/"): Promise<string[]> {
    const paths = await this.#workspace.list(workspacePath(prefix));
    const visible = paths.map(agentPath).filter((path): path is string => path !== undefined);
    if (visible.length > MAXIMUM_LISTED_FILES_V1) {
      throw new Error("Research virtual workspace file limit is exceeded.");
    }
    return visible.sort();
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const entries = directEntries(await this.#paths(path), path);
      for (const entry of entries) {
        if (!entry.is_dir) {
          const contents = await this.#workspace.readFile(workspacePath(entry.path));
          entry.size = contents === undefined ? 0 : textSize(contents);
          entry.modified_at = "";
        }
      }
      return { files: entries };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async read(filePath: string, offset = 0, limit = 500): Promise<ReadResult> {
    try {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        return { error: "Read offset and limit are invalid." };
      }
      const contents = await this.#workspace.readFile(workspacePath(filePath));
      if (contents === undefined) return { error: `File '${filePath}' not found` };
      return {
        content: contents.split("\n").slice(offset, offset + limit).join("\n"),
        mimeType: "text/plain",
      };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const contents = await this.#workspace.readFile(workspacePath(filePath));
      if (contents === undefined) return { error: `File '${filePath}' not found` };
      return {
        data: {
          content: contents,
          mimeType: "text/plain",
          created_at: "",
          modified_at: "",
        },
      };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async write(filePath: string, contents: string): Promise<WriteResult> {
    try {
      await this.#workspace.writeFile(workspacePath(filePath), contents);
      return { path: filePath, filesUpdate: null };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    try {
      const contents = await this.#workspace.readFile(workspacePath(filePath));
      if (contents === undefined) return { error: `File '${filePath}' not found` };
      if (!oldString) return { error: "The old string must not be empty." };
      const occurrences = contents.split(oldString).length - 1;
      if (occurrences === 0) return { error: "The old string was not found in the file." };
      await this.#workspace.writeFile(
        workspacePath(filePath),
        replaceAll ? contents.replaceAll(oldString, newString) : contents.replace(oldString, newString),
      );
      return { path: filePath, occurrences: replaceAll ? occurrences : 1, filesUpdate: null };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async delete(filePath: string): Promise<DeleteResult> {
    try {
      const contents = await this.#workspace.readFile(workspacePath(filePath));
      if (contents === undefined) return { error: `File '${filePath}' not found` };
      await this.#workspace.remove(workspacePath(filePath));
      return { path: filePath };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async grep(pattern: string, path = "/", glob: string | null = null): Promise<GrepResult> {
    try {
      if (!pattern) return { matches: [] };
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const filePath of await this.#paths(path)) {
        if (glob !== null && !globMatches(filePath, glob) && !globMatches(filePath.slice(1), glob)) continue;
        const contents = await this.#workspace.readFile(workspacePath(filePath));
        if (contents === undefined) continue;
        for (const [index, line] of contents.split("\n").entries()) {
          if (!line.includes(pattern)) continue;
          matches.push({ path: filePath, line: index + 1, text: line });
          if (matches.length >= MAXIMUM_GREP_MATCHES_V1) return { matches };
        }
      }
      return { matches };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    try {
      const files: FileInfo[] = [];
      for (const filePath of await this.#paths(path)) {
        if (!globMatches(filePath, pattern) && !globMatches(filePath.slice(1), pattern)) continue;
        const contents = await this.#workspace.readFile(workspacePath(filePath));
        files.push({
          path: filePath,
          is_dir: false,
          size: contents === undefined ? 0 : textSize(contents),
          modified_at: "",
        });
      }
      return { files };
    } catch (error) {
      return { error: message(error) };
    }
  }
}

/**
 * Native summarization uses a backend directly, not the model's composite
 * filesystem route. Namespace it into private durable storage so its history
 * survives host restart without making raw transcripts readable by the model.
 */
export function createResearchDeepAgentSummarizationBackendV1(
  workspace: ResearchWorkspace,
): ResearchDeepAgentWorkspaceBackendV1 {
  return createDeepAgentSummarizationBackendV1(
    workspace,
    RESEARCH_DEEPAGENT_SUMMARIZATION_STORAGE_ROOT_V1,
  );
}

/**
 * Shared storage adapter for native DeepAgentsJS summarization. Callers must
 * provide a host-owned root for their agent shape; Chat and Research never
 * share histories even when they use the same portable workspace backend.
 */
export function createDeepAgentSummarizationBackendV1(
  workspace: ResearchWorkspace,
  storageRoot: string,
): ResearchDeepAgentWorkspaceBackendV1 {
  return new ResearchDeepAgentWorkspaceBackendV1(
    createNamespacedResearchWorkspace(workspace, storageRoot),
  );
}
