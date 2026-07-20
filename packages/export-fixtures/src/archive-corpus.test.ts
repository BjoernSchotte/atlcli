/**
 * Cross-plan archive-policy conformance GATE (spec 011, Security hardening).
 *
 * Feeds 011's adversarial `.wiki-pdf-template` corpus through folder 007's REAL
 * `unpackTemplate` and asserts every malicious archive is rejected with the
 * matching typed error kind — and that the positive control unpacks cleanly. No
 * mocks: real PizZip archives, real central-directory sizes. 011 supplies the
 * negative fixtures; 007 owns the validator; this gate proves they agree, so a
 * future loosening of the validator cannot silently accept a traversal /
 * symlink / zip-bomb / entry flood.
 */
import { describe, expect, it } from "bun:test";
import { TemplatePackError, unpackTemplate } from "@atlcli/template-pack";
import { ARCHIVE_CORPUS, VALID_ARCHIVE_BYTES } from "./archive-corpus.js";

describe("archive-policy conformance gate (007 template-pack)", () => {
  it("unpacks the positive-control archive cleanly", () => {
    const result = unpackTemplate(VALID_ARCHIVE_BYTES);
    expect(result.manifest.id).toBe("com.atlcli.adversarial");
    expect(result.files["template.typ"]).toBeTruthy();
  });

  for (const testCase of ARCHIVE_CORPUS) {
    it(`rejects ${testCase.id} (${testCase.description}) with kind "${testCase.expectRejectKind}"`, () => {
      let thrown: unknown;
      try {
        unpackTemplate(testCase.bytes);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${testCase.id} must be rejected, not unpacked`).toBeInstanceOf(TemplatePackError);
      expect((thrown as TemplatePackError).kind).toBe(testCase.expectRejectKind);
    });
  }
});
