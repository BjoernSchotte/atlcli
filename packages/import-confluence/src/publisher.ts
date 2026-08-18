import {
  documentToAdf,
  documentToStorage,
  type AdfDocument,
  type AdfMediaResolution,
  type ImportDocumentV2,
} from "@atlcli/import-core";
import {
  verifyAdfSemanticReadback,
  verifyStorageSemanticReadback,
  type ConfluenceSemanticReadbackV1,
} from "./readback.js";

export const PREPARED_CONFLUENCE_PAGE_SCHEMA_V1 = "atlcli.prepared-confluence-page/1" as const;

export interface PreparedConfluencePageV1 {
  schema: typeof PREPARED_CONFLUENCE_PAGE_SCHEMA_V1;
  title: string;
  parentId?: string;
  document: ImportDocumentV2;
  review?: {
    sourceSha256: string;
    planDigest: string;
  };
}

export interface PublishedConfluencePageV1 {
  id: string;
  title: string;
  url?: string;
  version?: number;
}

export interface CloudImportClientPort {
  createPageAdf(input: {
    spaceId: string;
    title: string;
    adf: unknown;
    parentId?: string;
  }): Promise<PublishedConfluencePageV1>;
  updatePageAdf(input: {
    id: string;
    title: string;
    adf: unknown;
    version: number;
  }): Promise<PublishedConfluencePageV1>;
  getPageAdf(id: string): Promise<{ body: { value: string }; version?: number }>;
  uploadAttachment(input: {
    pageId: string;
    filename: string;
    data: Uint8Array;
    mimeType?: string;
  }): Promise<unknown>;
  listPageAttachmentMedia(pageId: string): Promise<{
    attachments: Array<{ filename: string; fileId: string }>;
  }>;
}

export interface DcImportClientPort {
  createPage(input: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string;
  }): Promise<PublishedConfluencePageV1>;
  updatePage(input: {
    id: string;
    title: string;
    storage: string;
    version: number;
  }): Promise<PublishedConfluencePageV1>;
  getPageDetails(id: string): Promise<{ storage?: string }>;
  uploadAttachment(input: {
    pageId: string;
    filename: string;
    data: Uint8Array;
    mimeType?: string;
  }): Promise<unknown>;
  addLabels(pageId: string, labels: string[]): Promise<unknown>;
  getLabels(pageId: string): Promise<Array<{ name: string }>>;
}

export interface OwnedPageDeletePort {
  deletePage(pageId: string): Promise<void>;
}

export interface CloudPublishResultV1 {
  page: PublishedConfluencePageV1;
  readbackValue: string;
  readback: ConfluenceSemanticReadbackV1;
  adf: AdfDocument;
}

export interface DcPublishResultV1 {
  page: PublishedConfluencePageV1;
  readback: ConfluenceSemanticReadbackV1;
  storage: string;
}

export interface OwnedPageRollbackV1 {
  attempted: string[];
  deleted: string[];
  failed: string[];
}

function validatePreparedPage(plan: PreparedConfluencePageV1): void {
  if (plan.schema !== PREPARED_CONFLUENCE_PAGE_SCHEMA_V1) throw new Error("Prepared Confluence page schema is invalid.");
  if (!plan.title || plan.title.length > 255) throw new Error("Prepared Confluence page title is invalid.");
  if (plan.document.schema !== "atlcli.import-document/2") throw new Error("Prepared import document schema is invalid.");
  const assetIds = new Set<string>();
  const filenames = new Set<string>();
  for (const asset of plan.document.assets) {
    if (assetIds.has(asset.id)) throw new Error(`Prepared import contains duplicate asset id ${asset.id}.`);
    if (filenames.has(asset.fileName)) throw new Error(`Prepared import contains duplicate attachment filename ${asset.fileName}.`);
    assetIds.add(asset.id);
    filenames.add(asset.fileName);
  }
}

export function prepareConfluencePage(input: Omit<PreparedConfluencePageV1, "schema">): PreparedConfluencePageV1 {
  const plan: PreparedConfluencePageV1 = { schema: PREPARED_CONFLUENCE_PAGE_SCHEMA_V1, ...input };
  validatePreparedPage(plan);
  return plan;
}

async function resolveCloudMedia(
  client: CloudImportClientPort,
  pageId: string,
  plan: PreparedConfluencePageV1,
): Promise<Map<string, AdfMediaResolution> | undefined> {
  if (plan.document.assets.length === 0) return undefined;
  for (const asset of plan.document.assets) {
    await client.uploadAttachment({
      pageId,
      filename: asset.fileName,
      data: asset.bytes,
      mimeType: asset.mediaType,
    });
  }
  const mediaList = await client.listPageAttachmentMedia(pageId);
  const fileIdByName = new Map(mediaList.attachments.map((attachment) => [attachment.filename, attachment.fileId]));
  const media = new Map<string, AdfMediaResolution>();
  for (const asset of plan.document.assets) {
    const fileId = fileIdByName.get(asset.fileName);
    if (!fileId) throw new Error(`Uploaded attachment ${asset.fileName} has no resolvable media fileId.`);
    media.set(asset.id, { fileId, collection: `contentId-${pageId}` });
  }
  return media;
}

export async function createPreparedCloudShell(
  client: CloudImportClientPort,
  spaceId: string,
  plan: PreparedConfluencePageV1,
  onOwnedPage: (pageId: string) => void,
): Promise<PublishedConfluencePageV1> {
  validatePreparedPage(plan);
  const page = await client.createPageAdf({
    spaceId,
    title: plan.title,
    adf: { version: 1, type: "doc", content: [] },
    parentId: plan.parentId,
  });
  onOwnedPage(page.id);
  return page;
}

export async function finalizePreparedCloudPage(
  client: CloudImportClientPort,
  pageId: string,
  plan: PreparedConfluencePageV1,
  options: {
    version?: number;
    references?: ReadonlyMap<string, string>;
  } = {},
): Promise<CloudPublishResultV1> {
  validatePreparedPage(plan);
  const media = await resolveCloudMedia(client, pageId, plan);
  const adf = documentToAdf(plan.document, {
    ...(media ? { media } : {}),
    ...(options.references ? { references: options.references } : {}),
  });
  const updated = await client.updatePageAdf({
    id: pageId,
    title: plan.title,
    adf,
    version: options.version ?? 2,
  });
  const readbackPage = await client.getPageAdf(pageId);
  const readback = await verifyAdfSemanticReadback(adf, readbackPage.body.value);
  return { page: updated, readbackValue: readbackPage.body.value, readback, adf };
}

export async function publishPreparedCloudPage(
  client: CloudImportClientPort,
  spaceId: string,
  plan: PreparedConfluencePageV1,
  options: {
    forceShell?: boolean;
    afterShell?: (pageId: string) => Promise<void>;
    onOwnedPage: (pageId: string) => void;
  },
): Promise<CloudPublishResultV1> {
  validatePreparedPage(plan);
  const useShell = options.forceShell === true || plan.document.assets.length > 0;
  if (useShell) {
    const shell = await createPreparedCloudShell(client, spaceId, plan, options.onOwnedPage);
    if (options.afterShell) await options.afterShell(shell.id);
    if (plan.document.blocks.length === 0 && plan.document.assets.length === 0) {
      const readbackPage = await client.getPageAdf(shell.id);
      const expected: AdfDocument = { version: 1, type: "doc", content: [] };
      const readback = await verifyAdfSemanticReadback(expected, readbackPage.body.value);
      return { page: shell, readbackValue: readbackPage.body.value, readback, adf: expected };
    }
    const finalized = await finalizePreparedCloudPage(client, shell.id, plan);
    return { ...finalized, page: { ...finalized.page, url: finalized.page.url ?? shell.url } };
  }

  const adf = documentToAdf(plan.document);
  const page = await client.createPageAdf({
    spaceId,
    title: plan.title,
    adf,
    parentId: plan.parentId,
  });
  options.onOwnedPage(page.id);
  const readbackPage = await client.getPageAdf(page.id);
  const readback = await verifyAdfSemanticReadback(adf, readbackPage.body.value);
  return { page, readbackValue: readbackPage.body.value, readback, adf };
}

export async function publishPreparedDcPage(
  client: DcImportClientPort,
  spaceKey: string,
  plan: PreparedConfluencePageV1,
  options: {
    labels?: string[];
    onOwnedPage: (pageId: string) => void;
  },
): Promise<DcPublishResultV1> {
  validatePreparedPage(plan);
  const shell = await client.createPage({
    spaceKey,
    title: plan.title,
    storage: "<p/>",
    parentId: plan.parentId,
  });
  options.onOwnedPage(shell.id);
  for (const asset of plan.document.assets) {
    await client.uploadAttachment({
      pageId: shell.id,
      filename: asset.fileName,
      data: asset.bytes,
      mimeType: asset.mediaType,
    });
  }
  const storage = documentToStorage(plan.document);
  const updated = await client.updatePage({ id: shell.id, title: plan.title, storage, version: 2 });
  const details = await client.getPageDetails(shell.id);
  const readback = await verifyStorageSemanticReadback(storage, details.storage ?? "");
  const labels = options.labels ?? [];
  if (labels.length > 0) {
    await client.addLabels(shell.id, labels);
    const effective = new Set((await client.getLabels(shell.id)).map((label) => label.name));
    const missing = labels.filter((label) => !effective.has(label));
    if (missing.length > 0) throw new Error(`Label readback failed: ${missing.length} required label(s) are missing.`);
  }
  return {
    page: { ...updated, url: updated.url ?? shell.url },
    readback,
    storage,
  };
}

export async function rollbackOwnedPages(
  client: OwnedPageDeletePort,
  ownedPageIds: readonly string[],
): Promise<OwnedPageRollbackV1> {
  const attempted = [...new Set(ownedPageIds)].reverse();
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const pageId of attempted) {
    try {
      await client.deletePage(pageId);
      deleted.push(pageId);
    } catch {
      failed.push(pageId);
    }
  }
  return { attempted, deleted, failed };
}
