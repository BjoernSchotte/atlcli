# @atlcli/confluence

Confluence REST client, bidirectional storage ↔ markdown conversion, and the
`ExportBlock` document model shared by the DOCX and PDF export engines.

- **Entry points:**
  - `.` / `./node` — the v1 surface: `ConfluenceClient`, `storageToMarkdown` /
    `markdownToStorage`, `storageToBlocks` + `ExportBlock`, mention
    resolution, page properties. Identical to `./browser`; statically clean
    of `node:`/`bun:` builtins.
  - `./browser` — same isomorphic surface for bundlers.
  - `./internal` — **non-frozen, Bun-only** repo machinery (sync-db on
    `bun:sqlite`, atlcli-dir, webhook server, poller, …). May change without
    notice.
- **Runtime:** Node ≥ 20, Bun, and browsers for `.`/`./browser`; Bun only for
  `./internal`.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { storageToBlocks } from "@atlcli/confluence";

const { blocks, notes } = storageToBlocks(page.storage);
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
