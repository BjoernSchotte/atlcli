# AP-03A cross-repository package handoff

**Status:** COMPLETE

**Date:** 2026-08-11

**Immutable atlcli source SHA:** `bdb4e0a6cf8cf1bb1eeb4d4e0b2b723b0bb3713e`

## Source and build integrity

AP-01 through AP-03 were committed and pushed before this receipt. The final package-boundary correction moved the stylesheet export into `dist/`; the immutable SHA above includes that correction.

The following clean-source check produced no status output before either package was rebuilt:

```bash
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
bun run --cwd packages/action-registry clean
bun run --cwd packages/action-registry build
bun run --cwd packages/action-palette-react clean
bun run --cwd packages/action-palette-react build
```

Observed SHA: `bdb4e0a6cf8cf1bb1eeb4d4e0b2b723b0bb3713e`. Both builds passed from that clean checkout.

## Published development boundaries

| Package | Version | Export | Built target |
| --- | --- | --- | --- |
| `@atlcli/action-registry` | `0.1.0` | `.` | `dist/index.js`, `dist/index.d.ts` |
| `@atlcli/action-palette-react` | `0.1.0` | `.` | `dist/index.js`, `dist/index.d.ts` |
| `@atlcli/action-palette-react` | `0.1.0` | `./styles.css` | `dist/styles.css` |

The presenter declares `react` and `react-dom` as peers at `>=18 <20`. It does not package a React runtime.

`bun pm pack --dry-run` passed after the clean build. It listed 22 files, all under `dist/` plus the generated package manifest, with an unpacked size of 108.91 KB. No tarball was retained or published.

## Chosen development consumption mechanism

AP-08 must use the Forge repository's existing private `file:` model, with these stricter rules:

1. Create or select a dedicated clean detached atlcli checkout at exactly `bdb4e0a6cf8cf1bb1eeb4d4e0b2b723b0bb3713e`; do not use an advancing feature worktree or extension source.
2. Build both package roots from that checkout.
3. Add absolute `file:` dependencies and overrides for `@atlcli/action-registry` and `@atlcli/action-palette-react`, then commit the resulting Forge lockfile on the AP-08 Forge branch.
4. Set Forge `EXPECTED_COMMIT` to this receipt SHA and add `action-registry@0.1.0` plus `action-palette-react@0.1.0` to `EXPECTED_PACKAGES`.
5. Extend the Forge resolver checks for `@atlcli/action-registry`, `@atlcli/action-palette-react`, and `@atlcli/action-palette-react/styles.css`; every one must resolve under the recorded `dist/` roots.
6. Retain Forge's host-owned React `18.3.1`; resolution must not add a second React copy.

A temporary offline consumer proved this mechanism without network access. It resolved registry, presenter, and stylesheet directly to their respective `dist/` files and executed with host React `18.3.1`.

Public package publishing is explicitly outside this implementation. Any registry release or production-consumption change still requires separate release authorization.

## Verification gates

```bash
bun run test packages/action-registry/src packages/action-palette-react/src
bun run typecheck
bun run build
bun run check:browser
```

Results:

- shared package tests: **79 passing, 0 failing**, two snapshots;
- repository typecheck: passed, including Extension, PDF browser compiler, and browser export harness;
- root build: **30 successful build tasks**, including the production WXT extension output;
- browser gate: **34 clean neutral entrypoints**;
- offline file-linked consumer: registry, presenter, and CSS resolved to `dist/`; React version was `18.3.1`.

## Deterministic artifact hashes

The aggregate SHA-256 values below hash the sorted `shasum -a 256` output, including relative filenames:

| Boundary | Aggregate SHA-256 |
| --- | --- |
| registry manifest plus `dist/*` | `40cb20f465d1731dab3bd9b860911ccce7fd0ab2d57b38a3ccbdb9b119a04c8f` |
| presenter manifest plus `dist/*` | `977d42705c76d50025a6721d08ea451f51097f288c37b74443ee4cd4167bbf38` |

Complete per-file manifest:

```text
f472a4a20fbbefa98d5a5ad68d389b896b2240efac7ddf284eb2ce919c7b93aa  packages/action-registry/package.json
49ffaeea896bfc2756faefb098b498268cf824ef16c90f2d1f0813a43776ffd5  packages/action-registry/dist/catalog.d.ts
fbf49785b61d5f9239e8044aebddfe0da6e9c63f0798061a5f4ecfb2fa995486  packages/action-registry/dist/catalog.d.ts.map
e528089833bfcd21d86b5223502cf142f0f2ac12b819451ae29d3728095d2ea7  packages/action-registry/dist/catalog.js
7b02051db0ff4d11cb0c33c5953aaadb9d5b712e16b08bfe77c65a2b1b5a473d  packages/action-registry/dist/catalog.js.map
aabec3de11c63cd762e89d2de059a694d1b34ff5bfcad13806d32c3f10c9e13a  packages/action-registry/dist/contracts.d.ts
25a845a796ce3f5871d02d4c0ca16155b086fddd2445a43cbf65adac495bf02a  packages/action-registry/dist/contracts.d.ts.map
a33d95cb3c80ac939054701a7a345ce6d66c9276cf3fb38c3f69f08b0720e35f  packages/action-registry/dist/contracts.js
8df19752e626dcf3b6a48499c59fb9df725df611dcc451985332dedd9f1ef623  packages/action-registry/dist/contracts.js.map
09fe2f7c9964e366af35558c31f50315453606293ca5e7093e4dd9fe39fcd2aa  packages/action-registry/dist/index.d.ts
7587e85d9389c71d2b5ee3c25b229b5447e13acb757aeb53be1972bb6d1ed8d7  packages/action-registry/dist/index.d.ts.map
f03db1adf06f02387560fd0af8b0bf0df4aaa6fa795b68ac429b740a2af27dbc  packages/action-registry/dist/index.js
e3af8b8bf60c6d0a315b6e11c72792369275935dd52dce5ecc80260cfaf4f1fb  packages/action-registry/dist/index.js.map
276ccb8a72e2188b7ebe51c99a9028dbd6748bf3f60f4287fcc9b49d22c9fd75  packages/action-registry/dist/search.d.ts
13f72eef156c2a33895b412e175ec6da22238f3400a52882ddc502ec09f5554e  packages/action-registry/dist/search.d.ts.map
e268ee457032dbc7fa3b52c82546f2f61de1bda410e98b79fa73741adef70844  packages/action-registry/dist/search.js
a597116778b00fc3a618edc47ac28f0f1a624642230a008258e6731c45145143  packages/action-registry/dist/search.js.map
74a6ab79e1499a70217d8242e3fe099d3fee40d8d084f7b5c0e22638c4f7bc1c  packages/action-registry/dist/selection.d.ts
0ddd7f110150fe4a9fe88c00bc1cf7ad4e727a706efcb2e6f5d97b0cf5a75257  packages/action-registry/dist/selection.d.ts.map
9535f785dc77a6bf9c8d244e2c713e5d0ad152ea7ff1c3693ea76f0691736776  packages/action-registry/dist/selection.js
97cb3191fbd13d25f8014319871a20437ae8eaf4e46ef52402bc1eabe5b80156  packages/action-registry/dist/selection.js.map
4a6b268a6bf68598d2020523269c16d6b3cda948d5685e1583d5345732ab822b  packages/action-registry/dist/validation.d.ts
0ac4337e7aae4d19dec29b98d5193e6bc6920c44c2b0249b29b698c78ef176b8  packages/action-registry/dist/validation.d.ts.map
b3b8775e49be162f2f9113440640fdce744d1835a8ec26d23e6343977eb87bf7  packages/action-registry/dist/validation.js
228a3f8e9e510c53c82b146fe1892e5eab4d0f7092db9844d4da70cfe1ccf329  packages/action-registry/dist/validation.js.map
eeec1134f7fc5de9aac56085920ba019791b93874441fbf0a64f139ef9ef65e0  packages/action-palette-react/package.json
fcd55632392b45174626190aba292da0ca89ee5e88f21f29299968f5334067c0  packages/action-palette-react/dist/ActionPalette.d.ts
4e36924a241c61ba14a4b58f063471b629bff7b772816a1e9a063e71e6363bcc  packages/action-palette-react/dist/ActionPalette.d.ts.map
2a28ff9c7c0fc90f34c61e9feb49947b6a58b835471d5eccb05308c3b4d338d6  packages/action-palette-react/dist/ActionPalette.js
9ec45737dbe3a54b3491d36b364a626d1d18d842d343fcd5a0a497ca1baa818c  packages/action-palette-react/dist/ActionPalette.js.map
4428eafeae02d0fbee6207410e29126fc9d508e182f68bc0f3e255a55f729ae7  packages/action-palette-react/dist/index.d.ts
302c45a56a442f9df426b75fa1dc6e441a7e01227afe2f0be5e3cb1914fd4db1  packages/action-palette-react/dist/index.d.ts.map
adbdfa2d9a2e8846aa7a3286b7983164df77b57788d58b5933b6595706394c7b  packages/action-palette-react/dist/index.js
66b78796e232734f86ea5b9c5c33aea8190683529e489cab48e4d5590cd5b14c  packages/action-palette-react/dist/index.js.map
230b4dbae1e4105ba12a9e0ee42392ced7f89c207e2492ce933ce27d5df50995  packages/action-palette-react/dist/messages.d.ts
b725256148e232b71de2aa81f6e54533f99dc422ceefcd563de6f60f4dfdaf3f  packages/action-palette-react/dist/messages.d.ts.map
78777bc88f13cea25fd1117439842a4aadc98f87cc2f86bd4d565fb56d4932e9  packages/action-palette-react/dist/messages.js
e559af9df54d27f6661eb8da3f30821587389cf7aca37411514c5e3407d4de5f  packages/action-palette-react/dist/messages.js.map
7144df544d2495ddbc01b594554ff12d364bdb7267e73ce433c62bea1dd271db  packages/action-palette-react/dist/state.d.ts
b36250ac9c91df73bb9c4edaa908248b2bbdf153972da239dc739d105ca90a26  packages/action-palette-react/dist/state.d.ts.map
745b471298b5afb47aa587430546678a0a16b028094b6af44068c133ccdb883e  packages/action-palette-react/dist/state.js
e1a43a65a4a1e646cf5d381c0672ad8cd43d5bd0f1d854c67c2a4ce3062d14a6  packages/action-palette-react/dist/state.js.map
ec834571f23e5f6aa9bdffb03eeeab9ffb0b65caee2b6f9dbdd8c176480aee54  packages/action-palette-react/dist/styles.css
fa84edb2afad44d0d5c9b3766b518961d351479eed71130296b8f1ed40733d9e  packages/action-palette-react/dist/types.d.ts
976b3500d3c6c03e298703d145fc3d63f2b4214a4a931c341a933872f54f035c  packages/action-palette-react/dist/types.d.ts.map
01ae2a5b120382f9a648ced7ee8507493a134f216d100fc61600c6c9738235d2  packages/action-palette-react/dist/types.js
a7de897b48fe57bf54d6f84169135ff2e89e2fc95ea0a0a815761cc29a41efee  packages/action-palette-react/dist/types.js.map
```
