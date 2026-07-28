import { describe, expect, test } from "bun:test";
import PizZip from "pizzip";
import {
  analyzeDocxOpc,
  canonicalDocxOpcFactsJson,
} from "./opc.js";
import {
  buildDocx,
  documentXml,
  officeRelationshipType,
  relationshipsXml,
} from "./test-support.js";

const DOCUMENT_RELS = "word/_rels/document.xml.rels";

describe("DOCX OPC facts", () => {
  test("canonical facts do not depend on ZIP entry order", async () => {
    const entries = {
      "word/document.xml": documentXml("<w:p/>"),
      "word/styles.xml":
        `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      [DOCUMENT_RELS]: relationshipsXml([
        {
          id: "rId1",
          type: officeRelationshipType("styles"),
          target: "styles.xml",
        },
      ]),
    };
    const forward = await analyzeDocxOpc(buildDocx(entries, "forward"));
    const reverse = await analyzeDocxOpc(buildDocx(entries, "reverse"));

    expect(canonicalDocxOpcFactsJson(forward)).toBe(
      canonicalDocxOpcFactsJson(reverse)
    );
  });

  test("resolves relative targets and names traversal, missing, and duplicate IDs", async () => {
    const result = await analyzeDocxOpc(
      buildDocx({
        "word/styles.xml":
          `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
        [DOCUMENT_RELS]: relationshipsXml([
          {
            id: "rIdStyles",
            type: officeRelationshipType("styles"),
            target: "./styles.xml",
          },
          {
            id: "rIdMissing",
            type: officeRelationshipType("theme"),
            target: "theme/missing.xml",
          },
          {
            id: "rIdTraversal",
            type: officeRelationshipType("image"),
            target: "../../escape.bin",
          },
          {
            id: "rIdStyles",
            type: officeRelationshipType("settings"),
            target: "settings.xml",
          },
        ]),
      })
    );

    expect(
      result.relationships.find(
        ({ relationshipRef, target }) =>
          relationshipRef === "rIdStyles" &&
          target.kind === "internal" &&
          target.exists
      )?.target
    ).toEqual({
      kind: "internal",
      partRef: "word/styles.xml",
      exists: true,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "DOCX_INTAKE_DUPLICATE_RELATIONSHIP",
        "DOCX_INTAKE_MISSING_PART",
        "DOCX_INTAKE_RELATIONSHIP_TRAVERSAL",
      ])
    );
  });

  test("redacts external targets and never invokes a network API", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must remain unreachable");
    }) as unknown as typeof fetch;
    try {
      const result = await analyzeDocxOpc(
        buildDocx({
          [DOCUMENT_RELS]: relationshipsXml([
            {
              id: "rIdExternal",
              type: officeRelationshipType("hyperlink"),
              target:
                "https://user:password@private.example/internal/report?token=secret",
              targetMode: "External",
            },
          ]),
        })
      );
      const json = canonicalDocxOpcFactsJson(result);

      expect(fetchCalls).toBe(0);
      expect(
        result.relationships.find(
          ({ relationshipRef }) => relationshipRef === "rIdExternal"
        )?.target
      ).toMatchObject({
        kind: "external-unresolved",
        scheme: "https",
      });
      expect(json).not.toContain("private.example");
      expect(json).not.toContain("password");
      expect(json).not.toContain("/internal/report");
      expect(json).not.toContain("token=secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("diagnoses unsupported and unknown binaries without reading payload bytes", async () => {
    const originalFile = PizZip.prototype.file;
    let unsupportedReads = 0;
    const wrapped = new WeakSet<object>();
    PizZip.prototype.file = function (this: PizZip, ...args: unknown[]) {
      const result = (
        originalFile as unknown as (
          this: PizZip,
          ...inner: unknown[]
        ) => unknown
      ).apply(this, args);
      for (const name of [
        "word/embeddings/object.bin",
        "word/embeddings/package.zip",
        "word/embeddings/unknown.bin",
        "word/media/audio.mp3",
        "word/media/movie.mp4",
        "word/external/data.bin",
      ]) {
        const entry = (
          this as unknown as {
            files: Record<
              string,
              { asUint8Array(): Uint8Array }
            >;
          }
        ).files[name];
        if (!entry || wrapped.has(entry)) continue;
        wrapped.add(entry);
        entry.asUint8Array = () => {
          unsupportedReads += 1;
          throw new Error("unsupported binary payload was read");
        };
      }
      return result;
    } as typeof PizZip.prototype.file;

    try {
      const result = await analyzeDocxOpc(
        buildDocx({
          "word/embeddings/object.bin": new Uint8Array([1, 2, 3]),
          "word/embeddings/package.zip": new Uint8Array([4, 5, 6, 7, 8]),
          "word/embeddings/unknown.bin": new Uint8Array([4, 5, 6, 7]),
          "word/media/audio.mp3": new Uint8Array([9]),
          "word/media/movie.mp4": new Uint8Array([10, 11]),
          "word/external/data.bin": new Uint8Array([12, 13, 14, 15, 16, 17]),
          [DOCUMENT_RELS]: relationshipsXml([
            {
              id: "rIdOle",
              type: officeRelationshipType("oleObject"),
              target: "embeddings/object.bin",
            },
            {
              id: "rIdPackage",
              type: officeRelationshipType("embeddedPackage"),
              target: "embeddings/package.zip",
            },
            {
              id: "rIdUnknown",
              type: "urn:example:relationships/private-binary",
              target: "embeddings/unknown.bin",
            },
            {
              id: "rIdAudio",
              type: officeRelationshipType("audio"),
              target: "media/audio.mp3",
            },
            {
              id: "rIdVideo",
              type: officeRelationshipType("video"),
              target: "media/movie.mp4",
            },
            {
              id: "rIdExternalData",
              type: officeRelationshipType("externalData"),
              target: "external/data.bin",
            },
          ]),
        })
      );

      expect(unsupportedReads).toBe(0);
      expect(
        result.relationships.filter(
          ({ kind }) => kind === "unsupported-binary"
        )
      ).toHaveLength(6);
      expect(
        result.diagnostics
          .filter(({ code }) => code === "DOCX_INTAKE_UNSUPPORTED_BINARY")
          .map(({ params }) => params.declaredBytes)
          .sort((left, right) => Number(left) - Number(right))
      ).toEqual([3, 5, 4, 1, 2, 6].sort((a, b) => a - b));
      expect(
        result.diagnostics
          .filter(({ code }) => code === "DOCX_INTAKE_UNSUPPORTED_BINARY")
          .map(({ params }) => params.kind)
      ).toEqual(
        expect.arrayContaining([
          "ole",
          "embedded-package",
          "unknown-binary",
          "audio",
          "video",
          "external-data",
        ])
      );
    } finally {
      PizZip.prototype.file = originalFile;
    }
  });
});
