import { ReplSession } from "@langchain/quickjs";

const session = new ReplSession("research-cross-process-characterization", {
  captureConsole: false,
});

try {
  const result = await session.eval(
    "globalThis.processProbeCounter = (globalThis.processProbeCounter ?? 0) + 1; processProbeCounter",
    5_000,
  );
  process.stdout.write(JSON.stringify(result));
} finally {
  session.dispose();
}
