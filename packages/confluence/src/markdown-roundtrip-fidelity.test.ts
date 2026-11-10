import { describe, test, expect } from "bun:test";
import { markdownToStorage, storageToMarkdown } from "./markdown";

// Regression: pull -> push without Markdown edits rewrote a legal document:
// straight quotes became English curly quotes, table width/layout/column
// widths were dropped, and empty spacer paragraphs disappeared.

const TABLE =
  `<table data-table-width="1800" data-layout="align-start" ac:local-id="t1">` +
  `<colgroup><col style="width: 118.0px;" /><col style="width: 191.0px;" /><col style="width: 299.0px;" /></colgroup>` +
  `<tbody><tr ac:local-id="r1"><th ac:local-id="h1"><p local-id="p1"><strong>Role</strong></p></th>` +
  `<th><p><strong>Name</strong></p></th><th><p><strong>Note</strong></p></th></tr>` +
  `<tr><td><p>Lead</p></td><td><p>Alice</p></td><td><p>Lorem ipsum</p></td></tr></tbody></table>`;

const PAGE =
  `<h1>Service Agreement</h1><p local-id="s1"><br /></p>` +
  `<p>Example Corp (the &quot;Customer&quot;) orders 'Platform - Basic'.</p>` +
  `<p><br /></p><p local-id="s2"><br /></p>${TABLE}<p>&nbsp;</p><p>Signed</p>`;

/** Pull then push: the storage a push writes for an unedited Markdown file. */
const roundTrip = (storage: string) => markdownToStorage(storageToMarkdown(storage));

describe("pull -> push round-trip fidelity", () => {
  test("straight quotes stay straight", () => {
    const out = roundTrip(PAGE);
    expect(out).toContain(`(the &quot;Customer&quot;) orders 'Platform - Basic'.`);
    expect(out).not.toMatch(/[‘’“”]|&[lr][sd]quo;/);
  });

  test("typed quotes and other typography are written as typed", () => {
    expect(markdownToStorage(`He said "hi" -- it's (c) ...`)).toBe(
      `<p>He said &quot;hi&quot; -- it's (c) ...</p>\n`,
    );
    expect(markdownToStorage(`„Foo“ and ‚bar‘`)).toContain(`„Foo“ and ‚bar‘`);
  });

  test("table keeps data-table-width, data-layout and colgroup widths", () => {
    const out = roundTrip(TABLE);
    expect(out).toContain(
      `<table data-table-width="1800" data-layout="align-start">` +
      `<colgroup><col style="width: 118.0px;" /><col style="width: 191.0px;" /><col style="width: 299.0px;" /></colgroup>`,
    );
    expect(out).toContain("<th><strong>Role</strong></th>");
  });

  test("table layout is a comment above the Markdown table", () => {
    expect(storageToMarkdown(TABLE)).toBe(
      `<!--atlcli:table/v1 data-table-width="1800" data-layout="align-start" cols="118.0,191.0,299.0"-->\n\n` +
      "| **Role** | **Name** | **Note** |\n| --- | --- | --- |\n| Lead | Alice | Lorem ipsum |\n",
    );
  });

  test("edited table keeps colgroup while the column count matches", () => {
    const md = storageToMarkdown(TABLE).replace("Alice", "Bob").concat("| Dev | Carol | x |\n");
    expect(markdownToStorage(md)).toContain(`<col style="width: 299.0px;" /></colgroup>`);
  });

  test("table with a changed column count keeps width/layout but drops colgroup", () => {
    const md = storageToMarkdown(TABLE)
      .replace("| **Note** |", "| **Note** | **Extra** |")
      .replace("| --- | --- | --- |", "| --- | --- | --- | --- |")
      .replace("| Lorem ipsum |", "| Lorem ipsum | y |");
    const out = markdownToStorage(md);
    expect(out).toContain(`<table data-table-width="1800" data-layout="align-start">\n<thead>`);
    expect(out).not.toContain("<colgroup");
  });

  test("layout comment without a following table is dropped", () => {
    expect(markdownToStorage(`<!--atlcli:table/v1 data-layout="wide"-->\n\nText`)).toBe("<p>Text</p>\n");
  });

  test("default-layout table without widths gets no layout comment", () => {
    const storage = `<table data-layout="default" ac:local-id="x"><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>`;
    expect(storageToMarkdown(storage)).toBe("| A |\n| --- |\n| 1 |\n");
  });

  test("empty spacer paragraphs survive", () => {
    const out = roundTrip(PAGE);
    expect(out.match(/<p><br \/><\/p>/g)).toHaveLength(3);
    expect(out).toContain("<p>&nbsp;</p>");
    expect(out.indexOf("<p><br /></p>")).toBeLessThan(out.indexOf("Example Corp"));
  });

  test("spacer with several line breaks keeps all of them", () => {
    expect(roundTrip(`<p>a</p><p><br /><br /></p><p>b</p>`)).toBe(`<p>a</p>\n<p><br /><br /></p>\n<p>b</p>\n`);
  });

  test("hard breaks before lines starting with inline syntax survive", () => {
    const storage =
      `<p>Example Corp<br /><span style="background-color: rgb(254,222,200);">Street 1</span><br />` +
      `<span style="background-color: rgb(254,222,200);">12345 City</span></p>`;
    expect(roundTrip(storage)).toBe(
      `<p>Example Corp<br /><span style="background-color: rgb(254,222,200);">Street 1</span><br />` +
      `<span style="background-color: rgb(254,222,200);">12345 City</span></p>\n`,
    );
  });

  test("a second pull of the pushed storage yields the same Markdown", () => {
    const md = storageToMarkdown(PAGE);
    expect(storageToMarkdown(markdownToStorage(md))).toBe(md);
  });
});

// Values captured from storage XML are already entity-encoded. Escaping them
// again leaked `&amp;` into the markdown, and the next push stored `&amp;amp;`.
describe("entity-encoded storage values are not escaped twice", () => {
  test.each([
    ['<p><ac:link><ri:attachment ri:filename="a&amp;b.pdf"/><ac:plain-text-link-body><![CDATA[R & D]]></ac:plain-text-link-body></ac:link></p>', "[R & D](./attachments/a&b.pdf)"],
    ['<p><ac:link><ri:attachment ri:filename="a&amp;b.pdf"/><ac:plain-text-link-body>R &amp; D</ac:plain-text-link-body></ac:link></p>', "[R & D](./attachments/a&b.pdf)"],
    ['<p><ac:link><ri:attachment ri:filename="a&amp;b.pdf"/></ac:link></p>', "[a&b.pdf](./attachments/a&b.pdf)"],
    ['<p><ac:image><ri:attachment ri:filename="a&amp;b.png" ac:alt="x &amp; y"/></ac:image></p>', "![x & y](./attachments/a&b.png)"],
    ['<p><ac:image ac:alt="x &amp; y" ac:width="10"><ri:attachment ri:filename="a&amp;b.png"/></ac:image></p>', "![x & y](./attachments/a&b.png){width=10}"],
    ['<p><ac:image ac:align="center" ac:width="600" ac:height="20"><ri:attachment ri:version-at-save="1" ri:filename="img.png" /></ac:image></p>', "![](./attachments/img.png){width=600 height=20}"],
    ['<ac:structured-macro ac:name="multimedia"><ac:parameter ac:name="name"><ri:attachment ri:filename="a&amp;b.mp4" /></ac:parameter></ac:structured-macro>', ':::multimedia file="a&b.mp4"'],
    ['<p><a href="https://example.atlassian.net/browse/X-1?a=1&amp;b=2" data-card-appearance="inline">T &amp; U</a></p>', "[T & U](https://example.atlassian.net/browse/X-1?a=1&b=2)"],
  ])("%s", (storage, markdown) => {
    expect(storageToMarkdown(storage)).toContain(markdown);
  });

  test.each([
    '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">A &amp; B &lt;c&gt; &quot;q&quot;</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">A &amp; B</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="panel"><ac:parameter ac:name="title">P &amp; Q</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>',
    '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">R &amp; D</ac:parameter></ac:structured-macro></p>',
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">a &amp; b</ac:parameter><ac:plain-text-body><![CDATA[x &amp; y < z]]></ac:plain-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="multimedia"><ac:parameter ac:name="name"><ri:attachment ri:filename="a&amp;b.mp4" /></ac:parameter></ac:structured-macro>',
  ])("round-trips %s", (storage) => {
    const markdown = storageToMarkdown(storage);
    expect(markdown).not.toContain("&amp;amp;");
    expect(markdownToStorage(markdown).replace(/\n/g, "")).toBe(storage);
  });
});
