# @atlcli/diagram

Format-agnostic mermaid → SVG rendering (via the self-contained
`beautiful-mermaid` renderer — synchronous, DOM-free, CSP-clean). Knows
nothing about DOCX/PDF; each export path embeds the returned SVG its own way.

- **Entry points:** `.` — `renderDiagram`, `warmDiagramRenderer`,
  `flattenSvgStyles`, `DiagramTheme`, `DEFAULT_DIAGRAM_THEME`.
- **Runtime:** Node ≥ 20, Bun, and browsers. The renderer chunk (~1.5 MB)
  loads lazily on the first supported diagram only.
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { renderDiagram } from "@atlcli/diagram";

const result = await renderDiagram("graph TD; A-->B");
if (result.kind === "svg") console.log(result.widthPx, result.heightPx);
```

Never throws — unsupported diagram types and parse failures come back as
structured results. Versioning: lockstep `@atlcli/*` train — see
[package versioning](https://atlcli.sh/reference/versioning/).
