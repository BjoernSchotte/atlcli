---
title: "Export Automation"
description: "Export automation - run atlcli PDF/DOCX export in CI/CD"
---

# Export Automation

Export Confluence pages to PDF (or DOCX) from a CI/CD pipeline, parse the
machine-readable report, and upload the result as a build artifact — with no
separate hosted renderer or polling service. Page and attachment data travels
between Confluence and your runner.

> Automation is the CLI itself. There is no hosted export job to submit or poll: a single
> `atlcli wiki export … --format pdf --report json` call does the whole job on the runner and
> reports its result as one JSON document on stdout with a deterministic exit code.

## On this page

- [Prerequisites](#prerequisites)
- [How it works](#how-it-works)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [Parsing the report](#parsing-the-report)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- An Atlassian API token stored as a CI/CD secret.
- The Confluence base URL and (for Cloud) the account email.
- **View permission** on the page(s) to export.
- Optional: a reviewed `.wiki-pdf-template` pack stored as a protected build
  input or repository artifact.

No `~/.atlcli/config.json` is needed: the jobs below use
[profile-free auth](/confluence/export/#profile-free-auth-for-ci) via environment variables.

## How it works

The export command:

1. Fetches the page (or the whole tree/space) with token auth.
2. Compiles a tagged, font-embedded PDF in-process (no browser).
3. Writes the file atomically (nothing partial on failure).
4. Prints an `atlcli.export-report/1` JSON document on stdout and exits with a
   [documented code](/confluence/export/#exit-codes).

When `--template <pack>` is present, atlcli validates and stores the pack
locally before the first Confluence request. The durable export job pins its
content hash rather than the caller's file path.

## GitHub Actions

```yaml
name: Export handbook PDF
on:
  workflow_dispatch:
jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - name: Install atlcli
        run: curl -fsSL https://atlcli.sh/install.sh | bash
      - name: Export to PDF
        env:
          ATLCLI_BASE_URL: ${{ vars.CONFLUENCE_BASE_URL }}
          ATLCLI_EMAIL: ${{ vars.CONFLUENCE_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.CONFLUENCE_TOKEN }}
        run: |
          atlcli wiki export "${{ github.event.inputs.page || '12345678' }}" \
            --format pdf --scope tree --label-exclude internal \
            --template ./templates/brand.wiki-pdf-template \
            --out-dir dist --report json --strict | tee report.json
      - name: Summarize
        run: |
          jq -r '"Exported \(.outputs[0]) — \(.outputDetails[0].pageCount) pages, \(.warnings | length) warnings"' report.json
      - name: Fail on an incomplete export
        run: |
          # `complete` is emitted for --format pdf and --format docx alike, so
          # this gate is identical whichever format the job produces.
          [ "$(jq -r '.complete' report.json)" = "true" ] || {
            echo "Export incomplete:" >&2; jq '.notesByCode' report.json >&2; exit 1;
          }
      - uses: actions/upload-artifact@v4
        with:
          name: handbook-pdf
          path: dist/*.pdf
```

## GitLab CI

```yaml
export_pdf:
  image: ubuntu:24.04
  variables:
    ATLCLI_BASE_URL: "$CONFLUENCE_BASE_URL"
    ATLCLI_EMAIL: "$CONFLUENCE_EMAIL"
    # ATLCLI_API_TOKEN is a protected/masked CI variable
  before_script:
    - apt-get update && apt-get install -y curl jq ca-certificates unzip
    - curl -fsSL https://atlcli.sh/install.sh | bash
    - export PATH="$HOME/.local/bin:$PATH"
  script:
    - atlcli wiki export "$PAGE_ID" --format pdf --out-dir dist --report json --strict | tee report.json
    - jq -r '.outputs[0]' report.json
  artifacts:
    paths:
      - dist/*.pdf
    when: on_success
```

## Parsing the report

The report is a stable, versioned projection. Useful `jq` queries:

```bash
# The produced file path(s)
jq -r '.outputs[]' report.json

# Per-artifact metrics (pages, embedded images, skipped assets)
jq '.outputDetails[0]' report.json

# Fail the build on any warning yourself (equivalent to --strict)
test "$(jq '.warnings | length' report.json)" -eq 0

# List every issue with its severity and phase
jq -r '.issues[] | "\(.severity)\t\(.phase)\t\(.code)"' report.json

# Informational notes (timings, label filters, macros that rendered fine) are
# reported but never fail the build — they are not in `.warnings`
jq -r '.issues[] | select(.severity == "info") | .code' report.json

# Gate on ONE condition by code — the same code whichever format you export
jq -e '(.notesByCode["image-missing-alt"] // 0) == 0' report.json
```

`severity` is one of `error`, `warning` or `info`, and `--strict` trips on the first two
only — see [Note severity and `--strict`](/confluence/export/#note-severity-and---strict).
If you are upgrading from a release where **every** note was reported as a warning, expect
`jq '.warnings | length'` to drop and a previously-always-`2` `--engine ts --strict` job to
start passing.

Exit codes let the pipeline branch without parsing at all: `0` success, `2` warnings under
`--strict`, `3` auth, `4` remote/API (e.g. page not found), `5` compile failure. See the
[full table](/confluence/export/#exit-codes).

:::caution[If you gate on a specific note code, read this before upgrading]
Note codes describe a condition on your **content**, so the same problem now carries
the same code whether the job exports DOCX or PDF. Getting there retired three
PDF-prefixed spellings:

| Retired code | Emitted today |
|--------------|---------------|
| `pdf-image-missing-alt` | `image-missing-alt` |
| `pdf-image-skipped` | `image-embed-failed` (**not** `image-skipped` — that is a different condition) |
| `pdf-mention-unresolved` | `mention-unresolved` |

A job that greps `notesByCode` for a retired code will stop matching — silently, since
a missing key is indistinguishable from a clean export in most `jq` expressions. Update
the expression, or use the transitional form in
[Migrating retired note codes](/confluence/export/#migrating-retired-note-codes).
Prefer `jq -e` with an explicit default (`// 0`) over `test -n`, so a renamed or absent
key can never read as "nothing to report".
:::

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Exit `3`, `auth-error` issue | Bad or missing `ATLCLI_API_TOKEN`, or Cloud without `ATLCLI_EMAIL` | Check the secret; Cloud needs the email, Data Center needs `--auth-type bearer` (no email) |
| Exit `1`, "must use HTTPS" | Plain-HTTP `--base-url` | Use HTTPS, or add `--allow-http` for Data Center |
| Exit `4`, page not found | Wrong page id, or no view permission for the token's user | Verify the id and the token account's permissions |
| Exit `1`, "already exists" | Output file exists | Use `--out-dir` for a fresh name, or `--force` to overwrite |
| Exit `1`, "PDF template validation failed" | Missing, modified, or incompatible pack | Rebuild it with `atlcli pdf-template build`; do not patch archive members in CI |

## Related topics

- [DOCX and PDF Export](/confluence/export/) — full command reference
- [Create a PDF template from Word](/confluence/pdf-template-from-word/) —
  build the reviewed pack used by the example
- [PDF Template Authoring CLI](/reference/pdf-template-authoring-cli/) —
  machine-mode authoring and schemas
- [CI/CD Documentation](/recipes/ci-cd-docs/) — publishing docs into Confluence from CI
- [Authentication](/authentication/) — tokens and profiles
