# Changelog

All notable changes to atlcli will be documented in this file.

## [0.11.0] - 2026-01-18

### Highlights

**SQLite Sync Foundation** - Major backend upgrade replacing the JSON-based sync state with SQLite. This enables advanced features like link graph tracking, contributor analysis, and content auditing. **Automatic migration**: Existing users with `state.json` will be automatically migrated to the new SQLite format on first sync operation - a backup is created at `state.json.bak` before migration.

**Wiki Audit Command** - New `atlcli audit wiki` command for comprehensive content health analysis:
- Detect stale pages with configurable thresholds (high/medium/low risk)
- Find orphaned pages with no incoming links
- Identify broken internal links
- Analyze contributor risks (bus factor, inactive maintainers)
- Validate external URLs via HTTP
- Check content compliance (missing labels, drafts, restrictions)
- Output as table, JSON, or markdown report
- Fix mode to auto-label stale pages and generate reports

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

- Remove unreachable architecture cases in detectPlatform([0a9684e](https://github.com/bjoernschotte/atlcli/commit/0a9684ecc3388dfa55e86cbbc9cfceb818f68a7a))
- **update:** Inject version at build time and reduce check interval([09eff71](https://github.com/bjoernschotte/atlcli/commit/09eff71b6022b8fd3fba67e34a35c198c89ec0e9))
- **doctor:** Fix TypeScript errors in doctor command([d7a1d07](https://github.com/bjoernschotte/atlcli/commit/d7a1d076bb737c23019c1c6fce539497a24dd0eb))
- **release:** Make dry-run a true preview with no changes([cb04305](https://github.com/bjoernschotte/atlcli/commit/cb04305d0aa5bbcaa3aa053ac53da54dbc37c20c))
- **release:** Use correct gh workflow run command([eea10c1](https://github.com/bjoernschotte/atlcli/commit/eea10c1b724d15dc6f0b96dbd27fb4b4843bc107))
- **update:** Instruct Homebrew users to run brew update first([7f02fb4](https://github.com/bjoernschotte/atlcli/commit/7f02fb4c25f71eec720be638557128e89efd71c9))

### Documentation

- Add doctor command to CLI reference([ac05565](https://github.com/bjoernschotte/atlcli/commit/ac05565d99dd81206b260b87f4fcbd8b205ebd86))
- **jira:** Add 'my' command to search documentation([36a61c7](https://github.com/bjoernschotte/atlcli/commit/36a61c74d94af6119ac4965ea3fea5ce196212d5))
- Add CLAUDE.md for AI assistant guidance([ca935ee](https://github.com/bjoernschotte/atlcli/commit/ca935ee0727d2ee563269c0158ed37283ba2e5cc))
- Add release process to CLAUDE.md([0e47c04](https://github.com/bjoernschotte/atlcli/commit/0e47c04871323cf4e166e5f6b2c7cd268852bbfa))

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

