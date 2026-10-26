import { describe, expect, it } from "bun:test";
import DEBUG_VARIANT from "@jitl/quickjs-ng-wasmfile-debug-sync";
import { applyScriptPlan } from "./apply.js";
import { createScriptPlan, parseScriptPlan, serializeScriptPlan } from "./plan.js";
import type { HttpRequestInput, HttpResponseView, ScriptPort } from "./port.js";
import { ScriptError } from "./sandbox.js";
import { checkLocalPath, planScript, type PlanScriptOptions } from "./verbs.js";

const BASE = "https://example.atlassian.net";
const TOKEN = "s3cr3t-value";

function host(routes: Record<string, (req: HttpRequestInput) => HttpResponseView> = {}) {
  const requests: HttpRequestInput[] = [];
  const files = new Map<string, string>([["data/in.csv", "a,b\n1,2\n"]]);
  const state = new Map<string, unknown>([["s/since", "2026-10-01"]]);
  const port = {
    secret: (name: string) => (name === "TOKEN" ? TOKEN : undefined),
    httpFetch: async (req: HttpRequestInput) => {
      requests.push(req);
      const route = routes[req.url];
      if (!route) return { status: 404, headers: {}, text: "not found" };
      return route(req);
    },
    fileRead: async (path: string) => {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path)!;
    },
    fileList: async () => [...files.keys()].map((name) => ({ name, type: "file" as const, size: files.get(name)!.length })),
    fileWrite: async (path: string, content: string) => (files.set(path, content), { path, bytes: content.length }),
    stateGet: async (store: string, key: string) => state.get(`${store}/${key}`),
    stateSet: async (store: string, key: string, value: unknown) => void (value === undefined ? state.delete(`${store}/${key}`) : state.set(`${store}/${key}`, value)),
  } as unknown as ScriptPort;
  return { port, requests, files, state };
}

const plan = (js: string, port: ScriptPort, extra: Partial<PlanScriptOptions> = {}) => planScript(js, { port, variant: DEBUG_VARIANT, name: "s", ...extra });
const apply = (operations: Awaited<ReturnType<typeof plan>>["operations"], port: ScriptPort) =>
  applyScriptPlan({ target: { baseUrl: BASE }, operations }, { port, baseUrl: BASE });

async function scriptError(promise: Promise<unknown>): Promise<ScriptError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ScriptError) return error;
    throw error;
  }
  throw new Error("expected a ScriptError");
}

const HTTP_META = `export const meta = { permissions: ["http:api.example.com"], secrets: ["TOKEN"] };`;

describe("atlcli.http", () => {
  it("get reads now, fills in secrets and hides them again in what comes back", async () => {
    const { port, requests } = host({
      "https://api.example.com/items?q=1": () => ({ status: 200, headers: { "Content-Type": "application/json" }, text: `{"echo":"${TOKEN}"}` }),
    });
    const run = await plan(
      `${HTTP_META}
       const r = await atlcli.http.get("https://api.example.com/items", { query: { q: 1 }, headers: { Authorization: "Bearer " + atlcli.secret("TOKEN") } });
       export default r;`,
      port,
    );
    expect(requests).toEqual([{ method: "GET", url: "https://api.example.com/items?q=1", headers: { authorization: `Bearer ${TOKEN}` } }]);
    expect(run.value).toEqual({ status: 200, headers: { "content-type": "application/json" }, text: '{"echo":"{secret:TOKEN}"}', json: { echo: "{secret:TOKEN}" } });
    expect(run.operations).toEqual([]);
  });

  it("needs an http grant even without other permissions, and only https (http for localhost)", async () => {
    const { port, requests } = host();
    const none = await scriptError(plan(`await atlcli.http.get("https://api.example.com/")`, port));
    expect(none.kind).toBe("permission-denied");
    await expect(plan(`${HTTP_META} await atlcli.http.get("http://api.example.com/")`, port)).rejects.toThrow(/Only https/);
    await expect(plan(`${HTTP_META} await atlcli.http.get("https://user:pw@api.example.com/")`, port)).rejects.toThrow(/credentials in a header/);
    const wildcard = `export const meta = { permissions: ["http:*.example.com"] };`;
    await plan(`${wildcard} await atlcli.http.get("https://a.b.example.com/")`, port);
    expect((await scriptError(plan(`${wildcard} await atlcli.http.get("https://example.com/")`, port))).kind).toBe("permission-denied");
    await plan(`export const meta = { permissions: ["http:localhost:8080"] }; await atlcli.http.get("http://localhost:8080/x")`, port);
    expect((await scriptError(plan(`export const meta = { permissions: ["http:localhost:8080"] }; await atlcli.http.get("http://localhost:9090/x")`, port))).kind).toBe("permission-denied");
    expect(requests.map((r) => r.url)).toEqual(["https://a.b.example.com/", "http://localhost:8080/x"]);
  });

  it("follows redirects only to granted hosts and drops credentials across origins", async () => {
    const { port, requests } = host({
      "https://api.example.com/a": () => ({ status: 302, headers: { location: "https://cdn.example.com/b" }, text: "" }),
      "https://cdn.example.com/b": () => ({ status: 200, headers: {}, text: "ok" }),
      "https://api.example.com/evil": () => ({ status: 302, headers: { location: "https://attacker.test/" }, text: "" }),
    });
    const meta = `export const meta = { permissions: ["http:api.example.com", "http:cdn.example.com"], secrets: ["TOKEN"] };`;
    const run = await plan(`${meta} export default (await atlcli.http.get("https://api.example.com/a", { headers: { authorization: atlcli.secret("TOKEN"), accept: "text/plain" } })).text;`, port);
    expect(run.value).toBe("ok");
    expect(requests[1]).toEqual({ method: "GET", url: "https://cdn.example.com/b", headers: { accept: "text/plain" } });
    expect((await scriptError(plan(`${meta} await atlcli.http.get("https://api.example.com/evil")`, port))).message).toContain("attacker.test");
  });

  it("secrets must be declared and set; they cannot form the host", async () => {
    const { port } = host();
    const undeclared = await scriptError(plan(`export const meta = { permissions: ["http:api.example.com"] }; await atlcli.http.get("https://api.example.com/?k=" + atlcli.secret("TOKEN"))`, port));
    expect(undeclared.message).toContain("not declared in meta.secrets");
    const unset = await scriptError(plan(`export const meta = { secrets: ["MISSING"] }; export default 1;`, port));
    expect(unset.message).toContain("ATLCLI_SECRET_MISSING");
    await expect(plan(`${HTTP_META} await atlcli.http.get("https://" + atlcli.secret("TOKEN") + ".example.com/")`, port)).rejects.toThrow();
    expect(() => plan(`atlcli.secret("lower")`, port)).toThrow;
    await expect(plan(`atlcli.secret("lower")`, port)).rejects.toThrow(/upper case/);
  });

  it("request is planned with secret references only, and sent with values on apply", async () => {
    const { port, requests } = host({
      "https://api.example.com/hook": (req) => ({ status: req.body?.includes("ATL-1") ? 204 : 400, headers: {}, text: "" }),
      "https://api.example.com/fail": () => ({ status: 500, headers: {}, text: `boom ${TOKEN}` }),
    });
    const run = await plan(`${HTTP_META} await atlcli.http.request("POST", "https://api.example.com/hook", { headers: { "X-Key": atlcli.secret("TOKEN") }, json: { issue: "ATL-1" } });`, port);
    expect(requests).toEqual([]);
    const planFile = serializeScriptPlan(await createScriptPlan(run, { source: "x", baseUrl: BASE }));
    expect(planFile).not.toContain(TOKEN);
    expect(run.operations[0]!.args).toEqual({ method: "POST", url: "https://api.example.com/hook", headers: { "x-key": "{secret:TOKEN}", "content-type": "application/json" }, body: '{"issue":"ATL-1"}' });
    const report = await apply((await parseScriptPlan(planFile)).operations, port);
    expect(report.operations[0]).toMatchObject({ status: "applied", result: { status: 204 } });
    expect(requests[0]!.headers["x-key"]).toBe(TOKEN);

    const failing = await plan(`${HTTP_META} await atlcli.http.request("DELETE", "https://api.example.com/fail", { headers: { authorization: atlcli.secret("TOKEN") } });`, port);
    const failed = await apply(failing.operations, port);
    expect(failed.operations[0]!.error).toBe("DELETE https://api.example.com/fail answered 500: boom {secret:TOKEN}");
  });
});

describe("atlcli.files", () => {
  it("reads and lists now, writes on apply, skips unchanged content", async () => {
    const { port, files } = host();
    const run = await plan(
      `const csv = await atlcli.files.read("./data/in.csv");
       const rows = csv.trim().split("\\n").slice(1).map((l) => l.split(","));
       await atlcli.files.write("out/report.md", "# " + rows.length);
       await atlcli.files.write("data/in.csv", csv);
       export default (await atlcli.files.list()).map((f) => f.name);`,
      port,
    );
    expect(run.value).toEqual(["data/in.csv"]);
    expect(run.skipped).toEqual([{ verb: "files.write", target: "data/in.csv", reason: "unchanged" }]);
    expect(files.has("out/report.md")).toBe(false);
    await apply(run.operations, port);
    expect(files.get("out/report.md")).toBe("# 1");
  });

  it("stays inside the working directory and refuses a second write to one path", async () => {
    const { port } = host();
    for (const path of ["/etc/passwd", "../x", "a/../../x", "C:/x", "~/x", "a\\\\b"]) {
      await expect(plan(`await atlcli.files.read(${JSON.stringify(path)})`, port)).rejects.toThrow(/stay inside the working directory/);
    }
    await expect(plan(`await atlcli.files.write("a.txt", "1"); await atlcli.files.write("./a.txt", "2");`, port)).rejects.toThrow(/already written/);
    expect(checkLocalPath("./a/./b.txt")).toBe("a/b.txt");
    const denied = await scriptError(plan(`export const meta = { permissions: ["file:read"] }; await atlcli.files.write("a.txt", "1")`, port));
    expect(denied.message).toContain('"file:write"');
  });
});

describe("atlcli.state", () => {
  it("get reads now; set and delete are planned, skipped when unchanged, and drift when the store moved", async () => {
    const { port, state } = host();
    const run = await plan(
      `const since = await atlcli.state.get("since");
       await atlcli.state.set("since", "2026-10-26");
       await atlcli.state.set("count", 3);
       await atlcli.state.delete("missing");
       export default since;`,
      port,
    );
    expect(run.value).toBe("2026-10-01");
    expect(run.skipped).toEqual([{ verb: "state.delete", target: "missing", reason: "unchanged" }]);
    expect(run.operations[0]!.precondition).toMatchObject({ kind: "state-unchanged", store: "s", key: "since" });
    expect(run.operations[1]!.precondition).toEqual({ kind: "state-unchanged", store: "s", key: "count", digest: null });

    state.set("s/since", "changed elsewhere");
    expect((await apply(run.operations, port)).status).toBe("drift");
    state.set("s/since", "2026-10-01");
    expect((await apply(run.operations, port)).status).toBe("applied");
    expect(state.get("s/since")).toBe("2026-10-26");
    expect(state.get("s/count")).toBe(3);

    const again = await plan(`await atlcli.state.set("since", "2026-10-26"); await atlcli.state.delete("count");`, port);
    expect(again.skipped.map((s) => s.verb)).toEqual(["state.set"]);
    await apply(again.operations, port);
    expect(state.has("s/count")).toBe(false);
  });

  it("uses meta.name as the store", async () => {
    const { port } = host();
    const run = await plan(`export const meta = { name: "nightly" }; await atlcli.state.set("k", 1);`, port);
    expect(run.operations[0]!.args).toMatchObject({ store: "nightly", stateKey: "k" });
  });
});
