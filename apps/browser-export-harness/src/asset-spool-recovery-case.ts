import {
  InMemorySpoolStore,
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import {
  checkpointDocxAssetsV1,
  checkpointPdfAssetsV1,
} from "@atlcli/export-wiring/jobs";

const limits: SpoolWriteLimitsV1 = {
  maxObjectBytes: 32 * 1024 * 1024,
  maxJobBytes: 128 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

function executionContext(
  store: InMemorySpoolStore,
  leaseEpoch: number,
  checkpointRef?: string,
): ExportJobExecutionContext {
  const context: ExportJobExecutionContext = {
    jobId: "browser-asset-spool",
    leaseEpoch,
    ...(checkpointRef ? { checkpointRef } : {}),
    signal: new AbortController().signal,
    spool: bindExportJobSpool(
      store,
      "browser-asset-spool",
      leaseEpoch,
      limits,
    ),
    readSpool(ref, options) {
      if (
        ref.jobId !== "browser-asset-spool" ||
        ref.leaseEpoch > leaseEpoch
      ) {
        throw new Error("Browser asset recovery escaped its execution identity.");
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

/** Generic production-browser proof of the shared PDF/DOCX asset spool. */
export async function runAssetSpoolRecoveryCase(): Promise<unknown> {
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  for (const forbidden of ["Buffer", "process", "chrome", "browser"]) {
    if (globals[forbidden] !== undefined) {
      throw new Error(`generic asset spool imported forbidden global ${forbidden}`);
    }
  }

  const store = new InMemorySpoolStore();
  const bytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3, 4);
  const reference = {
    kind: "attachment" as const,
    pageId: "42",
    filename: "figure.png",
  };
  const first = executionContext(store, 1);
  let pdfFetches = 0;
  const initial = checkpointPdfAssetsV1(first, "browser-request", {
    async resolve() {
      pdfFetches += 1;
      return { bytes, mediaType: "image/png", filename: "figure.png" };
    },
  });
  await initial.resolve(reference);
  if (!first.checkpointRef?.startsWith("atlcli.export-asset-spool/1:")) {
    throw new Error("generic asset spool did not publish its checkpoint");
  }

  const second = executionContext(store, 2, first.checkpointRef);
  const recovered = checkpointPdfAssetsV1(second, "browser-request", {
    async resolve() {
      throw new Error("generic asset recovery refetched committed bytes");
    },
  });
  const pdf = await recovered.resolve(reference);
  if (
    pdf.mediaType !== "image/png" ||
    pdf.filename !== "figure.png" ||
    JSON.stringify([...pdf.bytes]) !== JSON.stringify([...bytes])
  ) {
    throw new Error("generic asset recovery changed the resolved PDF asset");
  }

  let docxFetches = 0;
  const docx = checkpointDocxAssetsV1(second, "browser-request", {
    async fetch() {
      docxFetches += 1;
      return bytes;
    },
  });
  await Promise.all([
    docx.fetch({ url: "/download/attachments/1/one.png" }),
    docx.fetch({ url: "/download/attachments/2/two.png" }),
  ]);

  return {
    pdfFetches,
    docxFetches,
    recoveredByteLength: pdf.bytes.byteLength,
    checkpointPublished: second.checkpointRef?.startsWith(
      "atlcli.export-asset-spool/1:",
    ) === true,
  };
}
