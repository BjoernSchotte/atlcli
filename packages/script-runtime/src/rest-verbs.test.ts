import { expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import type { ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { MAX_REST_BYTES, planScript } from "./verbs.js";

/** Only the REST ports; every other call would be a bug. */
function port(responses: Record<string, unknown>, calls: unknown[] = []): ScriptPort {
  const rest = (product: string) => async (path: string, o: { query?: unknown }) => {
    calls.push([product, path, o.query ?? null]);
    if (!(path in responses)) throw new Error(`404 ${path}`);
    return responses[path];
  };
  return { jiraRest: rest("jira"), confluenceRest: rest("confluence") } as unknown as ScriptPort;
}

const plan = (js: string, p: ScriptPort) => planScript(js, { port: p, variant: DEBUG_VARIANT });

it("reads Jira and Confluence REST resources and records no operations", async () => {
  const calls: unknown[] = [];
  const result = await plan(
    `const fields = await atlcli.jira.rest("/rest/api/3/field", { query: { expand: "x", n: 2, b: true } });
     const props = await atlcli.confluence.rest("/api/v2/pages/1/properties");
     export default { fields, props };`,
    port({ "/rest/api/3/field": [{ id: "summary" }], "/api/v2/pages/1/properties": { results: [] } }, calls),
  );
  expect(result.value).toEqual({ fields: [{ id: "summary" }], props: { results: [] } });
  expect(result.operations).toEqual([]);
  expect(calls).toEqual([
    ["jira", "/rest/api/3/field", { expand: "x", n: 2, b: true }],
    ["confluence", "/api/v2/pages/1/properties", null],
  ]);
});

it("rejects relative, dotted and query-carrying paths before the host sees them", async () => {
  const calls: unknown[] = [];
  for (const path of ["rest/api/3/field", "/rest/../x", "/rest/api/3/field?x=1", "/rest/%2e%2e/x"]) {
    await expect(plan(`await atlcli.jira.rest(${JSON.stringify(path)})`, port({}, calls))).rejects.toThrow(/site-relative path/);
  }
  expect(calls).toEqual([]);
});

it("needs read permission when permissions are declared", async () => {
  const error = await plan(
    `export const meta = { permissions: ["confluence:read"] }; await atlcli.jira.rest("/rest/api/3/field")`,
    port({ "/rest/api/3/field": [] }),
  ).catch((e) => e);
  expect(error).toBeInstanceOf(ScriptError);
  expect((error as ScriptError).kind).toBe("permission-denied");
});

it("caps the response size", async () => {
  const big = "x".repeat(MAX_REST_BYTES + 1);
  await expect(plan(`await atlcli.jira.rest("/rest/big")`, port({ "/rest/big": big }))).rejects.toThrow(/the limit is/);
});

it("fails clearly on a host without REST access", async () => {
  await expect(plan(`await atlcli.jira.rest("/rest/api/3/field")`, {} as ScriptPort)).rejects.toThrow(/not available on this host/);
});
