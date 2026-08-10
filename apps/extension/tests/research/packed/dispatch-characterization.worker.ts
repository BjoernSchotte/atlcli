import { runDeclarativeDispatchCharacterization } from "../dispatch-adapter-declarative-harness.js";

interface CharacterizationRequest {
  kind: "run-dispatch-characterization";
}

globalThis.addEventListener("message", (event: MessageEvent<CharacterizationRequest>) => {
  if (event.data?.kind !== "run-dispatch-characterization") return;
  void runDeclarativeDispatchCharacterization().then(
    (result) => {
      globalThis.postMessage({
        kind: "dispatch-characterization-result",
        ok: true,
        result,
      });
    },
    (error) => {
      globalThis.postMessage({
        kind: "dispatch-characterization-result",
        ok: false,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: "UnknownError", message: String(error) },
      });
    },
  );
});
