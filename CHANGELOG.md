# Changelog

All notable changes to atlcli will be documented in this file.

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

