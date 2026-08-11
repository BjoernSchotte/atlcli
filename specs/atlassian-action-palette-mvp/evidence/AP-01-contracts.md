# AP-01 neutral action-contract evidence

**Captured:** 2026-08-11  
**Task base:** `e10278b0dcd722fd4505d9d6ab3dddc200f1b303`  
**Package:** `@atlcli/action-registry` `0.1.0`

## Outcome

AP-01 introduces one dependency-free, strict ESM package containing only serializable action contracts and pure boundary functions. It imports no WXT, Chrome, Forge, React, Node/Bun built-in, engine, worker, credential, or application-specific module.

The package owns:

- versioned action, module, context, requirement, intent, input, execution-request, receipt, result, surface-target, affordance, availability, and executor-port types;
- the eight reserved MVP root action IDs and four stable group IDs;
- exact schema, ID, string, keyword, requirement, effect, icon, input, intent, context, request, result, and receipt validation;
- JSON-only cloning, cycle/non-plain-object rejection, and deeply frozen parsed projections;
- pure capability/product/entity availability evaluation with stable reason codes plus English fallbacks;
- same-origin context and execution-request validation;
- redacted, structured-clone-safe receipt projection that drops internal fields;
- exact locale-key parity validation, including unavailable-reason text;
- a compile-time contribution intent namespace that remains fail-closed until the host allowlists the exact intent kind;
- a synthetic data-only contribution module fixture that is not imported by an application or palette shell.

## Contract decisions

### Built-in and contributed intents

Built-in intents are a closed discriminated union. Compile-time contribution modules may use the reserved `contribution.*` namespace, but the default validator rejects them. A host must name the exact contribution intent in `allowedContributionIntentKinds` and later provide an executor allowlist entry. A broad unknown-intent fallback is not present.

### Public receipts

`ActionReceiptV1` contains only action/job identifiers, coarse status, host kind, timestamps, and a bounded job kind. It has no origin, tenant, entity ID/title/URL, prompt, response, provider, key, bytes, or raw error field. `projectActionReceiptV1()` copies only this public allowlist from an internal object. `parseActionResultV1()` requires queued receipts to already match the exact public schema, preventing a result from reintroducing dropped internal fields.

### Context and requests

Contexts require an exact HTTPS origin. Entity URLs must be absolute HTTPS URLs on that same origin. Capabilities and entity kinds are stable namespaced IDs. Execution requests reject unknown top-level fields and validate their version, opaque request ID, action ID, intent, context, and bounded string input map. This is a neutral host-built request contract; AP-04 remains responsible for deriving authoritative tab context rather than trusting content-script fields.

## Proof

### Package contract suite

```bash
bun run test packages/action-registry/src
```

Result: **27 passing, 0 failing; 99 assertions**. Coverage includes:

- reserved IDs and built-in intent allowlist;
- JSON round trips, cloning, and nested mutation attempts;
- unknown schema versions and intents;
- exact contribution policy acceptance/rejection;
- duplicate action, secondary-action, field, option, capability, and keyword IDs/values;
- invalid module IDs, groups, icons, effects, requirements, inputs, targets, result affordances, contexts, and requests;
- functions, `undefined`, symbols, bigint, non-finite numbers, dates, accessors/non-plain objects, and cycles;
- capability/product/entity availability and all unavailable reason classes;
- same-origin context and extra-authority rejection;
- input validation and locale key parity;
- redacted receipt projection, exact queued-result receipt enforcement, deep freezing, and native `structuredClone()`.

### Workspace typecheck

```bash
bun run typecheck
```

Result: passed, including the root source graph, extension, browser PDF compiler, and browser export harness typecheck scopes.

### Browser-safety gate

```bash
bun run test scripts/check-browser-build.test.ts
bun run check:browser
```

Results:

- exact-entrypoint and negative gate suite: **27 passing, 0 failing**;
- `packages/action-registry/src/index.ts`: clean browser build, with no Node/Bun built-ins or host-specific graph reached;
- complete browser gate: **34 isomorphic entrypoints passed**.

### Build and published artifact

```bash
bun run --cwd packages/action-registry build
node --input-type=module -e "import('@atlcli/action-registry').then(/* export assertion */)"
bun run test scripts/pack-check.test.ts
```

Results:

- TypeScript emitted JavaScript, declarations, declaration maps, and source maps to `dist/`;
- the default package export loaded from built `dist` and exposed the schema version plus parser (`ACTION_REGISTRY_DIST_OK`);
- real `bun pm pack` validation passed for every publishable workspace package: **12 passing, 0 failing; 432 assertions**;
- the new tarball contains resolvable built JS and declarations, contains no `src/`, workspace range, or `development` export condition, and packing left the source worktree unchanged.

## Host/E2E boundary

AP-01 changes no CLI command, extension manifest/content script/background path, Atlassian resource, Forge module, API request, or user-visible surface. A live tenant E2E would therefore exercise no AP-01 behavior. The authoritative integration evidence for this host-neutral task is the real browser bundle graph and publish-tarball import above. Host and live Atlassian E2E gates begin when AP-04/AP-05 and AP-08 consume the package.
