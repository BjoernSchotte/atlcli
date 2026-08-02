---
title: "Experience adapter authoring"
description: "Add an Astro presentation layer without coupling it to Confluence or ADF"
---

An experience adapter owns presentation, not source acquisition. The neutral
publication bundle and `@atlcli/export-blocks-astro` remain the stable seam
between Confluence and Astro.

## Adapter responsibilities

An adapter may own:

- page shell, navigation slots, theme tokens, and route components;
- documented capabilities such as search, SEO, locale/RTL, or code styling;
- mapping of the neutral navigation plan into the theme's public API;
- static component overrides selected by the project, never by page content.

It must not own ADF/Storage parsing, Confluence credentials, page crawling,
bundle activation, or arbitrary HTML execution.

## Minimal composition

```astro
---
import ExportDocument from "@atlcli/export-blocks-astro/components/ExportDocument.astro";
import { createPublicationRenderContextV1 } from "@atlcli/web-publish-astro";

const context = createPublicationRenderContextV1({ bundle, page, base: "/docs" });
---

<main>
  <h1>{page.title}</h1>
  <ExportDocument blocks={page.blocks} context={context} />
</main>
```

The component registry is theme-neutral. A theme can override presentation via
the documented slot map, but it must retain semantic HTML, safe links, visible
unknown fallbacks, and the baseline accessibility contract.

## Conformance checklist

1. Declare an immutable experience id, version, capability set, and digest.
2. Consume `PublicationPageV1` and the preplanned navigation; do not recrawl.
3. Pass the trusted render context to one document dispatcher.
4. Keep static output usable with JavaScript disabled.
5. Add packed-consumer, route, link, CSP, accessibility, and privacy tests.
6. Register the experience only after its compatibility matrix is proven.

Starlight is the first supported experience. A future theme can implement the
same contract without requiring a second ADF component tree.

## Migration from a Markdown theme

Keep Markdown sync as an editing workflow. For publishing, replace the Markdown
loader with the immutable bundle loader, map the page body to `ExportBlock[]`,
and let the adapter supply the shell. Existing search, navigation, and theme
features can remain theme-owned.

## Related topics

- [Publishing guide](./index.md)
- [Renderers and charts](./renderers.md)
- [`@atlcli/export-blocks-astro` package reference](/reference/export-blocks-astro/)
