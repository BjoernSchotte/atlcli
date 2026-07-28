import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@atlcli/core";
import {
  analyzeDocxTemplate as analyzeBrowser,
} from "./index.browser.js";
import { analyzeDocxTemplate as analyzeNode } from "./index.js";
import {
  analyzeDocxTemplate,
  canonicalDocxTemplateFactsJson,
} from "./ooxml-facts.js";
import {
  DOCX_XML_LIMITS_V1,
  DocxXmlPartError,
  streamXmlPart,
  type DocxXmlLimitsV1,
} from "./streaming.js";
import {
  A_STRICT,
  A_TRANSITIONAL,
  buildDocx,
  MC,
  officeRelationshipType,
  relationshipsXml,
  R_STRICT,
  R_TRANSITIONAL,
  W_STRICT,
  W_TRANSITIONAL,
  WP_TRANSITIONAL,
} from "./test-support.js";

function wordDocument(
  prefix: string,
  uri: string,
  relationshipPrefix: string,
  relationshipUri: string,
  body: string,
  extraNamespaces = ""
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<${prefix}:document xmlns:${prefix}="${uri}"`,
    ` xmlns:${relationshipPrefix}="${relationshipUri}"`,
    extraNamespaces,
    `><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`,
  ].join("");
}

function semanticProjection(
  facts: Awaited<ReturnType<typeof analyzeDocxTemplate>>
): unknown {
  return {
    inventory: facts.inventory,
    sections: facts.sections,
    usage: facts.usage,
    revisions: facts.revisions,
    alternateContent: facts.alternateContent,
    diagnosticCodes: facts.diagnostics.map(({ code }) => code),
  };
}

function limits(
  overrides: Partial<DocxXmlLimitsV1>
): DocxXmlLimitsV1 {
  return { ...DOCX_XML_LIMITS_V1, ...overrides };
}

describe("namespace-aware OOXML facts", () => {
  test("prefix changes produce identical semantic facts", async () => {
    const make = (prefix: string): Uint8Array =>
      buildDocx({
        "word/document.xml": wordDocument(
          prefix,
          W_TRANSITIONAL,
          "rel",
          R_TRANSITIONAL,
          [
            `<${prefix}:p><${prefix}:pPr>`,
            `<${prefix}:pStyle ${prefix}:val="Heading1"/>`,
            `</${prefix}:pPr></${prefix}:p>`,
            `<${prefix}:sectPr>`,
            `<${prefix}:pgSz ${prefix}:w="11906" ${prefix}:h="16838"/>`,
            `<${prefix}:pgMar ${prefix}:top="1440" ${prefix}:right="1440"`,
            ` ${prefix}:bottom="1440" ${prefix}:left="1440"/>`,
            `</${prefix}:sectPr>`,
          ].join("")
        ),
      });

    const first = await analyzeDocxTemplate(make("w"));
    const second = await analyzeDocxTemplate(make("word"));
    expect(semanticProjection(first)).toEqual(semanticProjection(second));
  });

  test("Transitional and Strict namespaces resolve the same page and style facts", async () => {
    const make = (
      wordUri: string,
      relationshipUri: string,
      drawingUri: string
    ): Uint8Array =>
      buildDocx({
        "word/document.xml": wordDocument(
          "w",
          wordUri,
          "r",
          relationshipUri,
          [
            `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr></w:p>`,
            `<w:drawing><a:blip r:embed="rIdImage"/></w:drawing>`,
            `<w:sectPr><w:pgSz w:w="12240" w:h="15840"`,
            ` w:orient="portrait"/></w:sectPr>`,
          ].join(""),
          ` xmlns:a="${drawingUri}"`
        ),
      });

    const transitional = await analyzeDocxTemplate(
      make(W_TRANSITIONAL, R_TRANSITIONAL, A_TRANSITIONAL)
    );
    const strict = await analyzeDocxTemplate(
      make(W_STRICT, R_STRICT, A_STRICT)
    );
    expect(semanticProjection(transitional)).toEqual(
      semanticProjection(strict)
    );
  });

  test("extracts the supported semantic inventory without retaining text", async () => {
    const document = wordDocument(
      "w",
      W_TRANSITIONAL,
      "r",
      R_TRANSITIONAL,
      [
        `<w:background w:color="112233"/>`,
        `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>`,
        `<w:r><w:t>CONFIDENTIAL_BODY_MARKER</w:t></w:r></w:p>`,
        `<w:drawing><a:blip r:embed="rIdImage"/></w:drawing>`,
        `<w:sectPr><w:pgBorders><w:top w:val="single"/></w:pgBorders>`,
        `<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`,
      ].join(""),
      ` xmlns:a="${A_TRANSITIONAL}"`
    );
    const result = await analyzeDocxTemplate(
      buildDocx({
        "word/document.xml": document,
        "word/styles.xml": `<w:styles xmlns:w="${W_TRANSITIONAL}"><w:style/><w:style/></w:styles>`,
        "word/settings.xml": `<w:settings xmlns:w="${W_TRANSITIONAL}"/>`,
        "word/numbering.xml": `<w:numbering xmlns:w="${W_TRANSITIONAL}"><w:abstractNum/><w:num/></w:numbering>`,
        "word/fontTable.xml": `<w:fonts xmlns:w="${W_TRANSITIONAL}"><w:font/><w:font/></w:fonts>`,
        "word/theme/theme1.xml": `<a:theme xmlns:a="${A_TRANSITIONAL}"><a:clrScheme><a:dk1/><a:lt1/></a:clrScheme></a:theme>`,
        "word/header1.xml": `<w:hdr xmlns:w="${W_TRANSITIONAL}"/>`,
        "word/footer1.xml": `<w:ftr xmlns:w="${W_TRANSITIONAL}"/>`,
        "word/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        "word/_rels/document.xml.rels": relationshipsXml([
          {
            id: "rIdStyles",
            type: officeRelationshipType("styles"),
            target: "styles.xml",
          },
          {
            id: "rIdSettings",
            type: officeRelationshipType("settings"),
            target: "settings.xml",
          },
          {
            id: "rIdNumbering",
            type: officeRelationshipType("numbering"),
            target: "numbering.xml",
          },
          {
            id: "rIdFonts",
            type: officeRelationshipType("fontTable"),
            target: "fontTable.xml",
          },
          {
            id: "rIdTheme",
            type: officeRelationshipType("theme"),
            target: "theme/theme1.xml",
          },
          {
            id: "rIdHeader",
            type: officeRelationshipType("header"),
            target: "header1.xml",
          },
          {
            id: "rIdFooter",
            type: officeRelationshipType("footer"),
            target: "footer1.xml",
          },
          {
            id: "rIdImage",
            type: officeRelationshipType("image"),
            target: "media/image1.png",
          },
        ]),
      })
    );

    expect(result.inventory).toEqual({
      styles: 2,
      themeColorSlots: 2,
      settingsParts: 1,
      numberingDefinitions: 2,
      fonts: 2,
      sections: 1,
      headers: 1,
      footers: 1,
      backgrounds: 1,
      pageBorders: 1,
      drawings: 1,
      mediaReferences: 1,
      alternateContentGroups: 0,
    });
    expect(canonicalDocxTemplateFactsJson(result)).not.toContain(
      "CONFIDENTIAL_BODY_MARKER"
    );
  });

  test("reads semantic XML only when a known relationship allowlists it", async () => {
    const result = await analyzeDocxTemplate(
      buildDocx({
        "word/header-unreferenced.xml":
          `<!DOCTYPE w:hdr><w:hdr xmlns:w="${W_TRANSITIONAL}"/>`,
      })
    );
    expect(result.inventory.headers).toBe(0);
    expect(result.parts.map(({ partRef }) => partRef)).toEqual([
      "word/document.xml",
    ]);
  });

  test("uses one AlternateContent scene and retains both variants as fingerprints", async () => {
    const document = wordDocument(
      "w",
      W_TRANSITIONAL,
      "r",
      R_TRANSITIONAL,
      [
        `<mc:AlternateContent>`,
        `<mc:Choice Requires="wp"><w:drawing><wp:inline/></w:drawing></mc:Choice>`,
        `<mc:Fallback><w:pict><v:shape/></w:pict></mc:Fallback>`,
        `</mc:AlternateContent>`,
      ].join(""),
      ` xmlns:mc="${MC}" xmlns:wp="${WP_TRANSITIONAL}" xmlns:v="urn:schemas-microsoft-com:vml"`
    );
    const result = await analyzeDocxTemplate(
      buildDocx({ "word/document.xml": document })
    );

    expect(result.inventory.drawings).toBe(1);
    expect(result.inventory.alternateContentGroups).toBe(1);
    expect(result.alternateContent[0]?.variants).toHaveLength(2);
    expect(
      result.alternateContent[0]?.variants.map(({ selected }) => selected)
    ).toEqual([true, false]);
    expect(
      result.alternateContent[0]?.variants.every(
        ({ fingerprint }) => fingerprint.length === 64
      )
    ).toBe(true);
  });

  test("pins multiple-choice, unknown Requires, missing fallback, nesting, and MCE attributes", async () => {
    const document = wordDocument(
      "w",
      W_TRANSITIONAL,
      "r",
      R_TRANSITIONAL,
      [
        `<w:p mc:MustUnderstand="future"/>`,
        `<mc:AlternateContent>`,
        `<mc:Choice Requires="future"><w:drawing/></mc:Choice>`,
        `<mc:Choice Requires="wp"><w:drawing>`,
        `<mc:AlternateContent><mc:Choice Requires="wp"><w:drawing/></mc:Choice>`,
        `<mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent>`,
        `</w:drawing></mc:Choice>`,
        `<mc:Fallback><w:pict/></mc:Fallback>`,
        `</mc:AlternateContent>`,
        `<mc:AlternateContent><mc:Choice Requires="future"><w:pict/></mc:Choice></mc:AlternateContent>`,
      ].join(""),
      ` xmlns:mc="${MC}" xmlns:wp="${WP_TRANSITIONAL}" xmlns:future="urn:example:future"`
    );
    const result = await analyzeDocxTemplate(
      buildDocx({ "word/document.xml": document })
    );
    const codes = result.diagnostics.map(({ code }) => code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "DOCX_INTAKE_MCE_MUST_UNDERSTAND",
        "DOCX_INTAKE_MCE_UNKNOWN_REQUIRES",
        "DOCX_INTAKE_MCE_NESTED_ALTERNATE_CONTENT",
        "DOCX_INTAKE_MCE_MISSING_FALLBACK",
      ])
    );
    expect(result.alternateContent).toHaveLength(3);
  });

  test("rejects malformed XML, DOCTYPE, and entity declarations with typed errors", async () => {
    const cases = [
      {
        xml: `<w:document xmlns:w="${W_TRANSITIONAL}"><w:body></w:document>`,
        kind: "malformed-xml",
      },
      {
        xml: `<!DOCTYPE w:document><w:document xmlns:w="${W_TRANSITIONAL}"><w:body/></w:document>`,
        kind: "doctype-forbidden",
      },
      {
        xml: `<!DOCTYPE w:document [<!ENTITY secret "value">]><w:document xmlns:w="${W_TRANSITIONAL}"><w:body>&secret;</w:body></w:document>`,
        kind: "doctype-forbidden",
      },
    ] as const;

    for (const item of cases) {
      try {
        await analyzeDocxTemplate(
          buildDocx({ "word/document.xml": item.xml })
        );
        throw new Error("expected parser rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(DocxXmlPartError);
        expect((error as DocxXmlPartError).kind).toBe(item.kind);
        expect((error as DocxXmlPartError).partRef).toBe(
          "word/document.xml"
        );
      }
    }
  });

  test("enforces every streaming resource boundary and accepts the exact maximum", () => {
    const bytes = (xml: string): Uint8Array => new TextEncoder().encode(xml);
    expect(() =>
      streamXmlPart("word/document.xml", bytes("<a/>"), {}, limits({ maxBytes: 3 }))
    ).toThrow(new DocxXmlPartError("byte-limit", "word/document.xml"));
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes("<a/>"),
        {},
        limits({ maxCharacters: 3 })
      )
    ).toThrow(new DocxXmlPartError("character-limit", "word/document.xml"));
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes("<a><b><c/></b></a>"),
        {},
        limits({ maxDepth: 2 })
      )
    ).toThrow(new DocxXmlPartError("element-limit", "word/document.xml"));
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes("<a>x</a>"),
        {},
        limits({ maxNodes: 1 })
      )
    ).toThrow(new DocxXmlPartError("node-limit", "word/document.xml"));
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes(`<a x="1" y="2"/>`),
        {},
        limits({ maxAttributes: 1 })
      )
    ).toThrow(new DocxXmlPartError("attribute-limit", "word/document.xml"));
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes(`<a x="12"/>`),
        {},
        limits({ maxAttributeCharacters: 1 })
      )
    ).toThrow(new DocxXmlPartError("attribute-limit", "word/document.xml"));

    const maximum = `<a x="1"><b/></a>`;
    const result = streamXmlPart(
      "word/document.xml",
      bytes(maximum),
      {},
      {
        maxBytes: bytes(maximum).byteLength,
        maxCharacters: maximum.length,
        maxElements: 2,
        maxDepth: 2,
        maxAttributes: 1,
        maxAttributeCharacters: 1,
        maxNodes: 2,
      }
    );
    expect(result).toEqual({
      characters: maximum.length,
      elements: 2,
      maxDepth: 2,
      attributes: 1,
      nodes: 2,
    });
    expect(Object.keys(result)).not.toContain("text");

    const largeText = `<a>${"x".repeat(256 * 1024)}</a>`;
    const streamed = streamXmlPart(
      "word/document.xml",
      bytes(largeText)
    );
    expect(streamed.characters).toBe(largeText.length);
    expect(JSON.stringify(streamed).length).toBeLessThan(160);
  });

  test("accepts bounded opaque Word metadata but rejects one character beyond the cap", () => {
    const bytes = (xml: string): Uint8Array => new TextEncoder().encode(xml);
    const bounded = "x".repeat(DOCX_XML_LIMITS_V1.maxAttributeCharacters);
    const accepted = streamXmlPart(
      "word/document.xml",
      bytes(`<a opaque="${bounded}"/>`)
    );
    expect(accepted.attributes).toBe(1);

    const oversized = `${bounded}x`;
    expect(() =>
      streamXmlPart(
        "word/document.xml",
        bytes(`<a opaque="${oversized}"/>`)
      )
    ).toThrow(
      new DocxXmlPartError("attribute-limit", "word/document.xml")
    );
  });

  test("counts insertions, excludes deleted style usage, and warns about revisions", async () => {
    const document = wordDocument(
      "w",
      W_TRANSITIONAL,
      "r",
      R_TRANSITIONAL,
      [
        `<w:del><w:p><w:pPr><w:pStyle w:val="Deleted"/></w:pPr></w:p></w:del>`,
        `<w:ins><w:p><w:pPr><w:pStyle w:val="Visible"/></w:pPr></w:p></w:ins>`,
      ].join("")
    );
    const result = await analyzeDocxTemplate(
      buildDocx({ "word/document.xml": document })
    );
    const visible = await sha256Hex(new TextEncoder().encode("Visible"));
    const deleted = await sha256Hex(new TextEncoder().encode("Deleted"));

    expect(result.revisions).toEqual({
      present: true,
      insertions: 1,
      deletions: 1,
    });
    expect(result.usage.map(({ fingerprint }) => fingerprint)).toContain(
      visible
    );
    expect(result.usage.map(({ fingerprint }) => fingerprint)).not.toContain(
      deleted
    );
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "DOCX_INTAKE_REVISIONS_PRESENT"
    );
  });

  test("emits clone-safe, monotonic progress identically through browser and Node entries", async () => {
    const input = buildDocx({
      "word/styles.xml": `<w:styles xmlns:w="${W_TRANSITIONAL}"/>`,
    });
    const browserEvents: unknown[] = [];
    const nodeEvents: unknown[] = [];
    const browser = await analyzeBrowser(input, {
      progress(event) {
        browserEvents.push(structuredClone(event));
      },
    });
    const node = await analyzeNode(input, {
      progress(event) {
        nodeEvents.push(structuredClone(event));
      },
    });

    expect(browserEvents).toEqual(nodeEvents);
    expect(canonicalDocxTemplateFactsJson(browser)).toBe(
      canonicalDocxTemplateFactsJson(node)
    );
    for (const phase of ["scanning", "resolving"]) {
      const counts = (
        browserEvents as {
          phase: string;
          completed: number;
        }[]
      )
        .filter((event) => event.phase === phase)
        .map(({ completed }) => completed);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
    }
  });
});
