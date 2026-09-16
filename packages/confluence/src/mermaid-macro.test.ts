import { describe, expect, it } from "bun:test";
import { markdownToStorage, storageToMarkdown } from "./markdown.js";
import { storageToBlocks } from "./export-blocks.js";
import { adfToBlocks } from "./adf-to-blocks.js";

const source = 'flowchart LR\n  A["Übersicht & <plan> </ac:plain-text-body> </ac:structured-macro> ]]> ```"] --> B[Release]\n';
const fence = (body: string, info = "mermaid") => `\`\`\`\`${info}\n${body}\`\`\`\`\n`;

describe("Mermaid Integration macro", () => {
  it("round-trips source, Unicode, XML delimiters and embedded fences", () => {
    const storage = markdownToStorage(fence(source));
    expect(storage).toContain('ac:name="mermaid"');
    expect(storage).not.toContain('ri:attachment');
    const markdown = storageToMarkdown(storage);
    expect(markdown).toContain(source.trimEnd());
    expect(markdown.startsWith("````mermaid")).toBe(true);
    expect(markdownToStorage(markdown)).toBe(storage);
  });
  it("keeps themes, multiple blocks and nested blocks", () => {
    const input = fence("graph TD; A-->B\n", 'mermaid{theme="forest"}') + "\n> " + fence("graph LR; B-->C\n").trim().replaceAll("\n", "\n> ");
    const storage = markdownToStorage(input);
    expect(storage.match(/ac:name="mermaid"/g)).toHaveLength(2);
    const markdown = storageToMarkdown(storage);
    expect(markdown).toContain('mermaid{theme="forest"}');
    expect(markdown).toContain("graph LR; B-->C");
    expect(markdownToStorage(markdown)).toBe(storage);
  });
  it("round-trips a diagram inside a native expand macro", () => {
    const storage = markdownToStorage(':::expand "Plan"\n' + fence('graph LR; A-->B\n') + '\n:::');
    const back = storageToMarkdown(storage);
    expect(back).toContain("```mermaid");
    expect(back).toContain("graph LR; A-->B");
    expect(back).not.toContain("ac:structured-macro");
    expect(markdownToStorage(back)).toBe(storage);
  });
  it("preserves attachment-backed, malformed and unfamiliar macro variants as raw XML", () => {
    for (const body of ['{"diagramDefinition":""}', '{bad', '{"diagramDefinition":"graph TD; A-->B","extra":true}']) {
      const storage = `<ac:structured-macro ac:name="mermaid"><ac:parameter ac:name="fileName">mermaid_fixture</ac:parameter><ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
      const markdown = storageToMarkdown(storage);
      expect(markdown).toContain(":::confluence mermaid");
      expect(markdownToStorage(markdown).trim()).toBe(storage);
    }
  });
  it("feeds existing PDF/DOCX diagram rendering from Storage and Cloud ADF", () => {
    const storage = markdownToStorage(fence(source));
    const expected = { type: "codeBlock", language: "mermaid", code: source } as const;
    expect(storageToBlocks(storage).blocks).toEqual([expected]);
    const adf = {version:1,type:"doc",content:[{type:"extension",attrs:{extensionType:"com.atlassian.confluence.macro.core",extensionKey:"mermaid",parameters:{macroParams:{__bodyContent:{value:JSON.stringify({diagramDefinition:source})},theme:{value:"default"}}}}}]};
    expect(adfToBlocks(JSON.stringify(adf)).blocks).toEqual([expected]);
  });
  it("leaves ordinary code and third-party macros alone", () => {
    expect(markdownToStorage("```typescript\nconst x = 1;\n``` ")).toContain('ac:name="code"');
    const storage = '<ac:structured-macro ac:name="other-mermaid"><ac:plain-text-body><![CDATA[graph TD; A-->B]]></ac:plain-text-body></ac:structured-macro>';
    expect(markdownToStorage(storageToMarkdown(storage)).trim()).toBe(storage);
  });
});
