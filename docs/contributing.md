# Contributing

Guidelines for contributing to atlcli.

::: toc

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- Node.js 18+ (for some tooling)
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
bun test
```

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
bun scripts/release.ts patch    # 0.6.0 → 0.6.1
bun scripts/release.ts minor    # 0.6.0 → 0.7.0
bun scripts/release.ts major    # 0.6.0 → 1.0.0
```

### What the Release Script Does

1. Validates clean working directory and main branch
2. Runs tests and type checking
3. Bumps version in `package.json`
4. Generates changelog with git-cliff
5. Creates commit and tag
6. Pushes to origin (triggers GitHub release workflow)
7. Waits for release artifacts
8. Triggers Homebrew tap update

### Options

- `--dry-run` - Create commits/tags locally without pushing
- `--skip-tests` - Skip test step (use with caution)

### Prerequisites

- GitHub CLI authenticated (`gh auth login`)
- On main branch with clean working directory

### Example: Dry Run

```bash
# Preview release without pushing
bun scripts/release.ts patch --dry-run

# Review changes, then rollback
git reset --hard HEAD~1
git tag -d v0.6.1
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

- [Getting Started](getting-started.md) - Installation and setup
- [Creating Plugins](plugins/creating-plugins.md) - Extend atlcli with plugins
