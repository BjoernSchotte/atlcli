---
title: "Blog Posts"
description: "Create, update, and delete Confluence blog posts with atlcli"
---

# Blog Posts

Publish and maintain Confluence blog posts from Markdown files.

## Prerequisites

- Authenticated profile with Confluence access (`atlcli auth login`)
- **Space permission**: Add blog post (create), Edit (update), Delete (delete)
- `--restriction private` needs Confluence Cloud

:::caution
A published blog post is visible to everyone in the space and may notify space
watchers. To try things out, use your personal space (key starts with `~`) or
`--restriction private`.
:::

## Create a blog post

```bash
atlcli wiki blog create --space TEAM --title "Release 1.2" --body ./post.md
```

`--body` is a path to a Markdown file; it is converted to storage format the
same way as `wiki page create`. Blog posts have no parent page.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--space` | string | profile default space | Space key (required if no default) |
| `--title` | string | - | Blog post title (required) |
| `--body` | path | - | Markdown file (required) |
| `--restriction` | `inherit` \| `private` | `inherit` | `private`: only you can view and edit |
| `--json` | flag | off | JSON output |

### Private blog posts

```bash
atlcli wiki blog create --space TEAM --title "Draft announcement" --body ./post.md --restriction private
```

With `--restriction private` atlcli creates an empty, unpublished draft,
restricts view and edit to you, reads the restriction back, and only then
publishes the body. Nobody else sees the content or gets a notification. If the
restriction cannot be verified, the post stays an unpublished draft (only
visible to you) and the command fails with its id.

## Update a blog post

```bash
# Body and title
atlcli wiki blog update --id 12345 --body ./post.md --title "Release 1.2 (final)"

# Title only (body unchanged)
atlcli wiki blog update --id 12345 --title "Release 1.2 (final)"
```

`wiki blog update` is the same as `wiki page update`: both read the current
content type and version and send the update as the same type with version + 1.
Restrictions are left unchanged. `wiki docs push` also preserves the type, so a
blog post pulled with `wiki docs init --page-id <id>` can be pushed back.

## Get and list

```bash
atlcli wiki blog get --id 12345 --json
atlcli wiki blog list --space TEAM --limit 10 --json
```

## Delete a blog post

```bash
atlcli wiki blog delete --id 12345 --confirm
```

Moves the blog post to the space trash. The command refuses ids that are not a
blog post; use `wiki page delete` for pages.

## Troubleshooting

**Symptom**: `Type is required and must match existing entity type of blogpost, but received page`
**Cause**: atlcli before this release sent every update as a page.
**Fix**: Upgrade atlcli; `wiki page update`, `wiki blog update` and `wiki docs push` now keep the type.

**Symptom**: `Restriction failed; blog post left as an unpublished draft`
**Cause**: Restrictions could not be set or verified (for example on Data Center).
**Fix**: Open the draft in Confluence and delete or publish it manually.

## Related Topics

- [Pages](pages.md) - Page operations
- [Search](search.md) - Find blog posts with `--type blogpost`
- [Sync](sync.md) - Edit content as local Markdown
