# Changelog

All notable changes to atlcli will be documented in this file.

## [2026.10.3] - 2026-10-22

### Bug Fixes

- **docs:** Pull --page-id materializes only the page's ancestor path ([a20d4e2](https://github.com/bjoernschotte/atlcli/commit/a20d4e2ce29d2a82c84e3885c9d48c785a84e5a3))
- **import-pdf:** Avoid false layout fallbacks ([8f4cbbc](https://github.com/bjoernschotte/atlcli/commit/8f4cbbc341813af39e7d56c2ce222e73f0fd9303))
- **import-pdf:** Join tagged tables longer than 250 rows across pages ([a54fb73](https://github.com/bjoernschotte/atlcli/commit/a54fb734d895a5c56aab12a3ec783a9a385d2a20))
- **import-pdf:** Contain rejected tagged tables to their region ([4def3f9](https://github.com/bjoernschotte/atlcli/commit/4def3f9a02f14f1b3fbde279270eaecc258a4074))
- **import-pdf:** Keep underscores, banded columns and digit wraps native ([9581285](https://github.com/bjoernschotte/atlcli/commit/9581285be7dc7d1da1417ffb9f36dbbf979eb047))
- **import-pdf:** Keep pages with open-sided or linearized tables native ([b77d7d9](https://github.com/bjoernschotte/atlcli/commit/b77d7d97d2a7bddbe89da286c5e5cc9cd676e951))
- **import-pdf:** Keep hyphens of compounds wrapped at a line end ([436c950](https://github.com/bjoernschotte/atlcli/commit/436c9504e90152c561c84ab16bb6e4484d6510f3))
- **import-pdf:** Read the pieces of a cell line in line order ([15041d5](https://github.com/bjoernschotte/atlcli/commit/15041d5a2b90c52f7d250a331b4344d1d162a552))
- **confluence:** Page list honors --space and --limit ([da74a81](https://github.com/bjoernschotte/atlcli/commit/da74a81219e72164f142d2d6cfd3590d5a7f57b0))
- **ci:** Raise Node engines floor to 22.12.0; consumer smoke runs on it ([74b9878](https://github.com/bjoernschotte/atlcli/commit/74b987886749185662cfc3ce7acdef5a9b36f05c))
- **docs:** Build the docs site into dist-docs/, not the CLI's dist/ ([e3a02b6](https://github.com/bjoernschotte/atlcli/commit/e3a02b63434f221630a3e2c6e0c05601b8ff8246))
- **confluence:** Wait for a busy sync.db instead of failing at once ([f03df9d](https://github.com/bjoernschotte/atlcli/commit/f03df9d71d0d07620a0f0d25773e23de254932c1))
- **cli:** Docs pull --limit caps pages pulled, not the search page size ([6282674](https://github.com/bjoernschotte/atlcli/commit/6282674faad0b4123530895737cbd3db9ff209b5))
- **release:** Unblock nightly dev releases after advisory-only CI failures ([6199643](https://github.com/bjoernschotte/atlcli/commit/6199643bcd58af53fff0f01a278a5273c5c6ba0a))
- **confluence:** Keep markdown after a smart link at a line start ([f1f665d](https://github.com/bjoernschotte/atlcli/commit/f1f665ddf3fde1fa1fc4e4dd3f801f270962dbf2))
- **import-pdf:** Ground table breaks, headings and hyphens in producer exports ([2e0d3d1](https://github.com/bjoernschotte/atlcli/commit/2e0d3d1701d86d0ec93659a60c42e0e8c8fe0afe))
- **confluence:** Accept the table __autoSize hint without a warning ([5b8a122](https://github.com/bjoernschotte/atlcli/commit/5b8a1225e7ca805552ddea61f9f3dc098f243ed5))
- **security:** Bound PDF object decoding, keep ADF sentinels out of page tasks ([e381d9f](https://github.com/bjoernschotte/atlcli/commit/e381d9f91d61e7afd76580968d326a5729996113))

### Documentation

- **import-pdf:** Plan quality reconstruction ([d3b515a](https://github.com/bjoernschotte/atlcli/commit/d3b515a95ca378fa99dfdec5929fa736666d9099))
- **import-pdf:** Record quality baseline ([64f3dd6](https://github.com/bjoernschotte/atlcli/commit/64f3dd6f4586f93440fab325eb7afaf869b772e8))
- **import-pdf:** Close quality implementation evidence ([0946571](https://github.com/bjoernschotte/atlcli/commit/0946571298cbb96b02e3038e3f3ab775776cc1e9))
- **import-pdf:** Reopen native table acceptance gaps ([396141c](https://github.com/bjoernschotte/atlcli/commit/396141cbf16bc91fd2f8573235660eb31c251e49))
- **import-pdf:** Detail remaining native-table proof gates ([e594f59](https://github.com/bjoernschotte/atlcli/commit/e594f59fe01dc60bc20486d650e9f0dc4c0a5ca0))
- **spec:** Plan TypeScript 7 migration ([83182c0](https://github.com/bjoernschotte/atlcli/commit/83182c0876d2b6a4036e29dbf1ecac24235eadb3))
- **spec:** Record ts7 migration planning decisions ([d21851d](https://github.com/bjoernschotte/atlcli/commit/d21851d8ce9b9147108b84c0bd69dfabbb786627))
- **spec:** Mark ts7 T1/T2 done, record Node 22.12 floor ([a99e5d5](https://github.com/bjoernschotte/atlcli/commit/a99e5d580f0beeb6505c67e37b7f8f4b6c4e9fd6))
- Document the TS 7 / TS 6 compiler split and record adoption evidence ([ab98ad9](https://github.com/bjoernschotte/atlcli/commit/ab98ad94fba6fe2922bbd0561885885671d2a7f2))
- **spec:** Plan Jira content workflows and digest/flow metrics bundles ([c47716f](https://github.com/bjoernschotte/atlcli/commit/c47716f7b2df4f37e241c83419d7b6d28e2ab6f2))
- **spec:** Record decisions for bundles A and B ([1d439db](https://github.com/bjoernschotte/atlcli/commit/1d439db9aab8a4d9886d377a64449a4fa4c27ac5))
- Drop README contributors list, credits live in CHANGELOG ([5422640](https://github.com/bjoernschotte/atlcli/commit/542264054f5ce9781802124ebc96aa59d1526612))

### Features

- **import-pdf:** Preserve ordered V2 facts ([4371ce7](https://github.com/bjoernschotte/atlcli/commit/4371ce7e5002792828e9c329791fc53e23bcdd75))
- **import-pdf:** Add evidence-based text assembly ([11fbf9e](https://github.com/bjoernschotte/atlcli/commit/11fbf9ee3695fe4212905c7638f9b5ed409f9449))
- **import-pdf:** Route tagged semantics through V2 assembly ([f0bebaa](https://github.com/bjoernschotte/atlcli/commit/f0bebaa63fc1eedd519a2e12458e9cff077b7d76))
- **import-pdf:** Route geometry semantics through V2 assembly ([a421486](https://github.com/bjoernschotte/atlcli/commit/a4214868fe4b160d8bcd4f637b6f80811322903a))
- **import-pdf:** Cut production review over to V2 ([0628710](https://github.com/bjoernschotte/atlcli/commit/0628710824cca5026a1b63fdc10521dcb8a10439))
- **import-pdf:** Reconcile tagged geometry ownership ([89980ee](https://github.com/bjoernschotte/atlcli/commit/89980eece502090ae6e53c3dff89ce6352277da5))
- **import-pdf:** Preserve producer structures ([0ce3813](https://github.com/bjoernschotte/atlcli/commit/0ce3813f05d4c6c296ae98822607e4d78d330d5f))
- **import-pdf:** Enforce semantic quality gates ([08f35e8](https://github.com/bjoernschotte/atlcli/commit/08f35e8bbb6b14600d42fb773fbf94719243e0cc))
- **import-pdf:** Surface source fidelity reviews ([1751ad7](https://github.com/bjoernschotte/atlcli/commit/1751ad75b831e8aa63ddd3e80e1ec98159d7a539))
- **import-pdf:** Read the full-document structure tree ([d5f597f](https://github.com/bjoernschotte/atlcli/commit/d5f597f267797095b0c138625e93cd09234249d4))
- **import-pdf:** Use the document tree in the tagged lane (PIQ-13..15) ([94c3590](https://github.com/bjoernschotte/atlcli/commit/94c35901aa2e6f77d9a6fbbf3cef6aa36ededc48))
- **import-pdf:** Add the neutral acceptance corpus and live proof ([ba25230](https://github.com/bjoernschotte/atlcli/commit/ba252307b7e9c95bfaecda6f3953cd897ecdbd10))
- **import-pdf:** Rebuild untagged tables and layout from the drawing ([f5b5f2c](https://github.com/bjoernschotte/atlcli/commit/f5b5f2c09e81b53af14ba0e3ab266a2f2be4a241))
- **import-pdf:** Keep siblings of unresolved tags, tables on fallback pages, and alt-text drafts ([3c89165](https://github.com/bjoernschotte/atlcli/commit/3c891651a8415fe6f35f778e42794c8fb4c39845))
- **jira:** Markdown<->ADF conversion ([85bbd48](https://github.com/bjoernschotte/atlcli/commit/85bbd489a16483f44c6d8a060fc3f309eecc7c83))
- **jira:** Markdown content in the CLI, comment CRUD, history, unlink ([1b9248d](https://github.com/bjoernschotte/atlcli/commit/1b9248dd52120a44180ec8dd2d88d5b16dccc0a4))
- **confluence:** Turn page task items into Jira issues ([7a71608](https://github.com/bjoernschotte/atlcli/commit/7a716084dce13a566be71418bf47993e6f5b2a57))
- **jira:** Release notes and sprint review pages ([2688549](https://github.com/bjoernschotte/atlcli/commit/268854994cad87794b7a0866e7106675cda84439))
- **import-pdf:** Opt-in Table Transformer proposals for untagged tables ([5ca012f](https://github.com/bjoernschotte/atlcli/commit/5ca012f412c9de53f2b106aa23fa0730072369ab))
- **jira:** Readable report PDFs with issue pills and description excerpts ([8481fc9](https://github.com/bjoernschotte/atlcli/commit/8481fc9259d79818458527b676ee57d763775a6b))
- **pdf:** Configurable cover and closing page, curated Report template ([3e8944d](https://github.com/bjoernschotte/atlcli/commit/3e8944ded64c84296c0690be366ac58a1d9490b2))
- **pdf:** Title block on page 1, built-in "report" template for reports ([df6467b](https://github.com/bjoernschotte/atlcli/commit/df6467b50aa37288a590a6a3eb210808f80ff005))
- **import-pdf:** Verify untagged headings, join split rows, attach OCR layers ([5391750](https://github.com/bjoernschotte/atlcli/commit/539175014153ebe7601066703b0957243133a164))

### Miscellaneous

- **import-pdf:** Remove the multi-engine oracle spike ([9dbb429](https://github.com/bjoernschotte/atlcli/commit/9dbb429ac6931342ba40c824edd612953846bcfa))
- **import-pdf:** Port producer fixture tools from Python to TypeScript ([fe7d9e8](https://github.com/bjoernschotte/atlcli/commit/fe7d9e8664d239cf676f45acd1a204284a58b273))
- **fixtures:** Drop unused Python fixture generators ([c0f2417](https://github.com/bjoernschotte/atlcli/commit/c0f2417a2dd047dc90a8b5a12340b79cc65d2a28))
- **bench:** Port the Glow PTY probe from Python to TypeScript ([a5ec244](https://github.com/bjoernschotte/atlcli/commit/a5ec2446a1a23fd5a834493500b1d3d806392eef))
- Route docs-only workflow, .gitignore and CI test files narrowly ([fdaafee](https://github.com/bjoernschotte/atlcli/commit/fdaafee50ac0014edf67b9ef06946a56cd1a3c9a))
- Cut PR wall time (6 test shards, macOS Homebrew, Intel/CfT off PRs) ([5cddc20](https://github.com/bjoernschotte/atlcli/commit/5cddc20012b973a9de94507edae170c48993a1dc))
- PR fast lane; native platform proof runs after merge on main ([0ff4da4](https://github.com/bjoernschotte/atlcli/commit/0ff4da4538f2ef30efb2ed8e1acd2da112ff4984))
- **web-publish:** Untrack a generated Astro test build and restore the consumer inventory ([0205fa0](https://github.com/bjoernschotte/atlcli/commit/0205fa0c5e04f89968a2dcd85d65965ddf1a5643))

### Performance

- **nfs:** Let tests shorten helper deadlines instead of waiting them out ([07dd5f8](https://github.com/bjoernschotte/atlcli/commit/07dd5f8b4f8d63958a3ac55c2f098e0131cdb781))

### Styling

- **nfs:** Rustfmt helper argument tests ([d9afdb3](https://github.com/bjoernschotte/atlcli/commit/d9afdb3d784d0f3c2401e2ac7fb0ce5683a1b671))
- **confluence:** Drop trailing blank line in tasks-to-issues ([a1b404c](https://github.com/bjoernschotte/atlcli/commit/a1b404cbbb8afc58e558c1ee37d1216e1f9da772))

### Testing

- **import-pdf:** Add neutral quality corpus ([3061012](https://github.com/bjoernschotte/atlcli/commit/3061012f66593aefaf9d65f65865870ce7baa74c))
- **import-pdf:** Align hyphen boundary oracle ([4eeb6ee](https://github.com/bjoernschotte/atlcli/commit/4eeb6ee9ded83d96de72a8e3ae2b2134ec3256b2))
- **import-pdf:** Prove fragmented cloud readback ([2383570](https://github.com/bjoernschotte/atlcli/commit/238357049b39241ee7b756cb1ea85b691a67c791))
- **import-pdf:** Prove multi-engine oracle architecture ([213ddcc](https://github.com/bjoernschotte/atlcli/commit/213ddcc815671c1572a7a6cf53def7990751acee))
- **import-pdf:** Repin V1 facts digests for PDFium 2.15.1 ([b4919d2](https://github.com/bjoernschotte/atlcli/commit/b4919d2580bc4884e33b65d57fa2749477c1fc46))
- **vfs:** Replace inline Python probes in the NFS bridge tests ([3dbd203](https://github.com/bjoernschotte/atlcli/commit/3dbd2037ba3e3c60ebad9aba1a0920492fc98f37))
- **pdf:** Decode-proof corpus uses one asset per role (87 s -> <1 s) ([20ba1ee](https://github.com/bjoernschotte/atlcli/commit/20ba1ee630a44989233797f99d2b5bac0906d093))
- **nfs:** Explicit 20 s timeout for the bounded-pages journal test ([6ec1137](https://github.com/bjoernschotte/atlcli/commit/6ec1137179e36416d686ac4ab51304c699aad35b))
- **consumer-smoke:** Check the text assembly revision's shape, not a pinned number ([83ec618](https://github.com/bjoernschotte/atlcli/commit/83ec618d71bf34f4053713dacaddac28c7676b7f))
- **consumer-smoke:** Compare the revision prefix in the generated chunk source ([8247d56](https://github.com/bjoernschotte/atlcli/commit/8247d563e350a623b4b5ce5da2c3e96eaf969d4e))
- **jira:** Live E2E suite for content workflows ([578d4b9](https://github.com/bjoernschotte/atlcli/commit/578d4b9a6982643bef2ef43190fa819a8268d305))

### Build

- Prepare for TypeScript 7 (bun-types 1.4.2, explicit extension types) ([8452a2b](https://github.com/bjoernschotte/atlcli/commit/8452a2bc581dda6d48c52c56dd5ce49058c28f97))
- Adopt TypeScript 7 native compiler side-by-side with the TS 6 API ([bc4ccf4](https://github.com/bjoernschotte/atlcli/commit/bc4ccf4e81ef4bbd7c3eb0f39819b67bcf2614f0))
## [2026.10.2] - 2026-10-14

First public CalVer product release. Tag `v2026.10.1` remains reserved after an
unpublished release attempt; this entry carries forward its reviewed release
notes. CLI and Chrome extension share this version; libraries retain SemVer.

### Release verification

- Verify compiled CLI identity by executing each downloaded archive on its
  native platform. Bun executables may encode their JavaScript payload, so raw
  string searches cannot reliably recover release metadata. Archive safety,
  source bindings, checksums and the mandatory native publication gates remain.
- Verify the exact frozen dev Homebrew timestamp, run and attempt at runtime.
- Give stable draft download jobs the writer permission required by GitHub;
  downloaded CLI and extension consumers run without persisted checkout tokens.
- Prepare stable releases through a CI-verified pull request and tag the exact
  resulting merge commit, respecting protected main.

### Added

- **vfs:** Confluence as a filesystem, through two frontends over one core.
  `atlcli wiki sh` is an embedded bash — spaces and pages are directories, a
  page's body is `_index.md`, and `ls`, `cat`, `grep`, `find` and `sed` work on
  them, with a real exit code so `-c` composes from the outside.
  `atlcli wiki mount` attaches the same tree as an OS volume through a loopback
  WebDAV server: no kernel extension and no administrator rights on macOS or
  Windows, printed `davfs2` instructions on Linux.

  It is a **cache, not a copy**. Listing a directory costs one request for that
  directory; `ls`, `stat` and a Finder window never fetch a page body; a branch
  nobody opens is never fetched. The disk cache is a bounded LRU (100 MB by
  default, attachment blobs included) that is safe to delete at any time, and a
  recursive operation needing more than 300 page bodies stops and says so
  rather than quietly downloading a space. `atlcli wiki docs pull` remains the
  right tool for a complete local copy.

  Writing is off by default. `--mode rw` enables create, update, rename and
  move; `rm` additionally needs `--allow-delete` and only ever moves a page to
  the trash — no purge endpoint is called anywhere. Every write is a versioned
  compare-and-swap with a three-way merge, and a merge that conflicts fails
  loudly with the losing content preserved under the cache directory, listable
  with `atlcli wiki vfs conflicts`.

  `grep` can use Confluence's search index, but only when the pattern is marked
  as a whole word (`grep -rw`): the index matches words while `grep` matches
  substrings, so an unmarked pattern takes the full scan instead of risking a
  silently empty result. The path taken is always printed on stderr.

  Convenience directories: `.by-id/`, `.labels/`, `.recent/{24h,7d,30d}/` and
  `.search/<cql>/`, all resolved on access with no registration step, plus
  `_attachments/`, `.versions/` and `.comments.md` per page.

  New: `@atlcli/confluence-vfs` (experimental, 0.x), `atlcli wiki sh`,
  `atlcli wiki mount`, `atlcli wiki unmount`, `atlcli wiki vfs cache`,
  `atlcli wiki vfs conflicts`, a `vfs` config section (global and per profile),
  and `ConfluenceClient.getPagesBulk` for bulk body fetches.
  See [Virtual Filesystem](https://atlcli.sh/confluence/virtual-filesystem/).


### BREAKING CHANGES

- **export:** Remove the Python DOCX exporter (`packages/export`). `--engine
  python` stops the export with a migration message instead of selecting it;
  `--engine ts` is still accepted, and omitting `--engine` is unchanged. Python
  and `uv` are no longer part of the developer or CI toolchain — `bun install`
  is the whole setup. Templates written for the old exporter must be ported
  from docxtpl/Jinja (`{{ … }}`) to `$scroll.*` placeholders; unported
  placeholders render as literal text and are reported as a
  `template-foreign-placeholders` warning, so `--strict` fails the run. The
  `engine` field in `atlcli.export-report/1` is unchanged in shape and now only
  ever carries `"ts"`. See
  [Migrating from the Python exporter](https://atlcli.sh/confluence/export/#migrating-from-the-python-exporter).

### Features

- **publish:** Add the `wiki publish plan|refresh|build|verify|run|status|prune`
  lifecycle for immutable Confluence page, tree, and space bundles; verified
  Astro 7.1/Starlight output; local Pagefind search; navigation, SEO, i18n/RTL,
  privacy-safe analytics, and optional provider-validated edit links.
- **charts:** Normalize all twelve Confluence Chart macro shapes from Cloud ADF
  and Data Center Storage into a source-neutral model. Astro, DOCX, and PDF use
  one pinned TanStack scene/SVG adapter, retain exact-value tables, and add
  bounded keyboard-accessible Bar/XY Bar islands without making JavaScript a
  content dependency.
- **export:** Run DOCX and PDF through one durable, bounded job queue in the CLI
  and Chrome extension. Exports are recorded before the first source read,
  survive panel, service-worker, offscreen-document, and full browser restarts,
  expose shared Activity/history with statistics and bounded events, and
  support Cancel, Retry, Run again, resume after sign-in, download,
  acknowledgement, dismissal, and retention-safe cleanup.
- **extension:** Show active export counts on the toolbar badge (`9+` maximum),
  durable success/failure indicators, and an optional bounded completion pulse.
  Full DOCX and Typst/WASM PDF execution now continues outside the side panel.
- **cli:** Add `wiki export jobs list|show|watch|cancel|resume|retry|rerun|clear` while
  keeping ordinary exports foreground and scriptable. There is intentionally no
  daemon or detached mode.

### Changed

- **export:** Use the TypeScript DOCX engine exclusively (completed by the
  removal noted under Breaking Changes above).
- **export:** Buffer large tree/space exports through bounded, restartable
  source and content-addressed asset checkpoints. One global heavy-render slot
  prevents DOCX and PDF memory peaks from overlapping.
- **extension:** Prepare eligible non-original PDF rasters with target-sized
  ImageBitmap decoding in a disposable worker. Unsupported or failed native
  paths retain the deterministic pure-TypeScript fallback, and the worker is
  released before Typst compilation; public image-profile semantics are
  unchanged.

### Documentation

- Add the complete Web Publishing operator journey, schema-tested project
  example, CLI/configuration reference, Starlight/adapter guide, chart
  cross-output matrix, search, security/privacy, operations/rollback, and
  troubleshooting documentation.
- Document export-job lifecycle, monitoring, recovery, retention, storage
  limits, privacy boundaries, and browser/CLI operational procedures.

### Breaking changes

- **export:** Remove the Python DOCX exporter (#97) ([a39df23](https://github.com/bjoernschotte/atlcli/commit/a39df232e8b0af176127e3cbe826d4b9e7de705b))

`packages/export` (the `atlcli-export` Python package)
is gone. `--engine python` has already failed with a migration message
since the TypeScript engine became the default; this removes the code
behind it, the CI gate that tested it, and the venv helper that set it up.

Nothing in the shipped product invoked it. DOCX exports run through the
isomorphic `@atlcli/docx` engine and PDF through the Typst/WASM pipeline,
so neither format needs a Python toolchain on the machine — which is the
practical win: `bun install` is now the whole developer setup.


### Bug Fixes

- **markdown:** Convert regular code blocks to Confluence macros (#22) ([0c62d59](https://github.com/bjoernschotte/atlcli/commit/0c62d59de75f740dd74f2b87deaebad5158090d9))
- **ci:** Eliminate webhook port collisions (#25) ([b1cdc5a](https://github.com/bjoernschotte/atlcli/commit/b1cdc5a036ad9a1b42e4979b66b94d2eb29a2224))
- **path:** Resolve path correctly on Windows (#24) ([f4dabf4](https://github.com/bjoernschotte/atlcli/commit/f4dabf421a569e064d5ec45b23938942df340108))
- **confluence:** Preserve users when checks are skipped (#28) ([330a71b](https://github.com/bjoernschotte/atlcli/commit/330a71b8cb59c2cc5865049c2dd5a719363fb1aa))
- **docx:** Support quarter tokens Q/QQ/QQQ/QQQQ in date placeholders (#37) ([7c294d7](https://github.com/bjoernschotte/atlcli/commit/7c294d719745c3adc4b2ca67cdfc28d761efdcad))
- **extension:** Keep active page in sync (#45) ([81209d5](https://github.com/bjoernschotte/atlcli/commit/81209d5e08477151d8e3073bdc4d5f4fc141cc80))
- **extension:** Add stylerefStyleNames to ScanResult test fixtures (#59) ([01dcd96](https://github.com/bjoernschotte/atlcli/commit/01dcd967fddf56af35a812b7e3bd9b98a15c9f75))
- **typecheck:** Extend coverage to all root scripts (#63) ([9fa38b1](https://github.com/bjoernschotte/atlcli/commit/9fa38b19e88afa9b4b4ed298fade53ac28d22143))
- **export:** Emit complete/requestedScope/resolvedScope on the PDF path (#65) ([3ef02f4](https://github.com/bjoernschotte/atlcli/commit/3ef02f45dbf98502d82b8805a5214f2ce630c87d))
- **pdf:** Chapter running head names the FIRST chapter opening on a page (#67) ([22d373d](https://github.com/bjoernschotte/atlcli/commit/22d373d73d0609d622c4b8bc4271c7b18c76b4d9))
- **export:** Honor --report json on the DOCX paths, not just PDF (#68) ([1232f66](https://github.com/bjoernschotte/atlcli/commit/1232f6646bc01854b392fb6661927710c15956b6))
- **template-pack:** Refuse implausible declared sizes before inflating (#73) ([44fd6cc](https://github.com/bjoernschotte/atlcli/commit/44fd6cceb5a0134e0574b5077e9af0fc6e89199d))
- **cli:** Options that silently did the opposite of what they promised (#76) ([3eb98b2](https://github.com/bjoernschotte/atlcli/commit/3eb98b23097f6acfa781267b4e40a6f16137bf4a))
- **docs:** Keep a pulled page on its own filename (#77) ([88bc2bc](https://github.com/bjoernschotte/atlcli/commit/88bc2bc184baf2610ea2b8aad4afd95525d9c49c))
- **docs:** Emit exactly one JSON document per --json invocation (#78) ([ba38adc](https://github.com/bjoernschotte/atlcli/commit/ba38adc0d9ef6da3d5d501262bc7220b63980b5a))
- **extension:** Hide export controls outside Atlassian pages (#83) ([5cdf69c](https://github.com/bjoernschotte/atlcli/commit/5cdf69c7e8d06a476e29385c59821d853be65677))
- **ci:** Satisfy changed-surface whitespace gate ([acb9942](https://github.com/bjoernschotte/atlcli/commit/acb9942267ab63082d52c414cbca2dc21ebd39ff))
- **export:** Project typed Confluence emoji (#87) ([9a552c0](https://github.com/bjoernschotte/atlcli/commit/9a552c07f68ddc6a59cb2701550872795142244c))
- **extension:** Preserve ADF captions in PDF preview (#88) ([1ac7d71](https://github.com/bjoernschotte/atlcli/commit/1ac7d713f9eab25f076c892cd9b2c381d442fe23))
- **extension:** Avoid CORS fetches for external images (#89) ([0131ff6](https://github.com/bjoernschotte/atlcli/commit/0131ff6d8487ebaae4e542b8e5424c33e3e6a48b))
- **test:** Stabilize heavy and extension build tests (#99) ([99a260e](https://github.com/bjoernschotte/atlcli/commit/99a260e5b9e45ab438eda974ea24a418a5dfdbf8))
- **ci:** Validate README media routing (#105) ([92f03d7](https://github.com/bjoernschotte/atlcli/commit/92f03d7510062fada7568e8220ccf5c1a4714b5b))
- **export:** Quarantine unreadable journal records instead of failing every export (#121) ([72a0898](https://github.com/bjoernschotte/atlcli/commit/72a08980fab8ef38b921d6aea7f8ac831e8fcb70))
- **docx:** Defer code font until render demand (#124) ([2fa4e70](https://github.com/bjoernschotte/atlcli/commit/2fa4e70a6a0234a0dfe3c501a195be104abd06e3))
- **confluence:** Skip folder discovery on Data Center (#130) ([4cec5b3](https://github.com/bjoernschotte/atlcli/commit/4cec5b351fcca6e881da63b8de0fc895cd0f4fbf))
- **extension:** Keep research reports evidence-bound ([1055fc0](https://github.com/bjoernschotte/atlcli/commit/1055fc06cdc860566fae45b15796fb71ba674f8e))
- **extension:** Run research safely across MV3 realms ([9e2cae0](https://github.com/bjoernschotte/atlcli/commit/9e2cae0cd22a9d1fbefadc069970314d2064894b))
- **extension:** Stabilize final research gates ([dcff12b](https://github.com/bjoernschotte/atlcli/commit/dcff12b43943e10ae717902184242ff39cc47ba9))
- **extension:** Qualify truncated research evidence ([a001aee](https://github.com/bjoernschotte/atlcli/commit/a001aee29ddfb4c167a4157a594b2781eeb62c1e))
- **extension:** Expose research evidence coverage ([5fd856a](https://github.com/bjoernschotte/atlcli/commit/5fd856ae41c079065d1e35cce68c4c2718ffa260))
- **research:** Keep worker tools inside QuickJS PTC ([74e54cf](https://github.com/bjoernschotte/atlcli/commit/74e54cfff9ca2914809f5e9003bb9610aea24895))
- **research:** Declare empty worker tool surfaces ([8c0ec71](https://github.com/bjoernschotte/atlcli/commit/8c0ec71d2c8f2cb14fc7e9af4505d3e50e6576a2))
- **research:** Teach workers the QuickJS acquisition contract ([ac32962](https://github.com/bjoernschotte/atlcli/commit/ac3296279b717a5f875ba15469abcab1ca9ab902))
- **research:** Orchestrate dynamic workers through QuickJS task ([061df0c](https://github.com/bjoernschotte/atlcli/commit/061df0c930a15219fd1d247d4b44701c84314998))
- **research:** Bound worker acquisition workflows ([465f0f2](https://github.com/bjoernschotte/atlcli/commit/465f0f2b3db757c8fe0ee5a2df886de3265d92aa))
- **research:** Contain worker provider failures ([9862d57](https://github.com/bjoernschotte/atlcli/commit/9862d57c079088d9b2adcb2702071352ebf4ae83))
- **research:** Bound supervisor role execution ([7e4fde2](https://github.com/bjoernschotte/atlcli/commit/7e4fde20eb181dfc5dc2a76d168b04aa3c44361a))
- **research:** Avoid retrieval output retries ([6113f70](https://github.com/bjoernschotte/atlcli/commit/6113f70863806e5ddd0e83b5b0ae960ac5caec1d))
- **research:** Require complete linked evidence ([71103bc](https://github.com/bjoernschotte/atlcli/commit/71103bcc2384883c63a523077db65a62eb7a2d6d))
- **research:** Honor configured detail budget ([16f662c](https://github.com/bjoernschotte/atlcli/commit/16f662c63ef9bb2db36a78d03cf2f01e8da97453))
- **research:** Validate exact Jira project scope links ([af62fcf](https://github.com/bjoernschotte/atlcli/commit/af62fcf076d01e5b0240f311ce52d4160fbe6ab1))
- **research:** Prioritize exact scope links ([edb71a8](https://github.com/bjoernschotte/atlcli/commit/edb71a841f54a6c0646de7194922cef044dc21b5))
- **research:** Centralize browser scope preflight ([9f6b110](https://github.com/bjoernschotte/atlcli/commit/9f6b110216d2529a848e6008888eb18983e6f73f))
- **research:** Isolate dynamic task context ([a90a652](https://github.com/bjoernschotte/atlcli/commit/a90a652e64f6979c7350d3b12fcd0862cd0a6104))
- **research:** Scope LangGraph threads to sessions ([58b0a7e](https://github.com/bjoernschotte/atlcli/commit/58b0a7ea26f83a6c37cfae82fcefa0c0ccbf67a3))
- **research:** Honor detail retrieval budget ([d066c4d](https://github.com/bjoernschotte/atlcli/commit/d066c4dfb726311d898c08d165d9b04e97ec4c6f))
- **research:** Release plan-only session leases ([26fb187](https://github.com/bjoernschotte/atlcli/commit/26fb187f7f262fe528e0e6c90e9925184958109c))
- **research:** Harden dynamic workflow completion ([c435def](https://github.com/bjoernschotte/atlcli/commit/c435deff9e57082d9e9a8f104533896ddfbae5b8))
- **research:** Budget ranked repair retrieval ([04ffc41](https://github.com/bjoernschotte/atlcli/commit/04ffc4171735f9da5db01de702b48aa0d05f3ec2))
- **research:** Align retrieval with worker budgets ([025a79c](https://github.com/bjoernschotte/atlcli/commit/025a79c6b83ad516ef491043d1be8d94cae3758b))
- **research:** Refresh durable graph state ([6610803](https://github.com/bjoernschotte/atlcli/commit/6610803627d7921dccb2d7a414e6ebc21f2fba49))
- **research:** Preserve task identity across graph revisions ([db383ab](https://github.com/bjoernschotte/atlcli/commit/db383aba92abc19f86705b93f277dccabd111ff3))
- **research:** Persist browser cancellations ([f543815](https://github.com/bjoernschotte/atlcli/commit/f543815476b2f25ca516542ae22f7dbe2d6868a3))
- **research:** Preserve approved graph catalog for steering ([2a52865](https://github.com/bjoernschotte/atlcli/commit/2a52865cc52d90f1d53f6f4c08ffb08621b57b73))
- **research:** Abstain after expired dispatch ([2d5cf37](https://github.com/bjoernschotte/atlcli/commit/2d5cf37e5327bd238899f423ec14818f19771914))
- **research:** Preserve committed packet state ([44cd322](https://github.com/bjoernschotte/atlcli/commit/44cd3224d5693315721b2713cc4cd3efe48af8f2))
- **research:** Project dependencies before durable acceptance ([b12d131](https://github.com/bjoernschotte/atlcli/commit/b12d131095149d36b9e1119b423ef40cf9f04c28))
- **research:** Recover after committed packet projection ([eb8629e](https://github.com/bjoernschotte/atlcli/commit/eb8629ee14602eda5e302d34235577d2048c4619))
- **research:** Reissue safe interrupted continuations ([8c00127](https://github.com/bjoernschotte/atlcli/commit/8c00127c220226916ea8054fffab58d517c72715))
- **research:** Archive native summaries incrementally ([c9dfd0d](https://github.com/bjoernschotte/atlcli/commit/c9dfd0db2cc6bc2db2eb15b677a00b1f59ec45fe))
- **research:** Retain provider structured task results ([ec9b7fa](https://github.com/bjoernschotte/atlcli/commit/ec9b7fa7159b73f85a139b8218d8cc2244769d36))
- **research:** Retain scope bindings in follow-up turns ([cce9ba8](https://github.com/bjoernschotte/atlcli/commit/cce9ba80a974aeef31f95a208033e87d7a4a6252))
- **research:** Stop marginal retrieval waves ([c4e06a5](https://github.com/bjoernschotte/atlcli/commit/c4e06a5d94e0ea8621395518e01685016269771b))
- **research:** Bound catalog provider calls ([30d5b32](https://github.com/bjoernschotte/atlcli/commit/30d5b323ca4e598d249218581ffe5d01316f0b34))
- **research:** Align browser run deadline ([b23f8ae](https://github.com/bjoernschotte/atlcli/commit/b23f8ae9e2c94f8214308e38dced5a0da8810a7c))
- **research:** Isolate pagination cursor chains ([e6d0a26](https://github.com/bjoernschotte/atlcli/commit/e6d0a26dd630c9329282790b76744f1f47e15cda))
- **research:** Reserve Jira ranking for detail reads ([019e6da](https://github.com/bjoernschotte/atlcli/commit/019e6da48ec866d1c8af261bcfa61f69684a9d7c))
- **research:** Retain multi-wave token headroom ([8b21418](https://github.com/bjoernschotte/atlcli/commit/8b21418b701408ce1de2db8df03690e1129eb7c6))
- **research:** Retain host-validated abstentions ([16f487f](https://github.com/bjoernschotte/atlcli/commit/16f487f633a673773795f212c2ef454cb080e97c))
- **research:** Complete one-shot runs from synthesizer ([fd2949b](https://github.com/bjoernschotte/atlcli/commit/fd2949b16c6ca296c768c49f5b5c52dcb0a89e4a))
- **research:** Sanitize ancillary evidence references ([e0f34e1](https://github.com/bjoernschotte/atlcli/commit/e0f34e1ca3013d338e683de391e7b73929ddb315))
- **research:** Bound subagent acquisition programs ([d57f691](https://github.com/bjoernschotte/atlcli/commit/d57f691339c45bfae799be0931080b26a1282404))
- **research:** Complete bounded candidate retrieval ([4b2e505](https://github.com/bjoernschotte/atlcli/commit/4b2e505dce925648509378e524c621dcc5825a6f))
- **research:** Preserve budget for final reports ([ec9850e](https://github.com/bjoernschotte/atlcli/commit/ec9850edf99787063643b79b562fc3a5349935e0))
- **research:** Retain complete evidence workflows ([e3e5e0c](https://github.com/bjoernschotte/atlcli/commit/e3e5e0cfcb99dd40e0b78ddd919d3a3fa2aaa81a))
- **research:** Align task deadlines with run budget ([e185dab](https://github.com/bjoernschotte/atlcli/commit/e185dab29d016a58fe600a51b72982c1168a9c96))
- **research:** Classify subagent provider failures ([97fef75](https://github.com/bjoernschotte/atlcli/commit/97fef7543f42af1dad978970b43bb356cf197a0f))
- **research:** Validate localized suite reports ([7750ef1](https://github.com/bjoernschotte/atlcli/commit/7750ef103560a5ea4b3a87f3304e42f7aad8b79e))
- **research:** Surface unresolved cross-product evidence ([e73d17a](https://github.com/bjoernschotte/atlcli/commit/e73d17a41699bcd65f45f1b3e228da6555085aa1))
- **research:** Bound analysis subagent deliberation ([98f2056](https://github.com/bjoernschotte/atlcli/commit/98f2056fcc331ee03f4e69f2437e7c3e0465f135))
- **research:** Fence dynamic plan revisions ([1a59036](https://github.com/bjoernschotte/atlcli/commit/1a590369212f3c064ec9d3806d467b17f2e2f4ee))
- **extension:** Bind chat to exact page context ([d88138e](https://github.com/bjoernschotte/atlcli/commit/d88138e6b522e8f30987c7f2fd4dfa87f8c37254))
- **research:** Preserve durable chat context ([3a563f8](https://github.com/bjoernschotte/atlcli/commit/3a563f85848669f6a9220dd707e70e48d1ac8e9c))
- **research:** Harden checkpointed supervisor baseline ([5b6b8f0](https://github.com/bjoernschotte/atlcli/commit/5b6b8f09ef25701926f3f043e8864c720ae3b962))
- **chat:** Stop workers cooperatively ([8288ab8](https://github.com/bjoernschotte/atlcli/commit/8288ab8560e2b8e40dcc8d142df4f4a3cd4892db))
- **chat:** Make hitl schema provider compatible ([5415f48](https://github.com/bjoernschotte/atlcli/commit/5415f48db9019d1060adc53509344ce75590bdf9))
- **chat:** Stabilize parallel evidence acquisition ([c2e3cf9](https://github.com/bjoernschotte/atlcli/commit/c2e3cf95e4fec3ee6b50e12844d441a5cfff1a15))
- **chat:** Preserve grounded answer structure ([3e4b447](https://github.com/bjoernschotte/atlcli/commit/3e4b44749c4ac4c17f46788a0cc06afa90b79a10))
- **chat:** Stream repairable structured answers ([b89a27b](https://github.com/bjoernschotte/atlcli/commit/b89a27b7df15c1692ece8b3f426c40a0c1aa660a))
- **chat:** Account for bounded retrieval quality ([5a5ed21](https://github.com/bjoernschotte/atlcli/commit/5a5ed216fe8e02a965a6e65d4f78c10c12c2a222))
- **research:** Improve agentic chat quality ([4938b01](https://github.com/bjoernschotte/atlcli/commit/4938b012be2992716c328d6258fb40f618bec9c4))
- **research:** Preserve explicit retrieval anchors ([d01dbff](https://github.com/bjoernschotte/atlcli/commit/d01dbffda34b2ad31f1b3bbc5aa6dd5f89367f60))
- **research:** Harden ordinary chat evidence flow ([773a8a5](https://github.com/bjoernschotte/atlcli/commit/773a8a5a9725c390c9df107a9489263c3b66a604))
- **research:** Accept personal Confluence space bindings ([83f1060](https://github.com/bjoernschotte/atlcli/commit/83f10602de64e64dbf9b0d481106aaf9be0ca0e3))
- **research:** Preserve evidence-backed chat answers ([446ae42](https://github.com/bjoernschotte/atlcli/commit/446ae429d20251ed7d386b2b794cb71492f5df80))
- **research:** Recover bounded deep chat readers ([0184fe0](https://github.com/bjoernschotte/atlcli/commit/0184fe0d12eeeb3d4efa2e1b8e0302e3e3c9f098))
- **chat:** Bind release candidate proof authority ([de2f19b](https://github.com/bjoernschotte/atlcli/commit/de2f19b6873f76b52fecacdb886b156e4b37fe70))
- **chat:** Prove durable MV3 lifecycle parity ([bbf18ca](https://github.com/bjoernschotte/atlcli/commit/bbf18cac721ff7a11a503b32b9a1c80e9261358c))
- **chat:** Preserve retained private run policy ([e4d52ea](https://github.com/bjoernschotte/atlcli/commit/e4d52ea4089894a09ba874b2a798a2b6f9121425))
- **chat:** Isolate private suite sessions ([6d5ec2e](https://github.com/bjoernschotte/atlcli/commit/6d5ec2e698e7a7ec3eb4377f4878a5c075e1bf63))
- **chat:** Reject ceremonial HITL pauses ([86172d4](https://github.com/bjoernschotte/atlcli/commit/86172d43e8fb93ac47f73eccf32eefcd3ca0b769))
- **chat:** Preserve structured answer headroom ([0d6447d](https://github.com/bjoernschotte/atlcli/commit/0d6447d0ceb4e2a1a1ff257f50ac1194b8b0df50))
- **chat:** Bound quick answer repairs ([97d8b30](https://github.com/bjoernschotte/atlcli/commit/97d8b30b1a7f0c0fb7523cb59e4e5045c4de283d))
- **chat:** Retry durable stream continuation ([b21fa7c](https://github.com/bjoernschotte/atlcli/commit/b21fa7c0530377be4e79eda84809ffe4b0d9d345))
- **research:** Prioritize exact bound evidence ([4aff1e8](https://github.com/bjoernschotte/atlcli/commit/4aff1e8dbea573c96c11ad7675009f119549e505))
- **chat:** Publish one validated cli answer ([b3fed21](https://github.com/bjoernschotte/atlcli/commit/b3fed217fee04c4a8a674fd8b3f26116b19b903b))
- **research:** Report actual retrieval activity ([83eeb06](https://github.com/bjoernschotte/atlcli/commit/83eeb06b0e43f42cf3c1d7139a8737dfa8238d1d))
- **chat:** Repair incomplete evidence-bound answers ([598126e](https://github.com/bjoernschotte/atlcli/commit/598126ea496d060bf5e13c50dd6b2f0a417bfa3f))
- **chat:** Enforce complete evidence repair ([c05c4cf](https://github.com/bjoernschotte/atlcli/commit/c05c4cfddc46098527746d306d9b80a4c963472e))
- **chat:** Normalize release candidate markdown ([a132caa](https://github.com/bjoernschotte/atlcli/commit/a132caad03ec36cc484a4530a26092a178f44e66))
- **research:** Preserve validated report coverage ([1da7cbe](https://github.com/bjoernschotte/atlcli/commit/1da7cbee4932d90ffbd4559362cd71693f8179a1))
- **chat:** Retain recovered answer facets ([130054d](https://github.com/bjoernschotte/atlcli/commit/130054d5aee36fdb9fba85741ef2824a9e495c04))
- **research:** Harden deep report synthesis ([79bd4e7](https://github.com/bjoernschotte/atlcli/commit/79bd4e7d8e7b372690e7f16ac56d8258b6349cf9))
- **chat:** Preserve explicit request facets ([a53b303](https://github.com/bjoernschotte/atlcli/commit/a53b303623ab9f5e05fbb2320b91e5be80be2acf))
- **chat:** Remove redundant strategy handshake ([c87d151](https://github.com/bjoernschotte/atlcli/commit/c87d151fda909f4a745d071b037561787e2d449b))
- **chat:** Reject incomplete answer prose ([e046ac5](https://github.com/bjoernschotte/atlcli/commit/e046ac585a369cc2d455bee61e783df20ec0865b))
- **chat:** Reject detached continuation prose ([fc129a4](https://github.com/bjoernschotte/atlcli/commit/fc129a46a58cd95b585a41e8c6c574055ad75706))
- **chat:** Preserve complete answer paragraphs ([5f2405d](https://github.com/bjoernschotte/atlcli/commit/5f2405d3120ca3db39ee49cc97a26fa84529280b))
- **chat:** Honor measured ranking criteria ([133bcad](https://github.com/bjoernschotte/atlcli/commit/133bcad5ab8457aafe2d2063a32444474e3ebacd))
- **chat:** Recover mistyped bound references ([7a73eda](https://github.com/bjoernschotte/atlcli/commit/7a73edabddec952870372ca43bef1f3dbdbe1493))
- **chat:** Preserve complete quoted evidence ([4bfd1de](https://github.com/bjoernschotte/atlcli/commit/4bfd1de8a4c6d3238b1a3834caa23812e75c2af7))
- **chat:** Collapse abandoned facet alternatives ([5ade25d](https://github.com/bjoernschotte/atlcli/commit/5ade25d5705de93fa5bda638e7be3105014067f9))
- **chat:** Preserve distinct facet evidence ([2a0b51e](https://github.com/bjoernschotte/atlcli/commit/2a0b51e34224971234b96f5b2d5cddbfaf15dcb9))
- **chat:** Normalize forced tool selection ([8999c23](https://github.com/bjoernschotte/atlcli/commit/8999c234780617b1ae01e2362cfad00952fec656))
- **chat:** Normalize terminal native output ([edcb28f](https://github.com/bjoernschotte/atlcli/commit/edcb28f5f15656e31a0248822a655371cd5ab04a))
- **chat:** Collapse repeated answer prose ([b514def](https://github.com/bjoernschotte/atlcli/commit/b514def8fd380ea07bbb01b859c1da313f3dab19))
- **chat:** Enforce requested ranking order ([35e50ea](https://github.com/bjoernschotte/atlcli/commit/35e50eac6f01bdad459bf1042356562841e4ec91))
- **chat:** Prefer safe deterministic finalization ([8c34de2](https://github.com/bjoernschotte/atlcli/commit/8c34de2a90da44064fc3d654f3ec8f07fd3776a7))
- **chat:** Normalize measured rankings ([5cf1b5c](https://github.com/bjoernschotte/atlcli/commit/5cf1b5cbb939b98f8f88127346aea3ac3b2e0645))
- **chat:** Merge repeated supported prose ([fe27826](https://github.com/bjoernschotte/atlcli/commit/fe27826bb9681ee8e5a19879e8ec6eced65d8b05))
- **chat:** Preserve explicit question facets ([572d754](https://github.com/bjoernschotte/atlcli/commit/572d7542a41a48434f86335d385e3c3f961bb8c2))
- **research:** Score report integrity by mode ([bbc360c](https://github.com/bjoernschotte/atlcli/commit/bbc360ca16e5c00c937b46804f420f06c85feff9))
- **chat:** Stabilize terminal answer repair ([55f09a4](https://github.com/bjoernschotte/atlcli/commit/55f09a41ab98d553aced627dbd1888b1f9d21723))
- **chat:** Normalize private gold semantics ([5ed2626](https://github.com/bjoernschotte/atlcli/commit/5ed26263d8280aae6f0495042ab59ff5ab44733f))
- **chat:** Stabilize streamed answer presentation ([9121c18](https://github.com/bjoernschotte/atlcli/commit/9121c1860fa8396780f2339a70e354e19b50bf7a))
- **doctor:** Resolve active profile credentials (#131) ([9c974bd](https://github.com/bjoernschotte/atlcli/commit/9c974bd2277f3acc338f4f8fac38e6536b18aae4))
- **ci:** Normalize research source endings ([4c0776f](https://github.com/bjoernschotte/atlcli/commit/4c0776f10a49acc51814f92ca774305df99b7f58))
- **test:** Use portable temporary receipt path ([04b9c1b](https://github.com/bjoernschotte/atlcli/commit/04b9c1b0541804fac0002f693dcdc121033ee27e))
- **release:** Enforce canonical test runner ([7ac2bf8](https://github.com/bjoernschotte/atlcli/commit/7ac2bf8206fcdf0cafe31fb78cf87e00605d168f))
- **release:** Complete deterministic rehearsal ([4af22e3](https://github.com/bjoernschotte/atlcli/commit/4af22e3d53e40a893aec2a2be5f40030a10090cb))
- **release:** Honor required aggregate eligibility ([709f111](https://github.com/bjoernschotte/atlcli/commit/709f1114034198e755b4b31a7784eeeae71e3506))
- **release:** Provision extension fonts ([fc658ae](https://github.com/bjoernschotte/atlcli/commit/fc658aedfa2afd2837ebea49c55c5e636e02db6f))
- **release:** Freeze identity across retries ([6a99d09](https://github.com/bjoernschotte/atlcli/commit/6a99d09899fe5c9e64816aef03dcd7dc61fbb1c7))
- **release:** Preserve artifacts across retries ([79d9721](https://github.com/bjoernschotte/atlcli/commit/79d9721a06820f845e82e081fe5546ca68925b70))
- **release:** Retry transient dependency installs ([61e9263](https://github.com/bjoernschotte/atlcli/commit/61e9263502ac9d85df03bc1c1cb63a3b5fb8f8d5))
- **ci:** Retry frozen dependency installs ([70f8eb2](https://github.com/bjoernschotte/atlcli/commit/70f8eb202f617d6f642c8f4425b9b6f4be1e3ba1))
- **research:** Pin durable agent runtime packages ([2e02ae9](https://github.com/bjoernschotte/atlcli/commit/2e02ae9e7db4bad25b08335ea0094ebeda5d30a9))
- **ci:** Retry transient consumer dependency fetches ([4a310da](https://github.com/bjoernschotte/atlcli/commit/4a310dab3fabfbb34583c051d7f1b5bdeb6d6b82))
- **research:** Forward browser subagent config ([6cc3400](https://github.com/bjoernschotte/atlcli/commit/6cc3400217f66571094cf860160b56892b9f4425))
- **research:** Pin QuickJS browser config forwarding ([19e45ac](https://github.com/bjoernschotte/atlcli/commit/19e45aca283c09bd5d51357d36f3a80958634de1))
- **ci:** Ignore extension marker in dev shadow plan ([cf46966](https://github.com/bjoernschotte/atlcli/commit/cf469668f9474396d342e2e183a915447e9b3034))
- **ci:** Preserve release proof identity across reruns ([94366c4](https://github.com/bjoernschotte/atlcli/commit/94366c43b51911a731ed35cab58ecd2b4f585fca))
- **release:** Isolate tap credentials in environment ([7017d2d](https://github.com/bjoernschotte/atlcli/commit/7017d2da2eb0ddd5b5d658f0f32723b089b04865))
- **extension:** Hide prewarmed action palette host ([2d4d743](https://github.com/bjoernschotte/atlcli/commit/2d4d743d95fe71f21d21cd8acb08836013dea4ba))
- **release:** Exclude consumer extraction from bundle ([6590f1b](https://github.com/bjoernschotte/atlcli/commit/6590f1bee5a5accb842028ef50d4b0eb1ad7637c))
- **release:** Clean pre-write verification output ([bc67c44](https://github.com/bjoernschotte/atlcli/commit/bc67c44e3caecdd0366f9645385ea84cb4cd8172))
- **release:** Send asset content type and rollback drafts ([0302a3b](https://github.com/bjoernschotte/atlcli/commit/0302a3b8ec899b234d62d97016a27718f92071b1))
- **release:** Authorize and clean draft verification ([bee5dcd](https://github.com/bjoernschotte/atlcli/commit/bee5dcd3e0ddbfde7017695cb0af1a6bee4ae058))
- **release:** Download tap receipt with GitHub media type ([aab3cfa](https://github.com/bjoernschotte/atlcli/commit/aab3cfa13b20111f94eb021321170182c84f05ef))
- **release:** Keep rollback orchestration on main ([59b3236](https://github.com/bjoernschotte/atlcli/commit/59b3236ca1314480633fa043a541ba5884298dc7))
- **release:** Keep rollback orchestration on main (#189) ([4b05fe4](https://github.com/bjoernschotte/atlcli/commit/4b05fe4787997c50e8e1a4307fa928d360d8612b))
- **release:** Reuse pinned font cache ([85c3b36](https://github.com/bjoernschotte/atlcli/commit/85c3b36d7c3559b1421d505e8de1eadd0c1e7dc2))
- **release:** Reuse pinned font cache (#190) ([1818473](https://github.com/bjoernschotte/atlcli/commit/18184731cf128bf06ccc8a3c287a6b026f41b658))
- **release:** Complete scheduled dev proof (#193) ([406f5c7](https://github.com/bjoernschotte/atlcli/commit/406f5c701ea8f957c53039523f30ce25fa14e5f8))
- **confluence:** Restore reliable hierarchy exports (#188) ([690a397](https://github.com/bjoernschotte/atlcli/commit/690a39746373fe08159e1f1a36a118a3648837d8))
- **import-pdf:** Preserve rendered fallback order ([38bc985](https://github.com/bjoernschotte/atlcli/commit/38bc98531470e58615fdfa2b47a2dc2f630ff4df))
- **import-pdf:** Strip invalid control characters ([fbf6127](https://github.com/bjoernschotte/atlcli/commit/fbf6127a358dc8eea42f2950898bc2edf5d883b7))
- **import-pdf:** Provision PDFium in clean checkouts ([6b27aa5](https://github.com/bjoernschotte/atlcli/commit/6b27aa5b799a74160e04c4167bac82b9bdc1c0ec))
- **ci:** Isolate browser performance evidence ([032cba4](https://github.com/bjoernschotte/atlcli/commit/032cba43ddb45619b01dfb161f82fd4ee28bbfaa))
- **ci:** Run browser performance gates first ([3b16297](https://github.com/bjoernschotte/atlcli/commit/3b16297011ecdf7e1f00d89cdcf04d08856bcc59))
- **ci:** Restore browser assets under apps ([6987380](https://github.com/bjoernschotte/atlcli/commit/69873803364cdac36ae091a96bce2ca8e29325d3))
- **deps:** Coordinate Bun and research dependency updates (#210) ([a40d7ab](https://github.com/bjoernschotte/atlcli/commit/a40d7abde18798435d5a1331cbb93697902de31a))
- **deps:** Update dependency yaml to v2.9.1 (#211) ([1c0838a](https://github.com/bjoernschotte/atlcli/commit/1c0838a15e69db016a531df9d122ba7280ad9556))
- **deps:** Batch Renovate updates without losing approval gates (#214) ([2e3c57f](https://github.com/bjoernschotte/atlcli/commit/2e3c57fc065c903fd39ae6dd58ecc35b5432eeaf))
- **deps:** Explicitly isolate Node runtime updates (#215) ([cc18248](https://github.com/bjoernschotte/atlcli/commit/cc182487500ee4eb6a50e1d1bfb115a42c9f44d8))
- **deps:** Update dependency diff to v9 (#213) ([9e66ec9](https://github.com/bjoernschotte/atlcli/commit/9e66ec934346f5e8c2eceba727d4fb2163b6838e))
- **deps:** Update dependency entities to v8 (#224) ([a83f0c2](https://github.com/bjoernschotte/atlcli/commit/a83f0c221ac662658f1dfc9dd3d0ea74e5456e5f))
- **deps:** Update dependency streamdown to v2 (#226) ([c70e4f2](https://github.com/bjoernschotte/atlcli/commit/c70e4f27075bf1266421790079e6479a10c93c13))
- **deps:** Update dependency sharp to ^0.35.0 (#222) ([022d171](https://github.com/bjoernschotte/atlcli/commit/022d171ffc40e45270ad40e321cd67c793b08038))
- **deps:** Update astro ([f941da4](https://github.com/bjoernschotte/atlcli/commit/f941da4f50eb85ba8eb09316c2cfb9eb99bfeb38))
- **ci:** Preserve minimum Astro compatibility lane ([e5db3c7](https://github.com/bjoernschotte/atlcli/commit/e5db3c71753f45fab2e96ff86d78046f0051588a))
- **deps:** Update dependency markdown-it to v15 ([f95d68e](https://github.com/bjoernschotte/atlcli/commit/f95d68e8ac73a1eff3eedd728d5ca8d5a0f25ab7))
- **confluence:** Support markdown-it 15 plugin types ([023e8a1](https://github.com/bjoernschotte/atlcli/commit/023e8a157fea8c83ac194d393e3b7571d30f0f14))
- **deps:** Update dependency @tanstack/charts to v0.18.0 ([6a85bec](https://github.com/bjoernschotte/atlcli/commit/6a85bec0d129d68472d9c8db0d69b2015a2ab704))
- **charts:** Support TanStack Charts 0.18 ([332e113](https://github.com/bjoernschotte/atlcli/commit/332e113143fa8ab850a9c8c0483533505dc257d5))
- **deps:** Update stable non-major dependencies ([a8ab715](https://github.com/bjoernschotte/atlcli/commit/a8ab715a421c6f0f1bb7f327c252333cc97b8f09))
- **deps:** Complete stable non-major updates ([fae1cb5](https://github.com/bjoernschotte/atlcli/commit/fae1cb5f28d9fe538df1ae71059e3c23b16381cd))
- **confluence:** Stop code blocks gaining a trailing newline on round trip (#231) ([2285795](https://github.com/bjoernschotte/atlcli/commit/22857951b79a07b96f303197440a997aff678625))
- **confluence:** Preserve empty code and noformat blocks (#232) ([c27c413](https://github.com/bjoernschotte/atlcli/commit/c27c41367b86a5a99b270a2d0b972e310760a8f1))

### Documentation

- Add Astro 7 migration plan ([0fb55ce](https://github.com/bjoernschotte/atlcli/commit/0fb55cef0693978c4b39f18bc831da9c169c8c27))
- Record Astro 7 migration results ([fee3699](https://github.com/bjoernschotte/atlcli/commit/fee3699c6b729080b9cf071b37fef7d619298093))
- **spec:** 006 — isomorphic @atlcli/docx export engine (before PDF) (#31) ([c62db25](https://github.com/bjoernschotte/atlcli/commit/c62db25e32c4f8a5b7578cfd095e8dde2c111b64))
- **spec:** 005a — mermaid diagrams via beautiful-mermaid (after 005) (#33) ([f3fb7f4](https://github.com/bjoernschotte/atlcli/commit/f3fb7f4d32f678f0013080508da590b9f861d2e2))
- **spec:** Define PDF template customization UX (#43) ([4a71686](https://github.com/bjoernschotte/atlcli/commit/4a716860af298b1cd3be2c052f242d74e625b27e))
- **spec:** Export-expansion — baseline designs & implementation plan (#47) ([849b063](https://github.com/bjoernschotte/atlcli/commit/849b063a96fd95127d27babc36626efe83b2d6ac))
- **spec:** Correct stale status lines for merged specs 003/004/008 (#60) ([c24abef](https://github.com/bjoernschotte/atlcli/commit/c24abef4b0fdcc90633085650341cf6f9c6215e3))
- **spec-010:** PDF.js preview, durable background jobs, portable app layer (#74) ([010efd3](https://github.com/bjoernschotte/atlcli/commit/010efd3de4756b65a6371a212bb6129b7be7a7c5))
- **export:** Plan isomorphic background jobs ([c9ece40](https://github.com/bjoernschotte/atlcli/commit/c9ece40941c6227918c8808b7d0503bc7c7a830e))
- **export:** Link bounded spool draft PR ([133a91e](https://github.com/bjoernschotte/atlcli/commit/133a91eaf4c90e394739cd77fdadf419fadb8746))
- **export:** Link PDF executor draft PR ([d7a2dd8](https://github.com/bjoernschotte/atlcli/commit/d7a2dd8e56ecd1afdbec5c79c49a11307071a3ab))
- **export:** Link DOCX executor draft PR ([8a42fae](https://github.com/bjoernschotte/atlcli/commit/8a42faec4c3dea09d65bcf4f15970d61d3994469))
- Refresh README developer experience (#100) ([8ee3d67](https://github.com/bjoernschotte/atlcli/commit/8ee3d67107079a334e0ad4ca2b076b3818786c0d))
- Highlight export engine capabilities (#101) ([a35f6aa](https://github.com/bjoernschotte/atlcli/commit/a35f6aa444e6682bd80c08814da29e8f2bd2efe5))
- Showcase world-class document fidelity (#103) ([9034895](https://github.com/bjoernschotte/atlcli/commit/9034895de246683fae8dfe98949b3039a1032630))
- **extension:** Record research spike evidence ([bfaaeb0](https://github.com/bjoernschotte/atlcli/commit/bfaaeb00d4d3f11fab82ce2d6099f6ee0ae74d37))
- **research:** Plan durable scope-aware research agent ([30a5d0f](https://github.com/bjoernschotte/atlcli/commit/30a5d0f640e3b8de0d3c6ea4b96fef0646e646a7))
- **research:** Track detail selection provenance ([9279901](https://github.com/bjoernschotte/atlcli/commit/9279901941af98a8978ea1b34e84c23eb0bd148b))
- **research:** Record store conformance gate ([2327c15](https://github.com/bjoernschotte/atlcli/commit/2327c1567810f746109d3cf571923799280feef8))
- **research:** Record approval isolation gates ([c4ef49b](https://github.com/bjoernschotte/atlcli/commit/c4ef49be141bb7ed0659579d23697aba2013dd48))
- **research:** Record exact link policy proof ([26996b9](https://github.com/bjoernschotte/atlcli/commit/26996b924a50be480a16fa9a970325413b613ddf))
- **research:** Clarify run spend scope ([75c82a2](https://github.com/bjoernschotte/atlcli/commit/75c82a251a6b4ce93b2b212be5a6d2d182359d45))
- **research:** Record retrieval stop rationale ([58b3634](https://github.com/bjoernschotte/atlcli/commit/58b3634c186f2f5ae4fdc964d56df2d593b7d943))
- **research:** Record retrieval quality signals ([92002a0](https://github.com/bjoernschotte/atlcli/commit/92002a0d7ca7d79d20511a3e0af8a4d988b429f0))
- **research:** Record bounded cost controls ([245defb](https://github.com/bjoernschotte/atlcli/commit/245defb8cb36e2882c269eefdca4b93064334e07))
- **research:** Record dynamic checkpoint replanning ([6015030](https://github.com/bjoernschotte/atlcli/commit/6015030ca1ace25cf22e812617da3fbc54fe0c91))
- **research:** Record recovery parity proof ([a9a73d0](https://github.com/bjoernschotte/atlcli/commit/a9a73d0f2336e07dd81e371a49be563cda447e5e))
- **research:** Verify durable review gates ([1db58a3](https://github.com/bjoernschotte/atlcli/commit/1db58a3cfa7511df13d3e96c0123276f7357c562))
- **research:** Plan agentic chat quality workflow ([71066e1](https://github.com/bjoernschotte/atlcli/commit/71066e1669ed4478bb3cfcaf9f0ad581cff8d28a))
- **research:** Incorporate agentic chat review ([eb07ce7](https://github.com/bjoernschotte/atlcli/commit/eb07ce749cde606f2cb2bf1a543fbebc3eca8225))
- **research:** Stage agentic chat durability proof ([456c8e1](https://github.com/bjoernschotte/atlcli/commit/456c8e11fd15951d2b573f46d21cf3e8af1d35f8))
- **research:** Define retrieval quality proof gates ([db98fda](https://github.com/bjoernschotte/atlcli/commit/db98fdaf5214035d4a4f034f5fa7ecfcd1ac1ba4))
- **research:** Strengthen agent runtime invariants ([32b9992](https://github.com/bjoernschotte/atlcli/commit/32b999236c8ac6af4af47ea66b61001f9f075544))
- **research:** Define chat agent recovery track ([aa6414c](https://github.com/bjoernschotte/atlcli/commit/aa6414c77374f7da9dabe19a5650fbcf2f7c7090))
- **confluence:** Plan structured reading and AGG trial ([3257062](https://github.com/bjoernschotte/atlcli/commit/325706263ccf6d628dfcf3972e8427279ce99095))
- **chat:** Plan deep performance ratchet ([1237141](https://github.com/bjoernschotte/atlcli/commit/1237141cb0506ef8d60ccca9118b39ac42323dc7))
- **chat:** Record packed MV3 release proof ([84a2b01](https://github.com/bjoernschotte/atlcli/commit/84a2b0155b622618d16ed1d4da62289d673ed66b))
- **research:** Reconcile agent plan status ([5e929cf](https://github.com/bjoernschotte/atlcli/commit/5e929cf2f62294b037dfb761f1d12ace4e1f2235))
- **chat:** Close performance ratchet status ([937c4d9](https://github.com/bjoernschotte/atlcli/commit/937c4d9d6ddab8445fc875e0ba16007a7d5e967d))
- **chat:** Record auto quality proof ([91dc353](https://github.com/bjoernschotte/atlcli/commit/91dc3539095397a33cbed5ec23033d98c07a9a1d))
- **research:** Record targeted quality proofs ([1251bb7](https://github.com/bjoernschotte/atlcli/commit/1251bb73bf851a76c8cc434aefcf2af7d6db9ad3))
- **chat:** Close private cli gold gate ([310cb5d](https://github.com/bjoernschotte/atlcli/commit/310cb5d5538c168d9c8a85b1d663aa1c224e54d8))
- **publish:** Plan Astro web publishing (#142) ([fabafe8](https://github.com/bjoernschotte/atlcli/commit/fabafe80fccb6f4cedc106556200a7854bc93abc))
- Plan dev release channel ([9d875ae](https://github.com/bjoernschotte/atlcli/commit/9d875aec398940526bf5ba24d2d9e25b599b085a))
- Require green source SHA for dev releases ([b84ba46](https://github.com/bjoernschotte/atlcli/commit/b84ba46a773ecf65294fed852b92e3cd969fd789))
- **release:** Add dev channel operations evidence ([081b8b2](https://github.com/bjoernschotte/atlcli/commit/081b8b248b0927efc116f6b9892567ec39739ef2))
- **release:** Record green dev shadow proof ([48630dd](https://github.com/bjoernschotte/atlcli/commit/48630dd37de1779247210074ca13dedb3a19ff7a))
- **release:** Refresh dev shadow evidence ([5cce361](https://github.com/bjoernschotte/atlcli/commit/5cce36129bc7736e42880ccb4b04cc3acfd8f73a))
- **release:** Record live GitHub dev publication proof ([f3dcb32](https://github.com/bjoernschotte/atlcli/commit/f3dcb328b2695bfe3e119fb79b7a8b75a00eed81))
- **release:** Record live Homebrew dev channel proof ([81e1116](https://github.com/bjoernschotte/atlcli/commit/81e1116b5a5f74915afa2dffa70aa3198fa16b8e))
- **import-pdf:** Plan semantic PDF import MVP ([cd3a135](https://github.com/bjoernschotte/atlcli/commit/cd3a1356dd83cc74680ca05fbbdd06c05df61cdf))
- **import-pdf:** Plan PDFium import adapters ([1702e43](https://github.com/bjoernschotte/atlcli/commit/1702e43458d7fd610699c8f09522e23c8e15cc11))
- **import-pdf:** Default to bounded page trees ([58f7cc3](https://github.com/bjoernschotte/atlcli/commit/58f7cc3c075f2d342e2e91f7f07aa2e5f828349f))
- **import-pdf:** Record feasibility and drift evidence ([35dd658](https://github.com/bjoernschotte/atlcli/commit/35dd6585bf2dfc60e9ae7b05e530e5980fd0ed82))
- **import-pdf:** Complete security and operations guide ([fd8504b](https://github.com/bjoernschotte/atlcli/commit/fd8504be0b6012707c614500ddec3985f8b5282f))
- **extension:** Explain parallel browser evidence ([35148ff](https://github.com/bjoernschotte/atlcli/commit/35148ff27a5be24be9c8f6233ca4f2956f4e4c74))
- **specs:** Confluence virtual filesystem for coding agents (#202) ([8b08ad6](https://github.com/bjoernschotte/atlcli/commit/8b08ad65c547cf8fed1f03bf6fa118116226a32c))

### Features

- **core:** Browser-ready core — isomorphic clients, session auth, entity extractor (spec 001) (#29) ([dc50c3f](https://github.com/bjoernschotte/atlcli/commit/dc50c3f60a76f6e0ca1dee69ba5a21699fb2a20a))
- **extension:** Phase 1 — MV3 extension skeleton + session-auth read path (specs 002/003) (#30) ([40953db](https://github.com/bjoernschotte/atlcli/commit/40953db7c5c3696f382c4a65b94db2aef73776fe))
- **docx:** Close spec 004 — E2E passed, gaps G1 + G4 closed (#34) ([c2feae9](https://github.com/bjoernschotte/atlcli/commit/c2feae9ea4adb2db7ec1ddd92a99449f64164872))
- **docx:** Spec 006 — isomorphic @atlcli/docx export engine (#35) ([d4a95a9](https://github.com/bjoernschotte/atlcli/commit/d4a95a9531217b406749d88462a417885505b21f))
- **docx:** Spec 005 — self-built OOXML image module (images in DOCX export) (#36) ([af08b52](https://github.com/bjoernschotte/atlcli/commit/af08b52405560da0f9de76333066b3da15de12a3))
- **docx:** Close gap G3 — logo placeholders embed the space logo (#38) ([ea325b5](https://github.com/bjoernschotte/atlcli/commit/ea325b5eb270c2012629d9290d8f5d7a0dc39b23))
- **docx:** Spec 005a — mermaid diagrams render as vector drawings (svgBlip + PNG fallback) (#39) ([f3ab326](https://github.com/bjoernschotte/atlcli/commit/f3ab32627d660a0ed88b461f0b018fac1123eb82))
- **docx:** CLI renders mermaid diagrams — resvg-wasm rasterizer + CSS-flattened SVGs ([57f37a5](https://github.com/bjoernschotte/atlcli/commit/57f37a5e40cce850c8ccad1b2e02aae9cbd2ce3a))
- **pdf:** Ship browser-native Typst export (#42) ([f8b1340](https://github.com/bjoernschotte/atlcli/commit/f8b1340579527b03476d75cb9eca42078d4e5e51))
- **pdf:** Adapt inline layout in dense tables (#44) ([9a3c950](https://github.com/bjoernschotte/atlcli/commit/9a3c950ce36e63a88fbffe2f47172ebaf9cb9a95))
- **export:** Add reusable browser export runtimes (#46) ([08e57cd](https://github.com/bjoernschotte/atlcli/commit/08e57cdf52d8081f663c293ef0124d35597bf79c))
- **export:** Extend ExportBlock model for phase-1 content features (spec 001, sync point 0) (#49) ([885eec9](https://github.com/bjoernschotte/atlcli/commit/885eec969ca66ec39cf38504c4852125f76839ba))
- **pdf:** Template settings, watermark & template library (spec 007) (#52) ([ff4db5e](https://github.com/bjoernschotte/atlcli/commit/ff4db5edfe1a1dc44f4dd4aced629d9aab393f1d))
- **export:** Scope orchestration — tree, space and label export (spec 002) (#51) ([edc8e7c](https://github.com/bjoernschotte/atlcli/commit/edc8e7c2e42ea051b6c3292c385f438536f39ee2))
- **export:** Scroll-* compat macros, captions & table hardening (spec 003) (#54) ([a0448bb](https://github.com/bjoernschotte/atlcli/commit/a0448bba66b047a53d888a91ffe645ec4d73560e))
- **export:** Macro renderer registry with live Jira, diagrams & export_view fallback (spec 004) (#55) ([2038cbc](https://github.com/bjoernschotte/atlcli/commit/2038cbcd64a2a7ed9394f322f656ed886fb1715f))
- **pdf:** Bun-native PDF CLI — --format pdf with scope/label flags (spec 008) (#53) ([5bb2dd1](https://github.com/bjoernschotte/atlcli/commit/5bb2dd125517e3921aeaa95602237a864d51de68))
- **docx:** $scroll.includepage document pass & $scroll.metadata reclassification (spec 005) (#56) ([9f0b1b3](https://github.com/bjoernschotte/atlcli/commit/9f0b1b398fd37e0d51624550f62664d2927240d2))
- **docx:** Native list numbering, table widths, SVG embedding & STYLEREF checks (spec 006) (#58) ([af6fc4a](https://github.com/bjoernschotte/atlcli/commit/af6fc4a5d9d0b9b14cabbca8d522f3ea42d526a5))
- **quality-gates:** Shape-parity gate, conformance registry & security corpus (spec 011, round 1) (#57) ([ba2b29e](https://github.com/bjoernschotte/atlcli/commit/ba2b29e133d4bbf41f950207b8682e62e7da452d))
- **publishing:** Packaging readiness & API guards (spec 009) (#50) ([63b02ac](https://github.com/bjoernschotte/atlcli/commit/63b02aca09dba6421580b799cf6caa76d94e3d3c))
- **pdf:** Migrate template presentation into the manifest + second curated template (spec 012) (#64) ([c3e2a98](https://github.com/bjoernschotte/atlcli/commit/c3e2a980019bf5b764e20ef2763c95bc60a08d80))
- **quality-gates:** Conformance cases 001-006, M1 acceptance corpus & archive-policy gate (spec 011, round 2) (#62) ([3b335ba](https://github.com/bjoernschotte/atlcli/commit/3b335bac4fe6f2809e78d430c8776abc9aaeec68))
- **pdf:** Chapter-aware running head via features.header.mode (#66) ([62a0031](https://github.com/bjoernschotte/atlcli/commit/62a003134bb139270441be907bd1572ed41c7c4a))
- **security:** Archive/parse budgets, active-content policy & unified link scheme (spec 011) (#72) ([462e34c](https://github.com/bjoernschotte/atlcli/commit/462e34ce66d55112f9862fd5d450eb0bb96c5094))
- **pdf,docx:** Alt-text & language audits, honest accessibility statement (spec 011) (#70) ([d2656d0](https://github.com/bjoernschotte/atlcli/commit/d2656d028b8281f178ebd6eff5061b61595b7617))
- **bench:** Engine + end-to-end benchmark tiers, trend CI, Manuscript & M1 conformance (spec 011) (#71) ([ee84582](https://github.com/bjoernschotte/atlcli/commit/ee84582d7c5fb12bc1f43f3a0bb508998d7673a0))
- **extension:** Add publishing studio export integration ([d15e843](https://github.com/bjoernschotte/atlcli/commit/d15e843f876d486d75c8a65d535a42062d942a04))
- **export:** Add isomorphic export job kernel ([7e846ad](https://github.com/bjoernschotte/atlcli/commit/7e846ad0943a3523b6e825e7726086be06009390))
- **export:** Add bounded checkpoint pipeline ([0a04a33](https://github.com/bjoernschotte/atlcli/commit/0a04a33aa579f38e692ecb6c938e972f8bea1b8b))
- **export:** Add PDF job executor ([8495293](https://github.com/bjoernschotte/atlcli/commit/84952933ab66db4427dc1d427ac1f5e11889f84b))
- **export:** Add TypeScript DOCX job executor ([136e2de](https://github.com/bjoernschotte/atlcli/commit/136e2deeabb64bbe912821a3595672484878dd39))
- **export:** Add isomorphic background export jobs (#85) ([65ac1f8](https://github.com/bjoernschotte/atlcli/commit/65ac1f839dcf9f8a6e0cbaff90438b69f71524fc))
- **confluence:** Add ADF-primary export pipeline (#86) ([5876348](https://github.com/bjoernschotte/atlcli/commit/5876348343c5805c3424eea5d516a8c937b4f6f5))
- **jira:** Add issue attachment list, download and delete commands (#91) ([9ac4800](https://github.com/bjoernschotte/atlcli/commit/9ac48009dc0347e2239e72f181fe0e4c7bf47d33))
- **jira:** Positional key, multi-file upload and --comment for issue attach (#93) ([8366bc1](https://github.com/bjoernschotte/atlcli/commit/8366bc19e9707d2146ab717ff5c47449af5d0cfa))
- **export:** Add configurable Shiki themes (#106) ([a6b4c42](https://github.com/bjoernschotte/atlcli/commit/a6b4c42406642e1e10a906c78ce6f90d7a1e4f2d))
- **pdf-template:** Import Word design into verified PDF packs (#115) ([cb1f935](https://github.com/bjoernschotte/atlcli/commit/cb1f935693c13ed7e5c52b2a930faa9817b5f70a))
- **confluence:** Add host-neutral attachment delivery (#133) ([90c7ed9](https://github.com/bjoernschotte/atlcli/commit/90c7ed974a6f96eda43ba3d52d47b56b8ff42076))
- **confluence:** Export embedded Whiteboards as linked cards (#135) ([27d2e95](https://github.com/bjoernschotte/atlcli/commit/27d2e95bd90ea0695f5f7442efec807ec1dca155))
- **extension:** Adopt Kiteweave sidebar design system (#137) ([bdda236](https://github.com/bjoernschotte/atlcli/commit/bdda23617bea9dce5ffcb494417fff6b68a37903))
- **extension:** Define bounded research contracts ([0e3e3fd](https://github.com/bjoernschotte/atlcli/commit/0e3e3fd939536b74ba78538761226088989f63ec))
- **extension:** Add private research read seams ([588041a](https://github.com/bjoernschotte/atlcli/commit/588041a5a421257c4837616747ce2d57caa7ae6a))
- **extension:** Add bounded research read broker ([1987d92](https://github.com/bjoernschotte/atlcli/commit/1987d92379645072e41c1e0726271f9cae0e6421))
- **extension:** Add QuickJS research agent runtime ([bf06085](https://github.com/bjoernschotte/atlcli/commit/bf060855fa61b15c959b5ff89b1e6d2aef83ed5d))
- **extension:** Add research sidebar workflow ([b416ed4](https://github.com/bjoernschotte/atlcli/commit/b416ed4835958ff91d5c255cbe5770154bc041eb))
- **research:** Extract shared contracts and scope resolver ([c156d2f](https://github.com/bjoernschotte/atlcli/commit/c156d2fcafb17b6d3dc5235f3428d7c87ddb03da))
- **research:** Share scope discovery across hosts ([433e7dd](https://github.com/bjoernschotte/atlcli/commit/433e7ddfdb038003216abc81e9eed73576f06f07))
- **research:** Define scoped catalog capabilities ([8ed05f1](https://github.com/bjoernschotte/atlcli/commit/8ed05f12c43e39b28d507c44a035804c6a73f0d8))
- **research:** Broker scoped catalog reads ([2018a72](https://github.com/bjoernschotte/atlcli/commit/2018a724561f1e7ded294596ee4db55e3dfc1c38))
- **confluence:** Add paginated v2 space reads ([877b615](https://github.com/bjoernschotte/atlcli/commit/877b6153cda18c905327ac0eb81b18721e10ab24))
- **jira:** Make project catalog reads abortable ([d0e5737](https://github.com/bjoernschotte/atlcli/commit/d0e5737a0b85d13300d5e39a99e829f20bad7882))
- **research:** Adapt REST scope catalog providers ([f6229e8](https://github.com/bjoernschotte/atlcli/commit/f6229e87c7f89849d14e7caaebfec8737382c742))
- **research:** Expose scope catalog through PTC ([f99c4f2](https://github.com/bjoernschotte/atlcli/commit/f99c4f2275a68bd3acf5406ffb377fa937e12408))
- **research:** Add host-neutral session workspace ([043946b](https://github.com/bjoernschotte/atlcli/commit/043946b9840908ffe1ae292b63efc884e2ed5c1d))
- **cli:** Add bounded research one-shot host ([26ee2a6](https://github.com/bjoernschotte/atlcli/commit/26ee2a6d07ced051fd919066ccc86f2a2dad5990))
- **research:** Add dynamic graph and report artifacts ([5570a61](https://github.com/bjoernschotte/atlcli/commit/5570a6112388dd0a36ee5ec3e66de8ed7a2f0131))
- **cli:** Store research artifacts under documents ([9c87b01](https://github.com/bjoernschotte/atlcli/commit/9c87b011cc680675e9d8a8a640273c93f7b2e88a))
- **research:** Delegate graph runs to dynamic subagents ([98ee3c5](https://github.com/bjoernschotte/atlcli/commit/98ee3c52903dd1996b50adda6c81698308e6c50f))
- **research:** Detect funnel correspondence joins ([f6a7ea5](https://github.com/bjoernschotte/atlcli/commit/f6a7ea5d7b7152823bb10793ac6e9ad8ddc26299))
- **research:** Trace dynamic worker PTC calls ([7c566a7](https://github.com/bjoernschotte/atlcli/commit/7c566a740628406bff03ba0e5a1d20fe1a5ed042))
- **research:** Provide graph workflow skeleton ([e126b3a](https://github.com/bjoernschotte/atlcli/commit/e126b3a2768d2bb3e6def0b95399e6a5d6134da7))
- **research:** Prove dynamic deep research run ([6f25c92](https://github.com/bjoernschotte/atlcli/commit/6f25c922065f2896b6aa8941bcdf61e4627008eb))
- **research:** Prove browser-safe subagent dispatch ([822384e](https://github.com/bjoernschotte/atlcli/commit/822384ef0299ad79caec8d1b3a6ef17e7ef594b2))
- **research:** Harden scope catalog resolution ([afa64a1](https://github.com/bjoernschotte/atlcli/commit/afa64a1e582e0e61c99d7c11c2b6114cad4e5924))
- **research:** Run dynamic graph across hosts ([4af95d3](https://github.com/bjoernschotte/atlcli/commit/4af95d3211ec422496eb2578423f5e2a28e1fcce))
- **research:** Deliver equal CLI one-shot host ([635a1eb](https://github.com/bjoernschotte/atlcli/commit/635a1ebeadf5ca1ff9724eb05fa2a3a4419c4757))
- **research:** Fence accepted subagent packets ([5100204](https://github.com/bjoernschotte/atlcli/commit/5100204b40d06ad62511577948a7658bacb6393b))
- **research:** Verify natural language scope mentions ([fdb4024](https://github.com/bjoernschotte/atlcli/commit/fdb402483f1582d78085b812a6ff21132bd9c885))
- **research:** Stop on unresolved initial scope ([dc1b413](https://github.com/bjoernschotte/atlcli/commit/dc1b4136bd457aab187d437a59e7220744718497))
- **research:** Validate dynamic research graphs ([8b3a60c](https://github.com/bjoernschotte/atlcli/commit/8b3a60c4d048cf899daa4c891b0f553a7420280e))
- **research:** Orchestrate graph-bound subagents ([2a34077](https://github.com/bjoernschotte/atlcli/commit/2a34077015a4c174b1083f519c9c5e3dd060db95))
- **research:** Gate one-shot plans by policy ([8e9d7e4](https://github.com/bjoernschotte/atlcli/commit/8e9d7e436e0bc71589740d172a10ce446e1f95b0))
- **research:** Stream detailed execution traces ([9352d87](https://github.com/bjoernschotte/atlcli/commit/9352d877eda57b1d7bb3090cced72a6b0581e288))
- **research:** Admit supervisor graph proposals ([c31a0ad](https://github.com/bjoernschotte/atlcli/commit/c31a0ad1c63009e26a0715f2e8f0a2279cb1df29))
- **research:** Compose supervisor graph at runtime ([c73dbf9](https://github.com/bjoernschotte/atlcli/commit/c73dbf9a223a58d183dfc0bc9e0ddc84ee5836c3))
- **research:** Gate synthesis on reconciliation ([de19167](https://github.com/bjoernschotte/atlcli/commit/de1916710f2d41a7d67e6bab641d5f81f66079f8))
- **research:** Bound reconciliation repair ([f81fb75](https://github.com/bjoernschotte/atlcli/commit/f81fb75038ec7ad37f7d738c8b61414706761b1f))
- **research:** Project reconciliation packet set ([5095f30](https://github.com/bjoernschotte/atlcli/commit/5095f30a851132d8ac0e410406644a93dfd80569))
- **research:** Close scope contracts and lookup execution ([9ba6af7](https://github.com/bjoernschotte/atlcli/commit/9ba6af7af24614832e92b9ec4b4340a602684ab4))
- **research:** Resolve natural scope before agent runs ([171e019](https://github.com/bjoernschotte/atlcli/commit/171e0193d740627fd7b55cb0ea8968a2fb671710))
- **research:** Confirm ambiguous browser scope ([4306901](https://github.com/bjoernschotte/atlcli/commit/4306901162068ca6ac9946d763076d94ed85ed4c))
- **research:** Enforce atomic task packet budgets ([0d24ca7](https://github.com/bjoernschotte/atlcli/commit/0d24ca7ca803172a3a12d9178fd465aff6962246))
- **research:** Grant bounded scope catalog tools ([e853177](https://github.com/bjoernschotte/atlcli/commit/e853177505fa30e400ec19b5a84a6e8e51d311ee))
- **research:** Stop one-shot runs for brief clarification ([7c94f0b](https://github.com/bjoernschotte/atlcli/commit/7c94f0b00f57d9b5ecaf73707272b295fea0ba3e))
- **research:** Preserve clarification boundaries ([8733597](https://github.com/bjoernschotte/atlcli/commit/8733597f91be39331800ac31bc942a617d687642))
- **research:** Add durable session reducer ([842c927](https://github.com/bjoernschotte/atlcli/commit/842c92701ab966dffb1520021a6b6ad8124fc251))
- **research:** Add bounded session store port ([7bb68f9](https://github.com/bjoernschotte/atlcli/commit/7bb68f95966f1f23970003cd452de1309fd9456d))
- **research:** Scope LangGraph checkpoints to sessions ([c3f6211](https://github.com/bjoernschotte/atlcli/commit/c3f62118274ad50d29b8e792de464647a48b846d))
- **research:** Persist CLI sessions in SQLite ([a304e22](https://github.com/bjoernschotte/atlcli/commit/a304e22ab88052fb6c8532c48b11eecf38045e4c))
- **research:** Persist browser sessions in IndexedDB ([677d3ef](https://github.com/bjoernschotte/atlcli/commit/677d3ef35b0cb741a039b14429a1ee6461aa1913))
- **research:** Gate execution on durable plans ([d56161b](https://github.com/bjoernschotte/atlcli/commit/d56161b942e26f63428af27f8c3b82631dfd9311))
- **research:** Persist CLI plan-only sessions ([26c2e9f](https://github.com/bjoernschotte/atlcli/commit/26c2e9f5f63b828e8a0c0ada9403395db090c77c))
- **research:** Add revision-fenced session controls ([839504f](https://github.com/bjoernschotte/atlcli/commit/839504f529d937eebb16dda9e03a036e26db6cb8))
- **research:** Persist supervisor graph selections ([41946fd](https://github.com/bjoernschotte/atlcli/commit/41946fdeeabd412497edbda1c991a51ca1f3eb7a))
- **research:** Add durable dispatch journal ([aedf8a3](https://github.com/bjoernschotte/atlcli/commit/aedf8a361a376f3486c43f32ddb293b8780c119c))
- **research:** Wire durable task lifecycle ([59c7587](https://github.com/bjoernschotte/atlcli/commit/59c758773d580bde43d3a4ff20a51f4691da37e9))
- **research:** Hand off durable host sessions ([b7d394a](https://github.com/bjoernschotte/atlcli/commit/b7d394ad59c5949532796d51db34d03cfaed37fa))
- **research:** Persist CLI authentication waits ([e85b0a9](https://github.com/bjoernschotte/atlcli/commit/e85b0a94fa1cb300a1b53551ff5dbe4e343843f9))
- **research:** Resume authentication waits ([110d3c7](https://github.com/bjoernschotte/atlcli/commit/110d3c7749a6b27663dbb82dc052bbdc0e88adba))
- **research:** Persist LangGraph session checkpoints ([87cc60f](https://github.com/bjoernschotte/atlcli/commit/87cc60fe65c9014ca5141c0cbbd591896281b11d))
- **research:** Persist evidence source chunks ([f1f53f9](https://github.com/bjoernschotte/atlcli/commit/f1f53f9e98e07551715e6b89125880c20c82c001))
- **research:** Retain detail evidence at read boundary ([ef77fb2](https://github.com/bjoernschotte/atlcli/commit/ef77fb21fcb21ece7d111f2d5580e2ae4743633c))
- **research:** Retain evidence-backed claims ([5acdbcc](https://github.com/bjoernschotte/atlcli/commit/5acdbcc0385d575c0c7ed88e7b01a9572151a551))
- **research:** Invalidate claims on evidence refresh ([cd4ab0c](https://github.com/bjoernschotte/atlcli/commit/cd4ab0c95c1b2beb8ac73695a41a0323b3088f81))
- **research:** Persist evidence-linked outlines ([d5f7327](https://github.com/bjoernschotte/atlcli/commit/d5f7327ffdbb50f38e9803086cc6aa463d50afc7))
- **research:** Normalize evidence-backed claim candidates ([fff225a](https://github.com/bjoernschotte/atlcli/commit/fff225a7086213cb81f96e4908f4b0f9b27e6a8b))
- **research:** Normalize V2 evidence packets ([13311c3](https://github.com/bjoernschotte/atlcli/commit/13311c35fc8f6b435c268a1e0543df323e204b45))
- **research:** Admit host-normalized V2 packets ([51f6af5](https://github.com/bjoernschotte/atlcli/commit/51f6af5b4565b8077d4444ccf22e7ca32e9b7cae))
- **research:** Carry verified claims through V2 analysis ([d5fb664](https://github.com/bjoernschotte/atlcli/commit/d5fb66402d084031416e422fe529e1d5718eb618))
- **research:** Finalize evidence-backed V2 reports ([49f40ac](https://github.com/bjoernschotte/atlcli/commit/49f40ac16a70da7cc2ec54502d1a1f57f9487e0b))
- **research:** Publish durable V2 claim reports ([c270b2b](https://github.com/bjoernschotte/atlcli/commit/c270b2b5aa2885a7e25dfba8439d9ce75ff086a8))
- **research:** Persist V2 evidence outlines ([6664b03](https://github.com/bjoernschotte/atlcli/commit/6664b03ffcbf1b807d4737f2302d16060b2c116e))
- **research:** Render V2 outline sections ([b38fbc9](https://github.com/bjoernschotte/atlcli/commit/b38fbc9ba1e90fddbd64878ac6cbedaefa811a64))
- **research:** Add V2 outline planner ([e6f9600](https://github.com/bjoernschotte/atlcli/commit/e6f96003d37a50b4a8a0bcb03fbf0b0f6fec81d1))
- **research:** Delete durable CLI sessions ([ff0dd3f](https://github.com/bjoernschotte/atlcli/commit/ff0dd3f284fa4c1fdcf8023691bd552c391b38ca))
- **research:** Add durable CLI follow-up turns ([118bebc](https://github.com/bjoernschotte/atlcli/commit/118bebc82a8c0509d7bb35cdf58f9110b2f46754))
- **research:** Resume approved CLI plans ([b2f5bfd](https://github.com/bjoernschotte/atlcli/commit/b2f5bfd865ee96e9a94f6ae47ecf4b6041445773))
- **research:** Add durable evidence inspection ([0842c13](https://github.com/bjoernschotte/atlcli/commit/0842c138b35183511f8c35e4d397b9b8318e8b8b))
- **research:** Surface evidence coverage metadata ([c2a84ef](https://github.com/bjoernschotte/atlcli/commit/c2a84ef05b2a8e4b23d424c57d6172bc2c2a3876))
- **research:** Validate reconciliation namespaces ([f8486ca](https://github.com/bjoernschotte/atlcli/commit/f8486caee9a7831274a5bf806f7dbf73adabc256))
- **research:** Isolate browser evidence storage ([9f771d4](https://github.com/bjoernschotte/atlcli/commit/9f771d41c701db39cf0d285048260770d70a475f))
- **research:** Surface reconciliation outcomes ([3fbcda7](https://github.com/bjoernschotte/atlcli/commit/3fbcda793bbaeddf5959fb3467fc57bdfbf519d4))
- **research:** Prioritize detail candidates ([f3237c6](https://github.com/bjoernschotte/atlcli/commit/f3237c623e8df39ab4a7042b44b3dd0460e84a0a))
- **research:** Retain detail retrieval provenance ([e5b98dd](https://github.com/bjoernschotte/atlcli/commit/e5b98dddf6a95a5ebd7aabfc5b7e59bf533658ae))
- **research:** Assess bounded retrieval waves ([5df50f2](https://github.com/bjoernschotte/atlcli/commit/5df50f2c500b220ebeeee48ec096bbd7b01d8d20))
- **research:** Stream retrieval assessments ([e35ce46](https://github.com/bjoernschotte/atlcli/commit/e35ce467a61e63bb8aacedee46fb5c1fad755dbb))
- **research:** Persist retrieval assessments ([0ed65e8](https://github.com/bjoernschotte/atlcli/commit/0ed65e80e621bac472b95e3aa9721935610803e8))
- **research:** Append bounded task admissions ([61e6484](https://github.com/bjoernschotte/atlcli/commit/61e64848b5dc7e48a4737a2e506b137cab12cffd))
- **research:** Persist retrieval wave checkpoints ([c326a77](https://github.com/bjoernschotte/atlcli/commit/c326a776c1d01e07212a677c8883bcadde4340a5))
- **research:** Gate dynamic task frontiers ([09e1152](https://github.com/bjoernschotte/atlcli/commit/09e1152149029c2f5452f7f78fb7bb5e5c590938))
- **research:** Admit ready task frontiers ([30d0646](https://github.com/bjoernschotte/atlcli/commit/30d0646bc897a80c90863df03e6d631c7460aa8e))
- **research:** Gate eval continuations by checkpoint ([7a369d9](https://github.com/bjoernschotte/atlcli/commit/7a369d9e30e26ad88aeb3c814290636acd7d5d26))
- **research:** Persist wave continuations ([bc1e518](https://github.com/bjoernschotte/atlcli/commit/bc1e5186b858b3f168188c4547cdca157e9d6a37))
- **research:** Add retrieval checkpoint PTC ([38d6e89](https://github.com/bjoernschotte/atlcli/commit/38d6e89558ed8130d7bdea2948858e6041671d1a))
- **research:** Validate graph revisions ([67e2e92](https://github.com/bjoernschotte/atlcli/commit/67e2e92af8a5f075d51c05e28779d18b2fba2241))
- **research:** Journal graph revisions ([3aad39b](https://github.com/bjoernschotte/atlcli/commit/3aad39b2317ed93b79bec3d9f3fb6b704c9cd5fa))
- **research:** Add graph revision PTC ([52bf683](https://github.com/bjoernschotte/atlcli/commit/52bf68334c993b6f073e3c4b7c865e87a4253849))
- **research:** Hydrate durable task dependencies ([4a32235](https://github.com/bjoernschotte/atlcli/commit/4a32235b00e71ffc12eeb3ac3c9c9091c72a1914))
- **research:** Issue durable finalization continuations ([c60cdef](https://github.com/bjoernschotte/atlcli/commit/c60cdefd27a9667af2f92305a01a775000800aff))
- **research:** Project ready task frontiers ([cd096ba](https://github.com/bjoernschotte/atlcli/commit/cd096ba870f0542269e66d893bcdf8654d453dda))
- **research:** Continue durable deep frontiers ([0373d01](https://github.com/bjoernschotte/atlcli/commit/0373d01540913da794482a780245aab7acae8e56))
- **research:** Replan from validated coverage gaps ([cdf2df7](https://github.com/bjoernschotte/atlcli/commit/cdf2df73cb598513b0d0aec36b74b2ba3c104e51))
- **research:** Persist durable budget checkpoints ([8533f25](https://github.com/bjoernschotte/atlcli/commit/8533f251d2a0cd6e31843e20ce03c319e9b0719d))
- **research:** Resume issued durable continuations ([bd47d05](https://github.com/bjoernschotte/atlcli/commit/bd47d057d693f8ab4a897decd16b9e9ddddc7b35))
- **research:** List resumable browser sessions ([03919f9](https://github.com/bjoernschotte/atlcli/commit/03919f99fda2a0412934c376931a33ffe0bbced5))
- **research:** Persist durable clarification waits ([aa2626a](https://github.com/bjoernschotte/atlcli/commit/aa2626ab56abee5248a0efa7a0d1550030e52fdc))
- **research:** Add revision-fenced clarification flow ([636d92c](https://github.com/bjoernschotte/atlcli/commit/636d92cecbd47968a43e6c86d80433e0c3f48416))
- **research:** Add durable plan revision review ([5c1bf54](https://github.com/bjoernschotte/atlcli/commit/5c1bf54f198e139dbe4cb5bf200c64d7877f4486))
- **research:** Atomically revise approved scopes ([341317a](https://github.com/bjoernschotte/atlcli/commit/341317afc637905cfa3225085032ec1d874362a7))
- **cli:** Control scope expansion approvals ([2ef6dde](https://github.com/bjoernschotte/atlcli/commit/2ef6dde0268d4514fb91cf00d99e639e42d39f60))
- **research:** Review durable scope expansions ([306c071](https://github.com/bjoernschotte/atlcli/commit/306c07167ea10cbd29fccd208e48c5c4880a0ac3))
- **research:** Approve scope replacement plans ([dd7dcee](https://github.com/bjoernschotte/atlcli/commit/dd7dceec8c72f171a8ab365cedb5de2c9e34eb6b))
- **research:** Persist browser plan reviews ([a381a51](https://github.com/bjoernschotte/atlcli/commit/a381a5153caca33f7087a78747a99aa8e2a31295))
- **research:** Persist browser clarification reviews ([e620d29](https://github.com/bjoernschotte/atlcli/commit/e620d29408ee5217afaf9c75a7ff151eff449976))
- **research:** Persist browser scope clarifications ([c5c361e](https://github.com/bjoernschotte/atlcli/commit/c5c361ec8ec023b73afe4e6ee4f6c4db0fe84d0a))
- **research:** Recover CLI scope clarifications ([af24554](https://github.com/bjoernschotte/atlcli/commit/af245544cb9961fd892663ec0eeeff76c4767257))
- **research:** Add CLI pause controls ([5605b1e](https://github.com/bjoernschotte/atlcli/commit/5605b1ead95fdb39500edcc41b01f8c04a0567ca))
- **research:** Persist browser plan revisions ([d8a4553](https://github.com/bjoernschotte/atlcli/commit/d8a4553edf48a007634feea5d561d34a9d39a5e0))
- **research:** Add durable browser pause ([3bde2f7](https://github.com/bjoernschotte/atlcli/commit/3bde2f7e4816d91b7c1368bc8ae65190e48ce24f))
- **research:** Recover expired safe boundaries ([f83bf7f](https://github.com/bjoernschotte/atlcli/commit/f83bf7fa99fc745edba6421568b7d055575a5e7f))
- **research:** Fence concurrent browser resumes ([659e79d](https://github.com/bjoernschotte/atlcli/commit/659e79daaa39c3fef919c8eebb90121ac5a420c5))
- **research:** Delete browser sessions idempotently ([3d98b3c](https://github.com/bjoernschotte/atlcli/commit/3d98b3c6157faa6d12ab36e8af1000c1ef4896ba))
- **research:** Persist bounded steering revisions ([838a0aa](https://github.com/bjoernschotte/atlcli/commit/838a0aa9649c488225e80649f8f65f811aa59a1e))
- **cli:** Add bounded research steering control ([85cac0f](https://github.com/bjoernschotte/atlcli/commit/85cac0fa603e013a207884b0ce1769f6c2770f63))
- **extension:** Steer paused research checkpoints ([18a7f4b](https://github.com/bjoernschotte/atlcli/commit/18a7f4b77ec5076b32a4c08fc7c4ecd6dfd510a7))
- **research:** Resolve exact linked entities ([b2fc6aa](https://github.com/bjoernschotte/atlcli/commit/b2fc6aac6a3d1ed6dd9b4cf9157bc17e6c6afb1f))
- **research:** Retrieve approved exact entities ([dbe072a](https://github.com/bjoernschotte/atlcli/commit/dbe072a525cd0e4cc1b6800d7969c9cbc8a8415e))
- **research:** Retain discovered scope candidates ([0f4f981](https://github.com/bjoernschotte/atlcli/commit/0f4f9812561b74193382130714cf2e605060a33c))
- **research:** Persist supervisor scope decisions ([d466646](https://github.com/bjoernschotte/atlcli/commit/d4666466504d9174ddf23e1409d4f9ad908e0915))
- **research:** Gate scope expansion through supervisor ([8e9fcdc](https://github.com/bjoernschotte/atlcli/commit/8e9fcdc1a058fa292f7632a85608570d5aa367e9))
- **research:** Preauthorize exact linked entities ([f5719c6](https://github.com/bjoernschotte/atlcli/commit/f5719c6f9707e8711398778202db6fafa5e364f6))
- **research:** Checkpoint durable supervisor waves ([c7069c5](https://github.com/bjoernschotte/atlcli/commit/c7069c53505d29deb121ba4b553b06a007aab1d2))
- **research:** Bind coverage targets to moderator ([4592977](https://github.com/bjoernschotte/atlcli/commit/45929774587ea5086d8d08d8275ad289ff883b0d))
- **research:** Add durable virtual workspace ([cd95d7d](https://github.com/bjoernschotte/atlcli/commit/cd95d7d3b8521582e6f403710359780e33eb49e7))
- **research:** Add immutable message lineage ([caafc62](https://github.com/bjoernschotte/atlcli/commit/caafc625be46a621f82ecb1d14e15f6960957044))
- **research:** Archive transcripts before compaction ([065645f](https://github.com/bjoernschotte/atlcli/commit/065645f9d7e20246ba085a606efc4dd217748636))
- **research:** Enable durable native summarization ([8cf1a57](https://github.com/bjoernschotte/atlcli/commit/8cf1a57fbf3c861568e37c3596397847080e6f36))
- **research:** Assemble bounded durable turn context ([5d03c9e](https://github.com/bjoernschotte/atlcli/commit/5d03c9eb705b25e3e58021d96862c8ddb8eb8ab7))
- **research:** Cap model run spend ([727f6a9](https://github.com/bjoernschotte/atlcli/commit/727f6a9e0c70d96e389da232e3759e9c47f93bfc))
- **research:** Persist session model budgets ([99d04d6](https://github.com/bjoernschotte/atlcli/commit/99d04d66dc18923eb8e85ebffe42103f34597261))
- **research:** Expose browser session cost ceiling ([e414ae4](https://github.com/bjoernschotte/atlcli/commit/e414ae4af687ba235d402b547a2f68953cb48533))
- **research:** Show durable plan budgets before approval ([71a17c5](https://github.com/bjoernschotte/atlcli/commit/71a17c5cc437aa9045d033c1a432a966a1253fdf))
- **research:** Project retained session turns ([0e6150a](https://github.com/bjoernschotte/atlcli/commit/0e6150a6ee14728646801dfa1dfb9e1b7d14af84))
- **research:** Add browser follow-up turns ([ab1ff6b](https://github.com/bjoernschotte/atlcli/commit/ab1ff6b9acda70ea395a78685a57d35536dece35))
- **research:** Compact durable checkpoints ([8be9a8c](https://github.com/bjoernschotte/atlcli/commit/8be9a8c2e0275b8a392f824f86058aab3ed7e605))
- **research:** Persist durable session artifacts ([a3bab6b](https://github.com/bjoernschotte/atlcli/commit/a3bab6be5248376b5768930f65017524a96f8c90))
- **research:** Retain decision rationale ([c3c8efd](https://github.com/bjoernschotte/atlcli/commit/c3c8efd0e79334d60be0d2f0185d5cda85396526))
- **research:** Expose source scope authority ([d0b1f58](https://github.com/bjoernschotte/atlcli/commit/d0b1f5845bed2605c39ce82d4759137f430544ab))
- **research:** Disclose search freshness limits ([a515b41](https://github.com/bjoernschotte/atlcli/commit/a515b415ad141929b3f1b0879b3bb6c7910afe33))
- **research:** Bound browser run duration ([7a693b7](https://github.com/bjoernschotte/atlcli/commit/7a693b721dd518de224670368e9a0a63c1285f7c))
- **research:** Moderate coverage after outline ([8abe9cc](https://github.com/bjoernschotte/atlcli/commit/8abe9cc9910d26afc4dc0c9aba73d958a7b5bd8e))
- **research:** Disclose plan cost envelope ([b43b358](https://github.com/bjoernschotte/atlcli/commit/b43b358f52be3db0246e92c4764d531ff66aeb1f))
- **research:** Show tracked run budget ([760019c](https://github.com/bjoernschotte/atlcli/commit/760019cd71cf96308631ea7cc334d38416d72af3))
- **research:** Revalidate expired evidence ([f5a7d57](https://github.com/bjoernschotte/atlcli/commit/f5a7d5760f7c0b473ddd564bd8a1a606c43b125d))
- **research:** Add typed retrieval filters ([2ac034a](https://github.com/bjoernschotte/atlcli/commit/2ac034ad13ef61f282fec54159f52742cb98b717))
- **research:** Retain bounded source relations ([ab683b0](https://github.com/bjoernschotte/atlcli/commit/ab683b03efcd69f3478a5f9bb91e34b79bebbb25))
- **research:** Add direct child retrieval intent ([4d92aff](https://github.com/bjoernschotte/atlcli/commit/4d92afff57f6d989a0d46dedf51f161dcc1388a2))
- **research:** Retain bounded jira comment evidence ([f0bafb5](https://github.com/bjoernschotte/atlcli/commit/f0bafb5e2a7b6e85088d9b8044df57f1f0160020))
- **research:** Add bounded confluence comment reads ([252ee1c](https://github.com/bjoernschotte/atlcli/commit/252ee1cea92ec5969abc3b192e89e8f9b76f179e))
- **research:** Support localized report output ([989177a](https://github.com/bjoernschotte/atlcli/commit/989177af1d32658810a510721f5d60fac6efb799))
- **research:** Project cross-product links ([93abe95](https://github.com/bjoernschotte/atlcli/commit/93abe9577909a2bfd65578ec86978d5d1f62a54e))
- **research:** Add durable chat workflow ([ada4d86](https://github.com/bjoernschotte/atlcli/commit/ada4d86144d6951e9d50bcf0f49b97f53275b160))
- **extension:** Add conversational AI workspace ([7d344a4](https://github.com/bjoernschotte/atlcli/commit/7d344a4879f328ba7a31c1c9bf9ded5128572394))
- **cli:** Add durable read-only chat ([af63791](https://github.com/bjoernschotte/atlcli/commit/af6379148214c263c1ba6a5fb937791a180e93a1))
- **chat:** Add adaptive thinking modes ([5f20694](https://github.com/bjoernschotte/atlcli/commit/5f20694f37df943d37d8c26d38e1bea33812a460))
- **research:** Decouple chat quality policy ([253994e](https://github.com/bjoernschotte/atlcli/commit/253994e3c59abbab03e15c3f534c5319d502fa6b))
- **chat:** Split chat and research agent roots ([ca71633](https://github.com/bjoernschotte/atlcli/commit/ca71633b86fc259ba00d639092df58a648b28517))
- **chat:** Read bound Atlassian context directly ([260f523](https://github.com/bjoernschotte/atlcli/commit/260f523d0ce0f1f76fd45fc76e553643e69a1dae))
- **chat:** Navigate long Confluence pages ([85a91cd](https://github.com/bjoernschotte/atlcli/commit/85a91cd881d95c772c39bd2355e10bc58fb24f71))
- **chat:** Preserve structured Confluence evidence ([f62e7ab](https://github.com/bjoernschotte/atlcli/commit/f62e7ab9d0bd087f8eb624444cf301bd39b24fe6))
- **research:** Add streaming agentic chat runtime ([8b4f938](https://github.com/bjoernschotte/atlcli/commit/8b4f9386f859941dab9ea357423dfe93d7593547))
- **chat:** Add accountable streaming retrieval ([1f15519](https://github.com/bjoernschotte/atlcli/commit/1f155190ac473734103429522278792a009df655))
- **chat:** Persist related scope proposals ([06025aa](https://github.com/bjoernschotte/atlcli/commit/06025aaf1a046eafa58212666f292531c33baede))
- **chat:** Add quality-gated streaming synthesis ([f673851](https://github.com/bjoernschotte/atlcli/commit/f673851e53b15bb0a0e7a1af525b17f53acd5986))
- **chat:** Add durable evidence memory ([4a9353d](https://github.com/bjoernschotte/atlcli/commit/4a9353da5e3713f8eb20102ba5443f627af30344))
- **chat:** Add durable HITL checkpoints ([1dbf454](https://github.com/bjoernschotte/atlcli/commit/1dbf45492ed307845c5cd55032ee314ac7b08b00))
- **chat:** Transport durable HITL across hosts ([c1aca6c](https://github.com/bjoernschotte/atlcli/commit/c1aca6c261dfc5e9c7808d316192e0bf084b89fc))
- **chat:** Resume HITL in the CLI ([084da9d](https://github.com/bjoernschotte/atlcli/commit/084da9d7e45b437edf9ab2917f98949501b9b6c7))
- **chat:** Persist live queue controls ([d967291](https://github.com/bjoernschotte/atlcli/commit/d967291b46c3c072f8c5dadb862e6c4ea810ffd5))
- **chat:** Replay semantic activity ([653e0dc](https://github.com/bjoernschotte/atlcli/commit/653e0dc6217c4796f1b6142df3167bd41450be00))
- **chat:** Resume checkpointed steering ([934a521](https://github.com/bjoernschotte/atlcli/commit/934a521aa2d926e25323e323574d45f47c0e057f))
- **chat:** Recover interrupted model streams ([f66b19e](https://github.com/bjoernschotte/atlcli/commit/f66b19e6eef3f81ea93081bfbd5dde2d66561fb5))
- **chat:** Add host-neutral product port ([4902c09](https://github.com/bjoernschotte/atlcli/commit/4902c09da04fad7e5f6ea6a2f3f9e06facfed165))
- **chat:** Align cli and conversation history ([638408b](https://github.com/bjoernschotte/atlcli/commit/638408baf43b824be81c9d3cb61280b0342bc8b5))
- **chat:** Bind cli steering checkpoints ([2afacc8](https://github.com/bjoernschotte/atlcli/commit/2afacc8ad999145fd0c8565c7834f3cf59678202))
- **chat:** Add interactive cli controls ([9eb12fe](https://github.com/bjoernschotte/atlcli/commit/9eb12fee531983d8b22102e15b2473bc142ff657))
- **chat:** Present semantic cli activity ([8e172a5](https://github.com/bjoernschotte/atlcli/commit/8e172a589c4221df7f5162265a18e3dd0a3ba814))
- **chat:** Expose cli conversation history ([fe4b043](https://github.com/bjoernschotte/atlcli/commit/fe4b04388c8839cacd14a707fde31442aca87895))
- **chat:** Prove dynamic streaming workflow ([9208d2a](https://github.com/bjoernschotte/atlcli/commit/9208d2a04297c50e5103b3cd0488db059bbd627b))
- **chat:** Add privacy-safe answer feedback ([84dff51](https://github.com/bjoernschotte/atlcli/commit/84dff518af82fdc50cb03127add0c975d9b593e8))
- **extension:** Persist BYOK keys on device ([54f7bdc](https://github.com/bjoernschotte/atlcli/commit/54f7bdc15ff3e7dc6f0990b2708354b5847c5778))
- **research:** Assemble release candidate receipts ([743b79d](https://github.com/bjoernschotte/atlcli/commit/743b79da110c8fbdc77f15b01a8bb3140b64d469))
- **extension:** Add Rovo visibility preference (#141) ([cdf11eb](https://github.com/bjoernschotte/atlcli/commit/cdf11eb7d1f642528b6d8c995ea90ab75fffd77b))
- **publish:** Add Confluence chart ExportBlock parity (#143) ([cbd7ece](https://github.com/bjoernschotte/atlcli/commit/cbd7eceaf8ec36bf8063c1bf03624f5c8c9c69e1))
- **pdf:** Add declarative template-pack compositions (#145) ([8b4b93f](https://github.com/bjoernschotte/atlcli/commit/8b4b93fbadfdfc12b213d188de2508fb7903ce48))
- **pdf:** Anchor cover metadata at bottom (#146) ([2bf0006](https://github.com/bjoernschotte/atlcli/commit/2bf00066bc9eeac1c8dc2f7a0e039139e205c41e))
- **pdf:** Migrate the browser runtime to Typst 0.15.1 (#147) ([943bbb6](https://github.com/bjoernschotte/atlcli/commit/943bbb65dd6aaa42b6fcf6d544310d4c34959694))
- **pdf:** Add template capability catalog v3 (#148) ([8b664e3](https://github.com/bjoernschotte/atlcli/commit/8b664e3347ea2546f85f7ad97fabe755bb714238))
- Add streamed semantic Atlassian diffs (#149) ([878675a](https://github.com/bjoernschotte/atlcli/commit/878675a3ff4709f86bc7913c3b543a1fe1ae2c14))
- **extension:** Implement Atlassian action palette MVP (#154) ([e03755e](https://github.com/bjoernschotte/atlcli/commit/e03755e758b5d83cd5f3c6227060fba247f89e29))
- **release:** Define dev release identity ([4747fa3](https://github.com/bjoernschotte/atlcli/commit/4747fa39956f9cffd0059c3143292535318437fa))
- **release:** Build deterministic release artifacts ([6606ba5](https://github.com/bjoernschotte/atlcli/commit/6606ba55b4ec8c42512c41097e8f5f49f319b607))
- **release:** Verify exact release artifacts ([49442b2](https://github.com/bjoernschotte/atlcli/commit/49442b2a1bd29eee680da1ce06c8b1f698471db3))
- **release:** Share verified artifact workflow ([ff24908](https://github.com/bjoernschotte/atlcli/commit/ff24908dd58ed51bda1eb6259ba5e7b1d8abc39f))
- **release:** Gate dev builds on green main ([54d19b9](https://github.com/bjoernschotte/atlcli/commit/54d19b907f1ecde0844e8c3c3a0c5f81a9ce9268))
- **release:** Publish verified draft transactions ([282b376](https://github.com/bjoernschotte/atlcli/commit/282b376f3fa89605aa9058958a63c809f5630241))
- **release:** Publish verified Homebrew dev formula ([7c6feaa](https://github.com/bjoernschotte/atlcli/commit/7c6feaa86804c4eb1be60b248989bca941ef6bde))
- **release:** Add mutation-free dev rehearsal ([37d7ec3](https://github.com/bjoernschotte/atlcli/commit/37d7ec3569e48cfe218f8f9aae5795421887a671))
- **release:** Fence dev channel rollbacks ([5fa102c](https://github.com/bjoernschotte/atlcli/commit/5fa102c2ad0e7ef51a1db78b069d04f52364eb16))
- **release:** Verify immutable dev attestations ([3741707](https://github.com/bjoernschotte/atlcli/commit/3741707ad4cb8db93fdf1da83960a29127f815c8))
- **import-docx:** Semantic DOCX import — full Cloud feature set + DC contract track (#61) ([b6826af](https://github.com/bjoernschotte/atlcli/commit/b6826af5489ca08db6dea0e1ca384323c0d1c59f))
- **import-pdf:** Add safe PDF facts and classification ([aa20b2c](https://github.com/bjoernschotte/atlcli/commit/aa20b2cbe3c246a008d5dd371114c60de0826d07))
- **import-pdf:** Extract tagged document semantics ([6529467](https://github.com/bjoernschotte/atlcli/commit/6529467ff49c3cd5601d7751f785925d63f493d8))
- **import-pdf:** Add conservative geometry reading order ([ba76a08](https://github.com/bjoernschotte/atlcli/commit/ba76a08ee3a87bc38c9319829fc1062c2c306394))
- **import-pdf:** Reconstruct qualified tables ([bfdc4dc](https://github.com/bjoernschotte/atlcli/commit/bfdc4dcc70e57df603655ad86debfcdf420b6ff6))
- **import-pdf:** Preserve figures with bounded fallbacks ([2e57031](https://github.com/bjoernschotte/atlcli/commit/2e57031dd06d2e8134c6bdbb8e05ffe0cb6b462a))
- **import-pdf:** Add review-first CLI planning ([25b6900](https://github.com/bjoernschotte/atlcli/commit/25b6900c609a61b190309077e20fb43971a22ae4))
- **import-pdf:** Add destination-safe source retention and split ([39775ac](https://github.com/bjoernschotte/atlcli/commit/39775ac64b6916f892d0144fc474fb27b607cfe8))
- **import-pdf:** Classify visual fallback scope ([f0f48f0](https://github.com/bjoernschotte/atlcli/commit/f0f48f01a95baa03042cd225718d7a768cb0576c))
- **import-pdf:** Render bounded fallback regions ([62be516](https://github.com/bjoernschotte/atlcli/commit/62be51677cb893c95e5b80e73585bd974ed93f38))
- **import-pdf:** Add collapsed fallback presentation ([7c5bd3e](https://github.com/bjoernschotte/atlcli/commit/7c5bd3e7fefdd28494b83a6e2fd9dc1e6e2c9f30))
- **cli:** Control PDF visual fallback placement ([1519227](https://github.com/bjoernschotte/atlcli/commit/1519227a6dcc4e7c62649a41d046b33d0f83a209))
- **drawio:** Add Draw.io previews and Confluence sync integration (#197) ([cb981de](https://github.com/bjoernschotte/atlcli/commit/cb981dea1f83d4dd5e17932239e42f99a1a607c7))
- **confluence:** Round-trip native Mermaid macros (#204) ([eb94264](https://github.com/bjoernschotte/atlcli/commit/eb94264b010ff8c0e2ab0e59117213220ec37b75))
- **confluence:** Add optional NFS mount transport (#203) ([a635125](https://github.com/bjoernschotte/atlcli/commit/a635125f75fbd56eca84620f25212b5e14309f77))
- **release:** Adopt UTC CalVer for product releases (#233) ([e7b73a1](https://github.com/bjoernschotte/atlcli/commit/e7b73a1e572747a01066f59319f03ea011628b53))

### Miscellaneous

- Add AGENTS.md symlink ([cfe4a95](https://github.com/bjoernschotte/atlcli/commit/cfe4a95ba23fdf767bfa46a929372f6a346f9922))
- **docs:** Upgrade to Astro 7 ([192a309](https://github.com/bjoernschotte/atlcli/commit/192a309d4cd47b1f423cc91dac06ca8826b74d3f))
- **docs:** Validate Astro documentation builds ([f30a813](https://github.com/bjoernschotte/atlcli/commit/f30a813abb6641a918e7e89366ba00dbfe93c162))
- **docs:** Upgrade documentation to Astro 7 (#26) ([351de51](https://github.com/bjoernschotte/atlcli/commit/351de51257e8a62623c726bed6da6709ec1f43cb))
- Update actions to Node 24 runtimes ([f9bd764](https://github.com/bjoernschotte/atlcli/commit/f9bd764abd44978da3251f9539e9198730e6ec65))
- Update actions to Node 24 runtimes (#27) ([19b14a1](https://github.com/bjoernschotte/atlcli/commit/19b14a1c120ef84e213286232a43a64025e94c94))
- Relicense from MIT to Apache License 2.0 (#32) ([8e8a634](https://github.com/bjoernschotte/atlcli/commit/8e8a634db992098dd8daad8b39f9cd630c436b69))
- Optimize workflow routing and gates (#84) ([e25a481](https://github.com/bjoernschotte/atlcli/commit/e25a4815b0b411d99b952444a514765c74fbfdd7))
- Run CI when a pull request leaves draft (#95) ([3819696](https://github.com/bjoernschotte/atlcli/commit/38196962f40e65591fe7c8551d1badab40cde8d7))
- **research:** Add tracked privacy gate ([6774016](https://github.com/bjoernschotte/atlcli/commit/677401607eede8f91d5177ca1313284f388771ff))
- **research:** Parameterize privacy scan ([3ba84fd](https://github.com/bjoernschotte/atlcli/commit/3ba84fd3810256a087ff22b1d9fc5e0b7650c04b))
- Preserve existing formatting ([5c54fa6](https://github.com/bjoernschotte/atlcli/commit/5c54fa694b8b4a019e1cfcaf8833dff75985ec06))
- **research:** Close automated chat release gates ([fa9699f](https://github.com/bjoernschotte/atlcli/commit/fa9699f605e838a4e46ae6763f7ee1c04f13a4b5))
- Sync research branch with main ([e23edf1](https://github.com/bjoernschotte/atlcli/commit/e23edf159e642bbc5810d0e843da4295fcbe3583))
- **api:** Refresh confluence surface report ([60d6f50](https://github.com/bjoernschotte/atlcli/commit/60d6f500daa72c3fa39085cb4b84985e5323a1a6))
- Balance required test lanes by duration (#152) ([0adae61](https://github.com/bjoernschotte/atlcli/commit/0adae61967e9c48589fe22a4404e91c748aa4b46))
- **release:** Avoid duplicate packed product matrix ([814f2b3](https://github.com/bjoernschotte/atlcli/commit/814f2b397fb93aea0c6915bf64a470987767771c))
- **release:** Focus downloaded asset smoke ([d5353c8](https://github.com/bjoernschotte/atlcli/commit/d5353c8f23b9380a0c17a1cd01ad02beec229f47))
- **release:** Schedule one-shot dev build (#191) ([6eccfd5](https://github.com/bjoernschotte/atlcli/commit/6eccfd5b5a58419196ffe2145eac6ec03a10cd12))
- **release:** Restore nightly schedule and retry live acceptance (#192) ([e439c62](https://github.com/bjoernschotte/atlcli/commit/e439c62f318bee363045ef8beab62800704213f0))
- Optimize Turborepo task reuse and telemetry (#195) ([e3c6b8c](https://github.com/bjoernschotte/atlcli/commit/e3c6b8c25c83b4ca38cf66fa14eafc875fc0ed1f))
- Parallelize browser evidence lanes ([1bfc85e](https://github.com/bjoernschotte/atlcli/commit/1bfc85ef50c221e666ea9d8e6a9bb01e131a068a))
- Isolate browser lanes across runners ([87344c5](https://github.com/bjoernschotte/atlcli/commit/87344c59a691db720d6574c3a7508a85e9c3494f))
- **deps:** Configure hosted Renovate updates (#205) ([2a78489](https://github.com/bjoernschotte/atlcli/commit/2a784890063783bb79ca3924a201f6348b7039da))
- **deps:** Update dependency @types/emscripten to v1.41.6 (#207) ([c08bc2f](https://github.com/bjoernschotte/atlcli/commit/c08bc2f057b252831f3b0c837fbd9027f5e286ae))
- **deps:** Update dependency jszip to v3.10.2 (#208) ([b56cede](https://github.com/bjoernschotte/atlcli/commit/b56cede80fda601d9e3ce942713413a5a5e24ca6))
- **deps:** Update dependency turbo to v2.10.13 (#209) ([1242b9c](https://github.com/bjoernschotte/atlcli/commit/1242b9cd493a0b5e04f7893e0e9b44ef27d6468d))
- **deps:** Update github actions (#216) ([1b7b975](https://github.com/bjoernschotte/atlcli/commit/1b7b975598b6a9b3d6cfcf5d19192a4fbbc9ba05))
- **deps:** Update dependency bun to v1.4.2 (#212) ([2a0de3e](https://github.com/bjoernschotte/atlcli/commit/2a0de3e03c47891642dd63bc625f8441cd92abb0))
- **deps:** Update dependency wxt to ^0.21.0 (#219) ([3ca98a3](https://github.com/bjoernschotte/atlcli/commit/3ca98a31ae0b902594c3e65d18920fe6b3170116))
- **deps:** Update dependency node to v22.23.2 (#218) ([eb1ac2d](https://github.com/bjoernschotte/atlcli/commit/eb1ac2dc248de4246b5c8c6151417ab1817bc428))
- **deps:** Update dependency @types/chrome to ^0.3.0 (#217) ([fc90bae](https://github.com/bjoernschotte/atlcli/commit/fc90baef207cc760eb499caca240857978d26f75))

### Performance

- **docx:** Blazing-fast exports — parallel round-trips, wasm shiki, asset caches (#41) ([a56fce2](https://github.com/bjoernschotte/atlcli/commit/a56fce27977500a91c37d3a0e6b5ddd114c1b3d1))
- **docx:** Split Shiki engines by runtime (#107) ([52a5abb](https://github.com/bjoernschotte/atlcli/commit/52a5abbb6e962849e4d7a81514940e190b0b8385))
- **code-highlight:** Overlap grammar and highlighter imports (#109) ([36e6456](https://github.com/bjoernschotte/atlcli/commit/36e64566a9afb6ea9d1f979ff8ab3f29d851002a))
- **docx:** Prepare complete render runtime after export intent (#112) ([004cb29](https://github.com/bjoernschotte/atlcli/commit/004cb29fdb327a2004f876887680272d3410b2c0))
- **code-highlight:** Replace aggregate Shiki catalogues with fine-grained loaders (#113) ([bf9299d](https://github.com/bjoernschotte/atlcli/commit/bf9299dd465117e146d4c0abab0ce3d689984b38))
- **ci:** Reduce full Linux quality runtime (#114) ([a290e84](https://github.com/bjoernschotte/atlcli/commit/a290e8451695f92b1b7661bfe920db7134db73d2))
- **confluence:** Target ADF media pagination (#117) ([b0630fd](https://github.com/bjoernschotte/atlcli/commit/b0630fd185dba7f06b023f83bff277034d10ef50))
- **export:** Adaptive browser pdf memory (#120) ([b10fda9](https://github.com/bjoernschotte/atlcli/commit/b10fda99d734d6bbf66b66f9328a0e7d2a0ba424))
- **docx:** Add ordered browser intent entry (#125) ([074f3ee](https://github.com/bjoernschotte/atlcli/commit/074f3ee58b59c20ad5263ced97a3736df0449ee9))
- **docx:** Stream bounded OPC packaging (#127) ([204bad0](https://github.com/bjoernschotte/atlcli/commit/204bad0a9b9ef3351dea24063f792d55011d4583))
- **code-highlight:** Gate runtime by document usage (#129) ([52e78aa](https://github.com/bjoernschotte/atlcli/commit/52e78aade2dd8ad1b9c449a883faa92522822ef3))
- **ci:** Add evidence-gated throughput foundations (#136) ([2ac0752](https://github.com/bjoernschotte/atlcli/commit/2ac075211db1d38c8e0b8c4be07b4d05541fe3f8))
- **research:** Compact lookup workflow prompts ([a9fed08](https://github.com/bjoernschotte/atlcli/commit/a9fed08a899294edd9a858c26c9223e824f395e0))
- **chat:** Instrument provider call usage ([f3b3a37](https://github.com/bjoernschotte/atlcli/commit/f3b3a374744b833c85f44532c68c21b97d35ec42))
- **chat:** Establish deep chat performance ratchet ([3164357](https://github.com/bjoernschotte/atlcli/commit/31643570a6af571397244ef31649d757867d27ed))
- **chat:** Cache stable child prompts ([6ab5228](https://github.com/bjoernschotte/atlcli/commit/6ab52283bf45aec6471ba8e9ec363edc5bb842be))
- **chat:** Extract bound evidence in one pass ([4cf9b0d](https://github.com/bjoernschotte/atlcli/commit/4cf9b0d38fd2d2ae71bc57110b7d5b8d80956f48))
- **chat:** Auto-advance accepted workflows ([06d72e8](https://github.com/bjoernschotte/atlcli/commit/06d72e819eda735c6d4046140b3f8a0f1d4927a0))
- **chat:** Minimize dynamic specialist graphs ([bfb1cde](https://github.com/bjoernschotte/atlcli/commit/bfb1cde114ed77f3afecde009fcfb19c6d6c9a61))
- **chat:** Enforce deep chat performance ceilings ([d4c64cb](https://github.com/bjoernschotte/atlcli/commit/d4c64cbcd631962e63f4866b4cb7319f1575bc06))
- **pdf:** Stage fonts from resolved document demand (#140) ([03421a6](https://github.com/bjoernschotte/atlcli/commit/03421a69b3fafb450f85b36bfaa88abc4a733039))
- **ci:** Reduce draft and merge-ready latency (#150) ([152ebbc](https://github.com/bjoernschotte/atlcli/commit/152ebbc31470cfd7678a5ad56d846530534eec6f))
- **pdf:** Ratchet browser raster normalizer paths (#201) ([2617984](https://github.com/bjoernschotte/atlcli/commit/26179842babc2e691ce36b7b5114053eaea2d15b))

### Refactoring

- **research:** Share runtime across browser and cli ([2089de0](https://github.com/bjoernschotte/atlcli/commit/2089de070272b15ec5a8ce71f4b5726a49a7744c))
- **research:** Keep native conversation persistence canonical ([cda1926](https://github.com/bjoernschotte/atlcli/commit/cda1926aa7b3bec8ec4c680142aa45b85b034dca))
- **research:** Generalize agentic workflow core ([2d1a2a1](https://github.com/bjoernschotte/atlcli/commit/2d1a2a1c7ec51b83baa5208a0ec223e91513d831))
- **research:** Remove legacy chat runtime ([b36c6b4](https://github.com/bjoernschotte/atlcli/commit/b36c6b49821f006044762c34cd2f75b8ef6d84d0))
- **chat:** Make model routing measurable ([683dad5](https://github.com/bjoernschotte/atlcli/commit/683dad59459ad2e0777f139825c59b269c21d525))
- **release:** Reuse exact-sha main quality proof ([6bdf54e](https://github.com/bjoernschotte/atlcli/commit/6bdf54e1647adb98f7f3755affda5e2b3caa6b27))
- **import:** Extract proven semantic core ([c69e890](https://github.com/bjoernschotte/atlcli/commit/c69e8900ff5dd9dce1500ee1aad6324111c41356))
- **import:** Share verified Confluence publication ([289e5ea](https://github.com/bjoernschotte/atlcli/commit/289e5ea9d91600ab9f4b1d291c3059f85d558509))

### Testing

- **e2e:** Live-resource naming, run-id ownership marker & recovery sweeper (spec 011) (#69) ([c48550a](https://github.com/bjoernschotte/atlcli/commit/c48550a9be1f7af29b5dd5eb416987101b4dbe8e))
- **extension:** Stabilize restart recovery assertion (#98) ([e3cebb5](https://github.com/bjoernschotte/atlcli/commit/e3cebb594156f65b6b9d22cbbaf54ad7d4e9b309))
- **research:** Freeze issue 138 v1 contracts ([5398d13](https://github.com/bjoernschotte/atlcli/commit/5398d1318f66fe3f983b844eb3936568226a93ef))
- **research:** Add deterministic baseline scenario ([e0eec12](https://github.com/bjoernschotte/atlcli/commit/e0eec12b94e81a66e64ce0db6d69e09f41455703))
- **research:** Characterize pinned quickjs runtime ([4a81ac9](https://github.com/bjoernschotte/atlcli/commit/4a81ac9923b11c70acd5df0e2b614125837398e0))
- **research:** Freeze production response schemas ([46d6582](https://github.com/bjoernschotte/atlcli/commit/46d65828e9fa95eff0943630518d0ecfc81f2385))
- **research:** Freeze cross-host evaluation baseline ([18fc5d8](https://github.com/bjoernschotte/atlcli/commit/18fc5d8e2081cd9a492d82fa596c3b9faee42e94))
- **research:** Define private gold-set protocol ([e94ee49](https://github.com/bjoernschotte/atlcli/commit/e94ee493a2c241dec9e3a833177fa75c26fed1d3))
- **extension:** Align packed structured output fixture ([168d2d1](https://github.com/bjoernschotte/atlcli/commit/168d2d103c6ab2f0cb4576d9ddeb2e11170ad6c7))
- **research:** Record authenticated browser read proof ([fb5b202](https://github.com/bjoernschotte/atlcli/commit/fb5b202dea24dd512273475c29d840fdf77f0405))
- **research:** Prove packed dynamic composition ([b3126d9](https://github.com/bjoernschotte/atlcli/commit/b3126d940bc75a900850c3f405c597357231eaf1))
- **research:** Add T3 comparison harness ([bcfa2b3](https://github.com/bjoernschotte/atlcli/commit/bcfa2b3981e7420888749d4d5c4aa09e41771865))
- **research:** Run T3 runtime variants ([9a71ff7](https://github.com/bjoernschotte/atlcli/commit/9a71ff7625c21e23b4205b0ed9fa427c1333c3a2))
- **research:** Resolve question scopes in packed MV3 ([e9e1a33](https://github.com/bjoernschotte/atlcli/commit/e9e1a33622233820dfbcd05bb594b30884bf7d5b))
- **research:** Prove confluence scope host parity ([96cc3ca](https://github.com/bjoernschotte/atlcli/commit/96cc3ca8f1c927d67bbaa5f619a5f3b3dced7e8c))
- **research:** Prove scope alias host parity ([c32019f](https://github.com/bjoernschotte/atlcli/commit/c32019f66c094a35c4e570e66dcc0acd871437b9))
- **research:** Prove archived scope host parity ([c80f3ac](https://github.com/bjoernschotte/atlcli/commit/c80f3ac5ee3b5eb6f6f13a3305d682aecae31459))
- **research:** Prove inaccessible scope host parity ([0b7dcde](https://github.com/bjoernschotte/atlcli/commit/0b7dcde6c1f3c4e1a8ff454f7b7c88b583da8bbc))
- **research:** Prove duplicate scope host parity ([5f72e7c](https://github.com/bjoernschotte/atlcli/commit/5f72e7cbe69d6d9692a7a646eb27ec2de79d30db))
- **research:** Prove tenant boundary host parity ([5b4f3f9](https://github.com/bjoernschotte/atlcli/commit/5b4f3f9ebc3ccd76654397e054b7861cff34e52f))
- **research:** Prove scope priority host parity ([3a5fab6](https://github.com/bjoernschotte/atlcli/commit/3a5fab6fa4575fd32bd0819251dd6afa520db782))
- **research:** Prove scope matrix host parity ([f69e584](https://github.com/bjoernschotte/atlcli/commit/f69e584fd227ef774670b0226516c824612bb52d))
- **research:** Prove packed host report parity ([8e2692d](https://github.com/bjoernschotte/atlcli/commit/8e2692df5a3a4e33d676771b1be32aacbad8ff6b))
- **research:** Share session store conformance ([b66c51e](https://github.com/bjoernschotte/atlcli/commit/b66c51ea8e6d3234ad809bf6b7b5d7d9b0fa454c))
- **research:** Prove durable multi-frontier continuation ([0678eb4](https://github.com/bjoernschotte/atlcli/commit/0678eb42fc7e37abbf3211d8992c34d589dbbae6))
- **research:** Prove interrupted continuation recovery ([788d878](https://github.com/bjoernschotte/atlcli/commit/788d878c85ec982b25fc10c123fddb4196656507))
- **research:** Verify sanitized plan projections ([9a5bf28](https://github.com/bjoernschotte/atlcli/commit/9a5bf28cfd56c954141ea5dbc685c8b6e72f929d))
- **research:** Fence concurrent plan approvals ([ffd306d](https://github.com/bjoernschotte/atlcli/commit/ffd306df14d3d52c890266119c412488b3d44197))
- **research:** Fence concurrent browser steering ([db5f8b8](https://github.com/bjoernschotte/atlcli/commit/db5f8b85419331ed630a6233e7cc75978af36cbe))
- **research:** Prove packet publication atomicity ([94056c3](https://github.com/bjoernschotte/atlcli/commit/94056c3e4324c3a32db248d6bc634fe0763a1df1))
- **research:** Fence concurrent session commits ([e82f3be](https://github.com/bjoernschotte/atlcli/commit/e82f3beacc3d4209fcceee6a4d49aacf7c3a318b))
- **research:** Scan durable browser state ([e5df878](https://github.com/bjoernschotte/atlcli/commit/e5df878c29e219524f82386010126cf7d8bf58e2))
- **research:** Prove durable error redaction ([f10d2e2](https://github.com/bjoernschotte/atlcli/commit/f10d2e2270d6374191bd36199e07f91c2d03a05b))
- **research:** Fence durable clarification controls ([1b5eb00](https://github.com/bjoernschotte/atlcli/commit/1b5eb003dad1b4fe7bc70ede282563f73576ce3b))
- **research:** Fence durable scope candidates ([5bd5c78](https://github.com/bjoernschotte/atlcli/commit/5bd5c785a31f60e29956f42d99820b7b88a92e5a))
- **research:** Fence durable scope proposals ([5f1a393](https://github.com/bjoernschotte/atlcli/commit/5f1a393cc59b91403851b3c5902f3fccee9825b4))
- **research:** Hydrate committed packets after recovery ([36655bb](https://github.com/bjoernschotte/atlcli/commit/36655bb32509f1131fa180c06b39e06cf5a41100))
- **research:** Fence packet publication rollback ([77f496a](https://github.com/bjoernschotte/atlcli/commit/77f496a5ddfe938ca103d3028a10d95a42cef2ab))
- **research:** Prove durable runtime recovery parity ([8709220](https://github.com/bjoernschotte/atlcli/commit/87092201e2eb44d4dc9a8cd7730d6e000259ce18))
- **extension:** Compare recovered report across hosts ([46e0231](https://github.com/bjoernschotte/atlcli/commit/46e023191affb1e0f744dc5d09a98991b62410e6))
- **cli:** Preserve resumed report artifacts ([1e3809d](https://github.com/bjoernschotte/atlcli/commit/1e3809db1379bc090528ad95d66de45df03f228c))
- **research:** Recover hard-stopped cli checkpoint ([c034777](https://github.com/bjoernschotte/atlcli/commit/c034777342ade1f507337204a8e7552f09d0f971))
- **research:** Prove private data store recovery ([4dd5558](https://github.com/bjoernschotte/atlcli/commit/4dd5558987156ea992d256716395e8c36ef6e9db))
- **research:** Prove v2 report invalidation ([faa1198](https://github.com/bjoernschotte/atlcli/commit/faa11984a41c0a970ee598457013c13719fa7428))
- **research:** Prove durable native agent thread ([eaaf132](https://github.com/bjoernschotte/atlcli/commit/eaaf132a2b674a21319bde1f60e71e8d59392fbb))
- **research:** Prove packed plan budget projection ([4222c9b](https://github.com/bjoernschotte/atlcli/commit/4222c9bbea836a49022513a68cf43a481a3a6c4c))
- **research:** Extend summary soak to 1000 turns ([04ebf93](https://github.com/bjoernschotte/atlcli/commit/04ebf93ba27092a9310818da91541e4cab6a98d4))
- **research:** Add multi-turn session harness ([6b42f6b](https://github.com/bjoernschotte/atlcli/commit/6b42f6b51bd9df86d9f49739ccdbc3c52a244bc7))
- **research:** Prove compaction recovery ([b5056ad](https://github.com/bjoernschotte/atlcli/commit/b5056ada3db96adcf1e4d81b599a26a8b060ca91))
- **research:** Enforce bounded subagent composition ([a3ff284](https://github.com/bjoernschotte/atlcli/commit/a3ff284101833f2833a66b9445f252f110c89554))
- **research:** Retain canonical artifacts through compaction ([55f52f0](https://github.com/bjoernschotte/atlcli/commit/55f52f011c175f76a9fa7f66354d0d9f0d64424b))
- **research:** Prove sidebar follow-up recovery ([fedc46b](https://github.com/bjoernschotte/atlcli/commit/fedc46b0bbe1c96552ef3da5aca02094ed0ab5c0))
- **research:** Prove marginal evidence stop ([e30ed47](https://github.com/bjoernschotte/atlcli/commit/e30ed4718e1581aca5184069905a43e97c477909))
- **research:** Prove evidence content versioning ([767ba17](https://github.com/bjoernschotte/atlcli/commit/767ba175e9a6d3c971f3fbbf4a37bf882780a7fa))
- **research:** Prove private evidence authority ([85463df](https://github.com/bjoernschotte/atlcli/commit/85463df7e6cb2cb83513b9ba0b65dd086cd4f26a))
- **research:** Prove reconciliation cannot bypass evidence ([c023a46](https://github.com/bjoernschotte/atlcli/commit/c023a4699d5add81432800076f0f05c9b7061e34))
- **research:** Prove v1 report and v2 follow-up compatibility ([92dd46a](https://github.com/bjoernschotte/atlcli/commit/92dd46acdf107d292bc5df770b4f0c307886a7d9))
- **research:** Prove outline and v2 host report parity ([a9e1768](https://github.com/bjoernschotte/atlcli/commit/a9e1768d7df36c37b4d74904e49b3653e6ab59f4))
- **research:** Prove v2 claim validation gates ([57f1721](https://github.com/bjoernschotte/atlcli/commit/57f172189d9d10ed327cd6a00243d689f4f8ef50))
- **chat:** Freeze legacy quality baseline ([7431d5c](https://github.com/bjoernschotte/atlcli/commit/7431d5cbb96e15dbd4a110e39c4936a4fc57faf7))
- **chat:** Prove bounded quality repair ([7fccd2a](https://github.com/bjoernschotte/atlcli/commit/7fccd2ae7eca0a2437999a9dfafa1702f0e2448f))
- **chat:** Prove cross-shape port parity ([3190912](https://github.com/bjoernschotte/atlcli/commit/3190912201386d07ba956dab74daf449cf5c1414))
- **chat:** Isolate durable live sessions ([606ec9e](https://github.com/bjoernschotte/atlcli/commit/606ec9e6437a705491b06f38075ef74316d1fdee))
- **chat:** Establish release quality gates ([f2c7337](https://github.com/bjoernschotte/atlcli/commit/f2c7337ac490dd3d1e065d5f90d454c17da50a02))
- **chat:** Enforce deterministic release gates ([e694254](https://github.com/bjoernschotte/atlcli/commit/e69425443f7503048f640b1459883469c7acf495))
- **chat:** Define release candidate quality matrix ([9ae16f5](https://github.com/bjoernschotte/atlcli/commit/9ae16f54e5174a04e825b421cbd807e1d4e1f339))
- **chat:** Prove production runtime quality matrix ([66bdf5f](https://github.com/bjoernschotte/atlcli/commit/66bdf5f1df6e28da8c4d3d7d55f2cacfbae1371e))
- **chat:** Add private release candidate runner ([893a309](https://github.com/bjoernschotte/atlcli/commit/893a3091a1502c73c6bd6adaac4a4a327d819c2f))
- **chat:** Require clean private proof revision ([766d8d3](https://github.com/bjoernschotte/atlcli/commit/766d8d3e96f4ac5888c5b6712613439fdc209538))
- **extension:** Align packed recovery contracts ([21c3575](https://github.com/bjoernschotte/atlcli/commit/21c357511ce988ab83a8c14d30423cc4de7d7f35))
- **research:** Reconcile release proof contracts ([4f049a2](https://github.com/bjoernschotte/atlcli/commit/4f049a2e6adbf23d1d0913619c03eee3c9e8ff8c))
- **research:** Emit revision bound runtime proofs ([c227415](https://github.com/bjoernschotte/atlcli/commit/c22741506994caf85d0d60c8d77a65b183f7114d))
- **extension:** Enter publishing workspace in jobs e2e ([e429fe1](https://github.com/bjoernschotte/atlcli/commit/e429fe14fb785a89dc2734ed4d642b514cb3caa6))
- **extension:** Isolate rovo settings storage ([28f9c0d](https://github.com/bjoernschotte/atlcli/commit/28f9c0d5c77c0a9f47e40a8db7fc564a1c14b97f))
- **research:** Bound required long horizon proof ([cd78fe3](https://github.com/bjoernschotte/atlcli/commit/cd78fe39984d25309850f26b2f9d76f86fe0c351))
- **extension:** Tolerate palette frame close race ([ea98ecc](https://github.com/bjoernschotte/atlcli/commit/ea98ecc2831c89d1a933bee94f2b7f6d40387e9d))
- **release:** Aggregate live dev proof ([25401a3](https://github.com/bjoernschotte/atlcli/commit/25401a38b4749e984408c7710342d6f6ddc684c2))
- **export:** Await durable cancellation state ([06b60c9](https://github.com/bjoernschotte/atlcli/commit/06b60c9cb4cdc85abfdc81804dfd3ab80805754b))
- **ci:** Allow headroom for Astro consumer builds ([be11cd6](https://github.com/bjoernschotte/atlcli/commit/be11cd6d478c6bd47bb3bbe2a47f61a2686ad1d7))
- **ci:** Allow headroom for export benchmark ([64a580d](https://github.com/bjoernschotte/atlcli/commit/64a580ddf173dc391d8b0272e8b03aee19c7e731))
- **release:** Avoid duplicate timing gate ([e9f1625](https://github.com/bjoernschotte/atlcli/commit/e9f1625358e5410b166ea87b47cf1ee9d3b8f289))
- **import-pdf:** Record Cloud and DC evidence ([7ae2528](https://github.com/bjoernschotte/atlcli/commit/7ae25287c3fcb0095a45698760ee01b997b1f5e5))
- **extension:** Capture packed browser evidence ([f12ac52](https://github.com/bjoernschotte/atlcli/commit/f12ac52a40b94c835731c3ae74de03e81e58fb62))
- **extension:** Stabilize palette backdrop lifecycle ([0058939](https://github.com/bjoernschotte/atlcli/commit/00589398fec11f7f09c22c643b2bf8ed50f1787c))
- **extension:** Retry research browser timeouts in ci ([28e292f](https://github.com/bjoernschotte/atlcli/commit/28e292f4a2e97a65b80ae21f9b670b11b2bb83fd))

### New Contributors

- [@trueberryless](https://github.com/trueberryless) (Felix Schneider) - fix(markdown): convert regular code blocks to Confluence macros (#22)
- [@tmnd1991](https://github.com/tmnd1991) (Antonio Murgia) - feat(drawio): add Draw.io plugin for previews and integration with Confluence sync (#197)
- [@app/renovate](https://github.com/app/renovate) - chore(deps): update dependency @types/emscripten to v1.41.6 (#207)

### Thanks

A big thank you to everyone who helped shape this release 🙏

- [@app/renovate](https://github.com/app/renovate) — PRs #207, #208, #209, #211, #212, #213, #216, #217, #218, #219, #220, #221, #222, #223, #224, #225, #226
- [@jvm](https://github.com/jvm) — PRs #130, #131
- [@tmnd1991](https://github.com/tmnd1991) — PRs #197, #231
- [@trueberryless](https://github.com/trueberryless) — PRs #22, #24
- [@Tapematch](https://github.com/Tapematch) — reported issue #8
- [@tmnd1991](https://github.com/tmnd1991) — reported issue #196

## [0.17.2] - 2026-07-10

### Bug Fixes

- **plugin:** Bundle git plugin (#21)([cb09aad](https://github.com/bjoernschotte/atlcli/commit/cb09aad75b2c086f11fa67efd12f95d5ecb4f0db))

### Thanks

A big thank you to everyone who helped shape this release 🙏

- [@trueberryless](https://github.com/trueberryless) — reported issue #20

## [0.17.1] - 2026-07-10

### Bug Fixes

- **confluence:** Preserve Markdown table rows on pull (#17)([7492ad8](https://github.com/bjoernschotte/atlcli/commit/7492ad83af497a38eba8a665c158a1ca3c2c2bb2))
- **confluence:** Honor context path for Server/Data Center instances (#14)([e6513ee](https://github.com/bjoernschotte/atlcli/commit/e6513ee28e65951a4990f9c9a282f949fe1fea4a))
- **confluence:** Complete deployment-aware URL handling (#18)([033f5c8](https://github.com/bjoernschotte/atlcli/commit/033f5c8826aed77898d6bc72ea85d236d411b9bf))
- **docs:** Pin Astro Zod dependency (#19)([383d1a6](https://github.com/bjoernschotte/atlcli/commit/383d1a6804aab112ec311006cd50e08503f35fb3))
- **release:** Make rollback safe([71ee362](https://github.com/bjoernschotte/atlcli/commit/71ee362e89cc7e18457dabbf68ffc308c30ea290))

### Documentation

- Refresh stale version examples and fix release-process docs([4a7ef10](https://github.com/bjoernschotte/atlcli/commit/4a7ef10f0fd28b8fc76ae6f6b7afa8f540990ec2))
- **release:** Refresh version examples in release script help text([1a82f1d](https://github.com/bjoernschotte/atlcli/commit/1a82f1da3d0f972121368c30ec7637cee651e102))

### Miscellaneous

- Add SonarQube scanner config with coverage([95a7e7e](https://github.com/bjoernschotte/atlcli/commit/95a7e7eaf3125f3ddc89e6ee7a3d28feb35a9679))
## [0.17.0] - 2026-05-15

### Bug Fixes

- **confluence:** Handle undefined page title crash in slugifyTitle (#9)([46d0c81](https://github.com/bjoernschotte/atlcli/commit/46d0c81f4cad0697cd31cd141054aee2a0831e10))
- Serve install.sh via docs site and add checksum verification([d52b7b9](https://github.com/bjoernschotte/atlcli/commit/d52b7b97eeee1adf7bd50e197a4a87a683104cf5))
- Fix tmpdir cleanup leak and harden checksum grep in install.sh([3e05f4e](https://github.com/bjoernschotte/atlcli/commit/3e05f4e9fa62572c84c4f3ac727167a6d59be735))
- **release:** Correct new-contributor detection across tag-day boundary([94d4996](https://github.com/bjoernschotte/atlcli/commit/94d4996a430ea77349682584c546cecd461d6455))

### Documentation

- **release:** Clean meta header out of v0.16.0 release notes([a7d4bd0](https://github.com/bjoernschotte/atlcli/commit/a7d4bd0e10005e6322108c9e13b16c827fe883ac))
- Note that Confluence appends /wiki to site URL in auth help text (#10)([58f742c](https://github.com/bjoernschotte/atlcli/commit/58f742cbb6af990ef27d4f052a560324a1b48575))
- Update README to note Jira and Confluence Data Center (on-prem) support (#11)([c5142cd](https://github.com/bjoernschotte/atlcli/commit/c5142cdcf28f0ff8c15e6031a60216d92f0d816c))

### Features

- **release:** Credit PR contributors and issue reporters in changelog([4bdf47d](https://github.com/bjoernschotte/atlcli/commit/4bdf47d3f44843bfa64bb1f2dda9f74756335d07))
## [0.16.0] - 2026-04-09

### Bug Fixes

- **release:** Track windows-x64 asset in release script([065215c](https://github.com/bjoernschotte/atlcli/commit/065215c0ff9261f01a4aef2dd28f795423bf0e27))

### Documentation

- **reference:** Add --field examples to CLI reference([067c85a](https://github.com/bjoernschotte/atlcli/commit/067c85a28d6da7bde29470799aabfb98d1480ab8))
- **install:** Document Windows binary and unsigned-binary warnings([6734fb2](https://github.com/bjoernschotte/atlcli/commit/6734fb2aa0261b0b890f9ae65852abc589f287e3))
- **release:** Draft v0.16.0 release notes([1f0871a](https://github.com/bjoernschotte/atlcli/commit/1f0871a652733cceded2382c7306a2b9c070758e))
- **auth:** Document TLS/CA certificate support (#7)([9421cd1](https://github.com/bjoernschotte/atlcli/commit/9421cd165662d79d5538f148ba99235c8c9eaa29))

### Features

- **release:** Auto-detect new contributors in changelog([c716904](https://github.com/bjoernschotte/atlcli/commit/c7169041e0cebf0ddd63efe4e281a9e551f0a5a3))

### Miscellaneous

- **release:** Cross-compile all binaries from Linux, add Windows x64 (#6)([d5931ba](https://github.com/bjoernschotte/atlcli/commit/d5931ba175316a20b6118027af608aa314d308a5))
- **ci:** Bump actions/checkout to v6 across all workflows([92fdb70](https://github.com/bjoernschotte/atlcli/commit/92fdb70f75e786c7b4a10192c69d5748d7ec23cc))

### Testing

- **cli:** Fix helloworld test isolation (#5)([2b3c786](https://github.com/bjoernschotte/atlcli/commit/2b3c786e0052d16ddb1ddb4dc803cef39dca2c4f))
## [0.15.0] - 2026-03-07

### Bug Fixes

- **auth:** Harden credential handling([ca542fb](https://github.com/bjoernschotte/atlcli/commit/ca542fb742a4669fd3934af24981efa13265914f))
- **auth:** Remove .ts extension from test import([15716d5](https://github.com/bjoernschotte/atlcli/commit/15716d53008b463999bcf8c1e864809b62d44e03))

### Documentation

- **changelog:** Add contributor acknowledgment for PR #1([72ca0ae](https://github.com/bjoernschotte/atlcli/commit/72ca0aeaffd6745eb16f82a558c16886a0ffc4b1))

### Features

- **jira:** Add --field flag for custom fields on issue create and update (#2)([070ca2d](https://github.com/bjoernschotte/atlcli/commit/070ca2ded86971bbf05eba8413bd33aa138c1815))

### Miscellaneous

- Add typescript dev dependency([871d4eb](https://github.com/bjoernschotte/atlcli/commit/871d4ebfe268418b9b53e5c8c2f453cb6fbf6d40))
## [0.14.0] - 2026-01-30

### Bug Fixes

- **docs:** Use root locale to avoid /en/ URL prefix([a979d9a](https://github.com/bjoernschotte/atlcli/commit/a979d9adda1cdaea2f662b0134217be1c77c73cb))
- **release:** Use annotated tags with message([22bef59](https://github.com/bjoernschotte/atlcli/commit/22bef594fc35a99b8ffd05cfc3ff5e4d1366d7a5))

### Documentation

- **spec:** Add Confluence metadata enhancement spec([b78cbef](https://github.com/bjoernschotte/atlcli/commit/b78cbef415791193dec68ce9ff7b0ca2c3a6b3a9))
- **spec:** Add large space sync optimization spec([ce2ea28](https://github.com/bjoernschotte/atlcli/commit/ce2ea28723a51f37281cf02ac894dd3c1b553787))
- **spec:** Expand large space sync spec after self-critique([a86ae41](https://github.com/bjoernschotte/atlcli/commit/a86ae4185fae33c0d39d8f96315040a378921651))
- **spec:** Fix architectural flaws in large space sync spec([e4248ea](https://github.com/bjoernschotte/atlcli/commit/e4248eae5ff2ab6107f3e4efe6b4b82821936b15))
- **spec:** Fix confluence metadata spec after self-critique([efb7b7c](https://github.com/bjoernschotte/atlcli/commit/efb7b7cc7addde37d6cde5778e5d0389f49957f0))
- **confluence:** Improve structure and consistency per new doc standards([626cbb0](https://github.com/bjoernschotte/atlcli/commit/626cbb04dedac36eea6abfec7d5a547f4eec9c50))
- Comprehensive documentation improvements([6f4943a](https://github.com/bjoernschotte/atlcli/commit/6f4943a73008e2df3b48afe751ce3b21ed1b382d))
- Add Atlassian trademark disclaimer to footer and README([4d3b4a1](https://github.com/bjoernschotte/atlcli/commit/4d3b4a14992a59a2a0bd9adb2f81b2cadfe25936))
- **readme:** Improve structure and add missing sections([3b05aa7](https://github.com/bjoernschotte/atlcli/commit/3b05aa7b4b78366d51e10b9edd15a79ac08e88bc))
- **spec:** Add jira-cli competitive analysis and milestones([f42c241](https://github.com/bjoernschotte/atlcli/commit/f42c241a32439912ec273ca3ab452c82a5dae6f1))
- **changelog:** Add Bearer/PAT auth feature from PR #1([6405796](https://github.com/bjoernschotte/atlcli/commit/640579659507c91439efd38482c753232919d2a1))
- **auth:** Document Bearer/PAT authentication for Server/Data Center([795f188](https://github.com/bjoernschotte/atlcli/commit/795f188edd52432eea67e5c11a854cc13a8f2a74))
- Add Confluence & Jira features section to start page([645ffaf](https://github.com/bjoernschotte/atlcli/commit/645ffaf85ff58e18814499c157e2b323a3a0bb5f))

### Features

- **docs:** Migrate documentation from MkDocs to Astro Starlight([d9c3eec](https://github.com/bjoernschotte/atlcli/commit/d9c3eeca184e1a7d03150488408a9ed78bdf003f))
- **cli:** Add Atlassian trademark disclaimer to version output([74c25ba](https://github.com/bjoernschotte/atlcli/commit/74c25ba04bde3c02ccb71180a2f794263d9fc162))
- **auth:** Add Bearer/PAT auth for Server/Data Center (#1)([59711b2](https://github.com/bjoernschotte/atlcli/commit/59711b23f0dc965682aed7671d89cf6ae8605738))

### Miscellaneous

- Add .playwright-cli and opensrc to gitignore([20f098a](https://github.com/bjoernschotte/atlcli/commit/20f098ac81b7512e140b8126ffa2abce038dcec6))
## [0.13.1] - 2026-01-18

### Bug Fixes

- **confluence:** Quote space key in CQL queries([73a6118](https://github.com/bjoernschotte/atlcli/commit/73a61184bb82ee19a5b32ae949b3ef6bd8d88750))
- **confluence:** Use cursor-based pagination for large spaces([f69b20b](https://github.com/bjoernschotte/atlcli/commit/f69b20bfd5f7ef84f7c87be96ff876ad3b2d9964))
- **audit:** Fix directory detection and parser quirk([dde6437](https://github.com/bjoernschotte/atlcli/commit/dde643754f2530d309933c7969bb8b98f42d17b5))

### Features

- **confluence:** Fetch editor version with page data and add pagination([dc3c07e](https://github.com/bjoernschotte/atlcli/commit/dc3c07edccb30b407cbd264cadb8e8b4d9fead2d))
- **docs:** Add progress logging during pull([b9beff4](https://github.com/bjoernschotte/atlcli/commit/b9beff494cb972f1d9131bfb29775f3f08a48438))
## [0.13.0] - 2026-01-18

### Bug Fixes

- **confluence:** Strip quotes from macro titles([9bf4d7a](https://github.com/bjoernschotte/atlcli/commit/9bf4d7a0789d26993ae2e748e6ed1d7357de1c79))

### Documentation

- Add missing pages to sidebar navigation([80be639](https://github.com/bjoernschotte/atlcli/commit/80be6393be439f9f2dfb4ae4e517adc898a2ea63))
- **confluence:** Add editor format audit documentation([519fd83](https://github.com/bjoernschotte/atlcli/commit/519fd83cad0b9986583da88119f8ce8391ddcab1))
- **reference:** Add editor format commands to CLI reference([cdfe6e8](https://github.com/bjoernschotte/atlcli/commit/cdfe6e8c9aca589e91f340ddf5ac59df85208dfc))

### Features

- **confluence:** Add editor format support for v2/legacy editor([146a082](https://github.com/bjoernschotte/atlcli/commit/146a0823cc92376c286484017c8d7885cdbe6e50))
## [0.12.0] - 2026-01-18

### Documentation

- **audit:** Add feature flag prerequisite to audit documentation([876de8b](https://github.com/bjoernschotte/atlcli/commit/876de8b9997161c4b3a35fe50b3c8365131ef95b))
- Add planning guideline for unresolved questions([46d399b](https://github.com/bjoernschotte/atlcli/commit/46d399bac389dff620618fedb62876cd5a861ddb))
- **confluence:** Add comprehensive folder documentation([c31d26c](https://github.com/bjoernschotte/atlcli/commit/c31d26cd4c173692af9d397ad03e140ee92866fa))

### Features

- **confluence:** Add folder pull support([9aa760f](https://github.com/bjoernschotte/atlcli/commit/9aa760f3146116ab68c998cfd73b36df3ee62fcc))
- **confluence:** Add folder push support([e67d43e](https://github.com/bjoernschotte/atlcli/commit/e67d43ea941f1472707690a6d7bffc2fd6a61e5b))
- **confluence:** Add folder support to sync mode([519d9d8](https://github.com/bjoernschotte/atlcli/commit/519d9d80e02942d496d18200d6aea6ca25539d22))
- **confluence:** Add folder validation and diff support([b064daa](https://github.com/bjoernschotte/atlcli/commit/b064daa277b44c0ee8034acde07cc63069c176fb))
## [0.11.0] - 2026-01-18

### Bug Fixes

- **sync:** Change default directory from ./docs to current directory([5ec6523](https://github.com/bjoernschotte/atlcli/commit/5ec65234fb4bfc6485f6c1a75d70213db561b9d0))
- **cli:** Warn when .atlcli found inside source tree([26946b8](https://github.com/bjoernschotte/atlcli/commit/26946b881754ad82105a0cc3f00aaf0bdd84347f))
- **cli:** Simplify external link error messages in audit([903263d](https://github.com/bjoernschotte/atlcli/commit/903263d34249633e857c939afba68433e55266ac))
- **cli:** Add missing audit flags and shared link-validator module([97969e7](https://github.com/bjoernschotte/atlcli/commit/97969e711f2ece09c67fc471a8cec15ecd351c2a))
- **audit:** Spec compliance fixes for link validation and formatters([032c554](https://github.com/bjoernschotte/atlcli/commit/032c554b968e0bb373faa7f0719cbc0f5f3634bc))

### Documentation

- **claude:** Add rule for regression tests on bug fixes([ae59a61](https://github.com/bjoernschotte/atlcli/commit/ae59a61d133ba4e39846bd182f81bd6c66f51d1e))
- Add SQLite storage and wiki audit documentation([f9b3d1c](https://github.com/bjoernschotte/atlcli/commit/f9b3d1ca3bb315f4a7954bdf6f339e396807d12f))

### Features

- **spec:** Add SQLite sync foundation specification([2f686a1](https://github.com/bjoernschotte/atlcli/commit/2f686a124e492fe6319dd1c45779100900eaddef))
- **confluence:** Implement sync-db adapter infrastructure (Phase 0)([2455f98](https://github.com/bjoernschotte/atlcli/commit/2455f9810d57e1d4374d07c830bb616e0d5030f9))
- **confluence:** Add link extraction for storage and markdown formats (Phase 1)([367edd0](https://github.com/bjoernschotte/atlcli/commit/367edd0759229f9d9b6fa5f1c5f2eddb826189eb))
- **confluence:** Integrate link graph and user/contributor tracking (Phase 1 & 2)([31bee50](https://github.com/bjoernschotte/atlcli/commit/31bee5044b93a4a4d156904d10b76ee9f36675cf))
- **confluence:** Add getAtlcliPath helper function([d22a1d0](https://github.com/bjoernschotte/atlcli/commit/d22a1d0d224a5ee226c6cd47e03b002a715aba66))
- **confluence:** Add Phase 3 improvements to SQLite sync foundation([36db87c](https://github.com/bjoernschotte/atlcli/commit/36db87ce0334b165dbdc56daff9b573466d5c85e))
- **cli:** Add audit command for wiki content analysis (Phase 3)([dce7b0d](https://github.com/bjoernschotte/atlcli/commit/dce7b0dd5c9c5c82fe1b33f5c230f12850aa1cf2))
- **core:** Add audit config schema for threshold defaults([d5cfa59](https://github.com/bjoernschotte/atlcli/commit/d5cfa59c5ee85a10fd61e9f703a04db0bdbab0bb))
- **cli:** Populate sync.db pages table during pull([d9f66ee](https://github.com/bjoernschotte/atlcli/commit/d9f66ee464b63e25ed01fc02504d63fd9f4f8826))
- **cli:** Add external link HTTP validation to audit([5bdd506](https://github.com/bjoernschotte/atlcli/commit/5bdd506004a996b6f666cadd9f9a8263de1cebb6))
- **cli:** Add extended audit checks for wiki content([2027ae2](https://github.com/bjoernschotte/atlcli/commit/2027ae243c19c5bfd359c10b7ba26bd3dcdb0e52))
- **cli:** Add scope filtering to audit command([81a9ee6](https://github.com/bjoernschotte/atlcli/commit/81a9ee6390f43c1c45e2ce62d0f52cf18db9f0e7))
- **cli:** Add fix mode to audit command([25f3e66](https://github.com/bjoernschotte/atlcli/commit/25f3e662eeabac8274530d381fcada33bb02e467))
- **cli:** Add API-based audit enhancements([5123ba5](https://github.com/bjoernschotte/atlcli/commit/5123ba5e9a53f2fe1359ee8a4261c4627274e7b2))
- **cli:** Add defaultChecks config and link-validator tests([db3f028](https://github.com/bjoernschotte/atlcli/commit/db3f028ffb8548cb7b66641ac81457c43caaa7e1))

### Refactoring

- **cli:** Extract audit formatters and optimize stale detection([64c9d1b](https://github.com/bjoernschotte/atlcli/commit/64c9d1b224556826bec1ebdfa389b3fe47f3e0e9))

### Testing

- **sync:** Add regression test for default directory bug([0d77d8a](https://github.com/bjoernschotte/atlcli/commit/0d77d8a708abb61acf6aea17800b46a04fa381d1))
- **confluence:** Add comprehensive migration tests and fix migration bug([833b68a](https://github.com/bjoernschotte/atlcli/commit/833b68a7806c57775fab5c88a67c269611c4b7da))
## [0.10.0] - 2026-01-17

### Documentation

- **reference:** Add missing CLI commands to reference([3a69070](https://github.com/bjoernschotte/atlcli/commit/3a690700c1f791e3b23a2e2e811f6bf264f2a29f))
- **spec:** Add text formatting features to Phase 1 status([71bba3b](https://github.com/bjoernschotte/atlcli/commit/71bba3be1184d0df0b8ae5ea7084e4574e196612))

### Features

- **export:** Add DOCX export with Word template support([16eb224](https://github.com/bjoernschotte/atlcli/commit/16eb224f933d36147f38ae1663cbd3d79bd5b9cb))
- **export:** Add Phase 2 features - images, hyperlinks, code styling([3c41d6c](https://github.com/bjoernschotte/atlcli/commit/3c41d6cfeb3297aadf63ff0535dc21954b5f0ff2))
- **export:** Add Phase 3 - panels, badges, template storage, children([ffaed26](https://github.com/bjoernschotte/atlcli/commit/ffaed263796f07bb6146b5bb7db917661fe08ae7))
- **core:** Add feature flag system([d123941](https://github.com/bjoernschotte/atlcli/commit/d1239411d80de01a206a6f2bd159a8b92dd078e3))
- **export:** Add Word-native TOC with proper OOXML dirty flag([0bd9cad](https://github.com/bjoernschotte/atlcli/commit/0bd9cad92690255b246b54407bbffb191ae11312))
- **cli:** Add helloworld command gated by feature flag([a88752d](https://github.com/bjoernschotte/atlcli/commit/a88752db816537359ff2ccd45647a6679ff5cadb))

### Miscellaneous

- Add Python tests for export package([77efced](https://github.com/bjoernschotte/atlcli/commit/77efced3fe0275c79325b8d824b49f7a21d27840))
- **export:** Switch local Python testing to uv([6cafc7f](https://github.com/bjoernschotte/atlcli/commit/6cafc7f27a4d17512ad2055c07f2bf028a0a51f6))
## [0.9.0] - 2026-01-15

### Bug Fixes

- **confluence:** Add type declarations and fix implicit any types([99051e8](https://github.com/bjoernschotte/atlcli/commit/99051e85d70fca1691967ae8eeefc9b47593c942))

### Documentation

- Simplify and condense CLAUDE.md([9923bfa](https://github.com/bjoernschotte/atlcli/commit/9923bfa6bfce17e5d3e284aa7983cf1bd78d723c))
- **confluence:** Add documentation for new macro features([8176a5a](https://github.com/bjoernschotte/atlcli/commit/8176a5a09af8411cba89268d9742aa317cc18a38))
- **jira:** Add hierarchical template storage documentation([2ddc4ab](https://github.com/bjoernschotte/atlcli/commit/2ddc4ab5529c4fea5d9af70a0ce1c180bd01c4ea))

### Features

- **confluence:** Add native task list support([f5e5551](https://github.com/bjoernschotte/atlcli/commit/f5e55514fc1a2a7e8caa64d5a699b08c55a9608e))
- **confluence:** Add date macro support([9afdb9a](https://github.com/bjoernschotte/atlcli/commit/9afdb9ac2e7f081cfad41b39d73fa4e7539fe3fc))
- **confluence:** Add emoticon support with aliases([195b46c](https://github.com/bjoernschotte/atlcli/commit/195b46c11b84c57c92011fe5e39c756050de68b8))
- **confluence:** Add user mention support with @[Name](id) syntax([873812f](https://github.com/bjoernschotte/atlcli/commit/873812f5a268fec8a29c25b6dbb7786d4f1f0e3c))
- **confluence:** Add colored text support with {color:name}text{color} syntax([dc35151](https://github.com/bjoernschotte/atlcli/commit/dc35151dfa1ff73c3ba7f068ca87ada37f20f17e))
- **confluence:** Add background color support with {bg:color}text{bg} syntax([c2c6562](https://github.com/bjoernschotte/atlcli/commit/c2c656224f2fefcc16a9217b86612b69cfba6305))
- **confluence:** Add subscript/superscript support with ~sub~ and ^sup^ syntax([19249b3](https://github.com/bjoernschotte/atlcli/commit/19249b3e79fdede21faaae9bc26e1896a6eefa23))
- **confluence:** Add noformat macro support with ```noformat syntax([c992104](https://github.com/bjoernschotte/atlcli/commit/c9921049d7c17cdcb0118e477efd3bcbe5971024))
- **confluence:** Add Phase 2 Priority 1 macros (toc-zone, page-properties, task-report)([6c8da5c](https://github.com/bjoernschotte/atlcli/commit/6c8da5ccb03796d45f3b161cf7f7b237bcaca73c))
- **confluence:** Add Phase 2 Priority 2 macros (labels-list, popular-labels, related-labels)([408987e](https://github.com/bjoernschotte/atlcli/commit/408987e850aeadefcac6247607123b83edf488c3))
- **confluence:** Add Phase 2 Priority 3 macros (blog-posts, spaces-list, page-index)([a42b4c2](https://github.com/bjoernschotte/atlcli/commit/a42b4c2f9c47b9b80b3f96e2a33000dac1f29fdb))
- **confluence:** Add Phase 2 Priority 4 macros (contributors, change-history)([ec7a9fa](https://github.com/bjoernschotte/atlcli/commit/ec7a9fa622569a2ee52d12bc418506ff5417a105))
- **confluence:** Add Phase 2 Priority 5 macro (loremipsum)([362ccbf](https://github.com/bjoernschotte/atlcli/commit/362ccbfa259df3a59ea96b3ca53146752b913a65))

### Miscellaneous

- Update bun.lock([e9c032a](https://github.com/bjoernschotte/atlcli/commit/e9c032a39f1bccf39e4c26b8ae03cff7921da6a4))
## [0.8.0] - 2026-01-15

### Documentation

- Add rule to never create releases automatically([566ba04](https://github.com/bjoernschotte/atlcli/commit/566ba04c3971792b4450343110c1bbb00a78b9e4))
- Add smart links and cross-product linking documentation([d4913a8](https://github.com/bjoernschotte/atlcli/commit/d4913a843b79af77b820cb9056c7dd74a5d7eddc))

### Features

- **cli:** Add global --help and -h flag support([7d13913](https://github.com/bjoernschotte/atlcli/commit/7d13913e094e02baf4b0260da7665ea188401668))
- **cli:** Add --help/-h support to all commands (Phase 2)([3df7126](https://github.com/bjoernschotte/atlcli/commit/3df7126173d25eac9e60c7062801b0ea9f94c395))
- **cli:** Add --version/-v global flag (Phase 3)([f869c93](https://github.com/bjoernschotte/atlcli/commit/f869c93100e76e8f880c9be4c5c92940bcec1673))
- **cli:** Standardize help format across commands (Phase 4)([60ca394](https://github.com/bjoernschotte/atlcli/commit/60ca394fd015ba537390fd11ac76254cc04546b4))
- **jira,wiki:** Add cross-product linking between Jira and Confluence([a323a97](https://github.com/bjoernschotte/atlcli/commit/a323a9707dd1bf4b2242b4897d7cd65ea629e937))
- **confluence:** Add smart link support for markdown conversion([6274d81](https://github.com/bjoernschotte/atlcli/commit/6274d8169dda4eb6414e6d2be0c8e25e504539fb))
- **jira:** Add hierarchical template storage and enhanced list command([de28277](https://github.com/bjoernschotte/atlcli/commit/de2827753c2d0befd25b944d0d298bee5b925ade))
## [0.7.2] - 2026-01-15

### Bug Fixes

- **release:** Inject version at build time in CI workflow([b4dd0c5](https://github.com/bjoernschotte/atlcli/commit/b4dd0c5f0f418ed304de85ce0775d7452370a0bb))
## [0.7.1] - 2026-01-15

### Bug Fixes

- **release:** Use correct gh workflow run command([eea10c1](https://github.com/bjoernschotte/atlcli/commit/eea10c1b724d15dc6f0b96dbd27fb4b4843bc107))
- **update:** Instruct Homebrew users to run brew update first([7f02fb4](https://github.com/bjoernschotte/atlcli/commit/7f02fb4c25f71eec720be638557128e89efd71c9))

### Documentation

- Add release process to CLAUDE.md([0e47c04](https://github.com/bjoernschotte/atlcli/commit/0e47c04871323cf4e166e5f6b2c7cd268852bbfa))
## [0.7.0] - 2026-01-15

### Bug Fixes

- Remove unreachable architecture cases in detectPlatform([0a9684e](https://github.com/bjoernschotte/atlcli/commit/0a9684ecc3388dfa55e86cbbc9cfceb818f68a7a))
- **update:** Inject version at build time and reduce check interval([09eff71](https://github.com/bjoernschotte/atlcli/commit/09eff71b6022b8fd3fba67e34a35c198c89ec0e9))
- **doctor:** Fix TypeScript errors in doctor command([d7a1d07](https://github.com/bjoernschotte/atlcli/commit/d7a1d076bb737c23019c1c6fce539497a24dd0eb))
- **release:** Make dry-run a true preview with no changes([cb04305](https://github.com/bjoernschotte/atlcli/commit/cb04305d0aa5bbcaa3aa053ac53da54dbc37c20c))

### Documentation

- Add doctor command to CLI reference([ac05565](https://github.com/bjoernschotte/atlcli/commit/ac05565d99dd81206b260b87f4fcbd8b205ebd86))
- **jira:** Add 'my' command to search documentation([36a61c7](https://github.com/bjoernschotte/atlcli/commit/36a61c74d94af6119ac4965ea3fea5ce196212d5))
- Add CLAUDE.md for AI assistant guidance([ca935ee](https://github.com/bjoernschotte/atlcli/commit/ca935ee0727d2ee563269c0158ed37283ba2e5cc))

### Features

- Show attribution in help header instead of footer([e86b05e](https://github.com/bjoernschotte/atlcli/commit/e86b05ec28e271af1fada1937679cfb830240864))
- Add doctor command for diagnosing setup issues([dfb2b3a](https://github.com/bjoernschotte/atlcli/commit/dfb2b3aaa6e4512682ff1f713a171f2f87dc61a8))
- Add open command for issues and pages([40c5c0a](https://github.com/bjoernschotte/atlcli/commit/40c5c0a9b855e749ca4924dd869337122071db3a))
- **jira:** Add 'my' command for quick access to open issues([1b34aeb](https://github.com/bjoernschotte/atlcli/commit/1b34aeb5ba45167a28dd08a6db040637423f5ae4))
- **wiki:** Add 'recent' command for recently modified pages([cfc5995](https://github.com/bjoernschotte/atlcli/commit/cfc5995045731404118db5ec754bbeaeda545693))
- **wiki:** Add 'my' command for pages created or contributed to([9155635](https://github.com/bjoernschotte/atlcli/commit/9155635389db85d785b12bab6e1ce0c06098da04))
- Add config command for CLI configuration management([c5bd5a5](https://github.com/bjoernschotte/atlcli/commit/c5bd5a54f6c89061ba08991b19ba41a7621a6589))
- Wire config defaults to jira and wiki commands([aca1fb8](https://github.com/bjoernschotte/atlcli/commit/aca1fb85f9bf9c9e4a66cfffb702feb541fec9bf))
- Add per-profile config defaults([d6df3cb](https://github.com/bjoernschotte/atlcli/commit/d6df3cb30a33b75dd12ab45408c4fd0e72f2c85b))
- Add release script for automated releases([a809e03](https://github.com/bjoernschotte/atlcli/commit/a809e0309d405378585535790b69ddab51d6923c))
## [0.6.0] - 2026-01-14

### Documentation

- Add Homebrew installation instructions([ad7ee9b](https://github.com/bjoernschotte/atlcli/commit/ad7ee9b8ccff0ac100cdbddc198c4599c700bd98))
- Update CHANGELOG for v0.5.0 and v0.5.1([f59752b](https://github.com/bjoernschotte/atlcli/commit/f59752b40704768e27682ce0d54034a528f85ee9))
- Update quick start and CI/CD examples to use install script([e8933c9](https://github.com/bjoernschotte/atlcli/commit/e8933c980d632719ebbd55728599a42438376f44))

### Features

- Add install script for macOS/Linux([7c0da73](https://github.com/bjoernschotte/atlcli/commit/7c0da736b3b8c11ada6e1655fe1db473cdcc9339))
- Add shell completion for zsh and bash([4d5d72a](https://github.com/bjoernschotte/atlcli/commit/4d5d72ac13d0d7d08df72c13fed53cf680e71cc2))
- Add self-update capability with auto-check notifications([02714ad](https://github.com/bjoernschotte/atlcli/commit/02714ad98e1863fdf98581a8781881d0c97b7ca2))

### Miscellaneous

- Remove accidentally committed test attachments([72cebf2](https://github.com/bjoernschotte/atlcli/commit/72cebf2aea3d4f2cb4d9c86125030807ed748111))
- Merge specs/ into spec/([4c2ba6d](https://github.com/bjoernschotte/atlcli/commit/4c2ba6d15916871589001a745952fef24e0b9248))
## [0.5.1] - 2026-01-14

### Miscellaneous

- Add MIT license file([cdf5337](https://github.com/bjoernschotte/atlcli/commit/cdf53371a1bfcf44d93813ffc472dd4fb33ee081))
- Bump version to 0.5.1([06576b1](https://github.com/bjoernschotte/atlcli/commit/06576b1b0248228893d030fe033b709a271b1ef4))
## [0.5.0] - 2026-01-14

### Bug Fixes

- **ci:** Handle Bun test exit code when tests pass with stderr output([1fac813](https://github.com/bjoernschotte/atlcli/commit/1fac813203ac43c1ec596a492029cf807aa4e89c))
- **core:** Add short flag support to parseArgs([3e5a89e](https://github.com/bjoernschotte/atlcli/commit/3e5a89eade68f5bd91d372edf30964a85a5c1d21))
- **sync:** Auto-create during initial sync and path handling bugs([c104d5d](https://github.com/bjoernschotte/atlcli/commit/c104d5d496ed0c6f2044ad4a4b87032257ec6e90))

### Documentation

- Add Jira package research spec([93235a0](https://github.com/bjoernschotte/atlcli/commit/93235a00c6afd7ba6d4dd756b7d63f6284817556))
- **jira:** Mark Tempo integration as skipped([545cb57](https://github.com/bjoernschotte/atlcli/commit/545cb572ac36bf2a7a707a5b2637c913030d101d))
- **jira:** Add future roadmap ideas([786e149](https://github.com/bjoernschotte/atlcli/commit/786e149f96404edc98b399808f22954d8c4e7b1e))
- Add Jira documentation to README([7d748d4](https://github.com/bjoernschotte/atlcli/commit/7d748d4f9c56cfa61f9b0cf82bad85b1beb7bd38))
- Add documentation reorganization roadmap([e1a0ec3](https://github.com/bjoernschotte/atlcli/commit/e1a0ec3b967bc148cf914084bfe3f314ea3f7cac))
- Add documentation reorganization spec([62929c8](https://github.com/bjoernschotte/atlcli/commit/62929c8506c7921e91b7bb1ae9ef45d75dbd794a))
- Add mkdocs-material documentation site([adfb003](https://github.com/bjoernschotte/atlcli/commit/adfb00372fe0ac30ccb605ebd0af07eeea8b5290))
- **jira:** Fix command syntax and add missing documentation([31990a9](https://github.com/bjoernschotte/atlcli/commit/31990a92da3d6c51b437776166d5ce7a2425f0a0))
- Update mkdocs config with custom theme and nav([69ee007](https://github.com/bjoernschotte/atlcli/commit/69ee0076586d711d2ecafcfa7a6efb759afd2304))
- Fix config paths and environment variables([357e42e](https://github.com/bjoernschotte/atlcli/commit/357e42ecfdefe783d6b86330e0769efe3823b72f))
- Add documentation improvement planning specs([59f1746](https://github.com/bjoernschotte/atlcli/commit/59f17465f1cc107de3cbb443c6df190f1b7949d5))
- **jira:** Update time tracking documentation([058498b](https://github.com/bjoernschotte/atlcli/commit/058498b8d93d90d3d58958a237e27088910a0ce3))
- Update README to reference atlcli.sh domain([f311acf](https://github.com/bjoernschotte/atlcli/commit/f311acf54e301d1323870b339b842d534c106d11))
- Update spec to reference atlcli.sh domain([571f6e8](https://github.com/bjoernschotte/atlcli/commit/571f6e88f9cd36ccb5ba44bb8b0c7c44005c3019))
- Add wiki template system specification([d047220](https://github.com/bjoernschotte/atlcli/commit/d047220fa15532100f35cc8d27b23549179d95e6))
- Fix wiki template spec issues([2aa389a](https://github.com/bjoernschotte/atlcli/commit/2aa389a3b7305fa1e5bcada225315a05943f68bc))
- Fix remaining wiki template spec inconsistencies([08d94d5](https://github.com/bjoernschotte/atlcli/commit/08d94d55deabeb0fc3d00d39956439e2f8bc9224))
- Fix additional wiki template spec issues([1369e5f](https://github.com/bjoernschotte/atlcli/commit/1369e5f6bd3ef8536e1fb82f99caac1b00a5c851))
- Add @ prefix for built-in vars and fix spec issues([5b8d413](https://github.com/bjoernschotte/atlcli/commit/5b8d413e90938fde9211e3a68ab2a0f9275b459c))
- Update wiki template system spec as complete([9214b02](https://github.com/bjoernschotte/atlcli/commit/9214b02f2b145fcc4fb999b8c01ec1b4aa560048))
- Rewrite confluence templates documentation([2a2a0cc](https://github.com/bjoernschotte/atlcli/commit/2a2a0cce4721688a34ee99c317da1e159644ff18))
- Expand sync polling documentation([3bc020e](https://github.com/bjoernschotte/atlcli/commit/3bc020ece056b877fcbe3f044105e43a9ec4c4f9))
- Reorganize sync docs with watch mode first([dad9bce](https://github.com/bjoernschotte/atlcli/commit/dad9bced02b2983d7749d3a668e46ef3e9b66d28))
- Replace ASCII diagram with Mermaid in sync docs([cfc1f07](https://github.com/bjoernschotte/atlcli/commit/cfc1f074f9a72f998552e9cb0577011b4faa2222))
- **sync:** Expand auto-create documentation and fix frontmatter format([d54037b](https://github.com/bjoernschotte/atlcli/commit/d54037ba9627a4dc832e035cc1b5605daed0a86c))

### Features

- **jira:** Add Jira package foundation([3b74b66](https://github.com/bjoernschotte/atlcli/commit/3b74b6687e69ac06e08d9c16eb90ff664082495d))
- **jira:** Add board and sprint management([19f8deb](https://github.com/bjoernschotte/atlcli/commit/19f8deb049f713d66225823533d56fa5d007c094))
- **jira:** Add time tracking Phase 1 - worklog CRUD([5979c82](https://github.com/bjoernschotte/atlcli/commit/5979c8270915ca126433cee82bae197fe26553a6))
- **jira:** Add timer mode for start/stop time tracking([c7152de](https://github.com/bjoernschotte/atlcli/commit/c7152de9cff658b179a2e39a948a8a467274a2f9))
- **jira:** Add epic management commands([3871f44](https://github.com/bjoernschotte/atlcli/commit/3871f444b3a653e4aee65f86e7ac71c68995de4a))
- **jira:** Add sprint analytics and metrics([a24f7c4](https://github.com/bjoernschotte/atlcli/commit/a24f7c45687d2f55379a05ea7ecef86ada39e60c))
- **jira:** Add bulk operations for batch issue management([7f92701](https://github.com/bjoernschotte/atlcli/commit/7f92701d46a7731bdce9baeddd47eeb91dfcf11f))
- **jira:** Add saved filter management([43a0e99](https://github.com/bjoernschotte/atlcli/commit/43a0e990595a5b83b44ed4f0101cacd0c18377f9))
- **jira:** Add import/export for issues with comments and attachments([f4b256c](https://github.com/bjoernschotte/atlcli/commit/f4b256c31a968765ac7efa9440a0dbba443147ef))
- **jira:** Add issue attach command([31a0a7c](https://github.com/bjoernschotte/atlcli/commit/31a0a7ca2fce098b0b3c1f84445effdb9d78661b))
- **jira:** Add watch/unwatch/watchers commands([b85fa21](https://github.com/bjoernschotte/atlcli/commit/b85fa215e7240e800bb7b2ec91502e425ff05304))
- **jira:** Add webhook server for real-time notifications([7db95fe](https://github.com/bjoernschotte/atlcli/commit/7db95fe6c12e85c9ce3c0501839aff516eeeb9e2))
- **jira:** Add subtask management commands([a283e15](https://github.com/bjoernschotte/atlcli/commit/a283e158126f68b3170d0d283a1d3665b4e37485))
- **jira:** Add component and version management([e792250](https://github.com/bjoernschotte/atlcli/commit/e7922505f98c6a5407f84fe941e1e6eea4c5ee6f))
- **jira:** Add custom field exploration commands([0ff26b2](https://github.com/bjoernschotte/atlcli/commit/0ff26b2498ed32e6cd67c0cfdcc1f8e8ec8d8e02))
- **jira:** Add issue template management([1d3d520](https://github.com/bjoernschotte/atlcli/commit/1d3d5202999d06b4661933159741fcc6aa7ba2d5))
- **cli:** Add wiki prefix for Confluence commands([2af66f5](https://github.com/bjoernschotte/atlcli/commit/2af66f51bdfd18aeb07bf233cfe07a04004c43cd))
- **jira:** Add worklog report command([a48b0a4](https://github.com/bjoernschotte/atlcli/commit/a48b0a4cb13ae76618a817ff878a3d18a28f4b05))
- Add Turborepo and fix TypeScript strict mode errors([7f09359](https://github.com/bjoernschotte/atlcli/commit/7f09359eda047dd2538451b788a7015b15f0b071))
- Add release workflow and interactive promo([10610fd](https://github.com/bjoernschotte/atlcli/commit/10610fd92c7e26fbe70ae4225fbb6528c12131b4))
- **docs:** Configure custom domain atlcli.sh([588c015](https://github.com/bjoernschotte/atlcli/commit/588c015ebfbc5b4e8ff65c82d314737aca5e0c1a))
- **core:** Implement template system Phase 1 - core foundation([90842f2](https://github.com/bjoernschotte/atlcli/commit/90842f26804f34950b9bf28691a6c8daf6d6a049))
- **core:** Implement template system Phase 2 - storage layer([f7fb696](https://github.com/bjoernschotte/atlcli/commit/f7fb696070cda0420aff6d05349e4598abd9cc09))
- **cli:** Implement template system Phase 3 - CLI commands([ff72c85](https://github.com/bjoernschotte/atlcli/commit/ff72c85435b7e608c815168b98ff51f17d6676a7))
- **cli:** Implement template system Phase 4 - render and page integration([6f91331](https://github.com/bjoernschotte/atlcli/commit/6f91331725c45ed862f02d71a98a7f6c344ea0d2))
- **cli:** Implement template system Phase 5 - advanced commands([1bf34bb](https://github.com/bjoernschotte/atlcli/commit/1bf34bb542c57c937fbee46d81a482a68ee324eb))
- **cli:** Implement template system Phase 6 - import/export([3707ff3](https://github.com/bjoernschotte/atlcli/commit/3707ff3e29e172c1426503b75990470ce0242892))
- **sync:** Use modern .atlcli/ format and flatten home page hierarchy([307c990](https://github.com/bjoernschotte/atlcli/commit/307c9900b27a74f78a231773ca54f7dbcbff54b8))

### Miscellaneous

- Bump version to 0.5.0([4970148](https://github.com/bjoernschotte/atlcli/commit/4970148b7df4a71e18bbb094dbdf1d2025777f94))

### Styling

- **docs:** Add Atlassian blue theme for documentation([d183ca6](https://github.com/bjoernschotte/atlcli/commit/d183ca63143e3ed25eb97766ea8775ac9ae4cb78))
## [0.4.0] - 2026-01-12

### Bug Fixes

- **template:** Preserve frontmatter when creating from file([311ceb0](https://github.com/bjoernschotte/atlcli/commit/311ceb002097bc4fb3cdcd868bc335b46429b4fd))
- **page:** Support multiple --var flags in page create([a24bb82](https://github.com/bjoernschotte/atlcli/commit/a24bb8293b58445b3b32304f15bcad428e24d69a))
- **cli:** Make log tail default to global logs([512fae1](https://github.com/bjoernschotte/atlcli/commit/512fae1c883f71b37317edce9fd926a8af809db6))
- **confluence:** Fix attachment upload filename handling([1b77df5](https://github.com/bjoernschotte/atlcli/commit/1b77df5516af4392df78a387e1fe853637269246))

### Documentation

- Add Confluence feature roadmap and partial-sync spec([ce64fbf](https://github.com/bjoernschotte/atlcli/commit/ce64fbf4282670624333bd74365e031843d6112e))
- Update roadmap - partial sync and macros complete([2c684d1](https://github.com/bjoernschotte/atlcli/commit/2c684d126d1c33656fc1824d314ddba00412bd16))
- Mark attachments support complete in roadmap([10776cd](https://github.com/bjoernschotte/atlcli/commit/10776cd5cb9dda46b0cd4886898c2fe3e8854448))
- Mark labels support complete in roadmap([def1364](https://github.com/bjoernschotte/atlcli/commit/def13644969040795704343b0584e40f876a1ad4))
- Mark page history & diff as complete in roadmap([844a1c5](https://github.com/bjoernschotte/atlcli/commit/844a1c5142c3b3d834296b047f27ef9b54d709ad))
- Mark ignore patterns as complete in roadmap([4d40e67](https://github.com/bjoernschotte/atlcli/commit/4d40e67991b2a5e1254ea9ab62644c57561735e3))
- Add Confluence API v2 limitations for comments([94ee84b](https://github.com/bjoernschotte/atlcli/commit/94ee84b0bd75b73088db0fd6e56934dfa7222d4f))
- Add page templates documentation to README([0f8a8fb](https://github.com/bjoernschotte/atlcli/commit/0f8a8fb1b5f4fc4759e2f9173462fa4cb17aff97))
- Add profile management documentation to README([b4b8640](https://github.com/bjoernschotte/atlcli/commit/b4b8640a6e0c22894edf2747dd4a538d39502f86))
- Add sibling reordering spec([b913f32](https://github.com/bjoernschotte/atlcli/commit/b913f328114c4159e6a5d7afd3d65f533aebdefb))
- Add sibling reordering to README([ebf9e5e](https://github.com/bjoernschotte/atlcli/commit/ebf9e5eabd5dd9c9320f238ffa14c0a20e63a761))
- Add logging documentation to README([d092dd3](https://github.com/bjoernschotte/atlcli/commit/d092dd3eff440c8b7fb5163300fd9047466f0f45))
- Update log tail documentation for new default([ae758b8](https://github.com/bjoernschotte/atlcli/commit/ae758b8a124305f55e07c81fe976538a150df88b))
- Add attachment sync documentation to README([7639c7c](https://github.com/bjoernschotte/atlcli/commit/7639c7caa57194efccbed8c136fab61f57f59908))
- Mark sibling reordering complete in roadmap([f8fbf9a](https://github.com/bjoernschotte/atlcli/commit/f8fbf9a11db3fe4db5348d2fd1da16787731ef4f))
- Add CHANGELOG.md for all releases([08adfb7](https://github.com/bjoernschotte/atlcli/commit/08adfb715ce57650dd14c2f9e6cc7cc97639db4d))

### Features

- **confluence:** Implement partial sync with nested directory structure([88da22b](https://github.com/bjoernschotte/atlcli/commit/88da22b432a09d8ec82ae2b248077e2bae93864f))
- **confluence:** Add jira macro support([43b916c](https://github.com/bjoernschotte/atlcli/commit/43b916c24c6a29d64d75465f87ebb28700c53426))
- **confluence:** Add attachment sync support([66e5c79](https://github.com/bjoernschotte/atlcli/commit/66e5c792153ea278ba5aca85b4c35bb42dad4e4f))
- **confluence:** Add label API methods([160be8a](https://github.com/bjoernschotte/atlcli/commit/160be8a068b1e765bd9f688da9b7e6ac46d4a1f0))
- **cli:** Add page label commands([ee53ae1](https://github.com/bjoernschotte/atlcli/commit/ee53ae1410c5639ccd2875c8e469b8786701e3a6))
- **cli:** Add --label filter to docs pull and sync([c5671d5](https://github.com/bjoernschotte/atlcli/commit/c5671d5543265b43a5e2b4c7fafc420dc6808458))
- **confluence:** Add page version history API methods([8054721](https://github.com/bjoernschotte/atlcli/commit/8054721212fa533907665424de4c659df718ab24))
- **confluence:** Add diff utility([c4965f5](https://github.com/bjoernschotte/atlcli/commit/c4965f5e4b44404ecb7333cb48f80edcc658895b))
- **cli:** Add page history, diff, and restore commands([b0f2be2](https://github.com/bjoernschotte/atlcli/commit/b0f2be25fc8b0bd16c89d3419c0a8c856f2a2236))
- **cli:** Add docs diff command for local vs remote comparison([a6b8c21](https://github.com/bjoernschotte/atlcli/commit/a6b8c217a7216b50b4d76d9872934043793395c8))
- **confluence:** Add ignore pattern utility([aa1afa0](https://github.com/bjoernschotte/atlcli/commit/aa1afa03c6ba3fc41d795037f05bf95fc8fd572e))
- **cli:** Integrate ignore patterns into docs commands([4294386](https://github.com/bjoernschotte/atlcli/commit/42943864cdd9356b8ba9eed889385d2ea9e1b04a))
- **cli:** Integrate ignore patterns into sync engine([a674b55](https://github.com/bjoernschotte/atlcli/commit/a674b555d51fa20f44a903ee45d90f039a3042ec))
- **cli:** Add search command with CQL builder([8796f47](https://github.com/bjoernschotte/atlcli/commit/8796f471848f23cfdc474f2d0bf12a13f8634165))
- **confluence:** Add comments sync (pull-only)([5177aa1](https://github.com/bjoernschotte/atlcli/commit/5177aa1dcb0cbe7733fbac72803741bb03a434b8))
- **confluence:** Add comment creation and management CLI([ff10510](https://github.com/bjoernschotte/atlcli/commit/ff10510da2e8520acc0ef448cf2d60595aba0418))
- **confluence:** Add page tree management (move, copy, children)([7ac0229](https://github.com/bjoernschotte/atlcli/commit/7ac0229aea268c2d7025234e8bcbcd04441318ef))
- **confluence:** Add bulk operations (delete, archive, label via CQL)([035cf2a](https://github.com/bjoernschotte/atlcli/commit/035cf2abc21e74eed0c6b6cc427883b8f301dfeb))
- **confluence:** Add link checker and pre-push validation([1773110](https://github.com/bjoernschotte/atlcli/commit/17731109ac5adf363b074b7f663b06cfd870acce))
- **confluence:** Add page templates with Handlebars-style syntax([d588cab](https://github.com/bjoernschotte/atlcli/commit/d588cab15a2dcbd7d1d004c188c05622e82e7140))
- **cli:** Support multiple --var flags for templates([1020b26](https://github.com/bjoernschotte/atlcli/commit/1020b26ba6566ce941ec5838e9bb8cf44b50a723))
- **auth:** Add profile rename command([e0215cf](https://github.com/bjoernschotte/atlcli/commit/e0215cf89b3d22311179b76cc444d9f3d19cfb02))
- **auth:** Separate logout and delete commands([6bb80af](https://github.com/bjoernschotte/atlcli/commit/6bb80af122127e846d77986b5de79ec41a489ee9))
- **page:** Add sibling reordering and sorting([68864ca](https://github.com/bjoernschotte/atlcli/commit/68864cac5eea3af1c792043ea6f88c5507d4e40c))
- **core:** Add JSONL logging system for observability and audit([8935537](https://github.com/bjoernschotte/atlcli/commit/893553732dd07c91fc206d0f357de7acad47aecb))
- **cli:** Add sync event logging to docs pull/push([ee4772a](https://github.com/bjoernschotte/atlcli/commit/ee4772ae07607b8e3cf142f78147b28511014eed))
- **confluence:** Complete attachment sync feature([9a109dd](https://github.com/bjoernschotte/atlcli/commit/9a109ddd9b046a2e62fa86906a922455148cf42e))

### Testing

- **confluence:** Add tests for label API methods([13c5723](https://github.com/bjoernschotte/atlcli/commit/13c57236a4511bade471c12a92c5a50f725561e4))
- Add tests for history and diff functionality([286cd1e](https://github.com/bjoernschotte/atlcli/commit/286cd1ecf190548662637e86ef43bd527bf74542))
- Add tests for ignore patterns([c80f544](https://github.com/bjoernschotte/atlcli/commit/c80f5440345e9950d0748d4eeaf32aa7bc40fbbe))
- **core:** Add unit tests for profile management([ee0799f](https://github.com/bjoernschotte/atlcli/commit/ee0799f66c79fd9793f52ec30dbc39394bbadc01))

### Sync

- **confluence:** Pull 2 page(s) from Confluence([a7f8843](https://github.com/bjoernschotte/atlcli/commit/a7f8843c939d2df896f0b8b75efe16a3fa1e1a75))
## [0.3.0] - 2026-01-10

### Documentation

- **plugin-git:** Add README and tests([b8bd791](https://github.com/bjoernschotte/atlcli/commit/b8bd791bb4eba1ad4504a7719203ae72cb54e579))
- Add plugin-git to main README([cd4d892](https://github.com/bjoernschotte/atlcli/commit/cd4d892b8b369856134fce8f752b6cfeb18fe968))

### Features

- Add plugin-git for git integration([71b7a24](https://github.com/bjoernschotte/atlcli/commit/71b7a244cab8e1fb9e92b6e0962fd52c53e22cf2))
## [0.1.0] - 2026-01-10
