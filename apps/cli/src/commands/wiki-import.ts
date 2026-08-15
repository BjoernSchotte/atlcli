/**
 * `atlcli wiki import <file.docx>` — review-first semantic DOCX import
 * (specs/import-docx-mvp vertical slice).
 *
 * Without `--confirm` the command parses, previews, and exits without any
 * network write. With `--confirm` it publishes exactly the previewed ADF to a
 * new Cloud page, verifies the readback, and rolls the page back if
 * publication cannot be verified.
 */
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import {
  ERROR_CODES,
  OutputOptions,
  fail,
  getActiveProfile,
  getFlag,
  hasFlag,
  loadConfig,
  output,
  resolveDeploymentType,
} from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import {
  buildImportPreview,
  documentToAdf,
  parseDocx,
  renderImportPreview,
  type ImportedDocument,
} from "@atlcli/import-docx";
import { assertCliAuthSupported } from "./session-guard.js";

export async function handleWikiImport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  const [file] = args;
  if (!file || hasFlag(flags, "help")) {
    output(importHelp(), opts);
    return;
  }
  if (!file.toLowerCase().endsWith(".docx")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Only .docx files are supported.", { file });
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (err) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read file: ${(err as Error).message}`, { file });
  }

  let doc: ImportedDocument;
  try {
    doc = parseDocx(bytes);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Rejected DOCX package: ${(err as Error).message}`, {
      file,
    });
  }

  const confirm = hasFlag(flags, "confirm");
  const spaceFlag = getFlag(flags, "space");

  // The preview is a purely local projection: no config, profile, or network
  // access unless the run publishes or needs the profile's default space.
  let profile: Awaited<ReturnType<typeof getActiveProfile>> | undefined;
  if (confirm || !spaceFlag) {
    const config = await loadConfig();
    const profileName = getFlag(flags, "profile");
    profile = getActiveProfile(config, profileName);
    if (!profile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {
        profile: profileName,
      });
    }
    assertCliAuthSupported(profile, opts);
    if (confirm && resolveDeploymentType(profile) !== "cloud") {
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        "wiki import currently supports Confluence Cloud profiles only (Data Center follows the plan's contract track).",
        { profile: profile.name },
      );
    }
  }

  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  }
  const title = getFlag(flags, "title") ?? doc.titleCandidate ?? basename(file, ".docx");
  const parentId = getFlag(flags, "parent");

  const preview = await buildImportPreview(doc, { spaceKey, title, parentId });

  if (!confirm) {
    if (opts.json) {
      output({ mode: "preview", preview }, opts);
    } else {
      output(renderImportPreview(preview), opts);
      output("\nDry preview only — nothing was published. Re-run with --confirm to create the page.", opts);
    }
    return;
  }

  const client = new ConfluenceClient(profile!);
  const spacePage = await client.listSpacesV2({ keys: [spaceKey], limit: 1 });
  const space = spacePage.spaces.find((s) => s.key === spaceKey);
  if (!space) {
    fail(opts, 1, ERROR_CODES.API, `Space ${spaceKey} not found or not accessible.`, {
      spaceKey,
    });
  }

  const adf = documentToAdf(doc);
  const page = await client.createPageAdf({
    spaceId: space.id,
    title,
    adf,
    parentId,
  });

  // Verify by readback; a page that cannot be verified is rolled back.
  try {
    const readback = await client.getPageAdf(page.id);
    const published = JSON.parse(readback.body.value) as { content?: { type?: string }[] };
    const expectedTypes = adf.content.map((n) => n.type).join(",");
    const actualTypes = (published.content ?? []).map((n) => n.type).join(",");
    if (expectedTypes !== actualTypes) {
      throw new Error(
        `published block sequence [${actualTypes}] does not match the previewed plan [${expectedTypes}]`,
      );
    }
  } catch (err) {
    try {
      await client.deletePage(page.id);
    } catch {
      fail(
        opts,
        1,
        ERROR_CODES.API,
        `Publication verification failed AND rollback failed — page ${page.id} needs manual cleanup: ${(err as Error).message}`,
        { pageId: page.id },
      );
    }
    fail(
      opts,
      1,
      ERROR_CODES.API,
      `Publication could not be verified; the page was rolled back: ${(err as Error).message}`,
      {},
    );
  }

  if (opts.json) {
    output(
      {
        mode: "published",
        page: { id: page.id, title: page.title, url: page.url, version: page.version },
        adfDigest: preview.adfDigest,
        issues: doc.issues,
      },
      opts,
    );
  } else {
    output(`Created page "${page.title}" (${page.id})`, opts);
    if (page.url) output(page.url, opts);
    if (doc.issues.length > 0) {
      output(`${doc.issues.length} issue(s) — run without --confirm to review them in the preview.`, opts);
    }
  }
}

function importHelp(): string {
  return `atlcli wiki import <file.docx> [options]

Semantic DOCX import to a new Confluence Cloud page (review-first).

Without --confirm the command only previews: block counts, heading outline,
issues, and the digest of the exact ADF payload a confirmed run publishes.

Options:
  --space <KEY>     Target space key (default: profile space)
  --title <title>   Page title (default: first Heading 1, else file name)
  --parent <id>     Parent page id
  --confirm         Actually create the page
  --profile <name>  Use a specific auth profile
  --json            JSON output

Examples:
  atlcli wiki import handbook.docx --space DOCSY
  atlcli wiki import handbook.docx --space DOCSY --parent 12345 --confirm
`;
}
