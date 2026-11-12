import { describe, expect, test } from "bun:test";
import { extractLinks } from "./links.js";
import { markdownToStorage, storageToMarkdown } from "./markdown.js";

/** Storage → markdown → storage → markdown: the markdown must not change on the second pass. */
function roundtrip(storage: string): { markdown: string; storage: string } {
  const markdown = storageToMarkdown(storage).trim();
  const back = markdownToStorage(markdown);
  expect(storageToMarkdown(back).trim()).toBe(markdown);
  return { markdown, storage: back };
}

describe("links to other Confluence pages", () => {
  test("a page link keeps its text and target (it used to vanish from the markdown)", () => {
    const { markdown, storage } = roundtrip(
      '<p>See <ac:link><ri:page ri:content-title="API Spec" ri:space-key="DOCS"/><ac:plain-text-link-body><![CDATA[the spec]]></ac:plain-text-link-body></ac:link> first.</p>'
    );
    expect(markdown).toBe("See [the spec](page:DOCS/API%20Spec) first.");
    expect(storage).toContain('<ac:link><ri:page ri:content-title="API Spec" ri:space-key="DOCS" /><ac:plain-text-link-body><![CDATA[the spec]]></ac:plain-text-link-body></ac:link>');
  });

  test("a link without a body shows the title and is written back without one", () => {
    const { markdown, storage } = roundtrip('<p><ac:link><ri:page ri:content-title="Same Space"/></ac:link></p>');
    expect(markdown).toBe("[Same Space](page:Same%20Space)");
    expect(storage).toContain('<ac:link><ri:page ri:content-title="Same Space" /></ac:link>');
  });

  test("titles with markdown and URL characters survive", () => {
    const { markdown, storage } = roundtrip('<p><ac:link><ri:page ri:content-title="A (b) [c] &amp; d/e #1?"/></ac:link></p>');
    expect(markdown).toBe("[A (b) \\[c\\] & d/e #1?](page:A%20%28b%29%20%5Bc%5D%20%26%20d%2Fe%20%231%3F)");
    expect(storage).toContain('ri:content-title="A (b) [c] &amp; d/e #1?"');
  });

  test("content id, anchor and a rich link body", () => {
    const { markdown, storage } = roundtrip(
      '<p><ac:link ac:anchor="Sec 1"><ri:page ri:content-id="123" ri:content-title="Guide"/><ac:link-body><strong>rich</strong> body</ac:link-body></ac:link> <ac:link><ri:page ri:content-id="77"/></ac:link></p>'
    );
    expect(markdown).toBe("[rich body](page:Guide?id=123#Sec%201) [Page 77](page:?id=77)");
    expect(storage).toContain('<ac:link ac:anchor="Sec 1"><ri:page ri:content-id="123" ri:content-title="Guide" />');
    expect(storage).toContain('<ac:link><ri:page ri:content-id="77" /></ac:link>');
  });

  test("a page reference inside a macro parameter stays the macro's", () => {
    const include = '<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ac:link><ri:page ri:content-title="Shared"/></ac:link></ac:parameter></ac:structured-macro>';
    expect(storageToMarkdown(include)).not.toContain("page:");
  });

  test("a target that names no page is left as written; user mentions and images are not page links", () => {
    expect(markdownToStorage("[x](page:)")).not.toContain("ri:page");
    expect(markdownToStorage("[x](page:%E0%A4%A)")).not.toContain("ri:page");
    expect(markdownToStorage("@[Ann](page:Home)")).toContain("ri:user");
    expect(markdownToStorage("`[x](page:Home)`")).not.toContain("ri:page");
  });

  test("a page link is no file path for the link checks", () => {
    expect(extractLinks("[the spec](page:DOCS/API%20Spec)")).toMatchObject([{ type: "external", target: "page:DOCS/API%20Spec" }]);
  });
});
