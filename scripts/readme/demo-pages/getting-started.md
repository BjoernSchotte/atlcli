Everything you need for your first day with atlcli.

## Install

```bash
brew install bjoernschotte/tap/atlcli
atlcli auth init
atlcli doctor
```

## Your first workspace

1. Pick a space you own, for example `TEAM`.
2. Pull it into a folder: `atlcli wiki docs init ./team-docs --space TEAM`.
3. Edit the Markdown files with any editor.
4. Check and publish: `atlcli wiki docs status`, then `atlcli wiki docs push --validate`.

:::tip
Prefer a fullscreen view? Run `atlcli tui` and press `2` for the wiki.
:::

## Checklist

- [x] Profile created with `atlcli auth init`
- [x] `atlcli doctor` is all green
- [ ] First page pulled and pushed back
- [ ] Shell completion installed
