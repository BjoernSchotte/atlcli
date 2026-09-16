#!/usr/bin/env bun
/**
 * WP0.3b spike: measure what Confluence's CQL `text ~ "..."` actually matches.
 *
 * Decision 12 makes the `grep` CQL shortcut conditional on a guard, and the
 * guard is only as good as this table. The script creates one page holding
 * known character sequences, probes `text ~` with whole words, prefixes, word
 * interiors, compounds, umlauts and digits, prints the result table, and then
 * deletes the page again — in a `finally`, so a crash does not leave residue.
 *
 * Run: bun spikes/vfs-just-bash/cql-text-semantics.ts --profile mayflower --space DOCSY
 */
import { getActiveProfile, loadConfig } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const profileName = flag("profile", "mayflower");
const spaceKey = flag("space", "DOCSY");

const config = await loadConfig();
const profile = getActiveProfile(config, profileName);
if (!profile) {
  console.error(`No profile '${profileName}' in ~/.atlcli/config.json — spike skipped.`);
  process.exit(78);
}
const client = new ConfluenceClient(profile);

/** The needles planted in the page body, each unlikely to occur elsewhere. */
const NEEDLES = [
  "zqxwordmark",
  "zqxcompound_underscore",
  "zqxcompound-hyphen",
  "zqxumlautstraße",
  "zqxumlautgrün",
  "zqx1234567",
  "zqxCamelCaseWord",
  "prefix.zqxdotted.suffix",
];

/** query, what the query is probing, whether we hope it matches. */
const PROBES: { query: string; probes: string; expectHit: boolean }[] = [
  { query: "zqxwordmark", probes: "whole word", expectHit: true },
  { query: "zqxword", probes: "word prefix", expectHit: false },
  { query: "wordmark", probes: "word suffix", expectHit: false },
  { query: "qxwordma", probes: "word interior", expectHit: false },
  { query: "zqxcompound_underscore", probes: "full underscore compound", expectHit: true },
  { query: "zqxcompound", probes: "first half of an underscore compound", expectHit: false },
  { query: "underscore", probes: "second half of an underscore compound", expectHit: false },
  { query: "zqxcompound-hyphen", probes: "full hyphen compound", expectHit: true },
  { query: "hyphen", probes: "second half of a hyphen compound", expectHit: false },
  { query: "zqxumlautstraße", probes: "word with ß", expectHit: true },
  { query: "zqxumlautstrasse", probes: "ß transliterated to ss", expectHit: false },
  { query: "zqxumlautgrün", probes: "word with ü", expectHit: true },
  { query: "zqxumlautgrun", probes: "ü folded to u", expectHit: false },
  { query: "zqx1234567", probes: "digit sequence in a word", expectHit: true },
  { query: "1234567", probes: "bare digit sequence", expectHit: false },
  { query: "zqxcamelcaseword", probes: "case-insensitive whole word", expectHit: true },
  { query: "CamelCase", probes: "camel-case word interior", expectHit: false },
  { query: "zqxdotted", probes: "dot-separated token", expectHit: true },
  { query: "zqxwordmark*", probes: "explicit trailing wildcard", expectHit: true },
  { query: "zqxword*", probes: "prefix with explicit wildcard", expectHit: true },
];

let pageId: string | undefined;
try {
  const homepageId = await client.getSpaceHomepageId(spaceKey);
  const created = await client.createPage({
    spaceKey,
    title: `vfs-e2e-cql-semantics-${Date.now()}`,
    storage: `<p>${NEEDLES.join("</p><p>")}</p>`,
    parentId: homepageId ?? undefined,
  });
  pageId = created.id;
  console.log(`created probe page ${pageId}\n`);

  // Confluence indexes asynchronously; poll until the page is findable at all.
  const sentinel = `space = "${spaceKey}" AND id = ${pageId} AND text ~ "zqxwordmark"`;
  let indexed = false;
  for (let attempt = 0; attempt < 30 && !indexed; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const probe = await client.search(sentinel, { limit: 1 });
    indexed = probe.results.length > 0;
  }
  if (!indexed) {
    console.error("page never appeared in the search index after 60 s — results below are unusable");
  }

  const rows: { probes: string; query: string; hit: boolean; expected: boolean }[] = [];
  for (const probe of PROBES) {
    const cql = `space = "${spaceKey}" AND id = ${pageId} AND text ~ "${probe.query}"`;
    let hit = false;
    try {
      hit = (await client.search(cql, { limit: 5 })).results.length > 0;
    } catch (error) {
      console.error(`query ${probe.query} failed: ${String(error).slice(0, 120)}`);
    }
    rows.push({ probes: probe.probes, query: probe.query, hit, expected: probe.expectHit });
  }

  console.log("| probes | query | matched | expected |");
  console.log("|--------|-------|---------|----------|");
  for (const row of rows) {
    console.log(
      `| ${row.probes} | \`${row.query}\` | ${row.hit ? "yes" : "no"} | ${row.expected ? "yes" : "no"} |`,
    );
  }
  const surprises = rows.filter((r) => r.hit !== r.expected);
  console.log(
    `\n${rows.length - surprises.length}/${rows.length} matched the assumption behind decision 12.`,
  );
  for (const s of surprises) console.log(`  surprise: ${s.probes} (${s.query}) -> ${s.hit ? "hit" : "miss"}`);
} finally {
  if (pageId) {
    await client.deletePage(pageId);
    console.log(`\ndeleted probe page ${pageId}`);
  }
}
