import {
  InMemorySpoolStore,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import {
  fetchExportTree,
  type TreeSource,
} from "@atlcli/confluence/browser";
import { createExportTreeBodySpoolV1 } from "@atlcli/export-wiring/jobs";

const limits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 4 * 1024 * 1024,
  maxJobBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

function executionContext(
  store: InMemorySpoolStore,
  leaseEpoch: number,
  checkpointRef?: string,
): ExportJobExecutionContext {
  const context: ExportJobExecutionContext = {
    jobId: "browser-source-spool",
    leaseEpoch,
    ...(checkpointRef ? { checkpointRef } : {}),
    signal: new AbortController().signal,
    spool: bindExportJobSpool(
      store,
      "browser-source-spool",
      leaseEpoch,
      limits,
    ),
    readSpool(ref, options) {
      if (
        ref.jobId !== "browser-source-spool" ||
        ref.leaseEpoch > leaseEpoch
      ) {
        throw new Error("Browser recovery read escaped its execution identity.");
      }
      return store.read(ref, options);
    },
    artifacts: {
      async stage() {
        throw new Error("This case does not stage a final artifact.");
      },
      async getStaged() {
        return undefined;
      },
    },
    async updateProgress() {},
    async updateStats() {},
    async appendEvent() {},
    async checkpoint(ref) {
      context.checkpointRef = ref;
    },
  };
  return context;
}

function source(fetched: string[]): TreeSource {
  return {
    async getPage(id, { signal }) {
      signal?.throwIfAborted();
      fetched.push(id);
      return {
        id,
        title: id === "root" ? "Root" : id.toUpperCase(),
        storage: `<p>${id}</p>`,
        version: 1,
        labels: [],
        spaceKey: "DOCSY",
      };
    },
    async getPageVersion(id, { signal }) {
      signal?.throwIfAborted();
      return {
        title: id === "root" ? "Root" : id.toUpperCase(),
        version: 1,
      };
    },
    async getChildren(node, { signal }) {
      signal?.throwIfAborted();
      if (node.id !== "root") return [];
      return [
        { id: "a", kind: "page", title: "A", position: 0, observedVersion: 1 },
        { id: "b", kind: "page", title: "B", position: 1, observedVersion: 1 },
      ];
    },
    async getSpaceHomepageId(_spaceKey, { signal }) {
      signal?.throwIfAborted();
      return "root";
    },
  };
}

/** Generic production-browser proof of the same page spool used by CLI/Extension. */
export async function runSourceSpoolRecoveryCase(): Promise<unknown> {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  for (const forbidden of ["Buffer", "process", "chrome", "browser"]) {
    if (globals[forbidden] !== undefined) {
      throw new Error(`generic source spool imported forbidden global ${forbidden}`);
    }
  }

  const store = new InMemorySpoolStore();
  const first = executionContext(store, 1);
  const initial = createExportTreeBodySpoolV1(first, "browser-request");
  const controller = new AbortController();
  const firstFetched: string[] = [];
  try {
    await fetchExportTree(
      source(firstFetched),
      { kind: "tree", rootPageId: "root" },
      {
        signal: controller.signal,
        bodyStore: {
          prepare: (manifest, options) => initial.prepare(manifest, options),
          load: (entry, options) => initial.load(entry, options),
          async commit(entry, result, options) {
            await initial.commit(entry, result, options);
            if (entry.ordinal === 1) {
              controller.abort(
                new DOMException("Simulated generic-browser loss", "AbortError"),
              );
            }
          },
        },
      },
    );
    throw new Error("The simulated browser loss did not interrupt the first run.");
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "AbortError") {
      throw error;
    }
  }

  const second = executionContext(store, 2, first.checkpointRef);
  const resumedFetched: string[] = [];
  const resumed = await fetchExportTree(
    source(resumedFetched),
    { kind: "tree", rootPageId: "root" },
    {
      bodyStore: createExportTreeBodySpoolV1(second, "browser-request"),
    },
  );
  const titles = resumed.nodes.map((node) => node.title);
  if (JSON.stringify(resumedFetched) !== JSON.stringify(["b"])) {
    throw new Error(
      `generic source recovery refetched committed pages: ${JSON.stringify(resumedFetched)}`,
    );
  }
  if (JSON.stringify(titles) !== JSON.stringify(["Root", "A", "B"])) {
    throw new Error(`generic source recovery changed order: ${JSON.stringify(titles)}`);
  }

  return {
    firstFetched,
    resumedFetched,
    recoveredSlots: 2,
    titles,
    checkpointPublished: second.checkpointRef?.startsWith(
      "atlcli.export-tree-spool/1:",
    ) === true,
  };
}
