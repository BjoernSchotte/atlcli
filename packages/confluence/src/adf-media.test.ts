import { describe, expect, test } from "bun:test";
import { isTrustedValidatedAdf } from "@atlcli/change-set/adf";
import { adfToBlocks } from "./adf-to-blocks.js";
import { collectAdfMediaFileIds } from "./adf-media.js";
import { validateAdf } from "./adf-validate.js";
import { AdfValidationError, type ValidatedAdfDocument } from "./adf-types.js";

describe("collectAdfMediaFileIds", () => {
  test("preserves the validator trust brand across shared and Confluence consumers", () => {
    const validated = validateAdf({
      type: "doc",
      version: 1,
      content: [{
        type: "mediaSingle",
        content: [{
          type: "media",
          attrs: { type: "file", id: "shared-file", collection: "content-1" },
        }],
      }],
    });

    expect(isTrustedValidatedAdf(validated)).toBe(true);
    expect(adfToBlocks(validated).blocks).toHaveLength(1);
    expect(collectAdfMediaFileIds(validated)).toEqual(["shared-file"]);
  });

  test("collects nested media and mediaInline IDs in stable first-seen order", () => {
    const validated = validateAdf({
      type: "doc",
      version: 1,
      content: [
        {
          type: "mediaSingle",
          content: [{
            type: "media",
            attrs: { type: "file", id: "file-a", collection: "content-1" },
          }],
        },
        {
          type: "table",
          content: [{
            type: "tableRow",
            content: [{
              type: "tableCell",
              content: [{
                type: "paragraph",
                content: [
                  {
                    type: "mediaInline",
                    attrs: { id: "file-b", collection: "content-1" },
                  },
                  {
                    type: "mediaInline",
                    attrs: {
                      type: "file",
                      id: "file-a",
                      collection: "content-1",
                    },
                  },
                ],
              }],
            }],
          }],
        },
        {
          type: "media",
          attrs: {
            type: "external",
            id: "not-an-attachment",
            url: "https://example.invalid/image.png",
          },
        },
        {
          type: "media",
          attrs: { type: "link", id: "file-c", collection: "content-1" },
        },
      ],
    });

    expect(collectAdfMediaFileIds(validated)).toEqual([
      "file-a",
      "file-b",
      "file-c",
    ]);
  });

  test("requires bounded validator output", () => {
    const structuralLookalike = {
      document: { type: "doc", version: 1, content: [] },
      diagnostics: [],
      stats: {
        nodes: 1,
        marks: 0,
        maxDepth: 0,
        textBytes: 0,
        attributeBytes: 0,
        attributeValues: 0,
      },
    } as ValidatedAdfDocument;

    expect(() => collectAdfMediaFileIds(structuralLookalike)).toThrow(TypeError);
  });

  test("invalid and over-budget ADF fail before discovery", () => {
    const invalid = {
      type: "doc",
      version: 1,
      content: [{ type: "media", attrs: { type: "file", collection: "content-1" } }],
    };
    expect(() => validateAdf(invalid)).toThrow(AdfValidationError);

    const overBudget = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    };
    expect(() => validateAdf(overBudget, { budget: { maxNodes: 1 } }))
      .toThrow(AdfValidationError);
  });
});
