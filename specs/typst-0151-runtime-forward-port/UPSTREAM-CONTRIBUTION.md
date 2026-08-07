# Prepared upstream contribution

No upstream pull request was created. Submission requires explicit operator
authorization and must follow the dependency order below.

## Dependency order

1. Contribute the eight patch-equivalent Typst core commits from
   `BjoernSchotte/typst:codex/typst-0.15.1` to `Myriad-Dreamin/typst`.
2. Replace the temporary `BjoernSchotte/typst@301531fc...` dependency in the
   typst.ts integration commit with the merged immutable
   `Myriad-Dreamin/typst` commit or tag.
3. Re-run the clean reproducible build and browser/CSP gates.
4. Submit the two commits from
   `BjoernSchotte/typst.ts:codex/typst-0.15.1-integration` to
   `Myriad-Dreamin/typst.ts`.

Directly pointing typst.ts at official `typst/typst@9dfd3a08...` is not a
working substitute: the first compiler check fails because the existing
typst.ts/Tinymist integration requires the Myriad-specific
`Frame::content_hint` API. The production fork pin is therefore temporary but
technically necessary until step 1 lands.

## typst.ts pull-request draft

**Title:** Forward-port the web compiler to Typst 0.15.1

### Summary

This updates the typst.ts web compiler from its current Typst baseline to
Typst 0.15.1. It keeps the existing JavaScript/WASM API intact while adapting
the compiler bindings to the Typst 0.15.1 APIs. It also removes
runtime-generated JavaScript functions from the compiler builder so the
generated package can run under strict Content Security Policies without
`unsafe-eval`.

### What changed

- update the pinned Typst crates and lockfile to Typst 0.15.1;
- adapt the compiler bindings to the Typst 0.15.1 APIs;
- preserve the existing web-compiler package surface;
- replace dynamic `Function` construction with static closures;
- keep the generated WASM glue free of `eval` and `new Function`.

### Compatibility

- existing consumers continue to initialize and use the compiler through the
  current typst.ts API;
- no atlcli-specific code or package configuration is included;
- the Typst source is official 0.15.1 plus the existing Myriad integration
  patches, replayed onto that release.

### Verification

- Rust compiler checks pass with the pinned toolchain;
- two clean web-compiler builds produce byte-identical package artifacts;
- the generated package passes static CSP checks;
- browser compilation and PDF export pass against the 0.15.1 runtime.

### Commit structure

1. `build(compiler): forward port Typst 0.15.1`
2. `fix(compiler): remove dynamic function construction`

The CSP commit can be reviewed independently from the core forward-port.
