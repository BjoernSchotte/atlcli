/**
 * Final PDF import Cloud certification.
 *
 * This file is skipped during ordinary tests. Run the checked-in command:
 *
 *   bun run test:e2e:import-pdf
 *
 * It builds the CLI, publishes only neutral generated fixtures to DOCSY, reads
 * them back through an independent ConfluenceClient, and removes every owned
 * page in finally cleanup. No response body, tenant id, URL, or credential is
 * written to disk.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getActiveProfile,
  loadConfig,
  resolveDeploymentType,
  sha256Hex,
  type Profile,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  buildPdfImportReview,
  createPdfiumFactsAdapter,
  parsePdfSplitPolicy,
} from "@atlcli/import-pdf";
import type { DestinationGovernance } from "@atlcli/import-docx";
import {
  buildDocxFixture,
  p,
  r,
} from "../../../../packages/import-docx/src/test-support.js";
import {
  PdfPublicationTransactionError,
  publishPdfCloud,
} from "../commands/wiki-import-pdf-publication.js";
import { resolveSweeperProfile } from "./cleanup.js";
import { createConfluencePort } from "./rest-ports.js";
import {
  E2E_RUN_ID_PROPERTY,
  E2E_SPACE_KEY,
  makeE2eTitle,
  resolveRunId,
  withE2eResources,
  type E2eCleanupSummary,
  type E2eConfluencePort,
  type E2eResourceTracker,
} from "./resources.js";

const RUN = process.env.ATLCLI_IMPORT_PDF_E2E === "1";
const PROFILE_NAME = process.env.ATLCLI_E2E_PROFILE?.trim() || "mayflower";
const ROOT = resolve(import.meta.dir, "../../../..");
const CLI = resolve(ROOT, "dist/index.js");
const FIXTURES = resolve(ROOT, "specs/import-pdf-mvp/fixtures");
const PDFIUM_WASM = resolve(ROOT, "packages/import-pdf/vendor/pdfium.wasm");
const CASE_TIMEOUT_MS = 10 * 60_000;

interface PublishedPage {
  id: string;
  title: string;
  parentId?: string | null;
  sourcePageIndexes?: number[];
  children?: PublishedPage[];
}

interface PdfCliReceipt {
  mode: "published";
  source: { sha256: string; byteLength: number; pageCount: number };
  page: PublishedPage;
  pagesCreated: number;
  sourceAttachment?: { filename: string; sha256: string; byteLength: number };
}

interface DocxCliReceipt {
  mode: "published";
  page: PublishedPage;
  pagesCreated?: number;
}

interface AdfSummary {
  types: string[];
  text: string;
  mediaIds: string[];
  linkHrefs: string[];
  flow: string[];
}

interface PublishedProof {
  ids: string[];
  titles: string[];
}

type FailureStage =
  | "after-shell"
  | "after-restriction"
  | "after-source-upload"
  | "after-asset-upload"
  | "after-body-update"
  | "after-metadata"
  | "after-readback";

async function profile(): Promise<Profile> {
  const config = await loadConfig();
  const resolved = resolveSweeperProfile(config, PROFILE_NAME) ?? getActiveProfile(config, PROFILE_NAME);
  if (!resolved) throw new Error(`Live E2E profile ${PROFILE_NAME} is not configured.`);
  if (resolveDeploymentType(resolved) !== "cloud") throw new Error("PDF live E2E requires a Cloud profile.");
  return resolved;
}

async function runBuiltCli<T>(args: string[]): Promise<T> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    let diagnostic = stderr.trim();
    try {
      const parsed = JSON.parse(stdout) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string") diagnostic = message;
    } catch {
      // Keep stderr only; raw stdout can contain a live receipt and is never echoed.
    }
    throw new Error(`Built CLI failed with exit ${exitCode}: ${diagnostic || "no structured diagnostic"}`);
  }
  return JSON.parse(stdout) as T;
}

function flattenPages(root: PublishedPage): PublishedPage[] {
  return [root, ...(root.children ?? []).flatMap(flattenPages)];
}

function summarizeAdf(value: string): AdfSummary {
  const root = JSON.parse(value) as Record<string, unknown>;
  const summary: AdfSummary = { types: [], text: "", mediaIds: [], linkHrefs: [], flow: [] };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (typeof node.type === "string") summary.types.push(node.type);
    if (typeof node.text === "string") {
      summary.text += node.text;
      summary.flow.push(`text:${node.text}`);
    }
    if (node.type === "media" && node.attrs && typeof node.attrs === "object") {
      const id = (node.attrs as Record<string, unknown>).id;
      if (typeof id === "string") {
        summary.mediaIds.push(id);
        summary.flow.push(`media:${id}`);
      }
    }
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (!mark || typeof mark !== "object") continue;
        const record = mark as Record<string, unknown>;
        if (record.type !== "link" || !record.attrs || typeof record.attrs !== "object") continue;
        const href = (record.attrs as Record<string, unknown>).href;
        if (typeof href === "string") summary.linkHrefs.push(href);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "attrs" && key !== "marks") walk(child);
    }
  };
  walk(root);
  return summary;
}

async function stampAndTrack(
  tracker: E2eResourceTracker,
  port: E2eConfluencePort,
  pages: readonly PublishedPage[],
): Promise<void> {
  for (const page of pages) {
    tracker.trackPage(page.id);
    await port.setPageProperty(page.id, E2E_RUN_ID_PROPERTY, tracker.runId);
  }
}

async function assertNoCurrentState(
  client: ConfluenceClient,
  proof: PublishedProof,
): Promise<void> {
  for (const id of proof.ids) await expect(client.getPageDetails(id)).rejects.toThrow();
  for (const title of proof.titles) {
    const matches = await client.findPagesByTitle(title, { spaceKey: E2E_SPACE_KEY });
    expect(matches.filter((page) => page.title === title)).toHaveLength(0);
  }
}

async function withPublishedPdf(
  feature: string,
  fixture: string,
  extraArgs: string[],
  verify: (input: {
    receipt: PdfCliReceipt;
    pages: PublishedPage[];
    summaries: Map<string, AdfSummary>;
    client: ConfluenceClient;
  }) => Promise<void> | void,
): Promise<void> {
  const active = await profile();
  const client = new ConfluenceClient(active);
  const port = createConfluencePort(active);
  const title = makeE2eTitle(feature);
  let cleanup: E2eCleanupSummary | undefined;
  const proof = await withE2eResources(
    { confluence: port },
    async (tracker): Promise<PublishedProof> => {
      const receipt = await runBuiltCli<PdfCliReceipt>([
        "wiki", "import", resolve(FIXTURES, fixture),
        "--profile", PROFILE_NAME,
        "--space", E2E_SPACE_KEY,
        "--title", title,
        "--confirm",
        "--json",
        ...extraArgs,
      ]);
      expect(receipt.mode).toBe("published");
      const pages = flattenPages(receipt.page);
      expect(receipt.pagesCreated).toBe(pages.length);
      await stampAndTrack(tracker, port, pages);
      const summaries = new Map<string, AdfSummary>();
      for (const page of pages) {
        const adf = await client.getPageAdf(page.id);
        summaries.set(page.id, summarizeAdf(adf.body.value));
        const details = await client.getPageDetails(page.id);
        expect(details.title).toBe(page.title);
        if (page.parentId !== undefined) expect(details.parentId).toBe(page.parentId);
      }
      await verify({ receipt, pages, summaries, client });
      return { ids: pages.map((page) => page.id), titles: pages.map((page) => page.title) };
    },
    {
      runId: resolveRunId(),
      onCleanup: (summary) => { cleanup = summary; },
    },
  );
  expect(cleanup?.failures).toEqual([]);
  expect(cleanup?.deletedPages).toHaveLength(proof.ids.length);
  await assertNoCurrentState(client, proof);
}

async function attachmentDigests(client: ConfluenceClient, pageId: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const attachment of await client.listAttachments(pageId)) {
    result.set(attachment.filename, await sha256Hex(await client.downloadAttachment(attachment)));
  }
  return result;
}

function shouldFail(stage: FailureStage, method: PropertyKey, args: unknown[]): "before" | "after" | undefined {
  if (stage === "after-shell" && method === "setContentRestrictions") return "before";
  if (stage === "after-restriction" && method === "getContentRestrictions") return "after";
  if (method === "uploadAttachment") {
    const filename = (args[0] as { filename?: unknown } | undefined)?.filename;
    if (stage === "after-source-upload" && typeof filename === "string" && filename.endsWith(".pdf")) return "after";
    if (stage === "after-asset-upload" && typeof filename === "string" && !filename.endsWith(".pdf")) return "after";
  }
  if (stage === "after-body-update" && method === "updatePageAdf") return "after";
  if (stage === "after-metadata" && method === "addLabels") return "after";
  if (stage === "after-readback" && method === "getPageAdf") return "after";
  return undefined;
}

function faultingClient(
  base: ConfluenceClient,
  stage: FailureStage,
  createdIds: string[],
  port: E2eConfluencePort,
  runId: string,
): ConfluenceClient {
  return new Proxy(base, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== "function") return member;
      return async (...args: unknown[]): Promise<unknown> => {
        const timing = shouldFail(stage, property, args);
        if (timing === "before") throw new Error(`injected live failure ${stage}`);
        const result = await (member as (...values: unknown[]) => Promise<unknown>).apply(target, args);
        if (property === "createPageAdf") {
          const id = (result as { id?: unknown }).id;
          if (typeof id !== "string") throw new Error("Cloud shell returned no page id.");
          createdIds.push(id);
          await port.setPageProperty(id, E2E_RUN_ID_PROPERTY, runId);
        }
        if (timing === "after") throw new Error(`injected live failure ${stage}`);
        return result;
      };
    },
  });
}

async function removeIfPresent(client: ConfluenceClient, id: string): Promise<void> {
  try {
    await client.getPageDetails(id);
  } catch {
    return;
  }
  await client.deletePage(id);
}

describe.skipIf(!RUN).serial("built CLI PDF import live Cloud certification", () => {
  it("publishes and independently reads tagged text, a native table, and native media", async () => {
    await withPublishedPdf("import-pdf-tagged", "complex-tagged.pdf", ["--split", "off"], async ({ receipt, summaries, client }) => {
      const summary = summaries.get(receipt.page.id)!;
      expect(summary.text).toContain("Structured Garden Report");
      expect(summary.types).toContain("table");
      expect(summary.types).toContain("media");
      expect(summary.mediaIds).toHaveLength(1);
      expect((await attachmentDigests(client, receipt.page.id)).size).toBeGreaterThanOrEqual(1);
    });
  }, CASE_TIMEOUT_MS);

  it("publishes qualified two-column untagged text in the proven reading order", async () => {
    await withPublishedPdf("import-pdf-untagged", "complex-untagged.pdf", ["--split", "off"], ({ receipt, summaries }) => {
      const text = summaries.get(receipt.page.id)!.text;
      expect(text).toContain("Left column sentence 01");
      expect(text).toContain("Right column sentence 12");
      expect(text.indexOf("Left column sentence 01")).toBeLessThan(text.indexOf("Right column sentence 12"));
    });
  }, CASE_TIMEOUT_MS);

  it("publishes only the grid-qualified untagged table as native ADF", async () => {
    await withPublishedPdf("import-pdf-table", "table-positive.pdf", ["--split", "off"], ({ receipt, summaries }) => {
      expect(summaries.get(receipt.page.id)!.types).toContain("table");
    });
  }, CASE_TIMEOUT_MS);

  it("publishes raster media and a visible rendered fallback with attachment identity", async () => {
    await withPublishedPdf("import-pdf-figure", "figure.pdf", ["--split", "off"], async ({ receipt, summaries, client }) => {
      const summary = summaries.get(receipt.page.id)!;
      expect(summary.types).toContain("media");
      expect(summary.mediaIds.length).toBeGreaterThanOrEqual(2);
      const digests = await attachmentDigests(client, receipt.page.id);
      expect(digests.size).toBeGreaterThanOrEqual(2);
      expect(new Set(digests.values()).size).toBe(digests.size);
    });
  }, CASE_TIMEOUT_MS);

  it("proves restriction before source retention plus labels, metadata, and byte digest", async () => {
    await withPublishedPdf(
      "import-pdf-governance",
      "simple-untagged.pdf",
      [
        "--split", "off",
        "--restriction", "private",
        "--attach-source",
        "--label", "atlcli-pdf-e2e",
        "--content-property", "atlcli.import.proof=pdf-live-e2e",
      ],
      async ({ receipt, client }) => {
        const details = await client.getPageDetails(receipt.page.id);
        expect(details.labels).toContain("atlcli-pdf-e2e");
        expect(await client.getPagePropertyByKey(receipt.page.id, "atlcli.import.proof")).toBe("pdf-live-e2e");
        const restrictions = await client.getContentRestrictions(receipt.page.id);
        const importer = await client.getCurrentUser();
        expect(restrictions.read.accountIds).toContain(importer.accountId);
        expect(restrictions.update.accountIds).toContain(importer.accountId);
        expect(receipt.sourceAttachment?.sha256).toBe(receipt.source.sha256);
        const digests = await attachmentDigests(client, receipt.page.id);
        expect(digests.get(receipt.sourceAttachment!.filename)).toBe(receipt.source.sha256);
      },
    );
  }, CASE_TIMEOUT_MS);

  it("turns the neutral 100-page source into a bounded, exact-once page tree", async () => {
    await withPublishedPdf(
      "import-pdf-split",
      "heading-rich-100.pdf",
      ["--split", "auto", "--title-conflict", "rename"],
      ({ receipt, pages, summaries }) => {
      expect(receipt.source.pageCount).toBe(100);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.every((page) => (page.sourcePageIndexes?.length ?? 0) <= 40)).toBe(true);
      const assignments = pages.flatMap((page) => page.sourcePageIndexes ?? []).sort((a, b) => a - b);
      expect(assignments).toEqual(Array.from({ length: 100 }, (_, index) => index));
      const root = summaries.get(receipt.page.id)!;
      expect(root.types).toContain("bulletList");
      expect(root.linkHrefs.length).toBeGreaterThan(0);
      const atomicPage = pages.find((page) => page.sourcePageIndexes?.includes(38));
      expect(atomicPage).toBeDefined();
      const atomicFlow = summaries.get(atomicPage!.id)!.flow;
      const label = atomicFlow.findIndex((entry) => entry.includes("Atomic table segment 1 of 3"));
      const image = atomicFlow.findIndex((entry) => entry.startsWith("media:"));
      expect(label).toBeGreaterThanOrEqual(0);
      expect(image).toBeGreaterThan(label);
      },
    );
  }, CASE_TIMEOUT_MS);

  it("rolls back every exact owned page after each sensitive Cloud failure stage", async () => {
    const active = await profile();
    const base = new ConfluenceClient(active);
    const port = createConfluencePort(active);
    const spaces = await base.listSpacesV2({ keys: [E2E_SPACE_KEY], limit: 1 });
    const space = spaces.spaces.find((candidate) => candidate.key === E2E_SPACE_KEY);
    if (!space) throw new Error("DOCSY is not accessible to the live E2E profile.");
    const sourceBytes = new Uint8Array(await readFile(resolve(FIXTURES, "complex-tagged.pdf")));
    const wasmBinary = new Uint8Array(await readFile(PDFIUM_WASM));
    const governance: DestinationGovernance = {
      schema: "atlcli.docx-destination-governance/1",
      restriction: { mode: "private" },
      staging: { mode: "none" },
      labels: ["atlcli-pdf-e2e"],
      contentProperties: [],
    };
    for (const stage of [
      "after-shell",
      "after-restriction",
      "after-source-upload",
      "after-asset-upload",
      "after-body-update",
      "after-metadata",
      "after-readback",
    ] as const) {
      const title = makeE2eTitle(`import-pdf-fail-${stage}`);
      const review = await buildPdfImportReview(sourceBytes, createPdfiumFactsAdapter({ wasmBinary }), {
        target: {
          spaceKey: E2E_SPACE_KEY,
          title,
          deployment: "cloud",
          supportsPageTree: true,
          evidence: "profile",
        },
        splitPolicy: parsePdfSplitPolicy("off"),
        attachSource: true,
      });
      expect(review.blockers).toEqual([]);
      const createdIds: string[] = [];
      const runId = resolveRunId();
      try {
        await publishPdfCloud({
          client: faultingClient(base, stage, createdIds, port, runId),
          spaceId: space.id,
          plan: review.split,
          governance,
          sourceBytes,
          sourceSha256: review.source.sha256,
          attachSource: true,
          issues: review.document.issues,
        });
        throw new Error(`Expected live failure ${stage}.`);
      } catch (error) {
        expect(error).toBeInstanceOf(PdfPublicationTransactionError);
        const transaction = error as PdfPublicationTransactionError;
        expect(transaction.rollback.failed).toEqual([]);
        expect(transaction.rollback.attempted).toEqual([...createdIds].reverse());
        expect(transaction.rollback.deleted).toEqual([...createdIds].reverse());
      } finally {
        for (const id of createdIds) await removeIfPresent(base, id);
      }
      expect(createdIds).toHaveLength(1);
      await assertNoCurrentState(base, { ids: createdIds, titles: [title] });
    }
  }, CASE_TIMEOUT_MS);

  it("keeps the shared DOCX built-CLI publication path compatible", async () => {
    const active = await profile();
    const client = new ConfluenceClient(active);
    const port = createConfluencePort(active);
    const title = makeE2eTitle("import-pdf-docx-regression");
    const directory = await mkdtemp(join(tmpdir(), "atlcli-import-pdf-docx-"));
    const file = join(directory, "neutral.docx");
    let cleanup: E2eCleanupSummary | undefined;
    try {
      await writeFile(file, buildDocxFixture({
        body: p(r("Neutral DOCX Regression"), { style: "Heading1" }) + p(r("Shared publication remains compatible.")),
      }));
      const proof = await withE2eResources(
        { confluence: port },
        async (tracker): Promise<PublishedProof> => {
          const receipt = await runBuiltCli<DocxCliReceipt>([
            "wiki", "import", file,
            "--profile", PROFILE_NAME,
            "--space", E2E_SPACE_KEY,
            "--title", title,
            "--confirm",
            "--json",
          ]);
          expect(receipt.mode).toBe("published");
          await stampAndTrack(tracker, port, [receipt.page]);
          const summary = summarizeAdf((await client.getPageAdf(receipt.page.id)).body.value);
          expect(summary.text).toContain("Neutral DOCX Regression");
          expect(summary.text).toContain("Shared publication remains compatible.");
          return { ids: [receipt.page.id], titles: [receipt.page.title] };
        },
        { runId: resolveRunId(), onCleanup: (summary) => { cleanup = summary; } },
      );
      expect(cleanup?.failures).toEqual([]);
      await assertNoCurrentState(client, proof);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);
});
