# plugin-git

Git integration plugin for atlcli Confluence sync.

## Features

- **Auto-commit on pull**: Automatically commits changes to git after `docs pull`
- **Auto-push on commit**: Post-commit hook pushes changes to Confluence
- **Sync daemon awareness**: Skips auto-push when sync daemon is running

## Installation

```bash
atlcli plugin install ./plugins/plugin-git
```

## Usage

### Auto-commit (automatic)

After installing the plugin, any `docs pull` that brings in changes will automatically commit them to git:

```bash
atlcli docs pull ./docs
# [plugin-git] Auto-committed 3 file(s) from Confluence pull

git log -1
# sync(confluence): pull 3 page(s) from Confluence
#
# Updated: architecture.md, getting-started.md, api-reference.md
```

### Git Hook Commands

Install a post-commit hook to auto-push changes to Confluence:

```bash
# Install the hook
atlcli git hook install [dir]

# Check hook status
atlcli git hook status [dir]

# Remove the hook
atlcli git hook remove [dir]
```

### Options

```
atlcli git hook install [dir]
  --force, -f    Overwrite existing hook (backs up original)
  --json         JSON output

atlcli git hook status [dir]
  --json         JSON output

atlcli git hook remove [dir]
  --json         JSON output
```

## How It Works

### Auto-commit on Pull

1. Plugin registers an `afterCommand` hook
2. After `docs pull` completes, checks for git changes
3. Stages all changes and commits with descriptive message
4. Commit message format: `sync(confluence): pull N page(s) from Confluence`

### Auto-push on Commit

1. User installs post-commit hook via `atlcli git hook install`
2. Hook script is created at `.git/hooks/post-commit`
3. On each commit, hook checks for sync daemon lockfile
4. If no lockfile, runs `atlcli docs push` to sync to Confluence
5. Push failures are non-blocking (commit succeeds regardless)

### Lockfile Detection

When the sync daemon (`atlcli docs sync`) is running, it creates a lockfile at `.atlcli/.sync.lock`. The post-commit hook detects this and skips the push to avoid conflicts.

## Commit Message Format

Pull commits use this format:

```
sync(confluence): pull 3 page(s) from Confluence

Updated: page-one.md, page-two.md, page-three.md
```

For more than 10 files, the list is truncated:

```
sync(confluence): pull 15 page(s) from Confluence

Updated: file1.md, file2.md, ... and 5 more
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Not a git repo | Auto-commit skips silently |
| No changes after pull | No commit created |
| Existing post-commit hook | Error unless `--force` used |
| `--force` with existing hook | Backs up to `.backup`, installs ours |
| Remove with backup present | Restores original hook |
| Sync daemon running | Post-commit hook skips push |
| Push fails | Logged but doesn't block commit |

## Development

### Running Tests

```bash
cd plugins/plugin-git
bun test
```

### Plugin Structure

```
plugin-git/
├── README.md
├── package.json
└── src/
    ├── index.ts        # Plugin definition
    ├── auto-commit.ts  # Auto-commit after pull
    ├── git-hooks.ts    # Hook install/remove/status
    ├── types.ts        # TypeScript types
    └── utils.ts        # Git command utilities
```

## License

MIT
