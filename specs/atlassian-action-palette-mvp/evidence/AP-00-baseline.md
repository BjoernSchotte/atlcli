# AP-00 baseline and platform-feasibility evidence

**Captured:** 2026-08-11

**atlcli reviewed HEAD:** `b50979bffad9a04c610c7d0c587f29189ad765c0`

**atlcli planned source baseline:** `0adae61967e9c48589fe22a4404e91c748aa4b46`

**Forge reviewed baseline:** `f520e66f8f1fdd02f94a82e771553464d86deb14`

## Gate verdicts

| Gate | Verdict | Evidence and enforced consequence |
| --- | --- | --- |
| Extension `Cmd/Ctrl+K` | **GO WITH FALLBACK — approved 2026-08-11** | Chrome Stable assigned and delivered `Command+K` on macOS, but left `Ctrl+K` unbound on Linux. After an explicit Chrome shortcut remap, `Ctrl+Shift+K` was delivered. The operator therefore approved `Ctrl+Shift+K`, which Chrome maps to `Command+Shift+K` on macOS, as the shipped extension default. The UI must display the actual value returned by `chrome.commands.getAll()` and explain how to remap it. |
| Extension side-panel handoff | **GO** | A trusted click in a top-frame Atlassian content script sent a bounded message. The background called `chrome.sidePanel.open({ tabId })` synchronously inside the message listener, before any `await`, and both the response receipt and `chrome.sidePanel.onOpened` named `/sidepanel.html`. The final broker must preserve this gesture-sensitive ordering. |
| Forge `mod+k` | **GO WITH STATIC SEPARATION** | On a real Confluence Cloud development installation, `mod+k` opened exactly one content-action palette and menu access remained available. With the extension fallback above, Forge may retain `mod+k`; the extension uses `mod+shift+k`, so the shipped manifests are statically distinct. No install detection or cross-product broker is permitted. |
| Forge PDF/DOCX delegation | **GO** | The content-action palette opened the existing named PDF and DOCX modal resources with the current synthetic page context. Closing the nested export modal returned focus to the palette iframe. Closing the outer content action returned control to Confluence. The host creates a nested modal rather than replacing the palette; the final Forge adapter must retain this tested behavior and must not implement an export engine. |

## Repository drift

The Section 7 drift commands were run before implementation. There is no relevant diff from `0adae619` to the atlcli feature-branch HEAD in the planned plugin API, entity URL parser, extension ports/screens/app/entrypoints, or manifest boundaries. There is no relevant diff from `f520e66` in the Forge manifest, package pins, verification/cost scripts, or export app. The Forge worktree contains a pre-existing untracked `design/` directory; it was not read as product input, changed, staged, or removed.

The authoritative seams named in the plan therefore still apply. No command protocol, screen registry, export request owner, research port, Forge named entry, or cost invariant drifted in a way that requires the plan to be redesigned.

## Reproducible extension baseline

Dependencies were installed with `bun install`. The required focused baseline command passed with **75 passing, 0 failing** tests:

```bash
bun run test \
  apps/extension/tests/app-portability.test.tsx \
  apps/extension/tests/app-shell-layout.test.tsx \
  apps/extension/tests/screens.test.ts \
  apps/extension/tests/i18n.test.ts \
  apps/extension/tests/rovo-visibility.test.ts
```

The same focused suite was repeated after deleting all spike code and creating this evidence file: **75 passing, 0 failing**. The repository-wide `bun run typecheck` gate also completed successfully, including the extension, browser PDF compiler, and browser export harness scopes.

The clean production build and Chrome Web Store upload archive were reproduced after all spike code had been removed:

```text
WXT 0.20.27; Vite 8.1.4
production chrome-mv3 output: 61.59 MB reported by WXT (61,096 KiB on disk)
WXT upload ZIP: 21,314,757 bytes
manifest.json: 684 bytes; SHA-256 2d3cedce9a9a82977f25a285987cd37579665eb8987cd327b01bbb5d90b006c0
background.js: 63,739 bytes; SHA-256 62e71cc2e85d3099f2e9d5db0e733fb1d978759dadc0e53f2fcb67a2be9d904b
upload ZIP SHA-256: 075ba97094aae803c7f6ee22d538479ef1a49d8351568037c34f32af0315ff2d
```

`bun run --cwd apps/extension build` and `bunx wxt zip` both completed successfully. The runtime spike used a production WXT build output loaded with Chrome's supported `Extensions.loadUnpacked` development API. It was not installed as a `.crx`, so this evidence deliberately does not call the live runtime a packed CRX. The exact production output was also archived as the WXT ZIP above, which is the artifact used for upload/distribution review.

## Chrome Stable command probe

### macOS

- Browser: Google Chrome Stable `151.0.7922.77`.
- Host: macOS `26.4` (`25E246`), arm64.
- Policy context: `chrome://management` reported that the browser was not managed.
- Shortcut UI: `chrome://extensions/shortcuts` displayed `Command+K` for the disposable command.
- Input provenance: an OS-level AppleScript key event sent `Command+K`; renderer `keyboard.press()` was not used as command evidence.
- `chrome.commands.getAll()` returned `Command+K`.
- Five fresh disposable profiles passed. In every run, the MV3 worker target was absent before the first key, the OS key woke the worker and produced the real `commands.onCommand` receipt, and a second warm key produced another receipt.
- A trusted pointer click on the injected Atlassian probe produced both the successful `chrome.sidePanel.open()` response and a matching `sidePanel.onOpened` receipt.

The observed cold receipt values were 834–852 ms and warm values were 734–756 ms. Each includes an intentional 500 ms AppleScript delay and polling overhead, so these values prove the harness boundary and cold-worker wakeup only; they are not palette performance results and are not compared with the Section 2 budgets.

### Linux

- Browser: Google Chrome Stable `151.0.7922.108`, x86-64, in an amd64 Linux container with Xvfb/Openbox.
- Input provenance: real X11 key events through `xdotool`; renderer `keyboard.press()` was not used.
- The manifest suggestion `Ctrl+K` produced an empty shortcut in `chrome.commands.getAll()`.
- A real `Ctrl+K` event produced no command receipt during a five-second observation window.
- The binding was changed to `Ctrl+Shift+K` through Chrome's internal shortcut-setting delegate, the same delegate used by `chrome://extensions/shortcuts`.
- `chrome.commands.getAll()` then returned `Ctrl+Shift+K`, and a real `xdotool` `ctrl+shift+k` produced the expected `commands.onCommand` receipt.

This is an assignment failure, not a content-script keyboard conflict. The product must therefore treat `chrome.commands.getAll()` as authoritative and must not promise that the desired `Ctrl+K` suggestion is always installed.

## Forge development-installation probe

The disposable manifest added one Confluence content action backed by the existing lightweight macro resource and suggested `mod+k`. It added no scope, external origin, function, remote, storage, Jira module, AI capability, or export engine.

Pre-deployment checks:

- Forge app tests: **69 passing, 0 failing**.
- TypeScript: passed.
- Cost invariants: `COST_INVARIANTS_OK browser-only Custom UI`.
- Forge lint: no manifest issues; the development deployment explicitly acknowledged the existing major-version scope rule.
- The repository's broader `check:output` already failed at baseline because its audited inline-Worker carrier count is stale, and `verify:atlcli` points at a different local atlcli checkout/commit. These failures predate and are independent of the AP-00 manifest probe; neither was presented as green evidence.

Live development-installation observations on a retained synthetic Confluence export fixture:

1. **Additional menu action:** the probe appeared under **Further actions → Apps** and opened one medium content-action dialog.
2. **Actual Forge shortcut:** a trusted `Meta+K` browser event opened exactly one palette dialog/iframe. A regular Chrome profile had the atlcli extension installed at the same time; no duplicate surface appeared.
3. **PDF delegation:** the palette's PDF button opened the existing `export-ui/pdf` resource in a second named `Export as PDF` modal. The modal showed the same current synthetic page and reached its normal engine-loading/current-page state.
4. **DOCX delegation:** the DOCX button opened the existing `export-ui/docx` resource in a second named `Export as DOCX` modal. It showed the same current synthetic page, the existing template choices, and the normal ready state.
5. **Close/focus behavior:** closing the inner export modal removed only the format modal and focused the parent palette iframe. Pressing Escape on the outer dialog removed the palette and returned control to the Confluence document. Atlassian returns focus to the host document rather than recreating the removed Apps menu item; AP-08 must test this host-owned limitation rather than promise an unavailable trigger node.
6. **User gesture:** both nested modal opens completed from the trusted action-button click without a bridge rejection.

The probe was then fully cleaned up:

- the temporary Forge manifest and cost-check edits were reverted exactly;
- clean baseline `f520e66` was redeployed to **development only**;
- the temporary development installation was uninstalled;
- a final installation listing showed only the pre-existing production installation;
- the Forge worktree returned to only the untouched `design/` entry.

Production was not deployed, upgraded, or uninstalled.

## Simultaneous-installation decision

The live Forge test showed that `mod+k` opens one Forge palette when the existing extension is also installed. The isolated extension test showed that its reliable cross-platform choice is `mod+shift+k`. The enforceable MVP manifest decision is therefore:

- **Extension:** suggest `Ctrl+Shift+K` (`Command+Shift+K` on macOS), remain user-remappable, and display the actual installed binding.
- **Forge:** retain static `mod+k`, plus content-action menu access.

The manifests will never claim the same accelerator, and the MVP will not add extension-to-Forge discovery. The operator explicitly approved this decision on 2026-08-11.

## Performance harness boundary for later tasks

The AP-00 harness established these measurement rules:

- **Extension cold open:** terminate/observe absence of the MV3 worker, issue the actual OS shortcut, and measure from input dispatch to a content-script `performance.now()` mark after the search input is mounted and focused.
- **Extension warm open:** repeat in the already injected tab with the worker/content script resident; collect at least 30 samples and report p50/p95/max plus raw JSON evidence.
- **Query update:** mark immediately before input mutation and after the ranked DOM/options state commits; run against deterministic 500-action and pure 1,000-action fixtures with no network.
- **Forge:** measure content-action iframe navigation to focused search separately from nested export-modal startup; do not include PDF/DOCX engine readiness in palette-open budgets.
- Record Chrome version, OS/architecture, exact source and manifest hashes, installed shortcut returned by `getAll()`, managed-policy state, cold/warm classification, and input provenance.

No Section 2 performance budget is claimed by AP-00. Those budgets become release gates only after the real palette instrumentation exists.

## Spike cleanup

All disposable extension content-script, background-receipt, command-manifest, and harness files were deleted after evidence collection. `git status --short` in atlcli was clean before this evidence file was created. No alternate action-palette implementation remains for AP-01.
