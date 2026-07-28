# @atlcli/template-pack

Pure byte-in/byte-out functions for the `.wiki-pdf-template` container
(spec 007): pack/unpack/validate a template payload plus manifest with a
deterministic zip layout and sha256 payload integrity. Shared by the Typst
and DOCX engines and any external template tooling.

- **Entry points:** `.` / `./node` / `./browser` (identical isomorphic
  surface) — `packTemplate`, `unpackTemplate`, `validatePack`, the
  `TemplateManifest` types, and engine-neutral visual asset/decorations
  contracts.
- **Runtime:** Node ≥ 20, Bun, and browsers (PizZip + WebCrypto only).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { packTemplate, unpackTemplate } from "@atlcli/template-pack";

const packed = await packTemplate({ payload, manifest });
const { manifest: readBack, payload: bytes } = await unpackTemplate(packed);
```

`validateManifest()` checks only portable manifest shape: safe asset paths,
hashes, descriptors, references, placement bounds, and exact object keys. It
does not claim that an engine supports a slot, writer, scope, or decoration,
and it does not inspect payload bytes. Hosts must follow it with their
engine-specific manifest and pack-integrity validators.

Canonical authoring packs can identify their generated source through
`canonicalSource`. That marker lets an engine reject generator-foreign payload
files while legacy packs remain readable under the existing container policy.

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
