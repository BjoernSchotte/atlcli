# Documentation Migration: MkDocs → Astro Starlight

## Overview

Migrate atlcli documentation from MkDocs Material to Astro with Starlight theme.

**Branch:** `documentation-infra`
**Target:** https://atlcli.sh/
**Approach:** Big bang migration (complete in one PR)

## Requirements Summary

| Category | Decision |
|----------|----------|
| Project structure | In-place replacement (transform docs/ directly) |
| Package manager | bun |
| Styling | Starlight defaults + Atlassian Blue brand colors |
| Dark/light mode | Keep toggle |
| Syntax conversion | Auto-convert all (admonitions, tabs, TOC, cards) |
| Mermaid diagrams | Yes, include support |
| Navigation | Sidebar groups with explicit ordering |
| Deployment | GitHub Pages, trigger on docs changes only |
| Versioned docs | Infrastructure ready, single "latest" version |
| Blog | Changelog/releases + tutorials (source from CHANGELOG.md) |
| i18n | English only, infrastructure for future translations |
| Downtime | Brief downtime acceptable |

---

## Phase 1: Project Setup

### 1.1 Initialize Astro Starlight Project

```bash
# In repository root
bunx create-astro@latest docs-temp --template starlight --no-git --no-install
# Move contents to root, merge with existing structure
```

### 1.2 New File Structure

```
atlcli/
├── astro.config.mjs          # Astro + Starlight config
├── package.json              # Updated with Astro deps
├── tsconfig.json             # TypeScript config for Astro
├── src/
│   ├── content/
│   │   ├── docs/             # Main documentation (migrated from docs/)
│   │   │   ├── index.mdx     # Homepage
│   │   │   ├── getting-started.md
│   │   │   ├── confluence/
│   │   │   ├── jira/
│   │   │   ├── recipes/
│   │   │   ├── plugins/
│   │   │   └── reference/
│   │   └── blog/             # Blog/changelog section
│   │       └── ...
│   ├── styles/
│   │   └── custom.css        # Brand colors, minimal customization
│   └── assets/               # Images, logos
├── public/
│   └── CNAME                 # Custom domain: atlcli.sh
└── docs/                     # REMOVED (content moved to src/content/docs/)
```

### 1.3 Files to Remove

- `mkdocs.yml`
- `docs/stylesheets/` (replaced by src/styles/)
- `docs/javascripts/` (Mermaid handled differently)

### 1.4 Dependencies

```json
{
  "dependencies": {
    "astro": "^5.x",
    "@astrojs/starlight": "^0.x",
    "@astrojs/mdx": "^4.x",
    "sharp": "^0.x"
  },
  "devDependencies": {
    "@astrojs/check": "^0.x",
    "typescript": "^5.x"
  }
}
```

Additional for features:
- Mermaid: `remark-mermaidjs` or `@astrojs/starlight-mermaid`
- Blog: `@astrojs/starlight-blog` (if available) or custom collection

---

## Phase 2: Configuration

### 2.1 astro.config.mjs

```javascript
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://atlcli.sh',
  integrations: [
    starlight({
      title: 'atlcli',
      description: 'Extensible CLI for Atlassian products',
      logo: {
        src: './src/assets/logo.svg',  // Add later
      },
      social: {
        github: 'https://github.com/BjoernSchotte/atlcli',
      },
      editLink: {
        baseUrl: 'https://github.com/BjoernSchotte/atlcli/edit/main/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Home', link: '/' },
        { label: 'Getting Started', link: '/getting-started/' },
        {
          label: 'Confluence',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/confluence/' },
            { label: 'Sync', link: '/confluence/sync/' },
            { label: 'Pages', link: '/confluence/pages/' },
            // ... full list from mkdocs.yml nav
          ],
        },
        {
          label: 'Jira',
          collapsed: false,
          items: [
            { label: 'Overview', link: '/jira/' },
            { label: 'Issues', link: '/jira/issues/' },
            // ... full list
          ],
        },
        {
          label: 'Recipes',
          items: [/* ... */],
        },
        {
          label: 'Plugins',
          items: [/* ... */],
        },
        {
          label: 'Reference',
          items: [/* ... */],
        },
        { label: 'Contributing', link: '/contributing/' },
      ],
      // i18n infrastructure (English only for now)
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        // de: { label: 'Deutsch', lang: 'de' },  // Future
      },
    }),
  ],
});
```

### 2.2 Custom CSS (src/styles/custom.css)

```css
/* Atlassian Blue brand colors */
:root {
  --sl-color-accent-low: #0747a6;
  --sl-color-accent: #0052cc;
  --sl-color-accent-high: #4c9aff;

  /* Optional: Custom fonts */
  /* --sl-font: 'JetBrains Mono', monospace; */
  /* --sl-font-heading: 'Space Grotesk', sans-serif; */
}

/* Dark mode accent adjustments */
:root[data-theme='dark'] {
  --sl-color-accent-low: #0747a6;
  --sl-color-accent: #4c9aff;
  --sl-color-accent-high: #79e2f2;
}
```

---

## Phase 3: Content Migration

### 3.1 Syntax Transformations

| MkDocs Syntax | Starlight Syntax |
|---------------|------------------|
| `::: toc` | REMOVE (auto-generated from h2/h3) |
| `!!! note "Title"` | `:::note[Title]` |
| `!!! tip "Title"` | `:::tip[Title]` |
| `!!! warning "Title"` | `:::caution[Title]` |
| `!!! danger "Title"` | `:::danger[Title]` |
| `=== "Tab 1"` | `<Tabs><TabItem label="Tab 1">` (MDX) |
| Grid cards (HTML) | `<CardGrid><Card>` components |

### 3.2 Frontmatter Updates

**Before (MkDocs):**
```yaml
---
title: Page Title
---
```

**After (Starlight):**
```yaml
---
title: Page Title
description: Brief description for SEO
---
```

### 3.3 File Renames

- `docs/*.md` → `src/content/docs/*.md`
- `docs/confluence/*.md` → `src/content/docs/confluence/*.md`
- etc.

Some files may need `.mdx` extension if using components (Tabs, Cards).

### 3.4 Homepage Migration

Current `docs/index.md` uses MkDocs Material grid cards. Convert to:

```mdx
---
title: atlcli
description: Extensible CLI for Atlassian products
template: splash
hero:
  title: atlcli
  tagline: Blazingly fast CLI for Atlassian products
  actions:
    - text: Get Started
      link: /getting-started/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/BjoernSchotte/atlcli
      icon: external
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

<CardGrid>
  <Card title="Confluence" icon="document">
    Bidirectional markdown/wiki sync...
    [Learn more](/confluence/)
  </Card>
  <Card title="Jira" icon="list-format">
    Full issue lifecycle...
    [Learn more](/jira/)
  </Card>
  <!-- ... -->
</CardGrid>
```

### 3.5 Migration Script

Create `scripts/migrate-docs.ts` to automate:

1. Copy files from `docs/` to `src/content/docs/`
2. Transform admonition syntax
3. Remove `::: toc` markers
4. Add description to frontmatter
5. Convert tabs to MDX (flag files needing manual review)
6. Report files needing manual attention

---

## Phase 4: Blog Setup

### 4.1 Blog Collection

```
src/content/blog/
├── 2025-01-20-v0.5.0-release.md
├── 2025-01-15-getting-started-tutorial.md
└── ...
```

### 4.2 Blog Frontmatter

```yaml
---
title: atlcli v0.5.0 Released
date: 2025-01-20
authors:
  - name: Björn Schotte
description: New features in v0.5.0...
tags: [release, changelog]
---
```

### 4.3 CHANGELOG.md Integration

- Parse CHANGELOG.md sections
- Generate blog posts for releases
- Or: Display CHANGELOG.md directly as a page

---

## Phase 5: Mermaid Support

### 5.1 Setup Option A: remark-mermaidjs

```javascript
// astro.config.mjs
import remarkMermaid from 'remark-mermaidjs';

export default defineConfig({
  markdown: {
    remarkPlugins: [remarkMermaid],
  },
  // ...
});
```

### 5.2 Setup Option B: Client-side Mermaid

```javascript
// Add to custom script
import mermaid from 'mermaid';
mermaid.initialize({ startOnLoad: true });
```

---

## Phase 6: GitHub Workflow

### 6.1 New Workflow (.github/workflows/docs.yml)

```yaml
name: Deploy Documentation

on:
  push:
    branches: [main]
    paths:
      - 'src/content/**'
      - 'src/styles/**'
      - 'astro.config.mjs'
      - 'package.json'
      - '.github/workflows/docs.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: 'pages'
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build docs
        run: bun run docs:build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist/

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### 6.2 Package.json Scripts

```json
{
  "scripts": {
    "docs:dev": "astro dev",
    "docs:build": "astro build",
    "docs:preview": "astro preview"
  }
}
```

---

## Phase 7: Verification

### 7.1 Pre-deployment Checklist

- [ ] All 56 markdown files migrated
- [ ] Navigation matches mkdocs.yml structure
- [ ] Admonitions render correctly
- [ ] Code blocks have syntax highlighting
- [ ] Mermaid diagrams render
- [ ] Search works
- [ ] Dark/light mode toggle works
- [ ] Edit on GitHub links work
- [ ] Custom domain (atlcli.sh) configured
- [ ] Blog section accessible
- [ ] No broken internal links

### 7.2 Local Testing

```bash
bun run docs:dev
# Visit http://localhost:4321
# Test all pages, features
```

### 7.3 Build Testing

```bash
bun run docs:build
bun run docs:preview
```

---

## Implementation Order

1. **Setup** (Phase 1)
   - Initialize Astro project structure
   - Install dependencies
   - Create basic config

2. **Migration Script** (Phase 3.5)
   - Build automated migration tool
   - Run on all docs

3. **Manual Fixes** (Phase 3)
   - Homepage conversion to MDX
   - Tab components (if any)
   - Complex content

4. **Styling** (Phase 2.2)
   - Brand colors
   - Test dark/light modes

5. **Features** (Phases 4, 5)
   - Mermaid setup
   - Blog infrastructure

6. **Workflow** (Phase 6)
   - Update GitHub Actions
   - Test deployment

7. **Verification** (Phase 7)
   - Full testing
   - Deploy to production

---

## Rollback Plan

If issues occur:
1. Revert commit on main
2. MkDocs setup still in git history
3. Re-deploy previous version

---

## Decisions on Open Questions

1. **Logo**: No logo yet - skip for now, can add later
2. **Blog initial content**: Yes - create posts for minor AND patch releases from CHANGELOG.md
3. **Versioning**: Infrastructure ready, activate at v1.0 release

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Setup | 1 hour |
| Migration script | 2 hours |
| Manual content fixes | 2-3 hours |
| Styling | 1 hour |
| Features (Mermaid, Blog) | 2 hours |
| Workflow + testing | 1 hour |
| Verification | 1-2 hours |
| **Total** | **10-12 hours** |
