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

## Workflow Rules

- **Never push** until explicitly told to do so
- **Always write tests** for new functionality
- **Always E2E test before committing** (profile: `mayflower`, space: `DOCSY`, project: `ATLCLI`, dir: `~/wikisynctest/docs` or as specified)
- **Run typecheck before pushing**: `bun run typecheck`
- **Clean up test resources** - delete test pages/issues after E2E testing
- **Commit regularly** after completing logical units of work
- **Update docs/** after features complete - documentation is first-class

### Planning & Research

- Save feature plans to `spec/` directory for complex features
- Spawn multiple research agents in parallel for complex topics
- Use plan mode for non-trivial features before implementing

### Releasing

Never release automatically. Always dry-run first: `bun scripts/release.ts <type> --dry-run`

Post-release: verify GitHub release page, Homebrew tap (`brew info atlcli`), CHANGELOG.md

## Conventions

- **Commits**: Conventional Commits (`feat(jira):`, `fix(confluence):`, `docs:`, etc.)
- **TypeScript**: Strict mode, ESM (ES2022), explicit types, export types from index files
- **Confluence features**: Implement bidirectional conversion (markdown ↔ storage), always test roundtrip
