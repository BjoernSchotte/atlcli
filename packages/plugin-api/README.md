# @atlcli/plugin-api

Type definitions and helpers for writing atlcli plugins: `definePlugin`,
`defineCommand`, `defineSubcommand`, `defineFlag` plus the `AtlcliPlugin` /
`CommandContext` type surface.

- **Entry points:** `.` (the only one).
- **Runtime:** Node ≥ 20 and Bun (pure TypeScript, no platform APIs).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { definePlugin } from "@atlcli/plugin-api";

export default definePlugin({
  name: "my-plugin",
  version: "1.0.0",
  commands: [/* … */],
});
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
