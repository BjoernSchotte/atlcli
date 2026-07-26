# `@atlcli/code-highlight`

Shared Shiki highlighting for atlcli export engines, with host-specific RegExp
engines:

- the default Node/Bun entry installs Oniguruma and `shiki/wasm`;
- the `browser` export condition installs Shiki's JavaScript RegExp engine and
  never imports the Oniguruma adapter.

The concrete engines live in separate modules. Do not centralize them behind a
runtime branch: browser bundlers must never discover the Oniguruma/WASM import.
Engine installation is idempotent, but switching to a different engine after
the first highlighter initialization throws because the caches are
engine-bound.

The package ships Shiki's complete pinned bundled language/alias catalogue and
default theme catalogue. Themes and grammars are selected through Shiki's
generated lazy-loader maps, so no user input is interpolated into an import path
and no runtime network access is required. `github-light` is the default.

Hosts may await only the grammars needed for an imminent export:

```ts
import { prepareCodeHighlighting } from "@atlcli/code-highlight";

await prepareCodeHighlighting(["ts", "python", "unknown-language"]);
```

Aliases are canonicalized, unknown languages are ignored, and concurrent or
repeated calls share the same initialization/grammar promises. `highlightCode`
and `prepareCodeHighlighting` accept an `onTiming` callback that reports newly
performed engine initialization, grammar load/compile, and source
tokenization. Warm cache work is reported as zero.

After upgrading Shiki, regenerate and verify the checked-in catalogue:

```bash
bun run --cwd packages/code-highlight catalogue:generate
bun run --cwd packages/code-highlight catalogue:check
```
