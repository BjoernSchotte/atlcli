import type { VisualOracleEntryV1 } from "../visual-oracle.js";

/** Independently reviewed facts for the two real editor-produced fixtures. */
export const REAL_VISUAL_FIXTURE_ORACLES: Readonly<
  Record<string, readonly VisualOracleEntryV1[]>
> = Object.freeze({
  "neutral-word-16.111.1.docx": [
    {
      key: "scene.document.0.0.section.0.body.representation.0",
      assetSha256:
        "56ff7db1ba5c55b8f4c010bad5b24c9c78b9bfe8a79f01dee48bea5a5cd1248e",
      relationshipRef: "relationship.0.18be24b2a37d",
      targetFingerprint:
        "57e2db12d19d09064c92a88456eda68201fcc54258cb2db4a05610be8a95d411",
      alternateBranch: "",
      crop: "null",
      horizontalReference: "",
      verticalReference: "",
      section: 0,
      master: "",
      adoption: "do-not-include",
    },
  ],
  "neutral-libreoffice-7.1.1.2.docx": [
    {
      key: "scene.document.0.0.section.0.body.representation.0",
      assetSha256:
        "56ff7db1ba5c55b8f4c010bad5b24c9c78b9bfe8a79f01dee48bea5a5cd1248e",
      relationshipRef: "relationship.0.46921d070e56",
      targetFingerprint:
        "71e7f1524a7409af5d5080590ac55eb7949e2fba48d27af11506af7014b43d44",
      alternateBranch: "",
      crop: "null",
      horizontalReference: "",
      verticalReference: "",
      section: 0,
      master: "",
      adoption: "do-not-include",
    },
  ],
});
