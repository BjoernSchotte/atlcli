# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages (via Turbo)
bun run start            # Run development version
bun test                 # Run all tests
bun run typecheck        # TypeScript type checking
bun run build:prod       # Production build with minification
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

### Monorepo Structure

Bun workspaces with Turbo for build orchestration:

- **apps/cli** (`@atlcli/cli`) - CLI entry point and command handlers
- **packages/core** (`@atlcli/core`) - Shared utilities (config, logging, templates)
- **packages/confluence** (`@atlcli/confluence`) - Confluence REST API client
- **packages/jira** (`@atlcli/jira`) - Jira REST API client
- **packages/plugin-api** (`@atlcli/plugin-api`) - Plugin type definitions

Dependencies flow: `cli` → `core`, `confluence`, `jira`, `plugin-api`

### Command Handler Pattern

All commands in `apps/cli/src/commands/` follow this structure:

```typescript
export async function handleCommand(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  // 1. Validate input with getFlag/hasFlag helpers
  // 2. Load config and get active profile
  // 3. Create API client with profile
  // 4. Call API and format output via output() helper
}
```

### Configuration System

- Config stored in `~/.atlcli/config.json`
- Profile-based auth (multiple Atlassian instances)
- Defaults resolution: CLI flag > profile config > global config
- Key helpers: `loadConfig()`, `getActiveProfile()`, `resolveDefaults()`

### Output Pattern

Always use `output(data, opts)` for results - handles JSON mode (`--json` flag) automatically.

For errors use `fail(opts, exitCode, ERROR_CODES.*, message, details)`.

## Workflow Rules

- **Never push** until explicitly told to do so
- **Always write tests** for new functionality
- **Always do E2E testing** before committing:
  - Profile: `mayflower`
  - Wiki space: `DOCSY`
  - Jira project: `ATLCLI`
- **Commit regularly** after completing logical units of work
- **Update docs/** after features are complete and tests pass - documentation is first-class

### Releasing

Use the release script in `scripts/release.ts` to create releases:

```bash
bun scripts/release.ts patch    # 0.7.0 → 0.7.1
bun scripts/release.ts minor    # 0.7.0 → 0.8.0
bun scripts/release.ts major    # 0.7.0 → 1.0.0
```

**Always do a dry-run first** when creating a new release to check for errors or uncommitted/unpushed changes:

```bash
bun scripts/release.ts minor --dry-run
```

The script handles: version bump, changelog generation, git commit/tag, push, wait for GitHub release, and Homebrew tap update.

## Conventions

### Commit Messages

Follow Conventional Commits: `feat(jira):`, `fix(confluence):`, `docs:`, etc.

### TypeScript

- Strict mode enabled
- ESM modules (ES2022 target)
- Prefer explicit types over `any`
- Export types from package index files

### API Clients

Each Atlassian product has a dedicated client class (`ConfluenceClient`, `JiraClient`) that:
- Takes a Profile for auth configuration
- Handles REST API calls with proper error handling
- Returns typed responses
