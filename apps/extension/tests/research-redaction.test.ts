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

  it("classifies exhausted REST rate limits without provider details", () => {
    expect(classifyResearchError(new Error("Rate limited by Jira API after 3 retries"))).toEqual({
      code: "rate-limited",
      message: "The provider rate limit was reached.",
    });
  });

  it("classifies inaccessible catalog entities without echoing a response body", () => {
    const classified = classifyResearchError(
      new Error("Confluence API error (404): PRIVATE_NOT_FOUND_PAYLOAD"),
    );

    expect(classified).toEqual({
      code: "access-denied",
      message: "The Atlassian resource is unavailable.",
    });
    expect(JSON.stringify(classified)).not.toContain("PRIVATE_NOT_FOUND_PAYLOAD");
  });
});
