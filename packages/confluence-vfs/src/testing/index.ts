/**
 * Test doubles for the Confluence VFS, exported so `apps/cli` adapter tests can
 * build a filesystem without reaching a tenant.
 */
export {
  FakeConfluenceClient,
  FakeHttpError,
  type FakeAttachmentSeed,
  type FakeClientOptions,
  type FakeFailure,
  type FakePageSeed,
  type FakeSpaceSeed,
} from "./fake-client.js";
