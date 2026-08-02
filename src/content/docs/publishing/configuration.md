---
title: "Web publishing configuration"
description: "Configure scope, routes, experiences, search, media, privacy, and retention"
---

# Web publishing configuration

The project file is operator-owned configuration. It is parsed and validated
before acquisition; credentials remain in the selected profile and are never
copied into the file or bundle.

## On this page

- [Configuration shape](#configuration-shape)
- [Source and completeness](#source-and-completeness)
- [Builder and output](#builder-and-output)
- [Search, media, analytics, and edit links](#search-media-analytics-and-edit-links)
- [Retention](#retention)

## Configuration shape

The complete schema is versioned in `@atlcli/web-publish`. The following is a
representative fragment; use the package schema for required defaults and
validation:

```json
{
  "schema": "atlcli.publication-project/1",
  "publicationKey": "product-docs",
  "source": { "kind": "tree", "rootPageId": "12345" },
  "completeness": "strict",
  "visibility": "internal",
  "experience": { "id": "atlcli.starlight", "version": "1" },
  "search": { "languages": ["en", "de"] },
  "analytics": { "provider": "none" },
  "editLink": { "provider": "none" },
  "builder": {
    "builder": "astro-static",
    "projectDir": "./site",
    "outputProfile": "directory",
    "base": "/docs",
    "buildCommand": ["bun", "run", "build"]
  }
}
```

Paths are resolved from the project file's working directory. Keep the private
bundle workspace outside the public Astro output directory.

## Source and completeness

`source.kind` is `page`, `tree`, or `space`. A tree includes its root and follows
the planned hierarchy. `sourcePolicy` can bound depth/pages/folders and filter
labels. `strict` aborts on inaccessible, ambiguous, or changed pages. The
explicit `allow-partial` acknowledgement is required before a partial result
can be activated.

Cloud uses ADF as the primary representation. Data Center uses Storage XHTML.
Both converge on the same `ExportBlock[]` page contract.

## Builder and output

`base` is the URL prefix used by Astro. `outputProfile` is either:

- `directory`: `/guide/index.html`, served by a directory-index host;
- `portable-file`: `/guide.html`, served by a simple file host.

The builder is pinned to Astro `7.1.6` for the minimum fixture and supports the
tested Astro 7.x range. The Astro project owns its dependencies, routes, theme,
and build command. atlcli owns only the publication integration and its private
inventory.

## Search, media, analytics, and edit links

- Pagefind languages and facet values are declared in `search`; page content
  remains static and search runs in the browser.
- `media.images` chooses verified originals or bounded Astro-responsive
  derivatives; `fonts` chooses system or vendored local fonts.
- `analytics.provider` defaults to `none`; Plausible requires a credential-free
  HTTPS `/api/event` endpoint and an explicit site domain.
- `editLink.provider` defaults to `none`; Confluence links require provider
  relations and, for public/all visibility, explicit tenant-disclosure
  acknowledgement.

## Retention

`retention` bounds retained bundles, builds, and their grace period. Cleanup is
never inferred from titles or globs. Use `atlcli wiki publish prune --confirm`
after reviewing the status report.

## Related topics

- [Publishing guide](./index.md)
- [Operations and rollback](./operations.md)
- [Security and privacy](./security.md)
- [CLI configuration](/configuration/)
