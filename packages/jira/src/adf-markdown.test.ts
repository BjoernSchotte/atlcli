import { describe, expect, test } from "bun:test";
import { validateAdf, type AdfDocument, type AdfNode } from "@atlcli/change-set/adf";
import { adfToMarkdown, markdownToAdf, toJiraRichText } from "./adf-markdown.js";

const BASE = "https://example.atlassian.net";

/** Drop random localIds so trees compare deterministically. */
function stripIds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripIds);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "localId") continue;
      out[key] = stripIds(value);
    }
    return out;
  }
  return node;
}

function doc(...content: AdfNode[]): AdfDocument {
  return { type: "doc", version: 1, content };
}

function roundtrip(markdown: string): string {
  return adfToMarkdown(markdownToAdf(markdown, { baseUrl: BASE }), { baseUrl: BASE });
}

describe("markdown → ADF → markdown", () => {
  const cases: Array<[string, string]> = [
    ["heading", "# Title\n\n### Sub"],
    ["paragraphs", "First line.\n\nSecond paragraph."],
    ["marks", "**bold** and *em* and ~~gone~~ and `code`"],
    ["link wrapping strong", "[**strong link**](https://example.com/a)"],
    ["bare url", "see https://example.com/page"],
    ["nested lists", "- one\n  - nested\n- two\n\n1. first\n2. second"],
    ["ordered start", "3. three\n4. four"],
    ["task list", "- [ ] open\n- [x] done"],
    ["code block with backticks", "````ts\nconst a = ```;\n````"],
    ["code block without language", "```\nplain\n```"],
    ["blockquote", "> quoted\n>\n> more"],
    ["rule", "above\n\n---\n\nbelow"],
    ["table with marks", "| A | B |\n| --- | --- |\n| **x** | `y` |"],
    ["mention", "ping @[Jane Doe](557058:abc-def) please"],
    ["date", "due {date:2026-12-31}"],
    ["status", "state {status:green}Done{status} and {status:grey}Todo{status}"],
    ["jira key", "see {jira:ATLCLI-42}"],
    ["emoji", "nice :smile: work"],
    ["panel", ":::warning\nCareful **here**.\n:::"],
    ["expand", ":::expand Details\nHidden text.\n:::"],
    ["hard break", "line one\\\nline two"],
    ["escaped specials", "a \\*literal\\* star, 2 \\< 3, snake_case, \\{status:red\\}x\\{status\\}"],
  ];

  for (const [name, markdown] of cases) {
    test(`${name} is stable after one pass`, () => {
      const once = roundtrip(markdown);
      expect(roundtrip(once)).toBe(once);
    });
  }

  test("exact output for common constructs", () => {
    expect(roundtrip("# Title\n\nSome **bold** text.")).toBe("# Title\n\nSome **bold** text.");
    expect(roundtrip("- [ ] open\n- [x] done")).toBe("- [ ] open\n- [x] done");
    expect(roundtrip("ping @[Jane Doe](557058:abc-def)")).toBe("ping @[Jane Doe](557058:abc-def)");
    expect(roundtrip("see {jira:ATLCLI-42}")).toBe("see {jira:ATLCLI-42}");
    expect(roundtrip(":::warning\nCareful.\n:::")).toBe(":::warning\nCareful.\n:::");
    expect(roundtrip("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  test("every converted document passes validateAdf", () => {
    for (const [, markdown] of cases) {
      const adf = markdownToAdf(markdown, { baseUrl: BASE });
      expect(() => validateAdf(adf)).not.toThrow();
    }
  });
});

describe("markdownToAdf node mapping", () => {
  test("headings, marks and links", () => {
    const adf = markdownToAdf("## Hi\n\n**a** [b](https://x.test)");
    expect(stripIds(adf)).toEqual(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "https://x.test" } }] },
          ],
        },
      ),
    );
  });

  test("task list maps to taskList/taskItem with states", () => {
    const adf = stripIds(markdownToAdf("- [ ] a\n- [x] b")) as AdfDocument;
    expect(adf.content[0]).toEqual({
      type: "taskList",
      attrs: {},
      content: [
        { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "a" }] },
        { type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "b" }] },
      ],
    });
  });

  test("mixed list stays a bullet list", () => {
    const adf = markdownToAdf("- [ ] a\n- plain");
    expect(adf.content[0]!.type).toBe("bulletList");
  });

  test("date is a UTC midnight timestamp", () => {
    const adf = markdownToAdf("{date:2026-01-15}");
    expect(adf.content[0]!.content![0]).toEqual({ type: "date", attrs: { timestamp: String(Date.UTC(2026, 0, 15)) } });
  });

  test("{jira:KEY} without baseUrl stays plain text", () => {
    expect(markdownToAdf("{jira:AB-1}").content[0]!.content).toEqual([{ type: "text", text: "AB-1" }]);
  });

  test("bare browse URL and autolink become inline cards", () => {
    const adf = markdownToAdf(`${BASE}/browse/AB-1 and <https://other.test/x>`);
    const types = adf.content[0]!.content!.map((node) => node.type);
    expect(types).toEqual(["inlineCard", "text", "inlineCard"]);
  });

  test("time-like text is not an emoji", () => {
    expect(markdownToAdf("at 10:30:45").content[0]!.content).toEqual([{ type: "text", text: "at 10:30:45" }]);
  });

  test("tip panel maps to success", () => {
    expect(markdownToAdf(":::tip\nx\n:::").content[0]!.attrs).toEqual({ panelType: "success" });
  });

  test("panel syntax inside a code fence is left alone", () => {
    const adf = markdownToAdf("```\n:::info\nx\n:::\n```");
    expect(adf.content).toHaveLength(1);
    expect(adf.content[0]!.type).toBe("codeBlock");
  });

  test("local image becomes a link and warns", () => {
    const warnings: string[] = [];
    const adf = markdownToAdf("![shot](./a.png)", { onWarning: (w) => warnings.push(w) });
    expect(adf.content[0]!.content![0]!.marks).toEqual([{ type: "link", attrs: { href: "./a.png" } }]);
    expect(warnings).toHaveLength(1);
  });

  test("raw HTML is escaped as text and warns", () => {
    const warnings: string[] = [];
    const adf = markdownToAdf("<div>x</div>", { onWarning: (w) => warnings.push(w) });
    expect(adf.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "<div>x</div>" }] });
    expect(warnings).toHaveLength(1);
  });
});

describe("lossy-case policy", () => {
  const media: AdfNode = {
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [{ type: "media", attrs: { id: "abc-123", type: "file", collection: "jira-1" } }],
  };
  const extension: AdfNode = {
    type: "extension",
    attrs: { extensionType: "com.example", extensionKey: "k", parameters: { a: 1 } },
  };

  test("media and extensions survive md roundtrip byte-exactly", () => {
    const original = doc({ type: "paragraph", content: [{ type: "text", text: "before" }] }, media, extension);
    const markdown = adfToMarkdown(original);
    expect(markdown).toContain("<!--adf:");
    expect(markdownToAdf(markdown)).toEqual(original);
  });

  test("sentinels: false keeps sentinels from untrusted markdown as text", () => {
    const evil: AdfNode = { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] };
    const markdown = adfToMarkdown(doc({ type: "paragraph", content: [evil] }, extension));
    const warnings: string[] = [];
    const converted = JSON.stringify(markdownToAdf(markdown, { sentinels: false, onWarning: (w) => warnings.push(w) }));
    expect(converted).not.toContain('"href":"javascript:');
    expect(converted).not.toContain("com.example");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("inline sentinel survives inside a paragraph", () => {
    const inlineExt: AdfNode = { type: "inlineExtension", attrs: { extensionType: "x", extensionKey: "y" } };
    const original = doc({ type: "paragraph", content: [{ type: "text", text: "a " }, inlineExt, { type: "text", text: " b" }] });
    expect(markdownToAdf(adfToMarkdown(original))).toEqual(original);
  });

  test("table without header row is preserved opaquely", () => {
    const table: AdfNode = {
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] }],
    };
    expect(markdownToAdf(adfToMarkdown(doc(table)))).toEqual(doc(table));
  });

  test("unsupported marks keep their text", () => {
    const original = doc({
      type: "paragraph",
      content: [{ type: "text", text: "red", marks: [{ type: "textColor", attrs: { color: "#ff0000" } }, { type: "strong" }] }],
    });
    expect(adfToMarkdown(original)).toBe("**red**");
  });

  test("text that looks like markdown is escaped", () => {
    const original = doc({ type: "paragraph", content: [{ type: "text", text: "# not a heading *nor* [link]" }] });
    const back = markdownToAdf(adfToMarkdown(original));
    expect(back).toEqual(original);
  });

  test("text with dialect syntax is escaped", () => {
    const original = doc({ type: "paragraph", content: [{ type: "text", text: "{status:red}x{status} @[a](b) :smile:" }] });
    expect(markdownToAdf(adfToMarkdown(original))).toEqual(original);
  });
});

describe("adfToMarkdown", () => {
  test("null, undefined and DC strings", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown("plain DC text")).toBe("plain DC text");
  });

  test("a mention whose name has brackets survives the round trip", () => {
    const adf = doc({ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-1", text: "@Max Muster [extern]" } }] });
    const md = adfToMarkdown(adf);
    expect(md).toBe("@[Max Muster \\[extern\\]](acc-1)");
    expect(markdownToAdf(md).content[0]).toEqual({ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-1", text: "@Max Muster [extern]" } }] });
    expect(markdownToAdf("@[](acc-1)").content[0]).toEqual({ type: "paragraph", content: [{ type: "mention", attrs: { id: "acc-1", text: "@acc-1" } }] });
  });

  test("mention without text falls back to the id", () => {
    expect(adfToMarkdown(doc({ type: "paragraph", content: [{ type: "mention", attrs: { id: "u1" } }] }))).toBe("@[u1](u1)");
  });

  test("browse card on another site stays a URL", () => {
    const card = { type: "inlineCard", attrs: { url: "https://other.atlassian.net/browse/AB-1" } };
    expect(adfToMarkdown(doc({ type: "paragraph", content: [card] }), { baseUrl: BASE })).toBe(
      "<https://other.atlassian.net/browse/AB-1>",
    );
  });

  test("whitespace stays outside emphasis", () => {
    const original = doc({ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: " b ", marks: [{ type: "strong" }] }, { type: "text", text: "c" }] });
    expect(adfToMarkdown(original)).toBe("a **b** c");
  });
});

describe("real ADF fixtures", () => {
  const fixtures = [
    "../../confluence/test-fixtures/adf/schema-feature-zoo.json",
    "../../confluence/test-fixtures/adf/minimal.json",
    "../../confluence/test-fixtures/adf-pairs/basic.adf.json",
  ];
  const allText = (node: unknown): string =>
    Array.isArray(node)
      ? node.map(allText).join("")
      : node && typeof node === "object"
        ? `${typeof (node as AdfNode).text === "string" ? (node as AdfNode).text : ""}${allText((node as AdfNode).content ?? [])}`
        : "";

  for (const path of fixtures) {
    test(`${path.split("/").pop()} keeps all text and is stable`, async () => {
      const original = (await Bun.file(new URL(path, import.meta.url)).json()) as AdfDocument;
      const markdown = adfToMarkdown(original, { baseUrl: BASE });
      const back = markdownToAdf(markdown, { baseUrl: BASE });
      expect(() => validateAdf(back)).not.toThrow();
      expect(allText(back.content).replace(/\s+/g, "")).toBe(allText(original.content).replace(/\s+/g, ""));
      expect(adfToMarkdown(back, { baseUrl: BASE })).toBe(markdown);
    });
  }
});

describe("toJiraRichText", () => {
  test("Cloud gets ADF, Data Center gets the markdown string", () => {
    expect(toJiraRichText({ isCloudSite: true, siteUrl: BASE }, "**x**")).toEqual(markdownToAdf("**x**"));
    expect(toJiraRichText({ isCloudSite: false, siteUrl: "https://jira.local" }, "**x**")).toBe("**x**");
  });
});
