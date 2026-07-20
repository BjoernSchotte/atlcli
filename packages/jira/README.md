# @atlcli/jira

Jira REST API client plus worklog, analysis, import/export, template, and
webhook-server modules backing atlcli's `jira` commands.

- **Entry points:** `.` (the only one).
- **Runtime:** **Bun ≥ 1.3 only** — the barrel's webhook server is built on
  `Bun.serve`. (The REST client module itself is browser-safe and gated by
  the repo's browser-build check, but the package barrel is Bun-scoped.)
- **Install:** filesystem link or packed tarball — no registry publish today.
  See the [package consumption guide](https://atlcli.sh/reference/package-consumption/).

```ts
import { JiraClient } from "@atlcli/jira";

const client = new JiraClient(profile);
const issue = await client.getIssue("ATLCLI-1");
```

Versioning: lockstep `@atlcli/*` train; this package stays 0.x until its API
surface is reviewed for the freeze — see
[package versioning](https://atlcli.sh/reference/versioning/).
