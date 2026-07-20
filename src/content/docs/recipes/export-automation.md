---
title: "Export Automation"
description: "Export automation - run atlcli PDF/DOCX export in CI/CD"
---

# Export Automation

Export Confluence pages to PDF (or DOCX) from a CI/CD pipeline, parse the machine-readable
report, and upload the result as a build artifact — no hosted service, no polling, and no
data leaving your runner.

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

No `~/.atlcli/config.json` is needed: the jobs below use
[profile-free auth](/confluence/export/#profile-free-auth-for-ci) via environment variables.

## How it works

The export command:

1. Fetches the page (or the whole tree/space) with token auth.
2. Compiles a tagged, font-embedded PDF in-process (no browser).
3. Writes the file atomically (nothing partial on failure).
4. Prints an `atlcli.export-report/1` JSON document on stdout and exits with a
   [documented code](/confluence/export/#exit-codes).

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
            --out-dir dist --report json --strict | tee report.json
      - name: Summarize
        run: |
          jq -r '"Exported \(.outputs[0]) — \(.outputDetails[0].pageCount) pages, \(.warnings | length) warnings"' report.json
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
```

Exit codes let the pipeline branch without parsing at all: `0` success, `2` warnings under
`--strict`, `3` auth, `4` remote/API (e.g. page not found), `5` compile failure. See the
[full table](/confluence/export/#exit-codes).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Exit `3`, `auth-error` issue | Bad or missing `ATLCLI_API_TOKEN`, or Cloud without `ATLCLI_EMAIL` | Check the secret; Cloud needs the email, Data Center needs `--auth-type bearer` (no email) |
| Exit `1`, "must use HTTPS" | Plain-HTTP `--base-url` | Use HTTPS, or add `--allow-http` for Data Center |
| Exit `4`, page not found | Wrong page id, or no view permission for the token's user | Verify the id and the token account's permissions |
| Exit `1`, "already exists" | Output file exists | Use `--out-dir` for a fresh name, or `--force` to overwrite |

## Related topics

- [DOCX and PDF Export](/confluence/export/) — full command reference
- [CI/CD Documentation](/recipes/ci-cd-docs/) — publishing docs into Confluence from CI
- [Authentication](/confluence/authentication/) — tokens and profiles
