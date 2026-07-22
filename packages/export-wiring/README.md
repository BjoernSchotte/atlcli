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
| Background export orchestration | `@atlcli/export-wiring/jobs`: ordered checkpoint pipeline and bounded asset streaming |
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

## Related

- `@atlcli/export-macros` — the pure registry/resolver this wires up (zero
  `@atlcli/*` runtime imports; that is why the wiring cannot live there).
- `@atlcli/confluence`, `@atlcli/docx`, `@atlcli/pdf`.
