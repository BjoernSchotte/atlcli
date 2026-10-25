import { describe, test, expect } from "bun:test";
import { markdownToStorage, storageToMarkdown } from "./markdown.js";

// Regression: the per-macro regexes stopped at the first closing tag (storage)
// or the first `:::` line (Markdown), so nested macros lost content.
const squash = (xml: string) => xml.replace(/>\s+</g, "><").trim();
const roundTrip = (storage: string) => markdownToStorage(storageToMarkdown(storage));

const status = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro>`;

describe("nested macros", () => {
  test("a status inside an info panel survives pull and push", () => {
    const storage = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>State: ${status}</p></ac:rich-text-body></ac:structured-macro><p>after</p>`;
    expect(storageToMarkdown(storage).trim()).toBe(":::info\nState: {status:green}DONE{status}\n:::\n\nafter");
    expect(squash(roundTrip(storage))).toBe(squash(storage));
  });

  test("an info panel inside an expand survives pull and push", () => {
    const storage = `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><ac:structured-macro ac:name="info"><ac:rich-text-body><p>i</p></ac:rich-text-body></ac:structured-macro><p>tail</p></ac:rich-text-body></ac:structured-macro>`;
    expect(squash(roundTrip(storage))).toBe(squash(storage));
  });

  test("an unknown macro inside an expand is restored, not left as a placeholder", () => {
    const tabs = `<ac:structured-macro ac:name="ui-tabs"><ac:parameter ac:name="x">1</ac:parameter></ac:structured-macro>`;
    const storage = `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>x</p>${tabs}</ac:rich-text-body></ac:structured-macro>`;
    const back = roundTrip(storage);
    expect(back).not.toContain("PLACEHOLDER");
    expect(back).toContain(tabs);
  });

  test("an unknown macro keeps its nested macros as raw XML byte for byte", () => {
    const inner = `<ac:structured-macro ac:name="ui-tab"><ac:parameter ac:name="title">A</ac:parameter><ac:rich-text-body><ac:structured-macro ac:name="info"><ac:rich-text-body><p>a $&amp; b</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>`;
    const storage = `<ac:structured-macro ac:name="ui-tabs"><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`;
    expect(roundTrip(storage).trim()).toBe(storage);
  });

  test("a code body that mentions a macro tag is not a nested macro", () => {
    const storage = `<ac:structured-macro ac:name="info"><ac:rich-text-body><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<ac:structured-macro ac:name="x">]]></ac:plain-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>`;
    expect(storageToMarkdown(storage).trim()).toBe(':::info\n```\n<ac:structured-macro ac:name="x">\n```\n:::');
  });

  test("three levels of ::: blocks push as nested macros", () => {
    const back = squash(markdownToStorage(":::expand T\n:::info\n:::note\nNow {status:red}X{status}\n:::\n:::\ntail\n:::"));
    expect(back).toContain(`<ac:structured-macro ac:name="info"><ac:rich-text-body><ac:structured-macro ac:name="note"><ac:rich-text-body><p>Now <ac:structured-macro ac:name="status">`);
    expect(back).toContain("<p>tail</p></ac:rich-text-body></ac:structured-macro>");
    expect(back).not.toContain(":::");
  });
});
