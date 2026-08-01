---
title: "Search, indexing, and ranking"
description: "Configure privacy-safe Pagefind search for static Astro publications"
---

# Search, indexing, and ranking

The supported Starlight experience uses Pagefind as a post-build, static search
index. It does not require a hosted search backend or transmit source content.

## Indexed fields

Page bodies are indexed from the single `data-pagefind-body` region. The
publication integration adds title, source id, labels, and language metadata as
facets. Breadcrumbs, edit actions, analytics markers, and other chrome are
excluded. Private source URLs and search terms are never emitted into the
index.

## Languages and RTL

Declare the languages in the project configuration. Each page carries its
resolved `lang` and `dir`; English, German, Arabic, Unicode, and diacritic
queries are tested independently. Pagefind's language partitions are preserved
rather than merged into one unlabelled index.

## Performance budgets

The build measures the generated search files and gates three corpus classes:

| Corpus | Total index budget |
| --- | ---: |
| 3 pages | 1 MiB |
| 24 pages | 4 MiB |
| 100 pages | 16 MiB |

The initial Pagefind JavaScript budget is 256 KiB, query P95 is 500 ms in the
deterministic harness, and post-initialization heap growth is capped at 128 MiB.
The browser matrix additionally checks a five-second upper bound for a query
after the search dialog is open.

## Accessibility and fallback

Search opens by mouse or `ControlOrMeta+K`, traps focus while open, supports
keyboard closing, and exposes no-result and unavailable states. The default
worker is preferred; a main-thread fallback remains available when a strict CSP
or browser environment cannot create a worker. The narrow `wasm-unsafe-eval`
directive is required for Pagefind's WASM index; broad `unsafe-eval` is not
allowed.

## Ranking and exclusions

Ranking remains Pagefind's deterministic local ranking. Use labels and language
facets for operator-visible narrowing rather than injecting hidden keywords.
Excluded pages must be removed on a same-output rebuild; the deletion test
guards against stale index entries.

## Related topics

- [Publishing guide](./index.md)
- [Security and privacy](./security.md)
- [Operations](./operations.md)
