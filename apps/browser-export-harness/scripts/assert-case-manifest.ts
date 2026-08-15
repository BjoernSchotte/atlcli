/**
 * CI drift guard for the conformance-case registry (spec 011, T4.6). Fails the
 * build when the registered case-id set diverges from the expected set for the
 * feature folders that have landed — catching an unregistered case, a duplicate,
 * or a stale expectation before merge. Wired into the `browser-export-harness`
 * CI job alongside the Playwright run.
 */
// This guard imports the pure MANIFEST only (no DOM/engine code), so it checks
// id-set drift, not that every id has a run function. That runner-presence check
// lives in `conformance-registry.ts`, whose `RUNNERS[meta.id]` lookup throws at
// construction ("No run function registered for …") — exercised whenever the
// registry is imported (the app + the Playwright loop both do so).
import { CONFORMANCE_MANIFEST, EXPECTED_LANDED_CASE_IDS } from "../src/conformance-manifest.js";

function fail(message: string): never {
  process.stderr.write(`assert-case-manifest: ${message}\n`);
  process.exit(1);
}

const ids = CONFORMANCE_MANIFEST.map((c) => c.id);

const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) fail(`duplicate case ids: ${[...new Set(duplicates)].join(", ")}`);

const registered = new Set(ids);
const expected = new Set(EXPECTED_LANDED_CASE_IDS);

const unexpected = [...registered].filter((id) => !expected.has(id));
const missing = [...expected].filter((id) => !registered.has(id));

if (unexpected.length > 0 || missing.length > 0) {
  const parts: string[] = [];
  if (unexpected.length > 0) parts.push(`unregistered/unexpected: ${unexpected.join(", ")}`);
  if (missing.length > 0) parts.push(`missing expected: ${missing.join(", ")}`);
  fail(`case-id set does not match the expected landed set — ${parts.join("; ")}`);
}

// Every case must declare at least one engine and a media policy.
for (const meta of CONFORMANCE_MANIFEST) {
  if (meta.engines.length === 0) fail(`case "${meta.id}" declares no engines`);
  if (meta.folderTaskIds.length === 0) fail(`case "${meta.id}" declares no folderTaskIds`);
}

process.stdout.write(`assert-case-manifest: OK (${ids.length} cases: ${ids.join(", ")})\n`);
