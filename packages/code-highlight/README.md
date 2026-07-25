# `@atlcli/code-highlight`

Browser-safe shared Shiki highlighting for atlcli export engines.

The package ships Shiki's complete pinned bundled language/alias catalogue and
default theme catalogue. Themes and grammars are selected through Shiki's
generated lazy-loader maps, so no user input is interpolated into an import path
and no runtime network access is required. `github-light` is the default.

After upgrading Shiki, regenerate and verify the checked-in catalogue:

```bash
bun run --cwd packages/code-highlight catalogue:generate
bun run --cwd packages/code-highlight catalogue:check
```
