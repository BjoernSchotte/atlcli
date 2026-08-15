import { describe, test, expect } from "bun:test";
import {
  JiraSessionAuthError,
  assertNotAuthRedirect,
  assertSessionJsonOk,
  isAuthRedirect,
  isJiraSessionAuthError,
} from "./auth-redirect.js";

/**
 * Unit tests for the session-auth guards (spec 010 wave 2, finding B1).
 *
 * Every response here is a REAL `Response` instance — the opaque-redirect shape
 * is produced the way the rest of the repo produces it, by shadowing the
 * prototype's `type` getter on the instance (a browser-only response type that
 * no server can emit).
 */
describe("isAuthRedirect", () => {
  test("true for every 3xx status", () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(isAuthRedirect({ status })).toBe(true);
    }
  });

  test("true for a browser opaque redirect (status 0)", () => {
    expect(isAuthRedirect({ type: "opaqueredirect", status: 0 })).toBe(true);
  });

  test("false either side of the 3xx band", () => {
    for (const status of [200, 204, 299, 400, 401, 403, 404, 429, 500]) {
      expect(isAuthRedirect({ status })).toBe(false);
    }
  });
});

describe("assertNotAuthRedirect", () => {
  test("throws a typed auth-redirect error for a raw 302 in session mode", () => {
    const res = new Response(null, {
      status: 302,
      headers: { Location: "https://id.atlassian.com/login" },
    });

    let thrown: unknown;
    try {
      assertNotAuthRedirect(res, true);
    } catch (err) {
      thrown = err;
    }

    expect(isJiraSessionAuthError(thrown)).toBe(true);
    const err = thrown as JiraSessionAuthError;
    expect(err.reason).toBe("auth-redirect");
    expect(err.status).toBe(302);
    // Message shape is byte-compatible with ConfluenceClient's: the extension
    // classifies session expiry by matching these phrases.
    expect(err.message).toBe(
      "Jira API error (302): authentication redirect to Atlassian login (session not logged in)"
    );
    // The regression pin for B1: this must NOT read as a generic network error.
    expect(err).not.toBeInstanceOf(TypeError);
  });

  test("preserves the server's own 3xx status in the message", () => {
    const res = new Response(null, { status: 303 });
    expect(() => assertNotAuthRedirect(res, true)).toThrow(/Jira API error \(303\)/);
  });

  test("classifies an opaque redirect identically, substituting 302 for status 0", () => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "type", { value: "opaqueredirect" });

    let thrown: unknown;
    try {
      assertNotAuthRedirect(res as unknown as { type?: string; status: number }, true);
    } catch (err) {
      thrown = err;
    }

    const err = thrown as JiraSessionAuthError;
    expect(isJiraSessionAuthError(err)).toBe(true);
    expect(err.reason).toBe("auth-redirect");
    // Status 0 carries no information and would not match the `(\d{3})` the
    // downstream classifiers scan for, so 302 stands in.
    expect(err.status).toBe(302);
    expect(err.message).toContain("(302): authentication redirect");
  });

  test("no-op for token auth, even on a 302 (CLI behaviour is untouched)", () => {
    const res = new Response(null, { status: 302 });
    expect(() => assertNotAuthRedirect(res, false)).not.toThrow();
  });

  test("no-op on a 200 in session mode", () => {
    expect(() => assertNotAuthRedirect(new Response("{}", { status: 200 }), true)).not.toThrow();
  });
});

describe("assertSessionJsonOk", () => {
  const LOGIN_HTML = "<!doctype html><html><body><form id=login></form></body></html>";

  test("rejects a non-JSON 200 body (login page) in session mode", () => {
    let thrown: unknown;
    try {
      assertSessionJsonOk(LOGIN_HTML, LOGIN_HTML, false, true);
    } catch (err) {
      thrown = err;
    }

    const err = thrown as JiraSessionAuthError;
    expect(isJiraSessionAuthError(err)).toBe(true);
    expect(err.reason).toBe("login-page");
    expect(err.message).toBe(
      "Jira API error (login): non-JSON 200 response (login page — session not logged in)"
    );
  });

  test("rejects a 200 JSON error envelope, preserving the server's status", () => {
    const data = { statusCode: 403, message: "Not permitted" };
    let thrown: unknown;
    try {
      assertSessionJsonOk(JSON.stringify(data), data, true, true);
    } catch (err) {
      thrown = err;
    }

    const err = thrown as JiraSessionAuthError;
    expect(err.reason).toBe("error-envelope");
    expect(err.status).toBe(403);
    expect(err.message).toBe("Jira API error (403): Not permitted");
  });

  test("accepts an empty body (a 200 from DELETE is legitimate)", () => {
    expect(() => assertSessionJsonOk("", "", false, true)).not.toThrow();
  });

  test("accepts real issue JSON", () => {
    const data = { id: "1", key: "TEST-1", fields: {} };
    expect(() => assertSessionJsonOk(JSON.stringify(data), data, true, true)).not.toThrow();
  });

  test("ignores a sub-400 statusCode field", () => {
    const data = { statusCode: 200, message: "ok" };
    expect(() => assertSessionJsonOk(JSON.stringify(data), data, true, true)).not.toThrow();
  });

  test("no-op for token auth, even on an HTML body (CLI behaviour is untouched)", () => {
    expect(() => assertSessionJsonOk(LOGIN_HTML, LOGIN_HTML, false, false)).not.toThrow();
  });
});

describe("isJiraSessionAuthError", () => {
  test("rejects unrelated errors and non-errors", () => {
    expect(isJiraSessionAuthError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isJiraSessionAuthError(new Error("Jira API error (500): boom"))).toBe(false);
    expect(isJiraSessionAuthError("Jira API error (302)")).toBe(false);
    expect(isJiraSessionAuthError(undefined)).toBe(false);
  });

  test("accepts a structurally-equal error from a duplicate module instance", () => {
    // `instanceof` breaks when a bundle carries two copies of the package; the
    // stable `name` is what makes the classification survive that.
    const twin = new Error("…");
    twin.name = "JiraSessionAuthError";
    expect(isJiraSessionAuthError(twin)).toBe(true);
  });
});
