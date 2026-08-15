---
title: "Development releases"
description: "Install, inspect, update, and leave the atlcli development channel"
---

# Development releases

The `dev` channel is an opt-in preview built from a green commit on `main`.
Use it to try changes before a stable release. Each build has a unique tag and
is published as a GitHub prerelease, never as GitHub **Latest**.

## On this page

- [Choose a channel](#choose-a-channel)
- [Install the dev CLI with Homebrew](#install-the-dev-cli-with-homebrew)
- [Inspect and update a dev installation](#inspect-and-update-a-dev-installation)
- [Install the packaged browser extension](#install-the-packaged-browser-extension)
- [Return to stable](#return-to-stable)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Choose a channel

| Channel | Source | Update path | Intended use |
|---------|--------|-------------|--------------|
| Stable | Versioned stable release | `atlcli` Homebrew formula or install script | Normal use |
| Dev | Green `main` commit with a unique `dev-*` tag | `atlcli-dev` Homebrew formula | Preview and testing |

Dev builds are real release artifacts, but their interfaces and behavior may
change before the next stable version. They do not replace the stable release,
and the stable updater does not select them.

## Install the dev CLI with Homebrew

The stable and dev formulae both install the `atlcli` executable, so Homebrew
does not link them at the same time.

```bash
brew uninstall atlcli
brew install bjoernschotte/tap/atlcli-dev
```

Confirm the channel and exact source identity:

```bash
atlcli release-info --json
```

The result reports `"channel": "dev"`, the full `sourceSha`, and the immutable
`releaseTag` used by the formula.

## Inspect and update a dev installation

Inspect the installed formula and update to the newest published dev build:

```bash
brew info bjoernschotte/tap/atlcli-dev
brew update
brew upgrade atlcli-dev
atlcli release-info --json
```

The formula moves forward to a newly published tag. Existing release tags and
assets are never overwritten.

## Install the packaged browser extension

Every dev prerelease includes
`atlcli-extension-chrome-mv3-<dev-tag>.zip`. Download the ZIP and
`checksums.txt` from the same [GitHub release](https://github.com/BjoernSchotte/atlcli/releases),
then verify the ZIP before extracting it:

```bash
sha256sum -c checksums.txt --ignore-missing
unzip atlcli-extension-chrome-mv3-dev-*.zip -d atlcli-extension
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the extracted `atlcli-extension` directory containing
   `manifest.json`.

:::caution[Developer sideload only]
The ZIP is not a Chrome Web Store package and cannot be click-installed. Chrome
does not auto-update this sideloaded copy. Download, verify, extract, and load a
new ZIP when you want to update it.
:::

## Return to stable

Switch channels explicitly:

```bash
brew uninstall atlcli-dev
brew install bjoernschotte/tap/atlcli
atlcli release-info --json
```

The final command should report `"channel": "stable"`.

## Troubleshooting

### Homebrew reports a conflict

**Symptom:** Installing `atlcli-dev` says that `atlcli` conflicts, or the
reverse.

**Cause:** Both formulae intentionally own the same executable.

**Fix:** Uninstall the current channel first, then install the other formula as
shown above.

### `brew upgrade atlcli-dev` finds no update

**Symptom:** GitHub shows a newer commit on `main`, but Homebrew has no newer dev
formula.

**Cause:** A dev release is published only after the exact commit's required CI
run succeeds and the GitHub and Homebrew consumer gates finish. A commit on
`main` alone is not a release.

**Fix:** Inspect the latest `dev-*` prerelease and the Tap workflow. Keep the
current installation until a complete newer release is available.

### Chrome rejects the extension ZIP

**Symptom:** Chrome cannot load the downloaded ZIP directly.

**Cause:** **Load unpacked** expects an extracted directory with
`manifest.json` at its root.

**Fix:** Verify and extract the ZIP, then select the extracted directory. Do
not select the ZIP itself or a parent directory.

## Related topics

- [Getting started](/getting-started/)
- [Browser extension](/extension/)
- [Updating](/reference/updating/)
- [Contributing and release operations](/contributing/#development-release-operations)
