# AP-09 live extension and Forge acceptance evidence

**Status:** COMPLETE

**Date:** 2026-08-12

**Extension live source:** `b37dcbe80b1b8c53de3b205c332e2e29e3b6d54e`

**Final extension lifecycle source:** `028790b7d5e9c18cfbe431f9b24d0e25d80fc35e`

**Forge source:** `7aef95a98249fa777357cc0cb077106abd1979fc`

## Evidence boundary

The tenant runs used only the required `mayflower` profile, disposable resources
in Confluence space `DOCSY` and Jira project `ATLCLI`, and the Forge development
installation. This receipt intentionally excludes tenant origins, entity IDs,
resource titles, page or issue bodies, prompts, credentials, downloaded bytes,
and screenshots. The screenshots and generated PDF/DOCX artifacts were delivered
to the operator outside Git and were not committed.

The extension tenant acceptance ran on the production WXT output at the recorded
live source. The final lifecycle commit only changes close/reconnect timing: it
awaits removal of the old frame transport and prewarms a new hidden transport.
That final source is separately covered by the complete root suite, output scan,
and copied-production-output Chromium suite in `AP-09-quality.md`.

## Extension acceptance

- The production WXT directory was loaded through Chrome's unpacked-extension
  mechanism in Chrome Stable. This was not represented as a signed CRX.
- Chrome displayed the installed `Command+Shift+K` binding. A physical macOS
  key event opened the palette on a disposable Confluence page, focused search,
  and showed the current Confluence context. Reopen and Escape/focus behavior
  were exercised without duplicate or blank palettes.
- Selecting **Export current page as PDF** queued the existing durable export
  path. Activity reached the terminal `Fertig` state with one artifact, zero
  warnings, zero retries, and zero resumes after the palette was closed.
- Selecting **Export current page as DOCX** with a valid disposable template
  queued the existing durable DOCX path. Activity reached the terminal `Fertig`
  state with one artifact, zero warnings, zero retries, and zero resumes.
- Quick AI performed no work before explicit submit in the automated ratchet.
  In the live extension, `Command+Enter` was rejected while the disclosure was
  unchecked. After disclosure was checked, the same explicit submit reached the
  authoritative provider gate and failed closed because the isolated temporary
  extension intentionally had no provider credential. No credential was copied
  from the operator's installed extension, and this receipt does not claim a
  live provider response. The provider-backed streaming/cancel contract remains
  covered by AP-07's synthetic production-runtime harness.
- With a fresh execution lease, **Continue in Research** opened the existing
  sidebar Research screen with the current-page context. A deliberately stale
  lease was rejected before the fresh successful handoff.
- On the disposable Jira issue, the palette displayed Jira issue context. A
  Confluence-only PDF action remained discoverable, carried product/entity
  unavailability reasons, did not execute on `Enter`, and did not break arrow
  navigation.
- The temporary MVP extension was removed, the operator's original extension
  was re-enabled from its original source, and only the three temporary Chrome
  windows created for the probe were closed.

## Artifact inspection

| Artifact | Size | SHA-256 | Inspection result |
| --- | ---: | --- | --- |
| PDF | 44,692 bytes | `08bb08637baa8d493b070c83e58a23c6ba4ce979bbc921dd53c8a2b8e25f53ce` | PDF 1.7, four A4 pages, tagged, unencrypted, no JavaScript, produced by the pinned Typst runtime |
| DOCX | 58,709 bytes | `7bc75d72a79cf0c2f4a0635034b13975d42fd7d8e44cbc21b162c080809058db` | Valid OOXML; all 30 ZIP entries passed integrity checking and the expected PNG media part was present |

These hashes identify external proof artifacts only; the files are not part of
the repository.

## Forge development acceptance

- `forge install list` showed the development installation at app version 3 as
  up to date. A pre-existing production installation was observed but was not
  modified, deployed, upgraded, or invoked for this proof.
- A disposable `DOCSY` page carrying an ownership marker was created through the
  Confluence UI. **Kiteweave Actions (Development)** opened the palette with the
  current Confluence page and exactly the PDF and DOCX actions.
- Keyboard navigation and `Enter` opened the existing PDF modal and, after
  returning, the existing DOCX modal. Both modals retained their established
  engine/setup screens and the disposable page context. The palette did not
  bundle or execute an export engine.
- The static `mod+k` accelerator was exercised while the palette was open and
  did not produce a duplicate palette or modal. Menu access remained available.
- No **Generate** action was invoked, so the Forge run created no attachment.
  The disposable page was moved to trash through the UI and disappeared from
  the page tree.
- On the exact Forge source above, `bun run check` passed typecheck, build,
  output, cost-invariant, and pinned-atlcli verification gates. `forge lint`
  reported `No issues found`. The Forge worktree remained clean.

## Cleanup receipt

The extension cleanup helper revalidated ownership markers before deletion and
reported no failures. It deleted the tracked disposable Confluence page and Jira
issue; direct UI verification then showed both resources unavailable. The Forge
page was separately moved to trash and had no generated attachments. No retained
customer resource was changed.

## Acceptance conclusion

The live tenant paths prove the configured extension shortcut, durable PDF and
DOCX submission plus real artifacts, Activity completion, explicit Quick-AI
privacy/provider gates, Research continuation, Jira-aware unavailability, and
Forge development modal delegation. Successful provider streaming is not
claimed as a live-tenant result; its bounded behavior is an automated AP-07
gate, while this AP-09 run proves the explicit live submit and fail-closed path.
