# @atlcli/export-wiring

Host wiring for Confluence/Jira exports: the adapters that turn a REST **client**
into the inputs `@atlcli/docx` and `@atlcli/pdf` accept.

Isomorphic — it builds for `--target=browser` with zero `node:`/`bun:`
specifiers (enforced by `scripts/check-browser-build.ts`), so the CLI, the
Chrome extension, and any future shell share one implementation instead of one
each.

## What it provides

| Area | Exports |
|---|---|
| Macro ports | `confluenceContentPortFromClient`, `exportViewPortFromClient`, `attachmentLookupFromClient`, `jiraIssuePortFromClient`, `classifyClientError` |
| Asset security boundary | `createExternalAssetPolicy`, `createExternalAssetFetcher`, `defaultExternalAssetPolicy`, `defaultExternalAssetFetcher`, `isPrivateHost`, `parseIpv6` |
| Sink-side trust routing | `trustRoutingAssetFetcher`, `trustRoutingPdfAssetResolver` |
| Resolution options | `buildMacroResolutionOptions`, `createMacroRegistry` |
| Background export orchestration | `@atlcli/export-wiring/jobs`: ordered checkpoint pipeline, bounded asset streaming, and separate host-neutral TypeScript DOCX/PDF job executors |
| Parity contract | `@atlcli/export-wiring/fixtures` |

## Minimal example

```ts
import { ConfluenceClient } from "@atlcli/confluence";
import { buildMacroResolutionOptions } from "@atlcli/export-wiring";

const confluence = new ConfluenceClient(profile);
const macros = buildMacroResolutionOptions({
  siteBaseUrl: profile.baseUrl,
  confluence,
  targetEngine: "docx",
});
```

## Realistic example — a host with its own origin allowlist

```ts
import {
  buildMacroResolutionOptions,
  createExternalAssetFetcher,
  createExternalAssetPolicy,
  trustRoutingAssetFetcher,
  trustRoutingPdfAssetResolver,
} from "@atlcli/export-wiring";

// The shared policy allows the site origin and nothing else. A host widens it
// explicitly — never by inheriting a default it did not ask for.
const policy = createExternalAssetPolicy({
  siteOrigin: profile.baseUrl,
  allowedOrigins: ["https://api.media.atlassian.com"],
});
const externalAssets = createExternalAssetFetcher(policy);

const macros = buildMacroResolutionOptions({
  siteBaseUrl: profile.baseUrl,
  confluence,
  jira,
  targetEngine: "pdf",
  policy,
  externalAssets,
});

// REQUIRED whenever `macros` is present: macro-rendered HTML emits image URLs
// that reach the ENGINE's asset seam, not the macro renderer's fetcher.
const assets = trustRoutingPdfAssetResolver(hostResolver, externalAssets);
```

## The rule that is easy to forget

If an engine env carries `macros`, its asset seam **must** be wrapped in
`trustRoutingAssetFetcher` (DOCX) or `trustRoutingPdfAssetResolver` (PDF).
Otherwise `<img src="http://169.254.169.254/…">` inside third-party
`export_view` HTML is fetched by the host's own credentialed fetcher.

`assertPolicyRoutedPdfAssets` in `@atlcli/export-wiring/fixtures` is the
executable form of that rule; call it from the host's own test against the real
env it builds.

## Background PDF execution

`createPdfExportJobExecutor` does not own credentials, persistence, or a UI. A
host supplies source resolution, an opaque ready-to-render store, the Typst
compiler transport, one heavy-render reservation, and report storage. The
executor persists preparation before rendering, materializes the compiler
bundle only after admission, captures the PDF instead of downloading it, and
returns a staged artifact for the outer fenced job runtime to finalize.

Admission happens before the Typst VFS is built. The reservation then reconciles
the actual prepared and output byte counts. The checkpoint binds the materialized
payload by byte length and SHA-256, and the result store journals artifact plus
report as one recoverable execution result before the executor returns.

The ready-to-render store must atomically fence `beginRenderAttempt` by job and
lease epoch. One initial render plus one recovery render are allowed; source and
asset preparation are not repeated after a compiler-worker loss.

## Background TypeScript DOCX execution

`createTypescriptDocxExportJobExecutor` applies the same durable lifecycle to
the browser-safe `@atlcli/docx` engine without combining the two format
contracts. The host resolves a structural engine input, a pinned template
`recordKey` plus SHA-256, durable ready-to-render state, one cross-format heavy
reservation, and a crash-recoverable result store. The executor never resolves
an active-template alias and never imports or falls back to the deprecated
Python exporter.

Admission happens before template bytes are materialized and before PizZip,
asset fetch/decode, rasterization, or archive generation starts. Template,
prepared payload, estimate, request, artifact, and report identities are bound
by hashes. The final DOCX byte array is borrowed only until result staging has
consumed it; delivery remains a later host operation.

The ready store must return a fresh prepared-state clone for every render
attempt and fence the atomic attempt increment by job and lease epoch. A
partially mutated archive is never replayed. One initial render plus one
recovery render are allowed, and an uncertain staged-result return recovers in
O(1) from metadata without reading or copying artifact bytes.

## Related

- `@atlcli/export-macros` — the pure registry/resolver this wires up (zero
  `@atlcli/*` runtime imports; that is why the wiring cannot live there).
- `@atlcli/confluence`, `@atlcli/docx`, `@atlcli/pdf`.
