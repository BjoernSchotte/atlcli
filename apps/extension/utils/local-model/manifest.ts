export const LOCAL_MODEL_MANIFEST_SCHEMA_V1 =
  "atlcli.browser-local-model-manifest/v1" as const;

export interface LocalModelManifestFileV1 {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface LocalModelManifestV1 {
  schema: typeof LOCAL_MODEL_MANIFEST_SCHEMA_V1;
  modelId: string;
  modelRevision: string;
  sourceModelId: string;
  task: "text-generation";
  modelClass: "Gemma4ForConditionalGeneration";
  dtype: "q4f16";
  device: "webgpu";
  aggregateByteLength: number;
  files: readonly LocalModelManifestFileV1[];
  runtime: {
    transformersJs: string;
    onnxRuntimeWeb: string;
  };
  license: {
    spdx: "Apache-2.0";
    url: string;
    attribution: string;
  };
}

/**
 * G0 supply-chain boundary for the text-only Gemma 4 E4B browser proof.
 *
 * The immutable revision and file metadata come from the Hugging Face model
 * API with blob metadata enabled. Transformers.js 4.2.0 ModelRegistry resolves
 * this exact nine-file set for `text-generation`, `q4f16`, and `webgpu`.
 * Vision/audio encoders and every other dtype are deliberately absent.
 */
export const LOCAL_GEMMA_G0_MANIFEST_V1: LocalModelManifestV1 = {
  schema: LOCAL_MODEL_MANIFEST_SCHEMA_V1,
  modelId: "onnx-community/gemma-4-E4B-it-ONNX",
  modelRevision: "843f250f23bc91754def1e0f0db390dacd1e6b05",
  sourceModelId: "google/gemma-4-E4B-it",
  task: "text-generation",
  modelClass: "Gemma4ForConditionalGeneration",
  dtype: "q4f16",
  device: "webgpu",
  aggregateByteLength: 4_924_946_442,
  files: [
    {
      path: "config.json",
      byteLength: 5_741,
      sha256: "3251c77df50bccec2037f7e06a023105aeacbc89b784d990b1d279fc83ff9b1f",
    },
    {
      path: "onnx/embed_tokens_q4f16.onnx",
      byteLength: 5_619,
      sha256: "aa48aa1806eda0ea42b79cd8eea355aebaf3b6ae3b04190bfee7ceef308603a4",
    },
    {
      path: "onnx/embed_tokens_q4f16.onnx_data",
      byteLength: 2_017_460_224,
      sha256: "fd0f39c08f7e20a31145c2351a76a408b6c4ab60d15cc33f40e29cf30c0b2451",
    },
    {
      path: "onnx/decoder_model_merged_q4f16.onnx",
      byteLength: 850_610,
      sha256: "43aa27452be3dd7fbb9524257dd66af957add748ddab20ea63ae71923e59aa08",
    },
    {
      path: "onnx/decoder_model_merged_q4f16.onnx_data",
      byteLength: 2_074_847_232,
      sha256: "b6aa13eab3ecdf4721293e93c806c279ca0516956187f7aec63ee90ec7216e73",
    },
    {
      path: "onnx/decoder_model_merged_q4f16.onnx_data_1",
      byteLength: 812_318_720,
      sha256: "84e1c5f09ba88a5351959e4f73f62bce46f92dc19a7d7c82376ef36771c26a30",
    },
    {
      path: "generation_config.json",
      byteLength: 238,
      sha256: "e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155",
    },
    {
      path: "tokenizer.json",
      byteLength: 19_439_251,
      sha256: "47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566",
    },
    {
      path: "tokenizer_config.json",
      byteLength: 18_807,
      sha256: "06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3",
    },
  ],
  runtime: {
    transformersJs: "4.2.0",
    onnxRuntimeWeb: "1.26.0-dev.20260416-b7804b056c",
  },
  license: {
    spdx: "Apache-2.0",
    url: "https://ai.google.dev/gemma/docs/gemma_4_license",
    attribution: "Gemma 4 by Google DeepMind; ONNX export by ONNX Community.",
  },
};
