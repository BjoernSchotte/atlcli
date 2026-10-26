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

function outputHost() {
  const open = new Map<string, { path: string; text: string; writes: number }>();
  const closed = new Map<string, string>();
  const renders: unknown[] = [];
  let next = 0;
  const port = {
    outputOpen: async (path: string) => {
      const handle = `h${++next}`;
      open.set(handle, { path, text: "", writes: 0 });
      return handle;
    },
    outputWrite: async (handle: string, chunk: string) => {
      const file = open.get(handle)!;
      file.text += chunk;
      file.writes++;
    },
    outputRender: async (handle: string, template: string, options: unknown) => {
      renders.push({ template, options });
      open.get(handle)!.text += `<rendered ${template}>`;
      return [{ code: "unresolved", message: "Unresolved {{ x }}" }];
    },
    outputClose: async (handle: string) => {
      const file = open.get(handle)!;
      open.delete(handle);
      closed.set(file.path, file.text);
      return { path: file.path, bytes: file.text.length, sha256: "x" };
    },
  } as unknown as ScriptPort;
  return { port, open, closed, renders };
}

describe("atlcli.output", () => {
  it("writes lines, CSV rows and JSON Lines while planning, and plans nothing", async () => {
    const { port, closed } = outputHost();
    const run = await plan(
      `const csv = await atlcli.output("out/report.csv");
       await csv.row(["Key", "Summary"]);
       await csv.row(["A-1", 'says "hi", twice\\nand more']);
       await csv.row([null, { a: 1 }, 3]);
       const log = await atlcli.output("./out/log.jsonl");
       await log.json({ key: "A-1" });
       await log.line("plain");
       export default [await csv.close(), await log.close()];`,
      port,
    );
    expect(run.operations).toEqual([]);
    expect(closed.get("out/report.csv")).toBe('Key,Summary\r\nA-1,"says ""hi"", twice\nand more"\r\n,"{""a"":1}",3\r\n');
    expect(closed.get("out/log.jsonl")).toBe('{"key":"A-1"}\nplain\n');
    expect(run.value).toEqual([
      { path: "out/report.csv", bytes: closed.get("out/report.csv")!.length, sha256: "x" },
      { path: "out/log.jsonl", bytes: closed.get("out/log.jsonl")!.length, sha256: "x" },
    ]);
  });

  it("hands text over in 64 KB chunks, not per line", async () => {
    const { port, closed } = outputHost();
    let writes = 0;
    const counting = { ...port, outputWrite: async (h: string, c: string) => (writes++, port.outputWrite!(h, c)) } as ScriptPort;
    await plan(
      `const out = await atlcli.output("big.txt");
       const row = "x".repeat(9999);
       for (let i = 0; i < 20; i++) await out.line(row);
       await out.close();`,
      counting,
    );
    expect(closed.get("big.txt")).toBe(`${"x".repeat(9999)}\n`.repeat(20));
    expect(writes).toBe(3);
  });

  it("renders a template into the file after the text before it, with --var values and the clock", async () => {
    const { port, closed, renders } = outputHost();
    const run = await plan(
      `const out = await atlcli.output("r.md");
       await out.line("head");
       await out.render("{{ x }}", { y: 1 }, { templates: { "a.j2": "A" } });
       await out.close();`,
      port,
      { templating: { vars: { team: "core" }, now: "2026-10-26T09:00:00.000Z", strict: false } },
    );
    expect(closed.get("r.md")).toBe("head\n<rendered {{ x }}>");
    expect(renders).toEqual([
      { template: "{{ x }}", options: { vars: { team: "core", y: 1 }, now: "2026-10-26T09:00:00.000Z", strict: false, lines: true, templates: { "a.j2": "A" } } },
    ]);
    expect(run.renderWarnings).toEqual([{ code: "unresolved", message: "Unresolved {{ x }}" }]);
  });

  it("checks the path and the file:output grant", async () => {
    const { port } = outputHost();
    for (const path of ["../x", "/etc/x", "a/../../x", "."]) {
      await expect(plan(`await atlcli.output(${JSON.stringify(path)});`, port)).rejects.toThrow(/relative|file name/);
    }
    const denied = await scriptError(plan(`export const meta = { permissions: ["file:write"] }; await atlcli.output("a.txt");`, port));
    expect(denied.message).toContain('"file:output"');
    const ok = await plan(`export const meta = { permissions: ["file:output"] }; const o = await atlcli.output("a.txt"); await o.close();`, port);
    expect(ok.operations).toEqual([]);
  });

  it("is refused where the host says so (audit rules)", async () => {
    const { port } = outputHost();
    const error = await scriptError(plan(`await atlcli.output("a.txt");`, port, { noOutput: "audit rules write no files" }));
    expect(error.kind).toBe("permission-denied");
    expect(error.message).toContain("audit rules write no files");
  });

  it("refuses writes after close", async () => {
    const { port } = outputHost();
    await expect(plan(`const o = await atlcli.output("a.txt"); await o.close(); await o.line("late");`, port)).rejects.toThrow(/closed/);
  });
});

describe("atlcli.files.lines", () => {
  it("iterates pages through the cursor, with the format from the extension and a limit", async () => {
    const calls: unknown[] = [];
    const port = {
      fileLines: async (path: string, o: { format: string; limit: number; cursor?: string }) => {
        calls.push([path, o]);
        return o.cursor ? { items: [["c"]] } : { items: [["a"], ["b"]], cursor: "4:2" };
      },
    } as unknown as ScriptPort;
    const run = await plan(
      `const all = [];
       for await (const row of atlcli.files.lines("data/in.csv")) all.push(row);
       const first = [];
       for await (const line of atlcli.files.lines("./notes.txt", { limit: 1 })) first.push(line);
       export default { all, first };`,
      port,
    );
    expect(run.value).toEqual({ all: [["a"], ["b"], ["c"]], first: [["a"]] });
    expect(calls).toEqual([
      ["data/in.csv", { format: "csv", limit: 1000 }],
      ["data/in.csv", { format: "csv", limit: 1000, cursor: "4:2" }],
      ["notes.txt", { format: "text", limit: 1000 }],
    ]);
    await expect(plan(`for await (const l of atlcli.files.lines("../x")) {}`, port)).rejects.toThrow(/relative/);
  });
});
