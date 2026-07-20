# @atlcli/template-pack

Pure byte-in/byte-out functions for the `.wiki-pdf-template` container
(spec 007): pack/unpack/validate a template payload plus manifest with a
deterministic zip layout and sha256 payload integrity. Shared by the Typst
and DOCX engines and any external template tooling.

- **Entry points:** `.` / `./node` / `./browser` (identical isomorphic
  surface) — `packTemplate`, `unpackTemplate`, `validatePack`, the
  `TemplateManifest` types.
- **Runtime:** Node ≥ 20, Bun, and browsers (PizZip + WebCrypto only).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { packTemplate, unpackTemplate } from "@atlcli/template-pack";

const packed = await packTemplate({ payload, manifest });
const { manifest: readBack, payload: bytes } = await unpackTemplate(packed);
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
