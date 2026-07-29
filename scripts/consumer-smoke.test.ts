import { describe, expect, it } from "bun:test";
import { runTarballSmoke } from "./consumer-smoke.js";
import {
  FILELINK_SMOKE_ENV,
  runFilelinkSmoke,
} from "./consumer-smoke-filelink.js";
import { runNodeSmoke } from "./consumer-smoke-node.js";
import { runViteSmoke } from "./consumer-smoke-vite.js";

/**
 * Consumer smoke wiring (spec 009): the heavy suites run behind
 * ATLCLI_CONSUMER_SMOKE=1 (set in the consumer-smoke CI workflow) because
 * they install from the public registry (transitive third-party deps) and
 * spawn real npm/node processes — too slow/network-dependent for every local
 * `bun test`. Each suite throws on any failed step; a passing test means the
 * whole flow (pack → install → real DOCX/PDF exports → skipLibCheck:false
 * type-check) succeeded.
 */

const enabled = process.env.ATLCLI_CONSUMER_SMOKE === "1";

describe("filesystem-link package identity", () => {
  it("does not compare state across Bun's distinct direct and transitive file: copies", () => {
    expect(FILELINK_SMOKE_ENV).toEqual({
      NODE_ENV: "production",
      ATLCLI_ASSERT_SHARED_CODE_HIGHLIGHT_STATE: "0",
    });
  });
});

if (!enabled) {
  console.log(
    "consumer-smoke: SKIPPED — set ATLCLI_CONSUMER_SMOKE=1 to run the tarball, " +
      "filesystem-link, and Node-LTS consumer suites (registry access required).",
  );
}

describe.skipIf(!enabled)("consumer smoke (spec 009)", () => {
  it(
    "tarball install (bun): pack all, install with overrides, DOCX + PDF smokes, skipLibCheck:false types",
    async () => {
      const { smokes } = await runTarballSmoke();
      console.log(`tarball: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "filesystem-link install (bun, NODE_ENV=production): file: package dirs resolve to dist and export for real",
    async () => {
      const { smokes } = await runFilelinkSmoke();
      console.log(`filelink: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "Node-LTS (npm + plain node): every Node-compatible entrypoint imports, NodeNext types check, real exports run",
    async () => {
      const { nodeVersion, npmVersion, smokes } = await runNodeSmoke();
      console.log(`node ${nodeVersion} / npm ${npmVersion}: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );

  it(
    "Vite tarball build: browser assets resolve and the production chunk compiles real DOCX + PDF exports",
    async () => {
      const { viteVersion, smokes } = await runViteSmoke();
      console.log(`vite ${viteVersion}: ${smokes.docx} | ${smokes.pdf}`);
    },
    300000,
  );
});
