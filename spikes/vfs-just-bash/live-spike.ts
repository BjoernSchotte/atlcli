#!/usr/bin/env bun
/**
 * WP0.3 spike: drive just-bash against the **real** `ConfluenceClient`,
 * read-only, and record latency and request counts.
 *
 * Needs a configured profile. Run:
 *   bun spikes/vfs-just-bash/live-spike.ts --profile mayflower --space DOCSY
 */
import { getActiveProfile, loadConfig } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { slugifyTitle } from "@atlcli/confluence/internal";
import { Bash, MountableFs } from "just-bash";
import { FakeRemoteFs } from "./fake-fs.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const profileName = flag("profile", "mayflower");
const spaceKey = flag("space", "DOCSY");
const pageLimit = Number(flag("pages", "20"));

const config = await loadConfig();
const profile = getActiveProfile(config, profileName);
if (!profile) {
  console.error(`No profile '${profileName}' in ~/.atlcli/config.json — spike skipped.`);
  process.exit(78);
}

let requests = 0;
const client = new ConfluenceClient(profile, {
  observeTransport: (event) => {
    if (event.type === "attempt") requests += 1;
  },
});

const timings: { step: string; ms: number; requests: number }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const before = requests;
  const t0 = performance.now();
  const value = await fn();
  timings.push({ step: name, ms: performance.now() - t0, requests: requests - before });
  return value;
}

// Build a snapshot filesystem the same shape the real VFS will expose, so the
// spike measures API cost rather than adapter design.
const fs = new FakeRemoteFs();

const space = await step("getSpace", () => client.getSpace(spaceKey));
const rootChildren = await step("root direct-children", async () => {
  const homepageId = await client.getSpaceHomepageId(spaceKey);
  if (!homepageId) return [];
  return await client.getPageDirectChildren(homepageId, { limit: pageLimit });
});

const sample = rootChildren.slice(0, pageLimit);
await step(`bodies of ${sample.length} pages`, async () => {
  for (const page of sample) {
    const detail = await client.getPage(page.id);
    fs.seed(
      `/${slugifyTitle(page.title)}-${page.id}.md`,
      `---\natlcli:\n  id: "${page.id}"\n  title: "${page.title}"\n---\n\n${detail.storage}\n`,
    );
  }
});

const bash = new Bash({
  defenseInDepth: false,
  cwd: `/${spaceKey}`,
  fs: new MountableFs({ mounts: [{ mountPoint: `/${spaceKey}`, filesystem: fs }] }),
});

for (const script of ["ls", `grep -rl "the" .`, `find . -name "*.md" | wc -l`]) {
  const before = requests;
  const t0 = performance.now();
  const result = await bash.exec(script);
  timings.push({ step: `sh: ${script}`, ms: performance.now() - t0, requests: requests - before });
  console.log(`$ ${script}\n${result.stdout.split("\n").slice(0, 5).join("\n")}\n`);
}

console.log(`space: ${space.key} (${space.name}), sampled ${sample.length} pages\n`);
console.log("step                                 ms       requests");
for (const t of timings) {
  console.log(`${t.step.padEnd(36)} ${t.ms.toFixed(0).padStart(6)}   ${String(t.requests).padStart(8)}`);
}
console.log(`\ntotal REST requests: ${requests}`);
