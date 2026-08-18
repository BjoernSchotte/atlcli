import { sha256Hex } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  createPreparedCloudShell,
  finalizePreparedCloudPage,
  prepareConfluencePage,
  publishPreparedCloudPage,
  publishPreparedDcPage,
  rollbackOwnedPages,
  type OwnedPageRollbackV1,
  type PublishedConfluencePageV1,
} from "@atlcli/import-confluence";
import { IMPORT_DOCUMENT_SCHEMA_V2, importReferenceKey, type ImportDocumentV2 } from "@atlcli/import-core";
import type { DestinationGovernance } from "@atlcli/import-docx";
import type { PdfPlannedPageV1, PdfSplitPlanV1 } from "@atlcli/import-pdf";
import { applyMetadata, applyRestriction } from "./wiki-import-destination.js";

export interface PdfSourceAttachmentReceiptV1 {
  role: "source-pdf";
  filename: string;
  sha256: string;
  byteLength: number;
}

export interface PublishedPdfPageV1 extends PublishedConfluencePageV1 {
  plannedPageId: string;
  sourcePageIndexes: number[];
  children?: PublishedPdfPageV1[];
}

export interface PdfPublicationResultV1 {
  root: PublishedPdfPageV1;
  pagesCreated: number;
  publicationPlanDigest: string;
  sourceAttachment?: PdfSourceAttachmentReceiptV1;
}

export class PdfPublicationTransactionError extends Error {
  constructor(
    message: string,
    readonly rollback: OwnedPageRollbackV1,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PdfPublicationTransactionError";
  }
}

function documentFor(page: PdfPlannedPageV1, issues: ImportDocumentV2["issues"]): ImportDocumentV2 {
  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    blocks: page.blocks,
    assets: page.assets,
    issues,
  };
}

function assertPlanReady(plan: PdfSplitPlanV1): void {
  if (plan.blockers.length > 0) throw new Error("PDF publication plan still has blockers.");
  if (plan.totalWikiPages > plan.requested.maxWikiPages || plan.totalWikiPages > 200) {
    throw new Error("PDF publication plan exceeds its page cap.");
  }
  const assignments = plan.sourceAssignments.map((item) => item.pageIndex);
  if (assignments.some((page, index) => page !== index)) throw new Error("PDF publication plan has incomplete source-page ownership.");
  const walk = (page: PdfPlannedPageV1): void => {
    if (page.sourcePageIndexes.length > 40) throw new Error("PDF publication page exceeds the 40-source-page hard limit.");
    if (page.estimate.editability === "risk") throw new Error("PDF publication page exceeds the editability risk budget.");
    page.children.forEach(walk);
  };
  walk(plan.root);
}

async function attachSourcePdf(
  client: ConfluenceClient,
  pageId: string,
  sourceBytes: Uint8Array,
  sourceSha256: string,
): Promise<PdfSourceAttachmentReceiptV1> {
  const filename = sourcePdfFilename(sourceSha256);
  const attachment = await client.uploadAttachment({
    pageId,
    filename,
    data: sourceBytes,
    mimeType: "application/pdf",
  });
  const downloaded = await client.downloadAttachment(attachment);
  const readbackSha256 = await sha256Hex(downloaded);
  if (readbackSha256 !== sourceSha256 || downloaded.byteLength !== sourceBytes.byteLength) {
    throw new Error("Source PDF attachment byte-digest readback failed.");
  }
  return { role: "source-pdf", filename, sha256: sourceSha256, byteLength: sourceBytes.byteLength };
}

function sourcePdfFilename(sourceSha256: string): string {
  return `source-${sourceSha256.slice(0, 16)}.pdf`;
}

function assertSourceAttachmentNameAvailable(plan: PdfSplitPlanV1, sourceSha256: string): void {
  const filename = sourcePdfFilename(sourceSha256);
  if (flattenPages(plan.root).some((page) => page.assets.some((asset) => asset.fileName === filename))) {
    throw new Error("Source PDF attachment filename collides with an extracted content asset.");
  }
}

function flattenPages(root: PdfPlannedPageV1): PdfPlannedPageV1[] {
  return [root, ...root.children.flatMap(flattenPages)];
}

export async function publishPdfCloud(input: {
  client: ConfluenceClient;
  spaceId: string;
  plan: PdfSplitPlanV1;
  parentId?: string;
  governance: DestinationGovernance;
  stagingTitle?: string;
  sourceBytes: Uint8Array;
  sourceSha256: string;
  attachSource: boolean;
  issues: ImportDocumentV2["issues"];
}): Promise<PdfPublicationResultV1> {
  assertPlanReady(input.plan);
  if (input.attachSource) assertSourceAttachmentNameAvailable(input.plan, input.sourceSha256);
  const owned: string[] = [];
  let sourceAttachment: PdfSourceAttachmentReceiptV1 | undefined;
  try {
    const needsRestriction = input.governance.restriction.mode !== "inherit";
    const needsStaging = input.governance.staging.mode === "private-parent";
    const importer = needsRestriction || needsStaging ? await input.client.getCurrentUser() : undefined;
    let parentId = input.parentId;

    if (input.governance.staging.mode === "private-parent") {
      const staging = prepareConfluencePage({
        title: input.stagingTitle ?? input.governance.staging.title,
        parentId,
        document: { schema: IMPORT_DOCUMENT_SCHEMA_V2, sourceKind: "pdf", blocks: [], assets: [], issues: [] },
      });
      const shell = await createPreparedCloudShell(input.client, input.spaceId, staging, (id) => owned.push(id));
      await applyRestriction(
        input.client,
        shell.id,
        { ...input.governance, restriction: { mode: "private" } },
        importer!.accountId,
      );
      await input.client.createPageProperty(shell.id, "atlcli.import.staging", true);
      if (await input.client.getPagePropertyByKey(shell.id, "atlcli.import.staging") !== true) {
        throw new Error("Staging marker readback failed.");
      }
      parentId = shell.id;
    }

    const afterRootShell = async (pageId: string): Promise<void> => {
      if (needsRestriction) await applyRestriction(input.client, pageId, input.governance, importer!.accountId);
      if (input.attachSource) {
        sourceAttachment = await attachSourcePdf(input.client, pageId, input.sourceBytes, input.sourceSha256);
      }
    };

    if (input.plan.resolved.kind === "single-page") {
      const page = input.plan.root;
      const published = await publishPreparedCloudPage(
        input.client,
        input.spaceId,
        prepareConfluencePage({
          title: page.title,
          parentId,
          document: documentFor(page, input.issues),
          review: { sourceSha256: input.sourceSha256, planDigest: input.plan.digest },
        }),
        {
          forceShell: needsRestriction || input.attachSource,
          afterShell: afterRootShell,
          onOwnedPage: (id) => owned.push(id),
        },
      );
      await applyMetadata(input.client, published.page.id, input.governance);
      return {
        root: {
          ...published.page,
          plannedPageId: page.id,
          sourcePageIndexes: [...page.sourcePageIndexes],
        },
        pagesCreated: owned.length,
        publicationPlanDigest: input.plan.digest,
        ...(sourceAttachment ? { sourceAttachment } : {}),
      };
    }

    const shells = new Map<string, PublishedConfluencePageV1>();
    const createShells = async (page: PdfPlannedPageV1, targetParentId: string | undefined): Promise<void> => {
      const shell = await createPreparedCloudShell(
        input.client,
        input.spaceId,
        prepareConfluencePage({ title: page.title, parentId: targetParentId, document: documentFor(page, input.issues) }),
        (id) => owned.push(id),
      );
      shells.set(page.id, shell);
      if (page === input.plan.root) await afterRootShell(shell.id);
      for (const child of page.children) await createShells(child, shell.id);
    };
    await createShells(input.plan.root, parentId);

    const references = new Map<string, string>();
    for (const page of flattenPages(input.plan.root)) {
      const shell = shells.get(page.id);
      if (!shell?.url) throw new Error("Cloud did not return a URL for a planned page shell.");
      references.set(importReferenceKey({ namespace: "pdf-page", target: page.id }), shell.url);
    }

    const finalize = async (page: PdfPlannedPageV1, expectedParentId: string | undefined): Promise<PublishedPdfPageV1> => {
      const shell = shells.get(page.id)!;
      const finalized = await finalizePreparedCloudPage(
        input.client,
        shell.id,
        prepareConfluencePage({
          title: page.title,
          document: documentFor(page, input.issues),
          review: { sourceSha256: input.sourceSha256, planDigest: input.plan.digest },
        }),
        { references },
      );
      const details = await input.client.getPageDetails(shell.id);
      if (details.title !== page.title || (expectedParentId !== undefined && details.parentId !== expectedParentId)) {
        throw new Error("Published PDF tree title/parent readback mismatch.");
      }
      const children: PublishedPdfPageV1[] = [];
      for (const child of page.children) children.push(await finalize(child, shell.id));
      return {
        ...finalized.page,
        ...(details.parentId !== undefined || expectedParentId !== undefined
          ? { parentId: details.parentId ?? expectedParentId }
          : {}),
        plannedPageId: page.id,
        sourcePageIndexes: [...page.sourcePageIndexes],
        ...(children.length > 0 ? { children } : {}),
      };
    };
    const rootShell = shells.get(input.plan.root.id)!;
    const root = await finalize(input.plan.root, parentId);
    await applyMetadata(input.client, rootShell.id, input.governance);
    return {
      root,
      pagesCreated: owned.length,
      publicationPlanDigest: input.plan.digest,
      ...(sourceAttachment ? { sourceAttachment } : {}),
    };
  } catch (error) {
    const rollback = await rollbackOwnedPages(input.client, owned);
    throw new PdfPublicationTransactionError(
      rollback.failed.length > 0
        ? `PDF publication failed and ${rollback.failed.length} owned page(s) could not be rolled back.`
        : `PDF publication failed; ${rollback.deleted.length} owned page(s) were rolled back.`,
      rollback,
      { cause: error },
    );
  }
}

export async function publishPdfDc(input: {
  client: ConfluenceClient;
  spaceKey: string;
  plan: PdfSplitPlanV1;
  parentId?: string;
  labels: string[];
  sourceBytes: Uint8Array;
  sourceSha256: string;
  attachSource: boolean;
  issues: ImportDocumentV2["issues"];
}): Promise<PdfPublicationResultV1> {
  assertPlanReady(input.plan);
  if (input.attachSource) assertSourceAttachmentNameAvailable(input.plan, input.sourceSha256);
  if (input.plan.resolved.kind !== "single-page") {
    throw new Error(`Data Center cannot publish the resolved ${input.plan.totalWikiPages}-page PDF tree; it is not flattened.`);
  }
  const owned: string[] = [];
  let sourceAttachment: PdfSourceAttachmentReceiptV1 | undefined;
  try {
    const page = input.plan.root;
    const published = await publishPreparedDcPage(
      input.client,
      input.spaceKey,
      prepareConfluencePage({
        title: page.title,
        parentId: input.parentId,
        document: documentFor(page, input.issues),
        review: { sourceSha256: input.sourceSha256, planDigest: input.plan.digest },
      }),
      {
        labels: input.labels,
        onOwnedPage: (id) => owned.push(id),
        ...(input.attachSource ? {
          afterShell: async (pageId: string) => {
            sourceAttachment = await attachSourcePdf(input.client, pageId, input.sourceBytes, input.sourceSha256);
          },
        } : {}),
      },
    );
    return {
      root: {
        ...published.page,
        plannedPageId: page.id,
        sourcePageIndexes: [...page.sourcePageIndexes],
      },
      pagesCreated: 1,
      publicationPlanDigest: input.plan.digest,
      ...(sourceAttachment ? { sourceAttachment } : {}),
    };
  } catch (error) {
    const rollback = await rollbackOwnedPages(input.client, owned);
    throw new PdfPublicationTransactionError(
      rollback.failed.length > 0
        ? `Data Center PDF publication failed and rollback was incomplete.`
        : `Data Center PDF publication failed and its owned page was rolled back.`,
      rollback,
      { cause: error },
    );
  }
}
