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
  type AdfMediaResolution,
  type ImportedDocument,
} from "@atlcli/import-docx";
import { assertCliAuthSupported } from "./session-guard.js";

export async function handleWikiImport(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
): Promise<void> {
  const [file] = args;
  const fromPage = getFlag(flags, "from-page");
  const attachmentName = getFlag(flags, "attachment");

  if (hasFlag(flags, "help") || (!file && !fromPage)) {
    output(importHelp(), opts);
    return;
  }
  if (file && fromPage) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Give either a local file OR --from-page, not both.", {});
  }
  if (fromPage && !attachmentName) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "--from-page requires --attachment <filename>.", {});
  }
  const sourceName = file ?? attachmentName!;
  if (!sourceName.toLowerCase().endsWith(".docx")) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "Only .docx files are supported.", { file: sourceName });
  }

  const confirm = hasFlag(flags, "confirm");
  const spaceFlag = getFlag(flags, "space");

  // The preview of a local file is a purely local projection: no config,
  // profile, or network access unless the run publishes, needs the profile's
  // default space, or downloads its source from Confluence.
  let profile: Awaited<ReturnType<typeof getActiveProfile>> | undefined;
  if (confirm || !spaceFlag || fromPage) {
    const config = await loadConfig();
    const profileName = getFlag(flags, "profile");
    profile = getActiveProfile(config, profileName);
    if (!profile) {
      fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`.", {
        profile: profileName,
      });
    }
    assertCliAuthSupported(profile, opts);
    if ((confirm || fromPage) && resolveDeploymentType(profile) !== "cloud") {
      fail(
        opts,
        1,
        ERROR_CODES.VALIDATION,
        "wiki import currently supports Confluence Cloud profiles only (Data Center follows the plan's contract track).",
        { profile: profile.name },
      );
    }
  }

  // Acquire source bytes. The parser stays byte-oriented; the imperative
  // shell owns file/network acquisition (plan 004 source adapter).
  let bytes: Uint8Array;
  let source: { kind: "file"; path: string } | { kind: "attachment"; pageId: string; attachmentId: string; version: number };
  if (fromPage) {
    const sourceClient = new ConfluenceClient(profile!);
    const attachments = await sourceClient.listAttachments(fromPage);
    const attachment = attachments.find((a) => a.filename === attachmentName);
    if (!attachment) {
      fail(
        opts,
        1,
        ERROR_CODES.API,
        `Attachment "${attachmentName}" not found on page ${fromPage}.`,
        { pageId: fromPage, available: attachments.map((a) => a.filename).slice(0, 20) },
      );
    }
    bytes = await sourceClient.downloadAttachment(attachment);
    source = {
      kind: "attachment",
      pageId: fromPage,
      attachmentId: attachment.id,
      version: attachment.version,
    };
  } else {
    try {
      bytes = new Uint8Array(readFileSync(file!));
    } catch (err) {
      fail(opts, 1, ERROR_CODES.VALIDATION, `Cannot read file: ${(err as Error).message}`, { file });
    }
    source = { kind: "file", path: file! };
  }

  let doc: ImportedDocument;
  try {
    doc = parseDocx(bytes);
  } catch (err) {
    fail(opts, 1, ERROR_CODES.VALIDATION, `Rejected DOCX package: ${(err as Error).message}`, {
      file: sourceName,
    });
  }

  const spaceKey = spaceFlag ?? profile?.space;
  if (!spaceKey) {
    fail(opts, 1, ERROR_CODES.VALIDATION, "No space given. Use --space <KEY> or set a profile space.", {});
  }
  const title = getFlag(flags, "title") ?? doc.titleCandidate ?? basename(sourceName, ".docx");
  const parentId = getFlag(flags, "parent");

  const preview = await buildImportPreview(doc, { spaceKey, title, parentId });

  if (!confirm) {
    if (opts.json) {
      output({ mode: "preview", source, preview }, opts);
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

  // Publication transaction. With assets the page is created as an empty
  // shell first (attachments need a page id), assets are uploaded, and the
  // final ADF — identical to the preview except for substituted media
  // identities — lands as version 2. Any failure rolls the page back.
  const hasAssets = doc.assets.length > 0;
  const page = await client.createPageAdf({
    spaceId: space.id,
    title,
    adf: hasAssets ? { version: 1, type: "doc", content: [] } : documentToAdf(doc),
    parentId,
  });

  let adf = documentToAdf(doc);
  let finalPage = page;
  try {
    if (hasAssets) {
      for (const asset of doc.assets) {
        await client.uploadAttachment({
          pageId: page.id,
          filename: asset.fileName,
          data: asset.bytes,
          mimeType: asset.mediaType,
        });
      }
      const mediaList = await client.listPageAttachmentMedia(page.id);
      const fileIdByName = new Map(mediaList.attachments.map((a) => [a.filename, a.fileId]));
      const media = new Map<string, AdfMediaResolution>();
      for (const asset of doc.assets) {
        const fileId = fileIdByName.get(asset.fileName);
        if (!fileId) {
          throw new Error(`uploaded attachment ${asset.fileName} has no resolvable media fileId`);
        }
        media.set(asset.id, { fileId, collection: `contentId-${page.id}` });
      }
      adf = documentToAdf(doc, { media });
      finalPage = await client.updatePageAdf({ id: page.id, title, adf, version: 2 });
      finalPage = { ...finalPage, url: finalPage.url ?? page.url };
    }

    // Verify by readback; a page that cannot be verified is rolled back.
    const readback = await client.getPageAdf(page.id);
    const published = JSON.parse(readback.body.value) as {
      content?: { type?: string }[];
    };
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
        source,
        page: { id: finalPage.id, title: finalPage.title, url: finalPage.url, version: finalPage.version },
        adfDigest: preview.adfDigest,
        attachments: preview.assets,
        issues: doc.issues,
      },
      opts,
    );
  } else {
    output(`Created page "${finalPage.title}" (${finalPage.id})`, opts);
    if (finalPage.url) output(finalPage.url, opts);
    if (doc.issues.length > 0) {
      output(`${doc.issues.length} issue(s) — run without --confirm to review them in the preview.`, opts);
    }
  }
}

function importHelp(): string {
  return `atlcli wiki import <file.docx> [options]
atlcli wiki import --from-page <id> --attachment <name.docx> [options]

Semantic DOCX import to a new Confluence Cloud page (review-first).

Without --confirm the command only previews: block counts, heading outline,
issues, and the digest of the exact ADF payload a confirmed run publishes.
The source is a local file, or a DOCX already attached to a Confluence page.

Options:
  --from-page <id>       Source: page id carrying the DOCX attachment
  --attachment <name>    Source: exact attachment file name on that page
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
