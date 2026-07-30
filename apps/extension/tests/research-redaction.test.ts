import { describe, expect, it } from "bun:test";
import {
  classifyResearchError,
  redactResearchSecrets,
} from "../utils/research/redaction.js";

describe("research error redaction", () => {
  it("removes Anthropic-shaped keys and authorization headers", () => {
    const secret = ["sk", "ant", "SENTINEL_VALUE"].join("-");
    const redacted = redactResearchSecrets(
      `request failed x-api-key: ${secret} Authorization: Bearer ${secret}`
    );

    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  it("classifies invalid keys without echoing provider details", () => {
    const secret = ["sk", "ant", "SENTINEL_VALUE"].join("-");
    const classified = classifyResearchError(
      new Error(`authentication_error: invalid x-api-key ${secret}`)
    );

    expect(classified).toEqual({
      code: "invalid-key",
      message: "The Anthropic API key was rejected.",
    });
    expect(JSON.stringify(classified)).not.toContain(secret);
  });
});
