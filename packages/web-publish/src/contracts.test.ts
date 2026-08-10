import { expect, test } from "bun:test";
import {
  PUBLICATION_BUNDLE_SCHEMA_V1,
  PUBLICATION_PROJECT_SCHEMA_V1,
  STATIC_PUBLICATION_MANIFEST_SCHEMA_V1,
  type PublicationProjectV1,
} from "./index.js";

test("web publishing schemas and contracts are available from the browser-safe entry", () => {
  expect(PUBLICATION_PROJECT_SCHEMA_V1).toBe("atlcli.publication-project/1");
  expect(PUBLICATION_BUNDLE_SCHEMA_V1).toBe("atlcli.publication-bundle/1");
  expect(STATIC_PUBLICATION_MANIFEST_SCHEMA_V1)
    .toBe("atlcli.static-publication-manifest/1");

  const operation: PublicationProjectV1["builder"]["builder"] = "astro-static";
  expect(operation).toBe("astro-static");
});
