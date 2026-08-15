# Issue 116: Targeted ADF media pagination

## Outcome

Reduce Confluence v2 attachment requests by discovering the exact attachment
`fileId` values referenced by validated ADF and stopping cursor pagination once
all required IDs are resolved. The implementation remains shared by CLI,
Node/browser package consumers, the browser extension, and the browser export
hosts.

## Contract

1. Add browser-safe `collectAdfMediaFileIds(validated)`:
   - iterative document-order traversal;
   - `media` and `mediaInline` support in every nested location;
   - exact-value, first-seen deduplication;
   - exclude external `media`, which never uses attachment resolution;
   - accept only the bounded `ValidatedAdfDocument` contract.
2. Add targeted attachment pagination:
   - optional stable required-ID collection;
   - keep only matching attachment metadata in targeted mode;
   - retain a separate bounded count of observed valid attachment records;
   - stop before the next cursor request when all IDs are resolved;
   - return unresolved IDs and an explicit termination reason.
3. Preserve legacy full-index callers:
   - `complete` remains true only after natural index exhaustion;
   - early target satisfaction is intentionally not a complete attachment
     index;
   - cursor loops and aborts remain exceptions;
   - result/request caps remain enforced.
4. Preserve export behavior:
   - media-free ADF performs no attachment request;
   - invalid or over-budget ADF performs no attachment request, then remains
     classified by the existing decoder/degradation path;
   - missing IDs still produce `adf-media-unresolved`;
   - no filename matching and no body/filename logging;
   - reuse the validated ADF object transiently when the unchanged source
     object reaches the decoder, while cloned/persisted sources safely
     revalidate.

## Public result semantics

Targeted results distinguish:

- `index-exhausted`: the complete index was observed;
- `required-file-ids-satisfied`: a later cursor existed, but every requested ID
  was found;
- `attachment-limit-reached`: the valid-record budget stopped the scan;
- `request-limit-reached`: the request cap stopped the scan.

Every targeted result includes stable `unresolvedRequiredFileIds`. The existing
`PageAttachmentMediaResult` remains valid for callers that do not request
targeting; the targeted overload adds the explicit result contract.

## Shape verification

| Shape | Evidence gate |
| --- | --- |
| Shared client and ADF contract | focused Confluence validator, decoder, client, and tree tests |
| CLI DOCX/PDF | CLI ADF-source tests plus existing DOCX/PDF regressions |
| Browser package | browser build gate and public API report/closure |
| Browser extension | session-backed ADF-primary tree-source regression and extension typecheck |
| Browser DOCX/PDF harness | browser harness build/output/conformance checks |
| External Node/browser consumers | packed/API consumer checks where available |

## Implementation order

1. Add the validated media-ID collector and tests.
2. Add explicit targeted pagination results, bounds, and guard tests.
3. Wire `getExportPageDetailsWithMedia()` to validated IDs and transient
   validation reuse.
4. Propagate targeted diagnostics through export page/tree metadata.
5. Add extension integration coverage and public package documentation.
6. Regenerate API report/closure and run all shape gates.
7. Run a real `mayflower` / `DOCSY` export E2E, remove created resources, and
   commit the proven change without pushing.

## Unresolved questions

None. Issue 116 and the current shared-host architecture define the required
behavior and ownership boundaries.
