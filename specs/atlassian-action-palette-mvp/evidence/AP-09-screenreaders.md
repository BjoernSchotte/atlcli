# AP-09 screen-reader evidence

**Status:** COMPLETE

**Date:** 2026-08-12

**Final source commit:** `f07dae16cfaceb5849b6637f2b30c4aab7fb14a1`

This evidence used only a controlled synthetic Atlassian-shaped page at
`fixture.atlassian.net`. It contains no tenant identifier, customer page body,
credential, generated export, or downloaded customer artifact. Screenshots and
the redacted NVDA receipt remain in the task visualization directory outside
Git.

## Browsers and assistive technology

- macOS 26.4 arm64: macOS VoiceOver with its caption panel and Google Chrome
  for Testing. The complete state walkthrough used Chrome 151.0.7922.34. The
  result-count regression was re-proved from the final source with Chrome
  149.0.7827.55 after the production live-region fix.
- Windows Server 2025 x64: NVDA 2026.1.1 with input/output logging at level 12
  and headed Google Chrome for Testing Stable 151.0.7922.138. The successful
  workflow was [run 31572966118](https://github.com/BjoernSchotte/atlcli/actions/runs/31572966118).

Chrome 139 removed `--disable-extensions-except` from official branded Chrome
builds, so ordinary Google Chrome Stable 151 could not load the unpacked build
for automation. The final Windows lane resolves Google's official Chrome for
Testing Stable artifact, records its URL and archive hash, and runs the same
production MV3 output. Chrome documents both the [branded-build flag
change](https://developer.chrome.com/docs/extensions/whats-new#chrome-139) and
[Chrome for Testing as the reproducible automation distribution](https://developer.chrome.com/blog/chrome-for-testing/).

## Expected and actual results

| Requirement | VoiceOver + Chrome actual | NVDA + Chrome actual |
| --- | --- | --- |
| Dialog label | `atlcli-Aktionen` | `atlcli actions` |
| Result count | `8 Aktionen verfügbar` exposed after the delayed live-region mutation | `8 actions available` present in the NVDA speech log |
| Groups | Export, AI, Navigation | Export, AI, Navigation present in the speech log |
| Initial active option | PDF selected | `Export current page as PDF` spoken and selected |
| Arrow navigation | Down Arrow selected DOCX | `Export current page as DOCX` spoken and selected |
| Unavailable reason | Selected disabled PDF exposed the complete host-capability reason | Complete host-capability reason present in the speech log |
| Execution status | Failed state announced in German; the semantic walkthrough also covered the input panel | Queued, failed, and completed states present in the speech log |
| Escape hierarchy | Result to root, input to root, non-empty query cleared, empty root closed | All four levels asserted by the production/instrumented lanes |
| Returned host focus | `Return focus target` regained focus | `return focus target` present in the speech log and `host-button` active |

Every expected value was observed. The VoiceOver result-count rerun enabled
VoiceOver before closing and reopening the palette with the real `Shift+Cmd+K`
command. The final accessibility tree contained the distinct live-region text
`8 Aktionen verfügbar`, and the selected PDF option owned focus.

## Regression found by screen-reader proof

The first Windows run proved that the initial result count was not spoken: the
live region mounted with its final text, so assistive technology saw no
post-mount change. Commit `55001ec5` mounts it empty and publishes the count
after the bounded throttle interval. Its regression test asserts an empty
initial region and `3 actions available` after 140 ms. Both VoiceOver and NVDA
were re-proved after that fix.

## Windows receipt

The successful receipt records:

- source `f07dae16cfaceb5849b6637f2b30c4aab7fb14a1`;
- Chrome for Testing archive SHA-256
  `864a03252382fcfaf0475a1d7cad30b99cb54883060dcb5526249f4ca08aa03a`;
- official NVDA installer SHA-256
  `6e0289eb5a3aa076eb97ea99c5d5465cb48b5ecc6a3257dc3d811f881a1747c9`;
- all expected speech fragments and seven screenshot hashes;
- a production lane for dialog, groups, navigation, failed/queued status,
  Escape, and focus return;
- an isolated copied-build lane only for the missing-capability projection and
  a completed host result, with `productionFilesModified: false`.

The official [NVDA user guide](https://download.nvaccess.org/documentation/userGuide.html)
defines the portable command-line mode and input/output log level used by the
workflow. The installer version and checksum match the [NVDA 2026.1.1 release](https://www.nvaccess.org/post/nvda-2026-1-1/).

## Screenshot boundary

The VoiceOver screenshots are named:

- `ap09-voiceover-root.png`
- `ap09-voiceover-arrow-navigation.png`
- `ap09-voiceover-execution-status.png`
- `ap09-voiceover-unavailable-reason.png`
- `ap09-voiceover-focus-return.png`
- `ap09-voiceover-result-count-after-fix.png`

The final Windows artifact contains:

- `ap09-nvda-root.png`
- `ap09-nvda-arrow-navigation.png`
- `ap09-nvda-failed.png`
- `ap09-nvda-queued.png`
- `ap09-nvda-unavailable-reason.png`
- `ap09-nvda-completed.png`
- `ap09-nvda-focus-return.png`
- `ap09-nvda-receipt.json`

All files were displayed in the task and intentionally not committed.
