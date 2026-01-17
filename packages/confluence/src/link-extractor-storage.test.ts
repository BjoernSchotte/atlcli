import { describe, test, expect } from "bun:test";
import {
  extractLinksFromStorage,
  parseStorageLinks,
  hasLinks,
  countLinks,
} from "./link-extractor-storage.js";

describe("extractLinksFromStorage", () => {
  test("extracts internal page link with content-id", () => {
    const storage = `
      <p>See <ac:link>
        <ri:page ri:content-id="12345678" ri:content-title="Other Page"/>
        <ac:plain-text-link-body><![CDATA[click here]]></ac:plain-text-link-body>
      </ac:link> for more info.</p>
    `;

    const links = extractLinksFromStorage(storage, "source-page-id");

    expect(links.length).toBe(1);
    expect(links[0].sourcePageId).toBe("source-page-id");
    expect(links[0].targetPageId).toBe("12345678");
    expect(links[0].linkType).toBe("internal");
    expect(links[0].linkText).toBe("click here");
  });

  test("extracts internal page link with content-title only", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-title="Getting Started"/>
        <ac:plain-text-link-body>Getting Started Guide</ac:plain-text-link-body>
      </ac:link>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].targetPageId).toBeNull();
    expect(links[0].targetPath).toBe("Getting Started");
    expect(links[0].linkText).toBe("Getting Started Guide");
  });

  test("extracts cross-space page link", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-id="98765" ri:space-key="DOCS"/>
        <ac:plain-text-link-body>External Docs</ac:plain-text-link-body>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].targetPageId).toBe("98765");
    expect(parsed[0].targetSpaceKey).toBe("DOCS");
  });

  test("extracts attachment link", () => {
    const storage = `
      <p>Download the <ac:link>
        <ri:attachment ri:filename="report.pdf"/>
        <ac:plain-text-link-body><![CDATA[Report]]></ac:plain-text-link-body>
      </ac:link></p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].linkType).toBe("attachment");
    expect(links[0].targetPath).toBe("report.pdf");
    expect(links[0].linkText).toBe("Report");
  });

  test("extracts image attachment", () => {
    const storage = `
      <ac:image>
        <ri:attachment ri:filename="diagram.png"/>
      </ac:image>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].linkType).toBe("attachment");
    expect(links[0].targetPath).toBe("diagram.png");
  });

  test("extracts external links", () => {
    const storage = `
      <p>Visit <a href="https://example.com">Example</a> for more.</p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].linkType).toBe("external");
    expect(links[0].targetPath).toBe("https://example.com");
    expect(links[0].linkText).toBe("Example");
  });

  test("extracts mailto links as external", () => {
    const storage = `
      <p>Contact <a href="mailto:support@example.com">support</a></p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].linkType).toBe("external");
    expect(links[0].targetPath).toBe("mailto:support@example.com");
  });

  test("extracts anchor links", () => {
    const storage = `
      <p>Jump to <a href="#section-1">Section 1</a></p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(1);
    expect(links[0].linkType).toBe("anchor");
  });

  test("ignores user mentions", () => {
    const storage = `
      <p>CC <ac:link>
        <ri:user ri:account-id="123456:abcd-efgh"/>
        <ac:plain-text-link-body><![CDATA[John Doe]]></ac:plain-text-link-body>
      </ac:link></p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    // User mentions should not be included
    expect(links.length).toBe(0);
  });

  test("extracts multiple links", () => {
    const storage = `
      <p>See <ac:link>
        <ri:page ri:content-id="111"/>
        <ac:plain-text-link-body>Page 1</ac:plain-text-link-body>
      </ac:link> and <ac:link>
        <ri:page ri:content-id="222"/>
        <ac:plain-text-link-body>Page 2</ac:plain-text-link-body>
      </ac:link> and <a href="https://external.com">External</a></p>
    `;

    const links = extractLinksFromStorage(storage, "source");

    expect(links.length).toBe(3);
    expect(links[0].targetPageId).toBe("111");
    expect(links[1].targetPageId).toBe("222");
    expect(links[2].linkType).toBe("external");
  });

  test("handles HTML entities in titles", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-title="API &amp; Integration"/>
        <ac:plain-text-link-body>API Guide</ac:plain-text-link-body>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].targetPageTitle).toBe("API & Integration");
  });

  test("extracts link with anchor", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-id="12345"/>
        <ri:anchor ri:anchor="section-2"/>
        <ac:plain-text-link-body>Section 2</ac:plain-text-link-body>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].targetPageId).toBe("12345");
    expect(parsed[0].anchor).toBe("section-2");
  });
});

describe("hasLinks", () => {
  test("returns true for storage with links", () => {
    expect(hasLinks("<ac:link><ri:page/></ac:link>")).toBe(true);
    expect(hasLinks('<a href="http://x">x</a>')).toBe(true);
    expect(hasLinks("<ac:image><ri:attachment/></ac:image>")).toBe(true);
  });

  test("returns false for storage without links", () => {
    expect(hasLinks("<p>No links here</p>")).toBe(false);
    expect(hasLinks("Plain text")).toBe(false);
  });
});

describe("countLinks", () => {
  test("counts different link types", () => {
    const storage = `
      <ac:link><ri:page ri:content-id="1"/></ac:link>
      <ac:link><ri:page ri:content-id="2"/></ac:link>
      <a href="https://example.com">External</a>
      <ac:link><ri:attachment ri:filename="file.pdf"/></ac:link>
      <ac:image><ri:attachment ri:filename="img.png"/></ac:image>
    `;

    const counts = countLinks(storage);

    expect(counts.internal).toBe(2);
    expect(counts.external).toBe(1);
    expect(counts.attachments).toBe(2);
    expect(counts.total).toBe(5);
  });
});

describe("parseStorageLinks edge cases", () => {
  test("handles link-body (rich text)", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-id="123"/>
        <ac:link-body><strong>Bold Link</strong></ac:link-body>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].linkText).toBe("Bold Link");
  });

  test("handles link without text", () => {
    const storage = `
      <ac:link>
        <ri:page ri:content-id="123" ri:content-title="Page Title"/>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].linkText).toBeNull();
  });

  test("handles shortcut link", () => {
    const storage = `
      <ac:link>
        <ri:shortcut ri:value="https://shortcut.example.com"/>
        <ac:plain-text-link-body>Shortcut</ac:plain-text-link-body>
      </ac:link>
    `;

    const parsed = parseStorageLinks(storage);

    expect(parsed.length).toBe(1);
    expect(parsed[0].type).toBe("external");
    expect(parsed[0].externalUrl).toBe("https://shortcut.example.com");
  });

  test("handles empty storage", () => {
    expect(parseStorageLinks("")).toEqual([]);
    expect(parseStorageLinks("<p></p>")).toEqual([]);
  });
});
