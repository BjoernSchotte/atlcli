---
title: "Contributing"
description: "Contributing - atlcli documentation"
---

# Contributing

Guidelines for contributing to atlcli.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) 1.3.14 (the version declared in `package.json`)
- Node.js 22.12+ (for documentation tooling)
- An Atlassian Cloud account for testing

### Clone and Build

```bash
git clone https://github.com/BjoernSchotte/atlcli.git
cd atlcli
bun install
bun run build
```

### Run Tests

```bash
bun run test
```

Always use the root script. It enables the `development` export condition so
workspace imports resolve to live source instead of stale `dist/` output.

### CI cadence

CI classifies changed paths before starting expensive jobs. Documentation-only
changes can stay lightweight; product, workflow, dependency, and unknown
changes deliberately fail open to the complete product proof. The
always-present **required** job aggregates the selected results and is the
single check that branch protection should require.

The required test topology remains the legacy four-shard suite while three
duration-aware candidates collect same-SHA comparison evidence:
`general-2x1`, `general-3x1`, and `general-2x2-workers`. Worker count is fixed
at one or two; CI never uses global `--concurrent`. Real Typst/PDF and
package-contract tests are explicit serial lanes, and stateful isolation probes
remain serial.

| Cadence | Gates |
|---------|-------|
| Pull request | Selected product/platform gates, pinned consumer smoke, and documentation build |
| Push to `main` | Affected product/platform gates, security attestation, and documentation deployment when relevant |
| Daily | Blocking M1 cross-host acceptance, performance trend, and floating-Bun consumer canary |
| Weekly | Full unfiltered CI matrix, one rotating topology comparison, and a non-required system-Chrome compatibility signal |
| Release tag | Shared SHA-bound quality preflight and attestation before binary publication |

Superseded pull-request runs and Pages deployments are cancelled. Product CI
on `main`, nightly runs, and release evidence are never cancelled by a newer
commit.

Draft pull requests currently receive the same required product proof as Ready
pull requests. The proposed `draft-fast` mode is not active until its
live-state and affected-test promotion gates have passed. Before marking a PR
Ready, finish draft commits and synchronize `main`; do not toggle Ready merely
to restart CI.

Run the complete local suite with:

```bash
bun run test
```

Start **CI topology comparison** manually in GitHub Actions to compare one
duration-aware candidate with all four legacy shards on the same SHA. The
workflow is non-required and cannot replace **required**. Timing JSON is
available from the `ci-timing-<attempt>-<sha>` artifact and the run summary.
The system Google Chrome job is also a compatibility canary only; required
packed MV3 proof continues to use Playwright-matched Chromium.

Use **Re-run failed jobs** only after a failure has been classified as
infrastructure-related. Product failures and a second failure after the narrow
Bun file-link retry require diagnosis.

### README media

Store repository-owned screenshots and downloadable PDF references used by the
root `README.md` under `assets/readme/`. Keep each file below 10 MiB and the
referenced set below 25 MiB. PNG images must have non-zero dimensions no larger
than 4096×4096; PDFs may contain at most 20 detectable pages.

Run the lightweight validation before committing README presentation changes:

```bash
bun run check:readme-media
```

The check rejects missing or untracked files, unsupported local image formats,
invalid PNG/PDF headers, and media over the configured limits. Other `assets/`
subdirectories remain product or unknown surfaces and do not inherit this
documentation-only CI policy.

### Project Structure

```
atlcli/
├── apps/
│   └── cli/              # CLI application
│       └── src/
│           ├── commands/ # Command handlers
│           └── index.ts  # Entry point
├── packages/
│   ├── core/             # Shared utilities
│   ├── confluence/       # Confluence API client
│   └── jira/             # Jira API client
├── docs/                 # Documentation (this site)
└── spec/                 # Internal specs and roadmaps
```

## E2E Resources

Live end-to-end tests create real pages and issues in an Atlassian tenant.
These rules keep that tenant clean and make every resource's ownership
decidable. Live tenant tests are operator-controlled and local-only; GitHub
Actions does not receive Atlassian credentials or run them remotely. They are
the concrete form of the "clean up test resources" rule in `CLAUDE.md`.

Helpers live in `apps/cli/src/e2e/`.

Run live cases only against an explicitly selected sandbox or test tenant.
Keep its profile and fixture IDs in the local environment; do not add them as
GitHub repository secrets or variables.

### Naming convention

Every live E2E resource is named `atlcli-e2e-<feature>-<timestamp>`, where
`<feature>` is a lowercase dash-separated slug and `<timestamp>` is epoch
**seconds**:

```
atlcli-e2e-scope-tree-1789000000
```

Confluence pages go **only** in space `DOCSY`; Jira issues go **only** in
project `ATLCLI` (the summary carries the prefix). Build the name with
`makeE2eTitle(feature)` rather than by hand — it validates the slug, because an
off-convention name is one the sweeper can never recover.

### The run-id ownership marker

A title prefix is **not** proof of ownership. A real user page can share the
name, and two E2E runs can race inside the same second. So at creation every
page also gets a content property and every issue an issue property:

| Property key        | Value                                    |
| ------------------- | ---------------------------------------- |
| `atlcli-e2e-run-id` | The CI run ID (`gha-<run>-<attempt>`), or a local UUID |

**That property, not the name, is what any deletion path checks.** Anything
without it is treated as someone else's content and is never deleted.

### Clean up in `finally` — every run, not every night

Each test records what it creates and deletes it in a `finally` block, so the
tenant is clean after *every single run*. Use `withE2eResources`, which does the
tracking, the marker stamping and the `finally` for you:

```ts
import { withE2eResources } from "../e2e/resources.js";
import { createConfluencePort } from "../e2e/rest-ports.js";

await withE2eResources({ confluence: createConfluencePort(profile) }, async (t) => {
  const page = await t.createPage("scope-tree");   // named + marked + tracked
  await runCli(["wiki", "export", page.id]);
  // deleted on the way out, including when this body throws
});
```

Use `t.trackPage(id)` / `t.trackIssue(key)` for resources the CLI under test
created, so they are deleted too.

### The sweeper is recovery, not cleanup

`apps/cli/src/e2e/cleanup.ts` exists for the runs that could not clean up after
themselves — a crashed process, a cancelled CI job. It is not the primary
mechanism, and a test that relies on it is a broken test.

```bash
bun apps/cli/src/e2e/cleanup.ts            # dry run: lists what it would delete
bun apps/cli/src/e2e/cleanup.ts --force    # actually deletes
```

It deletes a resource only when **all four** hold:

1. It carries the `atlcli-e2e-run-id` marker.
2. Its name matches `atlcli-e2e-<feature>-<timestamp>`.
3. It is **older than 24 h** — so a running E2E is never swept out from under
   itself.
4. It lives in space `DOCSY` / project `ATLCLI`.

Every gate is re-checked immediately before each delete, not just when the plan
is built.

#### Options

| Flag | Default | Constraint |
| --- | --- | --- |
| `--force` | off | Without it, nothing is deleted |
| `--profile <name>` | `mayflower` | Selects the **tenant** — see the warning below |
| `--ttl-hours <n>` | `24` | May only be **raised**. Values below `1` are rejected: the TTL gate cannot be switched off |
| `--max-deletes <n>` | `50` | May only be **lowered**. `50` is a hard ceiling, not a default |

The two directional limits are deliberate. `--ttl-hours 0` would delete a page a
*different*, still-running E2E created seconds ago — the exact thing the TTL
exists to prevent. And raising `--max-deletes` is the obvious reflex right after
seeing an abort, which is precisely the moment a bad query is the likeliest
explanation.

:::caution[Circuit breaker]
If a single run selects more than **50** resources, the sweeper aborts the whole
sweep with a non-zero exit and deletes **nothing at all** — not even up to the
limit. A selection that large means the query is wrong, not that the tenant is
dirty. Investigate before re-running; if a sweep legitimately needs to remove
more, run it repeatedly.
:::

:::danger[`--profile` selects the tenant]
The `DOCSY`/`ATLCLI` lock constrains which space and project are swept, **not
which site**. Point `--profile` (or the `ATLCLI_BASE_URL` fallback) at the wrong
instance and the sweeper will happily sweep *that* instance's `DOCSY`.
:::

Listings are fully paginated: a short result page carrying a live next-cursor is
not the last page.

DOCSY also holds deliberately retained fixtures (the DOCX feature zoo, the
spec-005 logo/image page, the "M1 Abnahme …" set). What protects them is the
**naming gate**: their titles do not parse as `atlcli-e2e-<feature>-<timestamp>`,
so they are rejected even if something stamps a valid-looking marker on them.
That is a structural property of their names, not the contingent fact that they
happen to carry no marker today.

### Remote CI policy

GitHub Actions does not run live Atlassian E2E cases or the recovery sweeper.
The ordinary test suite keeps these cases disabled unless `ATLCLI_E2E=1` is
set locally. This avoids storing a tenant profile in remote CI and prevents
accidental requests against a non-sandbox instance.

## Coding Standards

### TypeScript

- Use strict TypeScript settings
- Prefer explicit types over `any`
- Use interfaces for public APIs

### Formatting

The project uses Biome for linting and formatting:

```bash
bun run lint
bun run format
```

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(jira): add worklog timer mode
fix(confluence): handle empty pages
docs: update authentication guide
```

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run tests (`bun run test`)
5. Commit with conventional commit message
6. Push and open a PR

### PR Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation if needed
- Ensure CI passes

## Architecture

### Monorepo Structure

atlcli uses a monorepo with:

- `apps/cli` - The CLI application
- `packages/*` - Shared libraries

### API Clients

Each Atlassian product has its own package:

- `@atlcli/confluence` - Confluence REST API
- `@atlcli/jira` - Jira REST API

Clients handle authentication, request/response, and error handling.

### Command Pattern

Commands follow a consistent pattern:

```typescript
async function handleCommand(args: string[], flags: Flags, opts: Options): Promise<void> {
  // 1. Parse and validate input
  // 2. Call API client
  // 3. Format and output result
}
```

## Releasing

Releases are automated via the release script:

```bash
bun scripts/release.ts patch    # 0.16.0 → 0.16.1
bun scripts/release.ts minor    # 0.16.0 → 0.17.0
bun scripts/release.ts major    # 0.16.0 → 1.0.0
```

### What the Release Script Does

1. Validates clean working directory and main branch
2. Runs tests and type checking
3. Bumps version in `package.json`
4. Generates the changelog with git-cliff, crediting contributors and issue reporters
5. Creates commit and tag
6. Pushes to origin (triggers GitHub release workflow)
7. Waits for the SHA-bound CI preflight and security attestation
8. Waits for release artifacts
9. Triggers Homebrew tap update

### Options

- `--dry-run` - Print the release plan and exit; makes no changes
- `--preview` - Render the changelog entry (including the Thanks section) and exit; makes no changes
- `--skip-tests` - Skip test step (use with caution)

### Prerequisites

- GitHub CLI authenticated (`gh auth login`)
- On main branch with clean working directory
- **Security review completed for this release** — see below

### Security Review Before Every Release

Run `/security-review` over the diff since the previous tag and confirm it is
clean before you cut a release. `bun scripts/release.ts <type> --dry-run` prints
this as a reminder checklist item; the script does not block on it, so the
confirmation is yours to make.

The review covers the untrusted-input surfaces plus anything new that talks to
the network:

| Surface | What to check | Where it lives |
|---------|---------------|----------------|
| Raw `.docx` template upload | Archive budget (entry count, declared uncompressed size), entry-name policy, active-content rejection | `packages/docx/src/scan.ts` |
| `.wiki-pdf-template` container | Path traversal, symlinks, per-file and cumulative size caps | `packages/template-pack/src/unpack.ts` |
| Embedded SVG | Script/`foreignObject`/`on*`/external-reference rejection | `packages/confluence/src/svg-safety.ts` |
| Confluence storage parsing | Node-count, nesting-depth and text-length budget | `packages/confluence/src/export-blocks.ts` |
| Link targets | Scheme allowlist (`http`, `https`, `mailto`, relative only) | `packages/confluence/src/link-safety.ts` |
| Fonts intake | sha256 manifest, sfnt magic bytes, per-font size cap | `packages/pdf/scripts/ensure-fonts.ts` |
| New network code | Any `fetch` added since the last tag: is the target host derived from user input? | anywhere |

:::caution
A guard that is present but untested is not a guard. If the review finds a new
input surface, add an adversarial test that proves it rejects **and** a positive
control that proves legitimate input still passes, in the same PR.
:::

### Example: Preview a Release

Both `--dry-run` and `--preview` print and exit without changing anything, so no rollback is needed:

```bash
# Show the step-by-step release plan
bun scripts/release.ts minor --dry-run

# Render the changelog entry, including the Thanks section
bun scripts/release.ts minor --preview
```

## Development release operations

Development releases are immutable GitHub prereleases built from an exact,
green commit on `main`. The scheduled and manual paths use the same quality,
artifact, consumer, and publication jobs. A red, missing, pending, cancelled,
skipped, neutral, or stale required CI result blocks that SHA. An explicitly
advisory canary may be red, but the release receipt must then report
`degraded`; it never substitutes for the required gate.

### Prerequisites

- GitHub release immutability is enabled for `BjoernSchotte/atlcli`.
- `HOMEBREW_TAP_APP_ID` is configured as a repository variable.
- `HOMEBREW_TAP_APP_PRIVATE_KEY` is configured as a repository secret.
- The GitHub App is installed only where needed and can dispatch Actions in
  `BjoernSchotte/homebrew-tap`; it has no tap contents-write permission.
- `DEV_RELEASE_SCHEDULE_ENABLED` remains `false` until the first manual live
  release and its consumer evidence are complete.

Never print, download into the repository, or copy the App private key into an
evidence receipt.

### Run manually

Open **Actions → Dev release → Run workflow**. The inputs are:

| Input | Default | Meaning |
|-------|---------|---------|
| `source_sha` | current `main` | Optional full SHA; it must be an ancestor of current `main` and have a successful canonical `main` push run |
| `force_rebuild` | `false` | Create a new immutable build identity for an already released SHA; never replace an existing tag or asset |
| `publish_homebrew` | `true` | Dispatch and verify the separate `atlcli-dev` formula after GitHub publication succeeds |
| `dry_run` | `true` | Run the exact quality/artifact/native-consumer shadow graph and record every publication mutation without creating a tag, release, or formula |

For the first live publication, complete the DR-09 shadow rehearsal and obtain
explicit maintainer approval. Record the clean source SHA, then run the manual
workflow with Homebrew enabled and `dry_run=false`. Scheduled runs use the same
live publication graph and are
accepted only after `DEV_RELEASE_SCHEDULE_ENABLED=true` is set.

The cross-repository Homebrew job is the only job bound to the `dev-release`
GitHub Environment. Store `HOMEBREW_TAP_APP_PRIVATE_KEY` as an Environment
secret and restrict the Environment deployment branch to `main`. The first
live run requires the explicit maintainer authorization recorded with DR-09.
After that one-time gate, do not configure permanent required reviewers: a
reviewer gate would leave every scheduled nightly waiting for manual approval.
Repository administrators own App-key rotation and review the Environment and
App installation quarterly.

### Diagnose and recover

- **Existing successful release for the SHA:** the normal run is a no-op. Use
  `force_rebuild=true` only when new immutable bytes are intentionally needed.
- **Partial GitHub draft:** do not edit or publish it by hand. Preserve its run
  evidence, correct the cause, and force a new build identity. Drafts are not
  stable or Homebrew inputs.
- **Failed GitHub consumer verification:** the draft remains unpublished and
  Homebrew is not dispatched. Fix the producing SHA or workflow and create a
  new immutable build.
- **Failed Tap dispatch or formula matrix:** the published GitHub prerelease
  remains available, but the live formula pointer is unchanged. Diagnose the
  correlated Tap run, then use a new forced build after the fix; never rewrite
  the old release.
- **Rollback:** select a previously green `main` SHA, run with
  `force_rebuild=true`, and publish a new forward-moving formula version that
  references the new tag. The workflow requires the exact current formula tag
  as a fence. It does not move the pointer backward or overwrite releases.

### Retention and evidence

After a live run, download the ten public release assets, the source run's
public-release, native-CLI, and Homebrew-dispatch receipts, and the correlated
Tap run's four native receipts. Verify and extract the exact downloaded release
bytes first, preserving its receipt as `published-verification.json`:

```bash
bun scripts/verify-release-artifacts.ts \
  --dir <downloaded-release-directory> \
  --out <published-verification.json>
```

Then build the final proof from those consumer inputs. The builder consumes the
verifier-owned `<downloaded-release-directory>/extension` extraction and rejects
a verifier receipt whose artifact inventory differs from `build-metadata.json`:

```bash
bun scripts/ci/build-live-release-proof.ts \
  --release-dir <downloaded-release-directory> \
  --release-verification <published-verification.json> \
  --release-receipt <published-release-receipt.json> \
  --release-run <release-run.json> \
  --native-cli-dir <native-cli-receipts-directory> \
  --homebrew-dispatch <homebrew-dev-dispatch.json> \
  --homebrew-native-dir <homebrew-native-receipts-directory> \
  --homebrew-pointer <atlcli-dev.json> \
  --homebrew-formula <atlcli-dev.rb> \
  --out specs/dev-release-channel/evidence/live-release-proof.json
```

The builder fails closed unless every source, release, CLI, extension, Tap,
and Homebrew identity resolves to the same immutable tag and source SHA. The
repository evidence policy validates the resulting file against the dedicated
live-proof schema and scans it for sensitive material.

The cleanup workflow first produces a dry-run receipt. Apply mode retains at
least the newest 14 successful dev releases or 30 days, and never deletes the
stable release, a draft, a release with mutable classification, or the tag
referenced by `atlcli-dev`. Supply `proven_tag` until the first live formula
pointer exists.

Repository maintainers own this lane. Run one manual no-op or shadow trigger
every month. Each quarter, rehearse the forward rollback and retention dry run
without changing the stable channel. Index sanitized receipts in
`specs/dev-release-channel/EVIDENCE.md`. Receipts may contain public URLs,
opaque GitHub run IDs, hashes, versions, and generic error codes; they must not
contain tokens, credentials, customer or tenant data, private identifiers, raw
logs, source bodies, or absolute home-directory paths.

## Reporting Issues

Use [GitHub Issues](https://github.com/BjoernSchotte/atlcli/issues) for:

- Bug reports
- Feature requests
- Questions

Include:

- atlcli version (`atlcli --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages

## License

atlcli is MIT licensed. By contributing, you agree your contributions will be under the same license.

## Related Topics

- [Getting Started](/getting-started/) - Installation and setup
- [Creating Plugins](plugins/creating-plugins.md) - Extend atlcli with plugins
