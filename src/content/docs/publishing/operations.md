---
title: "Web publishing operations"
description: "Refresh, build, verify, retain, and roll back static publications"
---

# Web publishing operations

The local workspace is the operational source of truth for a publication. A
successful build is a candidate; only verification establishes a publishable
artifact, and no command claims remote deployment.

## Refresh safely

1. Run `plan` and inspect route, deletion, completeness, and issue changes.
2. Resolve permission/version problems or explicitly acknowledge a partial plan.
3. Run `refresh` to materialize assets and activate the new immutable bundle.
4. Keep the previous bundle until the new build and verification are proven.

Activation is fenced by the expected active bundle digest. A stale concurrent
refresh fails instead of replacing a newer candidate.

## Build and verify

```bash
atlcli wiki publish build --project .atlcli/publish.json
atlcli wiki publish verify --project .atlcli/publish.json
```

Astro output and its private inventory are staged under sibling paths. Build or
verification failure restores the previous output byte-for-byte. Verification
checks the manifest, output ownership, file hashes, links, anchors, assets,
Pagefind, SEO, CSP, analytics, edit-link origins, and private URL markers.

## Rollback

Rollback is a local pointer operation: select the previous retained bundle/build
after reviewing its digest and verify it again before serving it. Never copy a
partially written directory over the active output and never delete by title or
glob.

## Retention and cleanup

```bash
atlcli wiki publish status --project .atlcli/publish.json
atlcli wiki publish prune --project .atlcli/publish.json --confirm
```

`prune` removes only verified unreachable bundles/builds within the configured
retention window. Keep the project file, active pointer, and last valid build
until an operator has confirmed the replacement.

## Reproducibility

The bundle digest, project/config/lockfile digests, experience digest, search
digest, SEO digest, and per-output SHA-256 values are recorded in the private
`StaticPublicationManifestV1`. Pagefind physical filenames may vary between
tool versions; semantic manifests and the exact candidate inventory are both
retained so a deployment can bind to the artifact actually verified.

## Related topics

- [Publishing guide](./index.md)
- [Configuration](./configuration.md)
- [Security and privacy](./security.md)
- [Troubleshooting](./troubleshooting.md)
