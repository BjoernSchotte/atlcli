import { describe, expect, it } from "bun:test";
import {
  PDF_OUTPUT_STANDARDS_V1,
  PdfOutputPolicyError,
  resolvePdfOutputPolicyV1,
} from "./output-policy.js";

describe("PDF output policy v1", () => {
  it("resolves every product conformance standard and derives its base PDF level", () => {
    for (const standard of PDF_OUTPUT_STANDARDS_V1) {
      const resolved = resolvePdfOutputPolicyV1({
        schema: "atlcli.pdf-output-policy/1",
        standards: [standard],
      });
      expect(resolved?.standards).toEqual([standard]);
    }
    expect(resolvePdfOutputPolicyV1({
      schema: "atlcli.pdf-output-policy/1",
      standards: ["a-1b"],
    })?.basePdfVersion).toBe("1.4");
    expect(resolvePdfOutputPolicyV1({
      schema: "atlcli.pdf-output-policy/1",
      standards: ["ua-1"],
    })?.basePdfVersion).toBe("1.7");
    expect(resolvePdfOutputPolicyV1({
      schema: "atlcli.pdf-output-policy/1",
      standards: ["a-4"],
    })?.basePdfVersion).toBe("2.0");
  });

  it("distinguishes absence from presence and rejects malformed durable values", () => {
    expect(resolvePdfOutputPolicyV1(undefined)).toBeUndefined();
    for (const invalid of [
      { schema: "atlcli.pdf-output-policy/1", standards: [] },
      { schema: "atlcli.pdf-output-policy/1", standards: ["ua-2"] },
      { schema: "atlcli.pdf-output-policy/1", standards: ["ua-1", "ua-1"] },
      { schema: "atlcli.pdf-output-policy/1", standards: ["ua-1", "a-2a"] },
      { schema: "atlcli.pdf-output-policy/1", standards: ["a-2a", "ua-1"] },
      { schema: "atlcli.pdf-output-policy/2", standards: ["ua-1"] },
      { schema: "atlcli.pdf-output-policy/1", standards: ["ua-1"], version: "2.0" },
    ]) {
      expect(() => resolvePdfOutputPolicyV1(invalid as never)).toThrow(PdfOutputPolicyError);
    }
  });
});
