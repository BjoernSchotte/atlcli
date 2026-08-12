import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extensionRoot = join(import.meta.dir, "..");
const offscreenSource = readFileSync(
  join(extensionRoot, "entrypoints", "offscreen", "main.ts"),
  "utf8",
);
const backgroundSource = readFileSync(
  join(extensionRoot, "entrypoints", "background.ts"),
  "utf8",
);

describe("local model offscreen boundary", () => {
  it("keeps activation storage in the background and lazily loads the offscreen runtime", () => {
    expect(backgroundSource).toContain("resolveBrowserChatModelRunBindingV1");
    expect(backgroundSource).toContain("LOCAL_MODEL_ACTIVATION_STORAGE_KEY_V1");
    expect(offscreenSource).not.toMatch(/chrome\.storage\.(?:local|session)/u);
    expect(offscreenSource).not.toContain("restoreInstalledLocalModelWorkerV1");
    expect(offscreenSource).toContain("function connectInstalledLocalModelV1()");
    expect(offscreenSource).toContain("prewarmLocalModelRuntimeV1");
    expect(offscreenSource).toContain("localModelRuntimeModulePromise");
    expect(offscreenSource).toContain("connectLocalModelPortV1(channel.port2)");
    expect(offscreenSource).not.toMatch(/new Worker\([^)]*local-model/isu);
    expect(backgroundSource).toContain("prewarmSelectedLocalModelV1");
    expect(backgroundSource).toContain("selection.providerId !== \"local-gemma\"");
  });
});
