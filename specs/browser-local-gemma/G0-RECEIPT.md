# Browser-local Gemma 4 E4B G0 decision receipt

Decision: **GO for continued implementation; not release-ready.**

The packed browser extension proves that Gemma 4 E4B can participate in the
existing Chat architecture for Quick, Auto, and Think deeper without a second
Chat surface or workflow. Anthropic remains available and unchanged. Deep
Research remains unavailable for the local model and is never silently routed
to Anthropic.

## Revision and environment

| Item | Recorded value |
| --- | --- |
| Implementation checkpoint | `670bda0820ab4b5bcdaa098973f4900c520929c5` |
| Extension artifact | Production WXT Chrome MV3 output |
| Browser | Chrome `151.0.7922.138` |
| Operating system | macOS `26.4` (`25E246`) |
| Decision hardware | MacBook Pro `Mac17,7`, Apple M5 Max, 18 CPU cores, 40 GPU cores, 128 GB unified memory |
| Inference runtime | Transformers.js `4.2.0`; ONNX Runtime Web `1.26.0-dev.20260416-b7804b056c` |
| Model | `onnx-community/gemma-4-E4B-it-ONNX` at revision `843f250f23bc91754def1e0f0db390dacd1e6b05` |
| Source model | `google/gemma-4-E4B-it` |
| Selection | `Gemma4ForCausalLM`, text generation, `q4f16`, WebGPU |
| Installed size | 4,924,946,442 bytes across nine verified files |
| License | Apache-2.0; Gemma 4 attribution and license notice retained by the manifest |

No device serial number, browser profile, tenant identifier, private URL,
prompt, page body, answer, or source reference is included in this receipt.

## Selected model file manifest

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `config.json` | 5,741 | `3251c77df50bccec2037f7e06a023105aeacbc89b784d990b1d279fc83ff9b1f` |
| `onnx/embed_tokens_q4f16.onnx` | 5,619 | `aa48aa1806eda0ea42b79cd8eea355aebaf3b6ae3b04190bfee7ceef308603a4` |
| `onnx/embed_tokens_q4f16.onnx_data` | 2,017,460,224 | `fd0f39c08f7e20a31145c2351a76a408b6c4ab60d15cc33f40e29cf30c0b2451` |
| `onnx/decoder_model_merged_q4f16.onnx` | 850,610 | `43aa27452be3dd7fbb9524257dd66af957add748ddab20ea63ae71923e59aa08` |
| `onnx/decoder_model_merged_q4f16.onnx_data` | 2,074,847,232 | `b6aa13eab3ecdf4721293e93c806c279ca0516956187f7aec63ee90ec7216e73` |
| `onnx/decoder_model_merged_q4f16.onnx_data_1` | 812,318,720 | `84e1c5f09ba88a5351959e4f73f62bce46f92dc19a7d7c82376ef36771c26a30` |
| `generation_config.json` | 238 | `e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155` |
| `tokenizer.json` | 19,439,251 | `47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566` |
| `tokenizer_config.json` | 18,807 | `06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3` |

## Production-path proof

All acceptance runs used the installed packed extension and the existing
side-panel conversation UI. Caller-path evidence records the existing five
host stages: `research-screen` -> `sidepanel-port` -> `background` ->
`offscreen` -> `research-worker`. The fresh research worker then used the
shared Chat runtime and the host-owned local model binding.

Sanitized live case classes:

| Case | Required result | Result |
| --- | --- | --- |
| Quick exact-context, three consecutive runs | Shared tool loop, streamed and canonical cited answer, persisted conversation | Pass |
| Auto direct, three consecutive runs | Direct strategy and terminal cited answer | Pass |
| Auto agentic, three consecutive runs | Existing workflow trajectory, validation, and terminal synthesis | Pass |
| Think deeper direct, three consecutive runs | Direct strategy, validation, one progress sequence, cited answer | Pass |
| Think deeper agentic, three consecutive runs | Delegation, validation/repair where needed, and terminal synthesis | Pass |
| Evidence-aware follow-up and reopen | Provider identity, evidence bindings, and tool correlation retained | Pass |
| Existing Chat cancellation | Typed terminal cancellation; no late progress; next Chat run succeeds | Pass |
| Five-minute idle and re-entry | Loaded model session disposed; later existing-UI Chat cold-loads and answers | Pass |

Host validation and repair are structural and evidence-driven. Contract fixtures
cover German, English, and French paraphrases without phrase-based acceptance,
literal request matching, page-specific anchors, or language-specific output
regexes.

## Timing and resource measurements

Three persisted warm terminal-generation samples from the productive caller
path were recorded without request or answer bodies:

| Input tokens | Output tokens | First token/preview | Generation | Total | Decode rate |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 969 | 151 | 1,320 ms | 12,602 ms | 12,612 ms | 11.98 tokens/s |
| 988 | 156 | 3,669 ms | 20,289 ms | 20,299 ms | 7.69 tokens/s |
| 988 | 156 | 2,747 ms | 16,983 ms | 16,993 ms | 9.19 tokens/s |

The highest observed extension-process snapshot during a real local turn was
3.4 GB process memory, 16.1 MB GPU memory, and 112,672 KB allocated / 98,543 KB
live JavaScript memory. CPU returned to 0 after completion. These values are a
decision-machine observation, not a support ceiling.

Cancellation was requested after approximately 33 seconds. The UI reached its
stopped terminal state, no additional generation progress appeared during the
next five seconds, and a fresh warm cited answer completed in approximately 24
seconds.

After five idle minutes, the offscreen host logged successful model-session
disposal. Chrome initially retained most of the already-grown WASM process
reservation (approximately 2.2 GB before and 2.1 GB shortly after disposal), so
this receipt does not claim that `model.dispose()` immediately returns RSS to
the operating system. A later Chat turn cold-loaded through the same existing
UI and produced a terminal answer in approximately 27 seconds; no cumulative
extension process remained after completion. Broader repeated-idle, memory
pressure, and support-threshold testing remains G6 work.

The host did not expose detailed thermal telemetry through the available
measurement command. Repeated local runs produced no operating-system thermal
warning, and CPU returned to idle after completion. Sustained thermal and
low-memory testing remains a release gate rather than a G0 claim.

## Network and privacy proof

A cleared offscreen Network recording around a warm local turn contained three
requests: two extension-owned bundled scripts and one expected Atlassian read.
It contained zero Anthropic requests and zero model-distribution-origin
requests. The answer completed normally. This proves the local LLM boundary;
it does not describe Atlassian reads as offline.

## Automated gates

The G0 lifecycle checkpoint passed:

```text
bun run test apps/extension/tests/local-model-runtime-lifecycle.test.ts \
  apps/extension/tests/local-model-offscreen-boundary.test.ts \
  apps/extension/tests/local-model-rpc.test.ts \
  apps/extension/tests/local-model-worker-bootstrap.test.ts \
  apps/extension/tests/research-worker-host.test.ts

74 pass, 0 fail
```

The workspace typecheck, packed-extension output audit, and tracked-tree
research privacy audit passed. The latest full-workspace test attempt recorded
7,742 passes, 17 skips, and 65 failures; the product ratchet mismatches found by
that run were repaired, while the remaining run was dominated by sandbox-only
local-port and temporary-directory failures. Because a clean unrestricted full
suite was not recorded, this receipt is explicitly not a release receipt.

## Decision and next gates

G0 is a **GO** because the real packed MV3 extension can run the existing Chat
architecture with the pinned local model, satisfy its tool/evidence/answer
contracts in all three Chat modes, preserve the Anthropic option, avoid remote
LLM fallback, cancel, dispose an idle session, and recover through the same UI.

Release remains blocked on the unchecked G1-G7 work, including complete model
download/removal recovery, provider-switch and export resource arbitration,
device-loss and memory-pressure recovery, broader hardware/browser thresholds,
user-facing support documentation, and a clean release-grade full test run.
