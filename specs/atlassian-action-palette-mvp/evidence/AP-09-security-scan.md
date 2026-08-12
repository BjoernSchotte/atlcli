# AP-09 staged and built-output security scan

**Status:** COMPLETE

**Date:** 2026-08-12

**Scanned source commit:** `fb6efcbc3dc716590f6b63afdac95f15cfca7098`

**Comparison base:** `0adae61967e9c48589fe22a4404e91c748aa4b46`

The scan covers the complete action-palette branch delta, the production WXT
output rebuilt from the scanned source, and the exact staged documentation
update that closes this gate. It records counts and classifications only; no
credential value, tenant URL, page content, prompt, or customer artifact is
copied into this receipt.

## Source and staged-diff scan

The branch delta contains 108 files. File-name and content scans found:

- zero tracked PDF, DOCX, ZIP, CRX, PNG/JPEG/GIF/WebP, HAR, trace, or log
  artifacts;
- zero `.env`, private-key, certificate, credential, secret, download, or
  artifact paths;
- zero private-key blocks or AWS, Google, Slack, Anthropic, or generic OpenAI
  token signatures;
- zero occurrences of the disposable AP-09 tenant URL, page ID/title, issue
  key, or account marker used during the preflight that was subsequently
  cleaned up;
- a clean `git diff --check` result.

After staging only this receipt and the PLAN checkbox, the same artifact,
credential, secret-signature, tenant-marker, and whitespace checks were run
against the exact Git index and all returned zero findings.

## Production-output scan

The extension was rebuilt before scanning:

```bash
bun run --cwd apps/extension build
bun run check:extension-output
bun run test apps/extension/tests/manifest.test.ts
```

The production directory contains 471 files (approximately 60 MiB). Its
manifest SHA-256 is
`9ad7e7092ee258002b733d8f4e47061d5adbf29d84087ad228184f791721af25`.
The output scanner reported the build CSP-safe and complete. Its negative
fixtures cover executable remote imports, `importScripts`, remote script
origins, Node built-ins, `Function`/`new Function`, and direct `eval`. A
separate built-output signature scan found zero private-key or provider-token
signatures and zero disposable tenant/resource markers.

## Manifest and permission audit

All 17 built-manifest assertions passed. The emitted extension remains MV3 and
declares exactly:

- permissions: `sidePanel`, `offscreen`, `storage`, and `tabs`;
- host permissions: Atlassian Cloud, the existing Atlassian media CDN, and the
  existing Anthropic API origin;
- no optional permissions or optional host permissions;
- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`;
- one top-frame isolated Atlassian action-palette content script;
- one approved action-palette command using the distinct fallback chord;
- only the lazy `action-palette.html` frame plus WXT's generated content-style
  resource exposed to Atlassian pages.

The branch diff adds the command and lazy web-accessible palette frame but does
not modify either permission array or either host-permission array. Negative
manifest tests reject remote script/object origins and plain `unsafe-eval`.
No unexpected permission, origin, CSP source, remotely hosted code path, or
runtime plugin loader is present.

## Artifact boundary

All LIVE screenshots, downloaded receipts, and generated proof files remain in
the task visualization directory outside both Git repositories. They are not
part of this branch, the staged index, or the production extension output.
