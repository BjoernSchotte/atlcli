/**
 * spec 011 — the ONE link-target scheme policy, and proof that every engine
 * agrees with it.
 *
 * Before this module the repo carried three independent implementations
 * (`isSafeLinkScheme` here, `isSafeHyperlinkUrl` in `@atlcli/docx`, and an
 * inline regex in `@atlcli/pdf`'s `resolveLink`). These tests pin the policy AND
 * assert the storage walker degrades unsafe targets with a visible note, so an
 * engine can never receive one in the first place.
 */
import { describe, expect, test } from "bun:test";
import {
  isSafeLinkScheme,
  normalizeLinkHref,
  sanitizeLinkHref,
  UNSAFE_LINK_NOTE_CODE,
} from "./link-safety.js";
import { storageToBlocks, type ExportBlock, type InlineNode } from "./export-blocks.js";
import { htmlToExportBlocks } from "./html-to-blocks.js";

/** Every scheme a hostile page might try, in the forms that actually appear. */
const BLOCKED = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "JAVASCRIPT:alert(document.cookie)",
  "vbscript:msgbox(1)",
  "VBScript:MsgBox(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "file://C:/Windows/System32/",
  "jar:http://evil.example/x.jar!/",
  "ms-msdt:/id",
  "search-ms:query=x",
  // Control characters ANYWHERE, not just at the edges: a URL parser strips
  // them, so each of these IS javascript: to the consumer.
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "java\u0000script:alert(1)",
  "j\u0001a\u0002v\u0003a\u0004script:alert(1)",
  " javascript:alert(1)",
  "\u000bjavascript:alert(1)",
  "vb\tscript:msgbox(1)",
  "da\tta:text/html,<script>alert(1)</script>",
];

/** Targets that must keep working — the regression risk of any tightening. */
const ALLOWED = [
  "https://example.com/page",
  "http://example.com/page",
  "HTTPS://EXAMPLE.COM/PAGE",
  "mailto:someone@example.com",
  "MailTo:someone@example.com",
  "https://example.com/a?b=c&d=e#frag",
  "/wiki/spaces/DOCSY/pages/123/My Page",
  "../sibling/page",
  "#in-document-anchor",
  "page.html",
  "https://example.com/path%20with%20escapes",
];

describe("link-safety — the canonical policy", () => {
  for (const href of BLOCKED) {
    test(`rejects ${JSON.stringify(href)}`, () => {
      expect(isSafeLinkScheme(href)).toBe(false);
      const verdict = sanitizeLinkHref(href);
      expect(verdict.safe).toBe(false);
    });
  }

  for (const href of ALLOWED) {
    test(`POSITIVE CONTROL: allows ${JSON.stringify(href)}`, () => {
      expect(isSafeLinkScheme(href)).toBe(true);
      const verdict = sanitizeLinkHref(href);
      expect(verdict).toEqual({ safe: true, href });
    });
  }

  test("rejects an empty or whitespace-only target with the `empty` reason", () => {
    expect(sanitizeLinkHref("")).toEqual({ safe: false, reason: "empty" });
    expect(sanitizeLinkHref("   ")).toEqual({ safe: false, reason: "empty" });
    expect(sanitizeLinkHref("\t\n")).toEqual({ safe: false, reason: "empty" });
  });

  test("names the blocked scheme so the note can explain itself", () => {
    expect(sanitizeLinkHref("javascript:alert(1)")).toEqual({
      safe: false,
      reason: "blocked-scheme",
      scheme: "javascript",
    });
    // Even when it was smuggled through a control character.
    expect(sanitizeLinkHref("java\tscript:alert(1)")).toEqual({
      safe: false,
      reason: "blocked-scheme",
      scheme: "javascript",
    });
  });

  test("normalizeLinkHref strips controls and space anywhere, then lowercases", () => {
    expect(normalizeLinkHref(" Ja\tva\nScript:X ")).toBe("javascript:x");
  });

  test("is an ALLOWLIST: an unknown future scheme is refused, not permitted", () => {
    expect(isSafeLinkScheme("wss://example.com")).toBe(false);
    expect(isSafeLinkScheme("some-scheme-invented-in-2030:x")).toBe(false);
  });

  test("tel: is allowed; the adjacent dial schemes are not (deliberate product call)", () => {
    // Contact and directory pages legitimately carry phone links, and tel: is
    // inert — it hands a number to a dialler, it cannot execute or fetch.
    expect(isSafeLinkScheme("tel:+4915112345678")).toBe(true);
    expect(isSafeLinkScheme("TEL:+49%20151%2012345678")).toBe(true);
    // The rarer dial schemes stay out until someone shows they are needed.
    expect(isSafeLinkScheme("sms:+4915112345678")).toBe(false);
    expect(isSafeLinkScheme("callto:someone")).toBe(false);
    expect(isSafeLinkScheme("skype:someone?call")).toBe(false);
  });

  test("returns the STRIPPED href, never the raw input", () => {
    // The verdict is reached on the control-character-free form, so handing the
    // raw string back would let a caller act on bytes the policy never saw.
    const smuggled = "https://ok.example/x\u0000javascript:alert(1)";
    const verdict = sanitizeLinkHref(smuggled);
    expect(verdict.safe).toBe(true);
    const href = (verdict as { safe: true; href: string }).href;
    expect(href).toBe("https://ok.example/xjavascript:alert(1)");
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f]/.test(href)).toBe(false);
  });

  test("stripping preserves case and spaces (only controls are removed)", () => {
    const verdict = sanitizeLinkHref("/wiki/spaces/DOCSY/My Page");
    expect(verdict).toEqual({ safe: true, href: "/wiki/spaces/DOCSY/My Page" });
  });
});

/** XML-escape an href for use inside a `href="…"` attribute. */
function attr(href: string): string {
  return href
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The `<a>` inline node of the first paragraph, or undefined if unlinked. */
function firstLink(blocks: ExportBlock[]): Extract<InlineNode, { type: "link" }> | undefined {
  const para = blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
  return para?.content.find((n) => n.type === "link") as
    | Extract<InlineNode, { type: "link" }>
    | undefined;
}

describe("storage walker — unsafe targets degrade to visible text + a note", () => {
  for (const href of ["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,<b>x</b>", "java\tscript:alert(1)"]) {
    test(`degrades ${JSON.stringify(href)} but keeps the link text`, () => {
      const storage = `<p><a href="${attr(href)}">click me</a></p>`;
      const { blocks, notes } = storageToBlocks(storage);
      expect(firstLink(blocks)).toBeUndefined();
      // The TEXT survives — a reader still sees what the author wrote.
      const para = blocks[0] as Extract<ExportBlock, { type: "paragraph" }>;
      expect(para.content.map((n) => (n.type === "text" ? n.text : "")).join("")).toContain("click me");
      const note = notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE);
      expect(note).toBeDefined();
      expect(note!.level).toBe("warning");
      expect(note!.message).toContain("click me");
    });
  }

  test("POSITIVE CONTROL: an https link survives with its target and no note", () => {
    const { blocks, notes } = storageToBlocks(`<p><a href="https://example.com/x">ok</a></p>`);
    expect(firstLink(blocks)?.target).toEqual({ kind: "external", href: "https://example.com/x" });
    expect(notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE)).toBeUndefined();
  });

  test("POSITIVE CONTROL: a relative link survives (same-origin by construction)", () => {
    const { blocks, notes } = storageToBlocks(`<p><a href="/wiki/x">rel</a></p>`);
    expect(firstLink(blocks)?.target).toEqual({ kind: "external", href: "/wiki/x" });
    expect(notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE)).toBeUndefined();
  });

  test("ac:link page/attachment/anchor targets are unaffected (no raw href)", () => {
    const storage =
      `<p><ac:link><ri:page ri:content-title="Other Page"/>` +
      `<ac:plain-text-link-body><![CDATA[Other]]></ac:plain-text-link-body></ac:link></p>`;
    const { blocks, notes } = storageToBlocks(storage);
    expect(firstLink(blocks)?.target).toEqual({ kind: "page", contentTitle: "Other Page" });
    expect(notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE)).toBeUndefined();
  });

  test("the note carries page provenance when a page context is threaded", () => {
    const { notes } = storageToBlocks(`<p><a href="javascript:alert(1)">x</a></p>`, {
      pageContext: { id: "42", title: "Hostile Page" },
    });
    const note = notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE);
    expect(note?.source?.pageId).toBe("42");
    expect(note?.source?.pageTitle).toBe("Hostile Page");
  });
});

describe("export_view HTML walker — same policy, same note code", () => {
  test("drops the target and reports it", () => {
    const { blocks, notes } = htmlToExportBlocks(`<p><a href="javascript:alert(1)">evil</a></p>`);
    expect(firstLink(blocks)).toBeUndefined();
    const note = notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE);
    expect(note).toBeDefined();
    expect(note!.level).toBe("warning");
  });

  test("POSITIVE CONTROL: safe targets are untouched and silent", () => {
    const { blocks, notes } = htmlToExportBlocks(`<p><a href="https://example.com">ok</a></p>`);
    expect(firstLink(blocks)?.target).toEqual({ kind: "external", href: "https://example.com" });
    expect(notes.find((n) => n.code === UNSAFE_LINK_NOTE_CODE)).toBeUndefined();
  });

  test("both walkers reach the SAME verdict for every corpus entry", () => {
    // The drift guard: if either walker is ever changed in isolation, this fails.
    for (const href of [...BLOCKED, ...ALLOWED]) {
      const escaped = attr(href);
      const storageLinked = firstLink(storageToBlocks(`<p><a href="${escaped}">t</a></p>`).blocks) !== undefined;
      const htmlLinked = firstLink(htmlToExportBlocks(`<p><a href="${escaped}">t</a></p>`).blocks) !== undefined;
      expect({ href, storageLinked, htmlLinked }).toEqual({
        href,
        storageLinked: isSafeLinkScheme(href),
        htmlLinked: isSafeLinkScheme(href),
      });
    }
  });
});
