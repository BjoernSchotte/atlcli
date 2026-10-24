What to do when a release breaks users.

## First 15 minutes

1. Acknowledge in the team channel and open an incident issue in Jira.
2. Check the latest release workflow run and the error reports.
3. Decide: roll forward with a fix, or point Homebrew back to the previous tag.

## Severity

| Level | Example | Response |
|---|---|---|
| SEV1 | Exports fail for everyone | Page the release captain |
| SEV2 | One macro renders wrong | Fix in the next release |
| SEV3 | Cosmetic issue in the TUI | Backlog |

:::info
Write the timeline as you go — the post-mortem starts from it.
:::
