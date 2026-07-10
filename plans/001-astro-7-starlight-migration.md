# Plan 001: Move the documentation site to Astro 7 and Starlight 0.41

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a5f942e..HEAD -- package.json bun.lock astro.config.mjs tsconfig.docs.json src/content.config.ts src/components/Footer.astro src/styles/custom.css src/content/docs .github/workflows/ci.yml .github/workflows/docs.yml README.md`
> If an in-scope file changed since this plan was written, compare the current
> state below against the live code before proceeding. A material mismatch is a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `a5f942e`, 2026-07-10

## Why this matters

The documentation site currently resolves Astro 5.16.15 and Starlight 0.37.3.
Astro 7 brings Vite 8/Rolldown, the Rust Astro compiler, and the Sätteri
Markdown pipeline, but current Starlight only peers with Astro 5. Astro and
Starlight therefore need an atomic upgrade to a supported pair.

The dependency change is small; rendering equivalence is the main risk. This
site has 56 Markdown/MDX content files, a manual sidebar, a custom footer,
custom CSS that targets Starlight classes, Pagefind search, a sitemap, and two
production public assets (`CNAME` and `install.sh`). The migration is complete
only when all of those survive the framework bump and PR CI prevents a repeat.

## Research baseline (2026-07-10)

- Latest verified Astro 7 patch: `7.0.7` (released 2026-07-08).
- Latest verified Starlight patch: `0.41.3` (released 2026-07-03).
- Starlight `0.41.0` is the first release supporting Astro 7 and drops Astro 6;
  `0.41.1` fixes a dependency-resolution regression in the initial 0.41 release.
- Astro 6 is an obligatory *migration-guide* checkpoint from Astro 5. It moves
  to Node 22.12+, Vite 7, Zod 4, Shiki 4, and removes implicit legacy content
  collection support.
- Astro 7 moves to Vite 8, the stricter Rust compiler, Sätteri for Markdown/MDX,
  and `compressHTML: 'jsx'` whitespace behavior. `src/fetch.ts` becomes
  reserved for advanced routing.
- The repository already uses the Content Layer API and has no Vite plugins,
  adapters, Astro image API, remark/rehype plugins, experimental flags, or
  conflicting `src/fetch.ts`.

Primary references:

- [Astro 6 migration guide](https://docs.astro.build/en/guides/upgrade-to/v6/)
- [Astro 7 migration guide](https://docs.astro.build/en/guides/upgrade-to/v7/)
- [Astro 7.0.7 release](https://github.com/withastro/astro/releases/tag/astro%407.0.7)
- [Starlight 0.41.0 release](https://github.com/withastro/starlight/releases/tag/%40astrojs%2Fstarlight%400.41.0)
- [Starlight releases](https://github.com/withastro/starlight/releases)
- [Starlight component override guide](https://starlight.astro.build/guides/overriding-components/)
- [Astro Bun recipe](https://docs.astro.build/en/recipes/bun/)
- [Vite 8 migration guide](https://vite.dev/guide/migration.html)

## Current state

- `package.json:6,23-41` declares Bun 1.3.5, Astro `^5.6.1`, Starlight
  `^0.37.3`, Sharp `^0.34.2`, Astro Check `^0.9.0`, and an explicit Zod
  `3.25.76` pin. The lock resolves Astro 5.16.15 and Starlight 0.37.3.
- The Zod pin was added in commit `383d1a6` as `fix(docs): pin Astro Zod
  dependency`. There are no direct Zod imports in the repository. Astro 7 uses
  Zod 4, so the old pin must be removed and the resulting graph verified.
- `src/content.config.ts:1-7` is already in the required Content Layer shape:

  ```ts
  import { defineCollection } from 'astro:content';
  import { docsLoader } from '@astrojs/starlight/loaders';
  import { docsSchema } from '@astrojs/starlight/schema';

  export const collections = {
    docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  };
  ```

- `astro.config.mjs:6-120` configures a static Starlight site at
  `https://atlcli.sh`, a 55-link manual sidebar, root-locale English URLs, the
  custom footer, and custom CSS. Preserve `defaultLocale: 'root'`; commit
  `a979d9a` intentionally removed the `/en/` prefix.
- `src/components/Footer.astro:2-7` imports Starlight's supported default footer
  override but forwards props using the old pattern:

  ```astro
  import Default from '@astrojs/starlight/components/Footer.astro';
  ---
  <Default {...Astro.props}>
    <slot />
  </Default>
  ```

  Current Starlight guidance renders `<Default><slot /></Default>`; page data is
  available through `Astro.locals.starlightRoute` when needed.
- `src/styles/custom.css:10-186` uses Starlight color tokens and also targets
  `.sl-markdown-content`, `.starlight-aside*`, `.card-grid`, global `pre`,
  tables, and headings. Expressive Code moves from 0.41.6 to 0.44.x, so a
  successful compile does not prove these selectors still render correctly.
- `src/content/docs/index.mdx:18,46-67` uses `Card`/`CardGrid` and splash hero
  metadata. `src/content/docs/getting-started.mdx:6,108-121,270-294` uses
  `Tabs`/`TabItem`. The content set also contains 21 Starlight directive asides.
- `.github/workflows/docs.yml:31-40` floats Bun `latest`, uses a non-frozen
  install, does not install Node, and only builds. Its path filter omits
  `bun.lock`, `src/content.config.ts`, and `tsconfig.docs.json`.
- `.github/workflows/ci.yml` does not check or build the docs on pull requests.
- `tsconfig.docs.json` already extends `astro/tsconfigs/strict`, and
  `@astrojs/check` is installed, but nothing invokes it.
- The current advisor environment has no installed dependencies. The attempted
  baseline command `bun run docs:build` exited 127 with `astro: command not
  found`; this is an environment limitation, not evidence about the site.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install current lock | `bun install --frozen-lockfile` | exit 0; lockfile unchanged |
| Resolve upgraded graph | `bun install` | exit 0; `bun.lock` updated, no incompatible Astro peer warning |
| Reproducibility | `bun install --frozen-lockfile` | exit 0 after the lock update |
| Docs diagnostics | `bun run docs:check` | exit 0; no Astro errors |
| Docs production build | `bun run docs:build` | exit 0; Pagefind completes |
| Root typecheck | `bun run typecheck` | exit 0; no TypeScript errors |
| Root tests | `bun test` | all tests pass / output includes `0 fail` |
| Root build | `bun run build` | exit 0 |
| Preview | `bun run docs:preview` | server starts and serves the generated site |

Use Node 22.12.0 or newer and Bun 1.3.5 for every command in this plan.

## Scope

**In scope** (the only files that may be modified):

- `package.json`
- `bun.lock`
- `src/components/Footer.astro`
- `astro.config.mjs` — only for proven compatibility fixes; no speculative flags
- `src/content.config.ts` — only if target Starlight types/build require a change
- `src/styles/custom.css` — only for selectors proven broken by visual/DOM checks
- `src/content/docs/**/*.md` and `src/content/docs/**/*.mdx` — only for proven
  Rust compiler, Sätteri, heading-anchor, or inline-whitespace regressions
- `tsconfig.docs.json`
- `.github/workflows/docs.yml`
- `.github/workflows/ci.yml`
- `README.md` — document the docs runtime and validation commands
- `plans/README.md` — status update only

**Out of scope** (do not touch):

- CLI/package source under `apps/`, `packages/`, or `plugins/`
- Release workflow/runtime changes; docs-only Node 22 setup is sufficient here
- New blog, Mermaid support, autogenerated sidebar, new content, or a redesign
- Font loading; the missing JetBrains Mono/Space Grotesk imports are pre-existing
- Changing Astro's output directory or the Pages deployment architecture
- Adding `unified()`/remark compatibility unless Sätteri has a demonstrated,
  unresolved regression in existing content
- Changing URLs, adding `/en/`, or changing `https://atlcli.sh`

## Git workflow

- Branch: `codex/astro-7-docs`
- Use conventional commits, split into logical units where the tree remains
  valid. Suggested messages: `chore(docs): upgrade to Astro 7` and
  `ci(docs): validate Astro documentation builds`.
- Do not push, open a PR, or deploy unless the operator explicitly asks.

## Steps

### Step 1: Capture a reproducible Astro 5 baseline

1. Confirm Node is at least 22.12.0 and Bun is exactly 1.3.5.
2. Run `bun install --frozen-lockfile`; confirm `git status --short` does not
   report a lockfile change.
3. Run `bunx astro check --tsconfig ./tsconfig.docs.json` and
   `bun run docs:build`. Record errors/warnings without fixing unrelated
   content yet.
4. Record generated route HTML paths, sitemap files, Pagefind files, `CNAME`,
   and `install.sh`. The source baseline is 56 content files (54 `.md`, 2
   `.mdx`); generated framework utility pages may make raw HTML counts differ.
5. Preview the current production build and capture light/dark desktop and
   mobile screenshots of:
   - `/` (splash hero and CardGrid)
   - `/getting-started/` (Tabs and asides)
   - `/confluence/macros/` (directive examples and code blocks)
   - `/reference/cli-commands/` (long navigation/reference page)
   - search UI, sidebar, and custom trademark footer

Store baseline notes/screenshots outside tracked source unless the operator
explicitly requests checked-in snapshots.

**Verify**: `git status --short` → no tracked changes from baseline capture.

### Step 2: Resolve the Astro 7-compatible dependency set atomically

1. In `package.json`, target:
   - `astro: ^7.0.7`
   - `@astrojs/starlight: ^0.41.3`
   - `@astrojs/check: ^0.9.9`
2. Remove the direct `zod: 3.25.76` dev dependency. Do not add Zod 4 directly;
   this repository has no direct Zod API use.
3. Keep Sharp on the existing compatible 0.34 range unless the resolver proves
   a newer minimum is required.
4. Add `docs:check`: `astro check --tsconfig ./tsconfig.docs.json` to scripts.
5. Run `bun install` once to regenerate `bun.lock`. Inspect the changed graph:
   Astro must resolve to 7.0.7 or a later 7.x patch, Starlight to 0.41.3 or a
   later 0.41.x patch, Vite to 8.x, Zod to 4.x for Astro, MDX to 7.x, and
   Expressive Code to 0.44.x. There must be no peer warning tying Starlight,
   MDX, or Expressive Code to Astro 5/6.
6. Run `bun install --frozen-lockfile` to prove reproducibility.

Do not use `bunx @astrojs/upgrade` as though it were an official documented
path. Astro documents npm/pnpm/yarn upgrade commands; manual edits plus Bun
lock regeneration are the predictable path for this Bun repository.

**Verify**: `bun run docs:check` → exit 0, or only actionable migration errors
that are addressed in Steps 3–4.

### Step 3: Update the Starlight component override

In `src/components/Footer.astro`, preserve the public default footer import,
slot, disclaimer text, and styles, but remove obsolete prop forwarding:

```astro
<Default>
  <slot />
</Default>
```

Do not replace the override with copied Starlight internals. Do not use
`Astro.locals.starlightRoute` unless a real data need is identified.

**Verify**: `bun run docs:check` → exit 0 with no diagnostic in
`src/components/Footer.astro`.

### Step 4: Adapt only demonstrated Astro 6/7 rendering breaks

Run `bun run docs:build`. Fix only errors or regressions attributable to these
known changes:

- Rust compiler: close unclosed non-void HTML/component tags and correct invalid
  nesting; do not rewrite valid Markdown broadly.
- Sätteri: keep the default processor. Verify Starlight asides, literal
  Confluence directive examples, MDX Cards, and Tabs. If a confirmed Sätteri
  bug cannot be fixed locally, STOP before adding unified/remark.
- JSX whitespace: inspect adjacent inline elements. Add explicit local spaces
  only where rendered text runs together. Do not set `compressHTML: true`
  globally unless widespread breakage is measured and approved.
- Heading IDs: verify punctuation-ending headings and internal anchors against
  Astro 6's `github-slugger` behavior. Preserve public URLs where possible.
- CSS/Expressive Code: compare DOM/selectors and baseline screenshots. Update
  only selectors that no longer match. Minor compiler CSS serialization changes
  are cosmetic and not a reason to churn source CSS.

Leave `src/content.config.ts` unchanged if it passes: its loader/schema pattern
is already the supported one. Leave Astro config free of compatibility flags if
the default build passes.

**Verify**: `bun run docs:check` and `bun run docs:build` → both exit 0 with no
new warning that points to project code.

### Step 5: Make docs validation reproducible in CI

1. Update `.github/workflows/docs.yml`:
   - add `actions/setup-node` with Node `22.12.0` before running Astro;
   - pin Bun to `1.3.5`, matching `packageManager`;
   - change install to `bun install --frozen-lockfile`;
   - run `bun run docs:check` before `bun run docs:build`;
   - add `bun.lock`, `src/content.config.ts`, and `tsconfig.docs.json` to the
     push path filter;
   - keep artifact path `dist/` and deploy behavior unchanged.
2. Add a separate `docs` job to `.github/workflows/ci.yml` for pull requests and
   main pushes. Use Node 22.12.0, Bun 1.3.5, frozen install, docs check, and docs
   build. Keep it separate from the CLI test/build job to avoid `dist/`
   collisions and to make failures attributable.
3. In `README.md`, add a concise documentation-development section with Node
   >=22.12, Bun 1.3.5, `bun run docs:dev`, `bun run docs:check`, and
   `bun run docs:build`.

**Verify**: inspect both workflow YAML files for valid structure, then run
`bun run docs:check` and `bun run docs:build` locally → exit 0.

### Step 6: Run artifact, route, and visual regression checks

Using the Astro 7 production build and preview:

1. Compare the generated documentation route set with the Step 1 baseline.
   Every source page and every one of the 55 explicit sidebar links must resolve.
2. Confirm `/` and all nested docs remain under root locale; no `/en/` prefix is
   introduced.
3. Confirm sitemap generation contains canonical `https://atlcli.sh` URLs.
4. Confirm Pagefind index files exist and search returns results from at least a
   Confluence page, a Jira page, and a reference page.
5. Confirm `dist/CNAME` contains the custom domain and `dist/install.sh` is
   present and byte-identical to `public/install.sh`.
6. Exercise hero actions, cards, Tabs keyboard interaction, theme toggle,
   sidebar on desktop/mobile, edit links, code copy buttons, and footer.
7. Compare the representative pages from Step 1 in light/dark and
   desktop/mobile. Pay particular attention to global `pre`, aside, table,
   `.sl-markdown-content`, and `.card-grid` styles.
8. Verify the raised browser baseline (Chromium 111+, Firefox 114+, Safari
   16.4+) is acceptable; test at the minimum where practical.

**Verify**: `bun run docs:preview` → all checks above pass against the production
artifact, not the development server.

### Step 7: Run repository gates and prepare the change

Run, in order:

1. `bun install --frozen-lockfile`
2. `bun run docs:check`
3. `bun run docs:build`
4. `bun run typecheck`
5. `bun test`
6. `bun run build`
7. the full production-preview E2E checklist from Step 6

Confirm only in-scope files changed. Commit logical units using conventional
commit messages. Do not deploy or push.

**Verify**: `git status --short` → only reviewed, in-scope changes; all commands
above pass.

## Test plan

- Compilation regression: Astro Check covers config, content loader/schema,
  MDX imports, and the footer override under Astro 7 types.
- Production regression: `astro build` exercises all 54 Markdown and 2 MDX
  files with the Rust compiler and Sätteri, then generates sitemap and Pagefind.
- Route regression: compare all content-derived paths and 55 manual sidebar
  links with the pre-upgrade route manifest; fail for any missing route.
- Asset regression: assert `CNAME` and `install.sh` exist in `dist/`, with
  `install.sh` byte-identical to its public source.
- Interaction E2E: preview build tests search, Tabs, code copy, theme toggle,
  responsive sidebar, edit links, hero/card links, and footer.
- Visual regression: manual before/after screenshots across the four named
  representative pages, two viewports, and both color modes.
- Existing CLI tests remain unchanged and must still report `0 fail`.

No new unit test is required for framework-owned behavior. The new PR docs job
is the automated regression gate for this dependency migration; do not invent
application logic solely to make a unit-test file possible.

## Done criteria

- [ ] `package.json` declares Astro `^7.0.7` (or later approved 7.x), Starlight
      `^0.41.3` (or later compatible 0.41.x), and Astro Check `^0.9.9`.
- [ ] The unused direct Zod 3 pin is gone; lockfile Astro dependencies use Zod 4.
- [ ] Lockfile has no Astro 5/6-only peer dependency in the Starlight graph.
- [ ] `bun install --frozen-lockfile` exits 0 under Bun 1.3.5.
- [ ] `bun run docs:check` exits 0 under Node >=22.12.0.
- [ ] `bun run docs:build`, `bun run typecheck`, `bun test`, and
      `bun run build` all pass.
- [ ] All 56 source pages and all 55 sidebar links resolve with no `/en/` drift.
- [ ] Pagefind search, sitemap canonical URLs, `CNAME`, and `install.sh` pass.
- [ ] Footer, Cards, Tabs, asides, code blocks, tables, light/dark theme, and
      desktop/mobile navigation match the accepted baseline.
- [ ] PR CI contains a dedicated frozen-lockfile docs check/build job.
- [ ] Pages CI pins Node/Bun, runs Astro Check, and watches all dependency/config
      inputs.
- [ ] README documents the supported docs toolchain and commands.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` marks Plan 001 DONE.

## STOP conditions

Stop and report back instead of improvising if:

- Astro 7.0.7+ and Starlight 0.41.3+ cannot resolve without an incompatible peer
  warning after one clean lockfile regeneration.
- Removing Zod 3 breaks non-docs repository code or reveals a direct consumer
  missed during recon.
- The Starlight content loader/schema API no longer accepts the current modern
  Content Layer configuration.
- Existing content requires remark/rehype/recma behavior not found during recon;
  approval is required before selecting unified over Sätteri.
- Restoring rendering requires a global `compressHTML: true` fallback or broad
  content/CSS rewrites rather than small, demonstrated compatibility fixes.
- Root-locale URLs, the manual sidebar, Pagefind, sitemap, `CNAME`, or
  `install.sh` cannot be preserved.
- Supporting browsers older than Chromium 111, Firefox 114, or Safari 16.4 is a
  product requirement; Starlight 0.41 intentionally raises the baseline.
- A verification command fails twice after one reasonable, scoped correction.
- Any fix requires a file or behavior listed as out of scope.

## Maintenance notes

- Review future Starlight upgrades against the footer override and CSS selectors;
  they are the only theme-coupled customizations.
- Keep Astro and Starlight peer ranges compatible and update them together.
- Keep docs CI's Bun version aligned with `packageManager` and Node at or above
  Astro's documented minimum. Prefer frozen installs in every docs job.
- Sätteri is now the intended Markdown path. If a future plugin requires unified,
  document the reason and add an explicit compatibility test before switching.
- The root `dist/` directory is shared by CLI and docs builds. Continue using
  isolated CI jobs; consider a separate output directory in a follow-up plan if
  local artifact collisions become a recurring problem.

## Resolved decisions

1. Node 22.12+ remains scoped to documentation development and documentation CI.
   Release jobs and the monorepo-wide runtime baseline are unchanged.
2. Starlight 0.41's browser floor is accepted: Chromium 111+, Firefox 114+,
   and Safari/iOS 16.4+.
