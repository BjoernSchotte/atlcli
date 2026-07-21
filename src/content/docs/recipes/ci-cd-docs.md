---
title: "CI/CD Documentation"
description: "CI/CD Documentation - atlcli documentation"
---

# CI/CD Documentation

Publish documentation to Confluence from CI/CD pipelines — and, on a release,
export the published tree back out as a versioned PDF or Word artifact.

## On this page

- [Prerequisites](#prerequisites)
- [Use case](#use-case)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [Jenkins](#jenkins)
- [Export the published docs as a release artifact](#export-the-published-docs-as-a-release-artifact)
- [Best practices](#best-practices)
- [Related topics](#related-topics)

## Prerequisites

- Atlassian API token stored as CI/CD secret
- atlcli installed in CI environment
- **Confluence permission**: Edit Pages (to publish); View (to export)

## Use Case

Automatically publish documentation to Confluence when:

- Code is merged to main
- Release is tagged
- Documentation files change

…and produce a downloadable handbook from the same source of truth when you cut
a release.

## GitHub Actions

### On Push to Main

```yaml
name: Publish Docs

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: curl -fsSL https://atlcli.sh/install.sh | bash

      - name: Push to Confluence
        env:
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: ~/.atlcli/bin/atlcli wiki docs push ./docs
```

### On Release

```yaml
name: Release Docs

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: curl -fsSL https://atlcli.sh/install.sh | bash

      - name: Update version in docs
        run: |
          sed -i "s/VERSION_PLACEHOLDER/${{ github.ref_name }}/g" docs/index.md

      - name: Push to Confluence
        env:
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: ~/.atlcli/bin/atlcli wiki docs push ./docs
```

## GitLab CI

```yaml
stages:
  - publish

publish-docs:
  stage: publish
  only:
    refs:
      - main
    changes:
      - docs/**
  script:
    - curl -fsSL https://atlcli.sh/install.sh | bash
    - ~/.atlcli/bin/atlcli wiki docs push ./docs
  variables:
    ATLCLI_BASE_URL: $ATLASSIAN_URL
    ATLCLI_EMAIL: $ATLASSIAN_EMAIL
    ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

## Jenkins

```groovy
pipeline {
    agent any

    environment {
        ATLCLI_BASE_URL = credentials('atlassian-url')
        ATLCLI_EMAIL = credentials('atlassian-email')
        ATLCLI_API_TOKEN = credentials('atlassian-token')
    }

    stages {
        stage('Install atlcli') {
            steps {
                sh 'curl -fsSL https://atlcli.sh/install.sh | bash'
            }
        }
        stage('Publish Docs') {
            when {
                changeset 'docs/**'
            }
            steps {
                sh '~/.atlcli/bin/atlcli wiki docs push ./docs'
            }
        }
    }
}
```

## Export the published docs as a release artifact

Publishing puts the pages in Confluence; exporting turns that tree back into one
document you can attach to a release. Both directions run on the same runner with
the same credentials — there is no hosted export job to poll and no data egress.

The three flags that matter here are the **scope**, the **label filter**, and
`--report json`:

```yaml
      - name: Export the handbook
        env:
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: |
          ~/.atlcli/bin/atlcli wiki export "$ROOT_PAGE_ID" \
            --format pdf --scope tree \
            --label-exclude internal,draft \
            --completeness strict \
            --out-dir dist --report json --strict | tee report.json

      - uses: actions/upload-artifact@v4
        with:
          name: handbook
          path: dist/*.pdf
```

What each flag buys in a pipeline:

| Flag | Why it belongs in CI |
|------|----------------------|
| `--scope tree` (or `--scope space --space KEY`) | One document with chapters following the page hierarchy — never one file per page |
| `--label-exclude internal,draft` | Curate at export time instead of maintaining a separate "public" tree. `--label-exclude-mode page-only` keeps the children of an excluded page |
| `--label-include` | The inverse: publish only what carries a label. **Fails the build** when nothing matches, rather than shipping an empty document |
| `--completeness strict` | A page the runner cannot read aborts the export instead of producing a document that *looks* complete |
| `--report json` (= `--json`) | Exactly one `atlcli.export-report/1` document on stdout; progress goes to stderr, so `| tee report.json` is safe |
| `--strict` | Exit `2` when the export completed with warnings. Informational notes (timings, "a label filter did what you asked") never trip it |
| `--out-dir dist` | A deterministic `<pageId>-<slug>.pdf` name, written atomically — a failed run never leaves a partial artifact |

Swap `--format pdf` for `--engine ts --template corporate` to produce Word from
the same tree; the scope, label, completeness and report flags are identical.

Exit codes are classified, so a pipeline can tell the failure modes apart:
`2` warnings under `--strict` · `3` auth · `4` remote/API · `5` compile,
validation, tree limits, label filters and the asset budget · `130` cancelled.

For a full pipeline that parses the report — gating on note codes, listing
issues by severity, distinguishing warnings from information — see the
[Export automation recipe](export-automation.md).

:::note[Document settings are not CLI flags]
Page size, header/footer text, accent colour, logo and watermark are configured
in the [browser panel](/extension/export/#document-settings-pdf), not on the
command line. A CLI PDF export always produces the default document design.
:::

## Best Practices

1. **Use secrets** - Never commit credentials
2. **Path filtering** - Only run when docs change
3. **Dry run first** - Test with `--dry-run` flag
4. **Version tagging** - Include version in doc pages
5. **Failure handling** - Don't block releases on doc failures
6. **Export strictly** - `--completeness strict` plus `--strict` turns a silently
   incomplete handbook into a failed build

## Related Topics

- [Authentication](../authentication.md) - Environment variable authentication
- [Confluence Sync](../confluence/sync.md) - Full sync documentation
- [Export Automation](export-automation.md) - Parsing the export report in CI
- [DOCX and PDF Export](../confluence/export.md) - Every export flag in detail
- [Team Docs](team-docs.md) - Manual workflow
