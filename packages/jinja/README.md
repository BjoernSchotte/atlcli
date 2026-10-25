# @atlcli/jinja

Jinja templates for atlcli: [Nunjucks](https://mozilla.github.io/nunjucks/)
rendered inside a QuickJS sandbox, never on the host, because a template is
code and templates also come from shared packs.

- **Tolerant by default:** an expression that cannot resolve stays as written
  and is reported, instead of silently becoming empty text (copied issues and
  pages often contain someone else's templates).
- **Synchronous rendering** after one `await initJinja()`.
- **Runtime:** Node ≥ 22 and Bun; browser-safe (QuickJS WASM).
- **Install:** filesystem link or packed tarball — no registry publish today.

```ts
import { initJinja, renderJinja } from "@atlcli/jinja";

await initJinja();
renderJinja("Release {{ version }} — {{ items | length }} issues", { version: "2026.11", items: [1, 2] });
// { text: "Release 2026.11 — 2 issues", warnings: [] }
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
