/**
 * Minimal Confluence surface for the MV3 research worker.
 *
 * Keep this entrypoint free of the storage↔Markdown converter: Turndown owns
 * DOM-oriented initialization that is valid in extension pages but not in a
 * DedicatedWorkerGlobalScope. Research needs only the REST client, the
 * dependency-free Storage→ExportBlock parser, and URL sanitization.
 */
export {
  ConfluenceClient,
  type ConfluenceTransportEvent,
} from "./client.js";
export {
  StorageParseError,
  storageToBlocks,
  type ExportBlock,
  type InlineNode,
  type LinkTarget,
} from "./export-blocks.js";
export { sanitizeLinkHref } from "./link-safety.js";
