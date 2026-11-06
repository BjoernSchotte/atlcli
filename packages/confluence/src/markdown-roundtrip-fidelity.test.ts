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
