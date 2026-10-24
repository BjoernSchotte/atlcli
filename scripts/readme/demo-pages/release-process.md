We ship a product release every few weeks, versioned `YYYY.M.N` (UTC month, monthly counter).

## Timeline

| Day | Step | Who |
|---|---|---|
| Monday | Freeze `main`, run the dry run | Release captain |
| Tuesday | Security review of the diff since the last tag | Two reviewers |
| Wednesday | Release PR, tag, artifacts, Homebrew | Release captain |
| Thursday | Announce, watch error reports | Everyone |

## Checklist

- [x] `bun scripts/release.ts --dry-run` reviewed
- [x] Changelog entry reads well
- [ ] Security review signed off
- [ ] Homebrew formula updated
- [ ] Release notes posted

:::warning
Never tag by hand. The release script tags the merge commit that CI proved.
:::
