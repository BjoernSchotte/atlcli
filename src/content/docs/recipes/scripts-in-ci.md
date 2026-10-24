---
title: "Scripts in CI"
description: "Review atlcli script plans in pull requests, apply exactly the reviewed plan, and run scheduled housekeeping"
---

# Scripts in CI

Keep Jira and Confluence automation in git and run it from CI. A pull request shows the plan a script would apply; after review, a job applies exactly that plan. Routine housekeeping runs on a schedule.

## On this page

- [Prerequisites](#prerequisites)
- [Use case](#use-case)
- [Credentials in CI](#credentials-in-ci)
- [Review a plan in a pull request](#review-a-plan-in-a-pull-request)
- [Apply the reviewed plan](#apply-the-reviewed-plan)
- [Scheduled housekeeping](#scheduled-housekeeping)
- [Best practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- Scripts in the repository, for example under `automation/` (see [Automation Scripts](../scripts.md))
- An Atlassian API token for a service account, stored as CI secrets
- **Jira and Confluence permissions** for that account, matching what the scripts write

## Use case

- A change to many issues or pages should be reviewed like code before it happens.
- The reviewer should approve the actual change set, not a script that might do something else by the time it runs.
- Recurring cleanups (stale issues, labels, release notes pages) should run unattended, within tight bounds.

## Credentials in CI

`atlcli auth login` reads the site, email and token from the environment, so no secret appears on the command line:

```yaml
env:
  ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
  ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
  ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
```

Every job below installs atlcli and logs in with these variables set.

## Review a plan in a pull request

The job runs the script without applying. It uploads the plan file as an artifact and shows the plan in the job summary:

```yaml
name: Automation plan

on:
  pull_request:
    paths: ['automation/**']

jobs:
  plan:
    runs-on: ubuntu-latest
    env:
      ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
      ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
      ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: |
          curl -fsSL https://atlcli.sh/install.sh | bash
          echo "$HOME/.atlcli/bin" >> "$GITHUB_PATH"

      - name: Log in
        run: atlcli auth login

      - name: Plan
        run: |
          atlcli script run automation/release-notes.ts \
            --param version=2026.10 --plan-out plan.json | tee plan.txt
          { echo '```'; cat plan.txt; echo '```'; } >> "$GITHUB_STEP_SUMMARY"

      - uses: actions/upload-artifact@v4
        with:
          name: atlcli-plan
          path: plan.json
```

Reviewers read the operations in the summary. The artifact is the exact plan. Its digest covers every operation, the parameters and the target site.

## Apply the reviewed plan

Apply with a manually started workflow. It takes the run id of the reviewed plan job and applies that artifact, not a fresh run of the script:

```yaml
name: Automation apply

on:
  workflow_dispatch:
    inputs:
      run-id:
        description: Run id of the reviewed "Automation plan" job
        required: true

jobs:
  apply:
    runs-on: ubuntu-latest
    environment: atlassian-production   # require an approval here
    env:
      ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
      ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
      ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
    steps:
      - name: Install atlcli
        run: |
          curl -fsSL https://atlcli.sh/install.sh | bash
          echo "$HOME/.atlcli/bin" >> "$GITHUB_PATH"

      - name: Log in
        run: atlcli auth login

      - uses: actions/download-artifact@v4
        with:
          name: atlcli-plan
          run-id: ${{ inputs.run-id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Apply
        run: atlcli script apply plan.json --yes --json > report.json

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: atlcli-report
          path: report.json
```

Apply never runs a changed plan or a stale one:

- **Changed plan:** a plan file edited after review fails its digest check.
- **Stale plan:** if an issue or page changed since the plan was made, apply writes nothing and exits with code 2. Re-run the plan job and review again.

## Scheduled housekeeping

For routine jobs, plan and apply in one step. Bound the script with `meta`, so a mistake cannot reach beyond one project or exceed a known number of writes:

```ts
// automation/stale-issues.ts
export const meta = {
  name: "stale-issues",
  permissions: ["jira:read", "jira:write:ATLCLI"],
  limits: { maxWrites: 40 },
};

for await (const issue of atlcli.jira.search("project = ATLCLI AND statusCategory != Done AND updated < -180d", { limit: 20 })) {
  await atlcli.jira.comment(issue.key, "No activity for 180 days; closing. Reopen if still relevant.");
  await atlcli.jira.transition(issue.key, "Won't Do");
}
```

```yaml
name: Weekly housekeeping

on:
  schedule:
    - cron: '17 6 * * 1'   # Mondays 06:17 UTC

jobs:
  housekeeping:
    runs-on: ubuntu-latest
    env:
      ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
      ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
      ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - name: Install atlcli
        run: |
          curl -fsSL https://atlcli.sh/install.sh | bash
          echo "$HOME/.atlcli/bin" >> "$GITHUB_PATH"

      - name: Log in
        run: atlcli auth login

      - name: Close stale issues
        run: atlcli script run automation/stale-issues.ts --apply --yes --plan-out plan.json

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: housekeeping-plan
          path: plan.json
```

The plan artifact records what each run did.

## Best practices

- **Check scripts in the pull request.** Add `atlcli script check automation/*.ts` (with `npm i -g typescript` for the type check) next to the plan step.
- **Declare `permissions` and `maxWrites` for unattended scripts.** A plan you never look at should not be able to grow without bounds.
- **Use a service account** whose Jira and Confluence permissions match the scripts, not an administrator.
- **Keep the plan job and the apply job separate** when a human should approve. Use `--apply --yes` only for scheduled, bounded jobs.
- **Prefer `upsertPage`** for generated pages, so re-runs update instead of failing on the title check.

## Troubleshooting

**Apply exits with code 2.**
Something changed between plan and apply. The log lists each target and its current state. Re-run the plan job, review the new plan, and apply that one.

**`Plan digest mismatch: the plan was modified after it was created`.**
The plan file is not the one the plan job wrote. Download the artifact again; never edit plans by hand.

**`Plan targets https://a.atlassian.net, but profile … is https://b.atlassian.net`.**
The apply job logged in to a different site. Use the same `ATLCLI_SITE` secret in both jobs.

**`Applying needs confirmation: pass --yes`.**
CI has no terminal to ask in. `--yes` belongs only in jobs that apply a reviewed or bounded plan.

**A transition fails during apply.**
Workflow transition names are localized and differ between projects. For issues the plan creates, names are only checked at apply. Test the script once interactively, and see [troubleshooting in the guide](../scripts.md#troubleshooting).

## Related topics

- [Automation Scripts](../scripts.md): writing scripts, plan and apply
- [Script API](../reference/scripts.md): verbs, `meta`, plan file, exit codes
- [CI/CD Documentation](ci-cd-docs.md): publishing docs from CI with `wiki docs push`
- [Authentication](../authentication.md): service accounts and tokens
