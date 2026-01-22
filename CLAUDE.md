# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages (via Turbo)
bun test                 # Run all tests
bun run typecheck        # TypeScript type checking
```

### Running Python Tests

```bash
cd packages/export
uv run pytest tests/ -v
```

### Running Single Tests

```bash
bun test packages/core/src/logger.test.ts           # Run specific test file
bun test --test-name-pattern "should parse"         # Run tests matching pattern
```

### Testing Local Changes

```bash
bun ./dist/index.js <command>                       # Run built CLI
bun run --cwd apps/cli src/index.ts <command>       # Run from source
```

## Architecture

Bun workspaces monorepo with Turbo. Dependencies: `apps/cli` → `packages/*`

| Package | Purpose |
|---------|---------|
| `apps/cli` | CLI entry point and command handlers |
| `packages/core` | Shared utilities (config, logging, templates) |
| `packages/confluence` | Confluence REST API client + markdown conversion |
| `packages/jira` | Jira REST API client |
| `packages/plugin-api` | Plugin type definitions |

**Key patterns:**
- Commands in `apps/cli/src/commands/` use `output(data, opts)` for results, `fail()` for errors
- Config: `~/.atlcli/config.json`, profile-based auth, helpers: `loadConfig()`, `getActiveProfile()`
- API clients (`ConfluenceClient`, `JiraClient`) take Profile, handle REST + errors, return typed responses
- Design for testability using "functional core, imperative shell": keep pure business logic separate from code that does IO (like CLI interaction)

## Docs standards (docs/)
- Organize docs by user journey and domain: Getting Started, Concepts/Glossary, Feature Guides, Reference, Troubleshooting, and Operations (backups, security, upgrades).
- Every long page must include an in-page TOC and clear “Related topics” links to keep navigation flowing (maybe comes from the doc generator system we use).
- Use a consistent page template: short intro → prerequisites → steps → configuration/options → examples → troubleshooting  related topics → feedback/edit link.
- Provide both UI-first and config-first guidance where relevant; separate them clearly and label which path each step applies to.
- For reference pages, list configuration variables with type, default, required/optional, and constraints; follow with minimal and advanced examples.
- Example policy: at least one minimal working example and one realistic/advanced example per feature.
- Tone and formatting: concise, task-focused, active voice; UI labels in **bold**, file paths/inputs in `code`, and consistent naming for concepts.
- Media: screenshots with captions for UI flows; optional short videos for complex workflows; use callouts for tips/warnings.
- Troubleshooting is embedded where issues occur; include symptoms, likely causes, and fixes.
- Keep docs aligned with product changes; add or update docs in the same PR when behavior changes.


## Workflow Rules

- **Never push** until explicitly told to do so
- **Always write tests** for new functionality
- **Always add regression tests for bug fixes** - when fixing a bug, add 1+ tests that would have caught it to prevent recurrence
- **Always E2E test before committing** (profile: `mayflower`, space: `DOCSY`, project: `ATLCLI`, dir: `~/wikisynctest/docs` or as specified)
- **Run typecheck before pushing**: `bun run typecheck`
- **Clean up test resources** - delete test pages/issues after E2E testing
- **Commit regularly** after completing logical units of work
- **Update docs/** after features complete - documentation is first-class

### Planning & Research

- Save feature plans to `spec/` directory for complex features
- Spawn multiple research agents in parallel for complex topics
- Use plan mode for non-trivial features before implementing
- At the end of each plan, give me a list of unresolved questions to answer, if any. Use AskUserQuestion tool.

### Releasing

Never release automatically. Always dry-run first: `bun scripts/release.ts <type> --dry-run`

Post-release: verify GitHub release page, Homebrew tap (`brew info atlcli`), CHANGELOG.md

## Conventions

- **Commits**: Conventional Commits (`feat(jira):`, `fix(confluence):`, `docs:`, etc.)
- **TypeScript**: Strict mode, ESM (ES2022), explicit types, export types from index files
- **Confluence features**: Implement bidirectional conversion (markdown ↔ storage), always test roundtrip
