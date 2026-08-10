# Pierre diff renderer spike

This isolated prototype consumes the neutral `unified` patch from
`atlcli wiki page diff --format review --json` and renders it directly with
`@pierre/diffs`. It is intentionally outside the root Bun workspace and has an
independent lockfile. It does not change the CLI, ChangeSet, Confluence, or Jira
runtime dependency graph.

## Verify with synthetic data

```bash
bun install --cwd spikes/pierre-diffs-renderer --frozen-lockfile
bun run --cwd spikes/pierre-diffs-renderer test
bun run --cwd spikes/pierre-diffs-renderer typecheck
bun run --cwd spikes/pierre-diffs-renderer build
```

## Run against an authorized page

The loopback-only server invokes the read-only page-diff command, keeps its
JSON response in memory, and exposes only that response to the local browser.
It writes no page content or capture:

```bash
bun run --cwd spikes/pierre-diffs-renderer live -- \
  --profile PROFILE --id PAGE_ID --from 1 --to 3
```

Use this only with an operator-authorized profile and page. Browser captures
belong in a private temporary directory and must not be committed.

## Boundary under evaluation

- `@pierre/diffs` owns patch parsing, word-level highlighting, themes, Shadow
  DOM, and future browser virtualization.
- atlcli owns exact-version acquisition, semantic ChangeSets, coverage, safe
  failure, and the neutral unified patch.
- A production integration would be a web/extension renderer package. The CLI
  must remain usable without Pierre, Shiki, DOM, React, or workers.

## Result

`@pierre/diffs` 1.3.5 directly parsed the jsdiff patch shape emitted by atlcli
and rendered the authorized v1-to-v3 Cloud review in headless Chromium. The
view showed both hunks, line numbers, classic indicators, wrapping, Markdown
highlighting, and inline change support. The semantic metric strip stayed an
atlcli-owned projection above the Pierre component. No live response or image
was written below this directory.

The deliberately simple single-entry Bun build measures 10,735,635 bytes
minified and 1,834,672 bytes gzip; the isolated install occupies about 70 MiB.
Those figures make Pierre unsuitable as an eager CLI/core dependency. They do
not reject it as an optional browser renderer: a production follow-up should
lazy-load it in a web/extension package, use `CodeView` virtualization and a
worker for large reviews, and set explicit initial-JS/heap/interaction budgets.

Decision: **viable as an optional presentation adapter; not as the diff engine
or a dependency of the host-neutral ChangeSet/CLI core.** Keep atlcli's
semantic and unified JSON contracts authoritative so another renderer can be
substituted without changing acquisition, SafeOps review meaning, or Jira.
