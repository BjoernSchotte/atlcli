import { describe, expect, test } from "bun:test";
import {
  parseChatReleaseCandidateMatrixArgumentsV1,
  runChatReleaseCandidateMatrixV1,
} from "./chat-release-candidate-matrix.js";

describe("release-candidate matrix CLI", () => {
  test("accepts one explicit receipt and rejects ambiguous input", () => {
    expect(parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt",
      "/private/tmp/release-candidate-matrix.json",
    ])).toEqual({ receiptPath: "/private/tmp/release-candidate-matrix.json" });
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([])).toThrow("Usage");
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt", "/private/tmp/a.json", "extra",
    ])).toThrow("Usage");
    expect(() => parseChatReleaseCandidateMatrixArgumentsV1([
      "--receipt", "relative/matrix.json",
    ])).toThrow("absolute");
  });

  test("returns non-zero for an incomplete receipt", async () => {
    const path = `/private/tmp/chat-release-candidate-${crypto.randomUUID()}.json`;
    await Bun.write(path, JSON.stringify({
      schema: "atlcli.chat-release-candidate-matrix/v1",
      generatedAt: "2026-08-09T12:00:00.000Z",
      proofs: [],
    }));
    const original = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await runChatReleaseCandidateMatrixV1(["--receipt", path])).toBe(1);
    } finally {
      console.log = original;
      console.error = originalError;
      await Bun.file(path).delete();
    }
  });
});
