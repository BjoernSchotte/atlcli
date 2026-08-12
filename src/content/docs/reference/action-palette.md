---
title: "Atlassian action palette"
description: "Open contextual Kiteweave actions from Confluence or Jira without leaving the current page"
---

# Atlassian action palette

The action palette is a keyboard-first overlay for fast work on Atlassian
Cloud pages. Search the actions available for the current Confluence or Jira
context, move with the arrow keys, and run the selected action without first
opening the full side panel.

The palette complements the side panel; it does not replace it. Long-running
exports continue in **Activity**, detailed publishing setup stays in
**Publishing**, and AI conversations can continue in **Research**.

## On this page

- [Prerequisites](#prerequisites)
- [Open and use the palette](#open-and-use-the-palette)
- [Configure the browser shortcut](#configure-the-browser-shortcut)
- [Available actions](#available-actions)
- [Quick AI](#quick-ai)
- [Extension and Forge behavior](#extension-and-forge-behavior)
- [Permissions and privacy](#permissions-and-privacy)
- [Action contribution contract](#action-contribution-contract)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)
- [Feedback and edits](#feedback-and-edits)

## Prerequisites

Choose one of these hosts:

- **Browser extension:** Chrome 140 or newer, the atlcli extension installed,
  and an authenticated `*.atlassian.net` tab. The palette supports Confluence
  and Jira Cloud contexts.
- **Kiteweave Forge app:** the app installed in the current Confluence Cloud
  site. This MVP supplies Confluence PDF and DOCX modal actions only.

Atlassian Data Center is outside the extension and Forge host permissions. Use
the [CLI export workflow](/confluence/export/) there.

## Open and use the palette

### UI-first path

In the browser extension:

1. Open a Confluence page or Jira issue.
2. Press `Ctrl+Shift+K` on Windows/Linux or `Command+Shift+K` on macOS. This is
   the default assignment; Chrome may report another assignment or no
   assignment after installation.
3. Type part of an action name or one of its keywords.
4. Use `ArrowDown` and `ArrowUp` to move through results.
5. Press `Enter` to run the active action. An action that needs input opens its
   form first.
6. Press `Escape` to leave a form, close the palette, or return focus to the
   Atlassian page, depending on the current level.

In the Forge app:

1. Open a Confluence page.
2. Choose **Kiteweave Actions** from the page action menu, or press `mod+k`
   (`Command+K` on macOS, `Ctrl+K` elsewhere) when Atlassian has assigned the
   declared accelerator.
3. Search, navigate, and select **Export as PDF** or **Export as DOCX**.
4. Complete the existing Forge export modal.

The search field receives focus when the palette opens. Unavailable actions
remain discoverable with a reason instead of disappearing. `Tab` stays inside
the open dialog; pointer selection and outside-click dismissal are also
supported.

### Keyboard reference

| Key | Result |
| --- | --- |
| `ArrowDown` / `ArrowUp` | Move the active result, wrapping at the ends |
| `Enter` | Open the active action or submit a valid action form |
| `Tab` / `Shift+Tab` | Move within the open dialog |
| `Escape` | Close the deepest open level, then the palette; restore host focus |
| Configured extension shortcut | Toggle the extension palette |

## Configure the browser shortcut

Chrome owns extension shortcut assignment. Kiteweave displays the assignment
reported by `chrome.commands`; it does not claim that a suggested key was
accepted.

### From the extension UI

1. Open the side panel and select **Settings**.
2. Find **Action palette shortcut**.
3. Select **Open Chrome shortcut settings**.
4. Assign an available key combination to **Open the Atlassian action
   palette**.
5. Return to an Atlassian tab and try the new shortcut.

### Direct Chrome path

Open `chrome://extensions/shortcuts`, find **atlcli**, and edit the action
palette assignment. Chrome can leave the command unbound or reject a chord
reserved by the browser or operating system. The Settings screen and palette
footer show the effective assignment.

Avoid assigning `Command+K` / `Ctrl+K` to the extension when the Forge app is
also installed: Forge declares `mod+k`, so the two hosts could compete for the
same gesture. The extension's suggested shifted chord avoids that collision.

## Available actions

The exact catalog depends on the host, page, current entity, and available
capabilities.

| Action | Extension on Confluence | Extension on Jira | Forge on Confluence |
| --- | --- | --- | --- |
| Export current page as PDF | Queues a durable browser export | Unavailable with reason | Opens the existing PDF modal |
| Export current page as DOCX | Queues when a template resolves; otherwise opens Publishing | Unavailable with reason | Opens the existing DOCX modal |
| Configure DOCX export | Opens Publishing | Available as navigation | Not included |
| Ask AI about this page or issue | Available after provider/context checks | Available after provider/context checks | Not included |
| Open sidebar / Publishing / Research / Activity | Available | Available | Not included |

Browser exports use the same durable queue as the side panel. Closing the
palette after submission does not cancel the job. Open **Activity** to inspect
progress, download a completed artifact, retry, or acknowledge a result.

The side panel remains the right surface for template management, export
scope, PDF document settings, previews, detailed activity, and continued AI
work.

## Quick AI

**Ask AI about this page** is a bounded, single-turn shortcut to the extension's
existing ordinary Chat workflow.

1. Select the action from a Confluence page or Jira issue.
2. Enter a question of 3–2,000 characters.
3. Review and select the disclosure confirming that the current Atlassian
   context is sent to the configured LLM provider.
4. Select **Ask AI**.
5. Read the bounded answer in the palette, cancel/detach if needed, or choose
   the continuation action to open **Research** in the side panel.

Opening the palette, searching, or opening the Quick AI form does not contact
the provider. A provider request begins only after an explicit valid submit.
The extension revalidates the active tab and context before execution. A
changed or stale page fails closed rather than sending the previous context.

Quick AI requires an Anthropic key configured in extension **Settings**. The
Forge palette has no AI action in this release.

## Extension and Forge behavior

The two hosts share serializable action definitions and the React presenter,
but each host remains authoritative for context, permissions, and execution.

| Area | Browser extension | Forge app |
| --- | --- | --- |
| Product scope | Confluence and Jira Cloud | Confluence Cloud only |
| Open path | Configurable Chrome extension command | **Kiteweave Actions** content action; static `mod+k` declaration |
| PDF/DOCX | Durable local extension export jobs | Delegates to existing Forge modals |
| Quick AI | Yes, explicit submit only | No |
| Sidebar continuation | Publishing, Research, Activity, main sidebar | No browser-extension sidebar integration |
| Runtime | Bundled MV3 code | Bundled Forge Custom UI code |

Installing both does not merge their execution runtimes. The extension overlay
executes extension actions; the Forge content action executes Forge actions.
Their shared contracts keep labels, keyboard behavior, and result semantics
consistent without giving either host authority over the other.

## Permissions and privacy

The action palette adds no broad page-write permission and cannot execute
arbitrary code.

- The content shell runs only in the top frame on `https://*.atlassian.net/*`.
  The background worker derives the tab, site, product, and entity from the
  actual sender and revalidates them before execution.
- Extension PDF/DOCX compilation and persistence remain browser-local. Network
  access for exports is limited to the Atlassian site and Atlassian media CDN.
- `api.anthropic.com` host access is used only for the configured AI workflow.
  The Quick AI form requires an explicit disclosure and submit before a call.
- The palette catalog and durable action receipts exclude tenant IDs, entity
  content, prompts, credentials, and provider responses. AI answer text is an
  ephemeral presentation, never injected as HTML.
- The MV3 content security policy permits packaged scripts and the bundled
  WASM compiler; it forbids remote code, inline code, `eval`, and
  string-to-code constructors.
- The Forge palette has no resolver, function, remote, storage, service, AI,
  or external egress. It can open only the two allowlisted export modals.

See [Browser extension: Where your data goes](/extension/#where-your-data-goes)
and [Jira and Confluence Research: Security boundaries](/reference/research/#security-boundaries)
for the underlying workflows.

## Action contribution contract

`ActionModuleV1` is the shared, serializable build-time contribution seam. A
module declares stable action IDs, localized text keys and fallbacks, search
keywords, group and icon tokens, a typed intent, context/capability
requirements, effect classification, and an optional bounded input schema.

The definition is not executable code. Every host must separately register an
exact intent executor, advertise the required capability, validate the module,
derive authoritative context, and allowlist execution. Unknown intents,
duplicate IDs, invalid fields, missing capabilities, and stale context fail
closed.

In this MVP, modules are imported into the source tree and bundled at build
time. Adding one therefore requires a reviewed source change, tests, a new
extension or Forge build, and the relevant store/deployment process.

:::caution[Runtime plugins are not supported]
The action palette does not load user-uploaded ZIP files, TypeScript source,
JavaScript, remote modules, or CLI plugins at runtime. Installing a CLI plugin
does not add browser or Forge palette actions. A future runtime extension model
needs a separate MV3/Chrome Web Store security and policy design; it is not
part of this release.
:::

## Examples

### Minimal: export the current Confluence page

1. Open a published Confluence page.
2. Open the extension palette with its displayed shortcut.
3. Type `pdf`, keep **Export current page as PDF** active, and press `Enter`.
4. Close the palette and continue working.
5. Open the palette again, type `activity`, and open **Activity** to retrieve
   the durable result.

### Realistic: ask about a Jira issue, then continue in the sidebar

1. Open the Jira issue and invoke the extension palette.
2. Search for `ask`, open **Ask AI about this page**, and enter a non-sensitive
   question.
3. Confirm the provider disclosure and submit.
4. Review the answer, then choose the continuation action to open **Research**.
5. Continue in the side panel without creating a duplicate conversation.

### Forge fallback when the shortcut is unavailable

1. Open a Confluence page.
2. Open the page action menu and choose **Kiteweave Actions**.
3. Select **Export as DOCX** and complete the unchanged DOCX modal.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The extension shortcut does nothing | Chrome left it unbound, another command owns it, or the active page is outside `*.atlassian.net` | Open extension **Settings**, inspect the effective assignment, then use `chrome://extensions/shortcuts` |
| `Command+K` / `Ctrl+K` opens another UI | The browser, Atlassian, or Forge owns that chord | Keep the extension on its shifted default or assign another available chord |
| An export appears but cannot run | The active entity is Jira, not a current Confluence page | Read the unavailable reason or open the intended Confluence page |
| DOCX opens Publishing instead of queuing | No valid template resolved, or template storage could not be read | Select or upload a template in **Publishing**, then retry |
| Quick AI says it is unavailable | No supported current page/issue or no configured provider credential | Open a Confluence page or Jira issue and configure the Anthropic key in **Settings** |
| Quick AI fails after navigation | The authoritative context changed before submit | Reopen the palette on the intended entity; stale context is intentionally rejected |
| Forge has no AI or Jira actions | Those capabilities are outside the Forge MVP | Use the browser extension for Jira and Quick AI |
| Search results look outdated after SPA navigation | The tab context changed while the palette was open | Close and reopen the palette; if it persists, reload the extension and tab |
| Focus does not return where expected | The original Atlassian control disappeared during navigation | Focus returns to the nearest valid host target; reopen the intended menu/control and retry |

## Related topics

- [Browser extension](/extension/) — installation, host permissions, limits,
  and side-panel capabilities
- [Exporting from the panel](/extension/export/) — detailed PDF/DOCX workflow
- [Jira and Confluence Research](/reference/research/) — Chat, Research, and AI
  security boundaries
- [Export Jobs & Operations](/reference/export-jobs/) — durable queue,
  recovery, retention, and diagnostics
- [Using CLI plugins](/plugins/using-plugins/) — the separate CLI plugin system

## Feedback and edits

Use the page's **Edit this page** link to propose a documentation correction,
or [open a GitHub issue](https://github.com/BjoernSchotte/atlcli/issues) for a
palette bug or feature request. Include the host (extension or Forge), Chrome
version, operating system, Atlassian product, displayed shortcut, and the exact
unavailable/error reason. Do not include tenant URLs, page content, prompts, or
credentials.
