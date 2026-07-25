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

CI classifies the changed paths before starting expensive jobs. Product,
consumer-package, and documentation gates run only when their surface is
affected; an unknown path or global build file deliberately enables every
gate. The always-present **required** job aggregates the selected results and
is the check that branch protection should require.

| Cadence | Gates |
|---------|-------|
| Pull request | Affected product/platform gates, pinned consumer smoke, and documentation build |
| Push to `main` | Affected product/platform gates, security attestation, and documentation deployment when relevant |
| Daily | Blocking M1 cross-host acceptance, performance trend, and floating-Bun consumer canary |
| Weekly | Full unfiltered CI matrix to detect routing drift |
| Release tag | Shared SHA-bound quality preflight and attestation before binary publication |

Superseded pull-request runs and Pages deployments are cancelled. Product CI
on `main`, nightly runs, and release evidence are never cancelled by a newer
commit.

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
4. Run tests (`bun test`)
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
