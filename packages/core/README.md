# @atlcli/core

Shared atlcli infrastructure: profile/config loading, auth token resolution,
logging, Confluence/Jira URL parsing, flag handling, and template utilities.

- **Entry points:** `.` (Node barrel), `./browser` (isomorphic subset: types,
  redaction, URL parsing, logger core, auth core), `./node`.
- **Runtime:** Node ≥ 20 and Bun; the `./browser` barrel is browser-safe
  (gated by the repo's browser-build CI check).
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { loadConfig, getActiveProfile } from "@atlcli/core";

const config = await loadConfig();
const profile = getActiveProfile(config);
```

Versioning: lockstep `@atlcli/*` train, pre-1.0 rules — see
[package versioning](https://atlcli.sh/reference/versioning/).
