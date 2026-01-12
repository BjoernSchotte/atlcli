# Changelog

All notable changes to atlcli will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-01-12

### Added

- **JSONL Logging** - Comprehensive logging for observability and enterprise audit
  - Log to `~/.atlcli/logs/` (global) and `.atlcli/logs/` (project)
  - Log types: `cli.command`, `cli.result`, `api.request`, `api.response`, `sync.event`, `auth.change`, `error`
  - Commands: `log list`, `log tail`, `log show`, `log clear`
  - Automatic sensitive data redaction (tokens, passwords)
  - Configurable log levels (off, error, warn, info, debug)

- **Attachment Sync** - Full bidirectional attachment synchronization
  - Storage in sibling `{page}.attachments/` directories
  - Smart change detection (hash-based, only upload changed files)
  - Large file warnings (10MB threshold)
  - Bidirectional deletion mirroring
  - Conflict resolution (keep both versions as `filename-conflict.ext`)
  - Confluence wiki syntax support (`!filename.ext!`)
  - SyncEngine integration for continuous sync

- **Partial Sync** - Granular control over sync scope
  - `--space <key>` for full space sync
  - `--ancestor <id>` for page tree sync
  - `--page-id <id>` for single page sync
  - Nested directory structure matching Confluence hierarchy

- **Page Templates** - Handlebars-style template system
  - 17 built-in variables (NOW, TODAY, USER, SPACE, etc.)
  - 50+ modifiers (date, string, number, array, conditional)
  - Template storage (local `.atlcli/templates/`, global `~/.config/atlcli/templates/`)
  - Commands: `template list`, `template create`, `template preview`, `template validate`

- **Comments Sync** - Pull and manage page comments
  - Footer comments with reply threads
  - Inline comments with text selection
  - Commands: `page comments list`, `add`, `reply`, `resolve`, `delete`

- **Page History & Diff** - Version control for pages
  - `page history` - View version history
  - `page diff` - Compare versions with colored diff
  - `page restore` - Restore to previous version
  - `docs diff` - Compare local file vs remote

- **Labels / Tags** - Label management and filtering
  - `page label add/remove/list` - Manage page labels
  - `--label` filter for `docs pull` and `docs sync`
  - `page list --label` - List pages with label

- **Search** - Full-text search with CQL support
  - Filter by space, label, title, creator, type, dates
  - `--cql` for raw CQL queries
  - Multiple output formats (table, compact, json)

- **Page Tree Management** - Complete page organization
  - `page move` - Move to new parent or reorder siblings
  - `page sort` - Sort children (alphabetical, natural, by date)
  - `page copy` - Duplicate pages
  - `page children` - List child pages

- **Bulk Operations** - Batch operations via CQL
  - `page delete --cql` - Delete matching pages
  - `page archive --cql` - Archive matching pages
  - `page label add/remove --cql` - Bulk label management
  - `--dry-run` for preview

- **Link Checker** - Pre-push validation
  - `docs check` - Validate markdown files
  - `docs push --validate` - Validate before push
  - Checks: broken links, unclosed macros, file size

- **Ignore Patterns** - `.atlcliignore` file support
  - Gitignore-style patterns
  - Automatic merge with `.gitignore`
  - Negate patterns with `!`

- **Additional Macros** - Extended Confluence macro support
  - `jira` - Jira issue embed
  - `status` - Status lozenges
  - `children`, `recently-updated`, `pagetree`
  - `include`, `excerpt`, `excerpt-include`
  - `section`, `column` - Multi-column layouts
  - `gallery`, `attachments`, `multimedia`

- **Profile Management** - Enhanced auth commands
  - `auth rename` - Rename profiles
  - `auth logout` - Clear credentials (keep profile)
  - `auth delete` - Remove profile entirely

### Fixed

- Attachment upload filename handling (use File instead of Blob)
- Smart change detection re-uploads after remote deletion
- Log tail defaults to global logs

## [0.3.0] - 2026-01-10

### Added

- **plugin-git** - Git integration for bidirectional sync
  - Auto-commit on pull
  - Auto-push on commit via post-commit hook
  - Commands: `git hook install/remove/status`

## [0.2.0] - 2026-01-10

### Changed

- Reorganized as monorepo structure
  - `apps/cli` - Main CLI application
  - `packages/core` - Shared utilities
  - `packages/confluence` - Confluence API & sync
  - `packages/plugin-api` - Plugin interfaces
  - `plugins/` - Plugin directory

## [0.1.0] - 2026-01-10

### Added

- Initial release with bidirectional Confluence sync
- Markdown to Confluence storage format conversion
- Confluence macro support (info, note, warning, tip, expand, toc)
- GFM support (tables, task lists, fenced code blocks)
- Multiple auth profiles
- YAML frontmatter for page tracking
- Three-way merge conflict detection
- `docs init`, `pull`, `push`, `sync`, `status`, `add` commands
- `auth init`, `login`, `logout`, `status`, `list`, `switch` commands
- `space list`, `get`, `create` commands
- `page list`, `get`, `create`, `update`, `delete` commands

[0.4.0]: https://github.com/BjoernSchotte/atlcli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BjoernSchotte/atlcli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BjoernSchotte/atlcli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BjoernSchotte/atlcli/releases/tag/v0.1.0
