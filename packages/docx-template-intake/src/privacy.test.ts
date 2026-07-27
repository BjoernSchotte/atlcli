import { describe, expect, test } from "bun:test";
import { validateTemplateDiagnostic } from "@atlcli/pdf-template-authoring";
import { renderTemplateDiagnostic } from "./messages.js";
import {
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  analyzeDocxTemplate,
  canonicalDocxTemplateFactsJson,
} from "./ooxml-facts.js";
import { DOCX_INTAKE_MESSAGE_REGISTRY_V1 } from "./opc.js";
import {
  A_TRANSITIONAL,
  buildDocx,
  officeRelationshipType,
  relationshipsXml,
  R_TRANSITIONAL,
  W_TRANSITIONAL,
} from "./test-support.js";

describe("portable DOCX analysis privacy", () => {
  test("golden JSON contains no document text, raw XML, Base64, paths, or external target data", async () => {
    const result = await analyzeDocxTemplate(
      buildDocx({
        "word/document.xml": [
          `<?xml version="1.0"?>`,
          `<w:document xmlns:w="${W_TRANSITIONAL}"`,
          ` xmlns:r="${R_TRANSITIONAL}" xmlns:a="${A_TRANSITIONAL}">`,
          `<w:body><w:p><w:pPr><w:pStyle w:val="PrivateStyleName"/>`,
          `<w:rPr><w:rFonts w:ascii="PrivateCorporateFont"/></w:rPr>`,
          `</w:pPr><w:r><w:t>PRIVATE_WORD_TEXT_MARKER</w:t></w:r></w:p>`,
          `<w:drawing><a:t>PRIVATE_DRAWING_TEXT_MARKER</a:t></w:drawing>`,
          `<w:p><w:r><w:t>/Users/private/customer/source.docx</w:t></w:r></w:p>`,
          `</w:body></w:document>`,
        ].join(""),
        "word/media/private.png": new TextEncoder().encode(
          "data:image/png;base64,PRIVATE_BASE64_MARKER"
        ),
        "word/_rels/document.xml.rels": relationshipsXml([
          {
            id: "rIdExternal",
            type: officeRelationshipType("hyperlink"),
            target:
              "https://user:password@private.example/internal/path?token=secret",
            targetMode: "External",
          },
        ]),
      })
    );
    const json = canonicalDocxTemplateFactsJson(result);

    for (const forbidden of [
      "PRIVATE_WORD_TEXT_MARKER",
      "PRIVATE_DRAWING_TEXT_MARKER",
      "PrivateStyleName",
      "PrivateCorporateFont",
      "/Users/private/customer/source.docx",
      "PRIVATE_BASE64_MARKER",
      "data:image/png;base64",
      "private.example",
      "password",
      "/internal/path",
      "token=secret",
      "<?xml",
      "<w:",
      "<a:",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  test("all diagnostics keep stable identity, safe params, and recovery metadata", async () => {
    const result = await analyzeDocxTemplate(
      buildDocx({
        "word/document.xml": `<w:document xmlns:w="${W_TRANSITIONAL}"><w:body><w:ins/><w:sectPr/></w:body></w:document>`,
        "word/embeddings/object.bin": new Uint8Array([1, 2, 3]),
        "word/_rels/document.xml.rels": relationshipsXml([
          {
            id: "duplicate",
            type: officeRelationshipType("oleObject"),
            target: "embeddings/object.bin",
          },
          {
            id: "duplicate",
            type: officeRelationshipType("styles"),
            target: "missing.xml",
          },
          {
            id: "external",
            type: officeRelationshipType("hyperlink"),
            target: "mailto:private@example.invalid",
            targetMode: "External",
          },
        ]),
      })
    );

    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      expect(() =>
        validateTemplateDiagnostic(diagnostic, [
          DOCX_INTAKE_MESSAGE_REGISTRY_V1,
          DOCX_FACTS_MESSAGE_REGISTRY_V1,
        ])
      ).not.toThrow();
      expect(diagnostic.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(diagnostic.recoveryActions.length).toBeGreaterThan(0);
      expect(JSON.stringify(diagnostic.params)).not.toMatch(
        /private|example\.invalid|mailto:/i
      );
    }
  });

  test("host locale changes rendered copy but not analysis identity or JSON", async () => {
    const result = await analyzeDocxTemplate(
      buildDocx({
        "word/_rels/document.xml.rels": relationshipsXml([
          {
            id: "external",
            type: officeRelationshipType("hyperlink"),
            target: "https://private.example/path",
            targetMode: "External",
          },
        ]),
      })
    );
    const diagnostic = result.diagnostics.find(
      ({ code }) => code === "DOCX_INTAKE_EXTERNAL_RELATIONSHIP"
    );
    expect(diagnostic).toBeDefined();
    const before = canonicalDocxTemplateFactsJson(result);
    const english = renderTemplateDiagnostic(diagnostic!, {
      DOCX_INTAKE_EXTERNAL_RELATIONSHIP:
        "An external {scheme} reference needs review.",
    });
    const german = renderTemplateDiagnostic(diagnostic!, {
      DOCX_INTAKE_EXTERNAL_RELATIONSHIP:
        "Ein externer {scheme}-Verweis muss geprüft werden.",
    });

    expect(english.code).toBe(german.code);
    expect(english.text).not.toBe(german.text);
    expect(canonicalDocxTemplateFactsJson(result)).toBe(before);
  });
});
