#!/usr/bin/env bun
/**
 * Node-LTS consumer smoke (spec 009, Consumer smoke).
 *
 * A fresh npm project (npm, not bun) installs the packed tarballs, its
 * `main.ts` imports every entrypoint the support matrix marks
 * Node-compatible (everything except @atlcli/jira, whose webhook-server is
 * Bun-native — see the engines fields), type-checks under
 * `moduleResolution: NodeNext` with `skipLibCheck: false`, and runs the real
 * DOCX + PDF smokes under plain `node`. This is the check that actually
 * proves the `bun:sqlite` barrel fix holds for a plain-Node consumer.
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSUMER_DEV_DEPS,
  assertNoWorkspaceLeak,
  buildPackages,
  packAll,
  run,
  runConsumerTypecheck,
  runSmokes,
  scaffoldConsumer,
  type SmokeRunResult,
} from "./consumer-smoke.js";

/** Entrypoints the support matrix marks Node-compatible (jira is Bun-only). */
const NODE_COMPATIBLE_IMPORTS = `
import * as pluginApi from "@atlcli/plugin-api";
import * as core from "@atlcli/core";
import * as diagram from "@atlcli/diagram";
import * as confluence from "@atlcli/confluence";
import * as docx from "@atlcli/docx";
import * as pdf from "@atlcli/pdf";
import * as pcb from "@atlcli/pdf-compiler-browser";
import * as exportMacros from "@atlcli/export-macros";
import * as templatePack from "@atlcli/template-pack";
import * as exportNode from "@atlcli/export-node";

for (const [name, mod] of Object.entries({ pluginApi, core, diagram, confluence, docx, pdf, pcb, exportMacros, templatePack, exportNode })) {
  if (Object.keys(mod).length === 0) throw new Error(\`\${name} has no exports\`);
}
console.log("NODE_IMPORTS_OK");
`;

export interface NodeSmokeResult {
  projectDir: string;
  nodeVersion: string;
  npmVersion: string;
  smokes: SmokeRunResult;
}

export async function runNodeSmoke(baseDir?: string): Promise<NodeSmokeResult> {
  const workDir = baseDir ?? join(tmpdir(), `atlcli-node-smoke-${process.pid}`);
  rmSync(workDir, { recursive: true, force: true });

  buildPackages();
  const tarballs = packAll(join(workDir, "tarballs"));

  const projectDir = join(workDir, "consumer");
  const dependencies = Object.fromEntries(
    [...tarballs.entries()].map(([name, path]) => [name, `file:${path}`]),
  );
  scaffoldConsumer(projectDir, {
    dependencies,
    devDependencies: CONSUMER_DEV_DEPS,
    moduleResolution: "nodenext",
  });
  writeFileSync(join(projectDir, "node-imports.mjs"), NODE_COMPATIBLE_IMPORTS);

  const nodeVersion = run(["node", "--version"], projectDir).stdout.trim();
  const npmVersion = run(["npm", "--version"], projectDir).stdout.trim();

  const install = run(["npm", "install", "--no-audit", "--no-fund"], projectDir);
  if (install.exitCode !== 0) {
    throw new Error(`npm install (node consumer) failed:\n${install.stdout}\n${install.stderr}`);
  }
  assertNoWorkspaceLeak(projectDir);

  // Every Node-compatible entrypoint must import cleanly under plain node.
  const imports = run(["node", "node-imports.mjs"], projectDir);
  if (imports.exitCode !== 0 || !imports.stdout.includes("NODE_IMPORTS_OK")) {
    throw new Error(`node entrypoint imports failed:\n${imports.stdout}\n${imports.stderr}`);
  }

  // NodeNext + skipLibCheck:false type-consumption.
  runConsumerTypecheck(projectDir);

  // Real exports under plain node.
  const smokes = runSmokes(projectDir, ["node"]);
  return { projectDir, nodeVersion, npmVersion, smokes };
}

if (import.meta.main) {
  const { projectDir, nodeVersion, npmVersion, smokes } = await runNodeSmoke();
  console.log(`node consumer smoke OK in ${projectDir} (node ${nodeVersion}, npm ${npmVersion})`);
  console.log(smokes.docx);
  console.log(smokes.pdf);
}
