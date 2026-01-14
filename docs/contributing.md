# Contributing

Guidelines for contributing to atlcli.

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
