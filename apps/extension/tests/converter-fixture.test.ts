import { describe, expect, it } from "bun:test";
import type { Profile } from "@atlcli/core";
import type { ConfluencePageDetails } from "@atlcli/confluence/browser";
import { loadConfluencePage, type ReadPathDeps } from "../utils/read-path.js";

/**
 * Task 3 fixture: a representative Confluence storage document exercising the
 * landmarks a real page uses — headings, an info (callout) macro, a table, an
 * inline image reference, and a code block — converted through the REAL
 * storage→markdown converter (imported via the browser entry) inside the panel
 * read path. Asserts the resulting panel state carries non-empty markdown with
 * each landmark present, plus a plausible word count and attachment metadata.
 */
const STORAGE_FIXTURE = `
<h1>Release Notes</h1>
<h2>Highlights</h2>
<p>The <strong>exporter</strong> now supports session auth.</p>
<ac:structured-macro ac:name="info">
  <ac:rich-text-body><p>Remember to log in to Confluence first.</p></ac:rich-text-body>
</ac:structured-macro>
<table>
  <tbody>
    <tr><th>Feature</th><th>Status</th></tr>
    <tr><td>Read path</td><td>Done</td></tr>
    <tr><td>Export</td><td>Planned</td></tr>
  </tbody>
</table>
<p>Architecture diagram:</p>
<ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">bash</ac:parameter>
  <ac:plain-text-body><![CDATA[atlcli export page 12345]]></ac:plain-text-body>
</ac:structured-macro>
`.trim();

const details: ConfluencePageDetails = {
  id: "12345",
  title: "Release Notes",
  version: 7,
  spaceKey: "DOCSY",
  storage: STORAGE_FIXTURE,
  modified: "2026-07-14T10:00:00.000Z",
  modifiedBy: { displayName: "Björn Schotte" },
};

const fakeClientDeps: Pick<ReadPathDeps, "makeClient"> = {
  makeClient: () => ({
    getPageDetails: async () => details,
    listAttachments: async () => [
      {
        id: "att1",
        filename: "diagram.png",
        mediaType: "image/png",
        fileSize: 4096,
        version: 1,
        pageId: "12345",
        downloadUrl: "/download/attachments/12345/diagram.png",
      },
    ],
  }),
};

const sessionProfile: Profile = {
  name: "session",
  baseUrl: "https://test.atlassian.net",
  deploymentType: "cloud",
  auth: { type: "session" },
};

describe("storage → markdown fixture conversion (Task 3)", () => {
  it("produces non-empty markdown carrying every landmark", async () => {
    const loaded = await loadConfluencePage("12345", sessionProfile, fakeClientDeps);
    const md = loaded.markdown;

    expect(md.length).toBeGreaterThan(0);

    // Heading landmark (ATX `#`).
    expect(md).toMatch(/^#\s+Release Notes/m);
    expect(md).toContain("Highlights");

    // Callout macro body survived the conversion.
    expect(md).toContain("Remember to log in to Confluence first.");

    // Table landmark: a markdown pipe row + separator.
    expect(md).toContain("| Feature | Status |");
    expect(md).toMatch(/\|\s*-+\s*\|/);

    // Image reference (attachment filename appears in the markdown image).
    expect(md).toContain("diagram.png");

    // Code block landmark: fenced code containing the command.
    expect(md).toContain("```");
    expect(md).toContain("atlcli export page 12345");
  });

  it("computes a plausible word count and attachment metadata", async () => {
    const loaded = await loadConfluencePage("12345", sessionProfile, fakeClientDeps);

    expect(loaded.wordCount).toBeGreaterThan(10);
    expect(loaded.attachments).toEqual([
      {
        name: "diagram.png",
        mediaType: "image/png",
        size: 4096,
        link: "/download/attachments/12345/diagram.png",
      },
    ]);
  });
});
