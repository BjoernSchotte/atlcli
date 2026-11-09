import { expect, test } from "bun:test";
import { redactResearchSecrets } from "./redaction.js";

test("redacts the credential of a Basic authorization header, not just the scheme", () => {
  const redacted = redactResearchSecrets("Authorization: Basic dXNlcjpTRUNSRVQ= failed");
  expect(redacted).toBe("Authorization: Basic [REDACTED] failed");
});

test("redacts every pair of a Cookie header", () => {
  const redacted = redactResearchSecrets("Cookie: a=1; session=SECRET status 401");
  expect(redacted).not.toContain("SECRET");
  expect(redacted).toBe("Cookie: [REDACTED] status 401");
});

test("redacts JSON-shaped credential headers", () => {
  const redacted = redactResearchSecrets(
    JSON.stringify({ authorization: "Bearer SECRETTOKEN", "x-api-key": "SECRETKEY", cookie: "a=1; s=SECRETCOOKIE" }),
  );
  expect(redacted).not.toContain("SECRETTOKEN");
  expect(redacted).not.toContain("SECRETKEY");
  expect(redacted).not.toContain("SECRETCOOKIE");
});

test("replaces a bare Anthropic key without leaking a literal group reference", () => {
  const key = ["sk", "ant", "SENTINEL_VALUE"].join("-");
  expect(redactResearchSecrets(`key ${key} rejected`)).toBe("key [REDACTED] rejected");
});
