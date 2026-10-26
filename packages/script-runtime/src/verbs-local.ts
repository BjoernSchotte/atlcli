import { canonicalJsonV1, digestCanonicalJsonV1 } from "@atlcli/change-set";
import { z } from "zod";
import { SECRET_NAME } from "./meta.js";
import type { HttpResponseView, ScriptPort } from "./port.js";
import { hostOp, type Recorder, str, verb, type Verb } from "./recorder.js";
import { ScriptError } from "./sandbox.js";

/** Largest HTTP response, file read and file write a script handles. */
export const MAX_LOCAL_BYTES = 10 * 1024 * 1024;
/** Largest single state value (serialized). */
export const MAX_STATE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

/** What `atlcli.secret("NAME")` gives the script: a reference the host replaces in HTTP requests only. */
export const SECRET_REFERENCE = /\{secret:([A-Z][A-Z0-9_]*)\}/g;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Replaces secret references with their values. Every name must be declared
 * in `meta.secrets` (when `declared` is given) and set on the host.
 */
export function resolveSecrets(text: string, port: Pick<ScriptPort, "secret">, declared?: readonly string[]): { text: string; values: Map<string, string> } {
  const values = new Map<string, string>();
  const out = text.replace(SECRET_REFERENCE, (_ref, name: string) => {
    if (declared && !declared.includes(name)) {
      throw new ScriptError("permission-denied", `Secret ${name} is not declared in meta.secrets`);
    }
    const value = port.secret?.(name);
    if (value === undefined || value === "") throw new Error(`Secret ${name} is not set (ATLCLI_SECRET_${name})`);
    values.set(value, name);
    return value;
  });
  return { text: out, values };
}

/** Replaces secret values a service echoed back with their references. */
function redact(text: string, values: Map<string, string>): string {
  let out = text;
  for (const [value, name] of values) out = out.split(value).join(`{secret:${name}}`);
  return out;
}

/**
 * An external URL as the script wrote it (secret references unresolved) and
 * resolved. https only, http just for localhost; no credentials in the URL;
 * secrets may not be part of the host. Throws on a violation.
 */
export function checkHttpUrl(raw: string, port: Pick<ScriptPort, "secret">, declared?: readonly string[]): { url: URL; values: Map<string, string> } {
  const { text, values } = resolveSecrets(raw, port, declared);
  let url: URL;
  let shape: URL;
  try {
    url = new URL(text);
    shape = new URL(raw.replace(SECRET_REFERENCE, "x"));
  } catch {
    throw new Error(`Not an absolute URL: ${JSON.stringify(raw)}`);
  }
  if (url.host !== shape.host) throw new Error("Secrets cannot be part of a URL's host");
  checkScheme(url);
  if (url.username || url.password) throw new Error("Pass credentials in a header (with atlcli.secret), not in the URL");
  return { url, values };
}

function checkScheme(url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return;
  throw new Error(`Only https URLs are allowed (http only for localhost): ${url.origin}`);
}

const hostOf = (url: URL) => ({ host: url.hostname.toLowerCase(), port: url.port });

function resolveHeaders(headers: Record<string, string>, port: Pick<ScriptPort, "secret">, declared: readonly string[] | undefined, values: Map<string, string>) {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const resolved = resolveSecrets(value, port, declared);
    for (const [k, v] of resolved.values) values.set(k, v);
    out[name.toLowerCase()] = resolved.text;
  }
  return out;
}

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * Sends one request through the host, following up to five redirects for
 * reads. Each hop is checked against the scheme rule and, through `allow`,
 * the script's grants; credentials do not follow a redirect to another origin.
 */
async function fetchFollowing(
  port: ScriptPort,
  first: URL,
  headers: Record<string, string>,
  allow: (url: URL) => void,
  signal: AbortSignal,
): Promise<HttpResponseView & { url: string }> {
  const send = hostOp(port.httpFetch?.bind(port), "http.get");
  let url = first;
  let sent = headers;
  for (let hop = 0; ; hop++) {
    const response = await send({ method: "GET", url: url.href, headers: sent }, { signal });
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location) return { ...response, url: url.href };
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${first.origin}`);
    const next = new URL(location, url);
    checkScheme(next);
    allow(next);
    if (next.origin !== url.origin) sent = Object.fromEntries(Object.entries(sent).filter(([k]) => !SENSITIVE_HEADERS.has(k)));
    url = next;
  }
}

/**
 * A local path below the host's working directory: relative, forward
 * slashes, no `..`, empty segments or control characters. Checked when
 * planning and again by the host before touching the file system.
 */
export function checkLocalPath(path: string): string {
  const segments = path.split("/");
  const bad =
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("~") ||
    segments.some((s) => s === "" || s === "..") ||
    /[\u0000-\u001f]/.test(path);
  if (bad) throw new Error(`File paths must be relative and stay inside the working directory: ${JSON.stringify(path)}`);
  const clean = segments.filter((s) => s !== ".").join("/");
  return clean === "" ? "." : clean;
}

const renderToFile = z.strictObject({
  /** Document mode (default): a line holding only a block tag disappears. */
  lines: z.boolean().optional(),
  /** Templates `{% include %}`/`{% extends %}`/`{% import %}` can load, by name. */
  templates: z.record(z.string(), z.string()).optional(),
});
const encoding = z.strictObject({ encoding: z.enum(["utf8", "base64"]).optional() });
const headers = z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "a header name"), z.string());
const httpUrl = str.max(8192);
const stateKey = str.max(200);

function byteLength(content: string, enc: "utf8" | "base64"): number {
  if (enc === "utf8") return new TextEncoder().encode(content).length;
  const clean = content.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) throw new Error("content is not valid base64");
  return (clean.length / 4) * 3 - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
}

const digestOf = async (value: unknown): Promise<string | null> => (value === undefined ? null : digestCanonicalJsonV1(value));

function jsonValue(value: unknown, what: string): unknown {
  if (value === undefined) throw new Error(`${what} needs a value; use state.delete to remove a key`);
  const size = canonicalJsonV1(value as never).length;
  if (size > MAX_STATE_BYTES) throw new Error(`${what} is ${size} bytes; the limit is ${MAX_STATE_BYTES}`);
  return value;
}

async function stateWrite(r: Recorder, key: string, value: unknown): Promise<null> {
  const verbName = value === undefined ? "state.delete" : "state.set";
  const object = `state:${key}`;
  const get = hostOp(r.port.stateGet?.bind(r.port), verbName);
  let digest: string | null | undefined;
  if (r.lastWrite(object) === undefined) {
    const live = (await get(r.store, key)) ?? undefined;
    digest = await digestOf(live);
    if (digest === (await digestOf(value))) {
      r.skipped.push({ verb: verbName, target: key, reason: "unchanged" });
      return null;
    }
  }
  await r.record(verbName, { store: r.store, stateKey: key, ...(value === undefined ? {} : { value }) }, object, async () =>
    digest === undefined ? undefined : { kind: "state-unchanged", store: r.store, key, digest },
  );
  return null;
}

export const LOCAL_VERBS: Record<string, Verb> = {
  // Never the value: a reference the host replaces in HTTP requests only. The guest wrapper makes it synchronous.
  secret: verb(z.tuple([str.regex(SECRET_NAME, "secret names are upper case letters, digits and _")]), async (_r, [name]) => `{secret:${name}}`),
  "http.get": verb(
    z.tuple([httpUrl, z.strictObject({ headers: headers.optional(), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }).optional()]),
    async (r, [raw, o], signal) => {
      const declared = r.meta.secrets ?? [];
      const { url, values } = checkHttpUrl(raw, r.port, declared);
      for (const [k, v] of Object.entries(o?.query ?? {})) url.searchParams.append(k, resolveSecrets(String(v), r.port, declared).text);
      const allow = (target: URL) => {
        const { host, port } = hostOf(target);
        r.requireHttp(host, port);
      };
      allow(url);
      const sent = resolveHeaders(o?.headers ?? {}, r.port, declared, values);
      const response = await fetchFollowing(r.port, url, sent, allow, signal);
      if (response.text.length > MAX_LOCAL_BYTES) throw new Error(`Response of ${url.origin} is larger than ${MAX_LOCAL_BYTES} bytes`);
      const text = redact(response.text, values);
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), redact(v, values)]));
      let json: unknown;
      if (/\bjson\b/i.test(responseHeaders["content-type"] ?? "")) {
        try {
          json = JSON.parse(text);
        } catch {}
      }
      return { status: response.status, headers: responseHeaders, text, ...(json !== undefined ? { json } : {}) };
    },
  ),
  "http.request": verb(
    z.tuple([
      z
        .string()
        .transform((m) => m.toUpperCase())
        .pipe(z.enum(["POST", "PUT", "PATCH", "DELETE"], { message: "POST, PUT, PATCH or DELETE (GET is http.get)" })),
      httpUrl,
      z
        .strictObject({ headers: headers.optional(), body: z.string().optional(), json: z.unknown().optional() })
        .refine((o) => o.body === undefined || o.json === undefined, "pass body or json, not both")
        .optional(),
    ]),
    async (r, [method, raw, o]) => {
      const declared = r.meta.secrets ?? [];
      // Resolved now only to check the target and that every secret is declared and set; the plan keeps the references.
      const { url } = checkHttpUrl(raw, r.port, declared);
      const { host, port } = hostOf(url);
      r.requireHttp(host, port);
      const sent: Record<string, string> = Object.fromEntries(Object.entries(o?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      resolveHeaders(sent, r.port, declared, new Map());
      let body = o?.body;
      if (o?.json !== undefined) {
        body = JSON.stringify(o.json);
        sent["content-type"] ??= "application/json";
      }
      if (body !== undefined) {
        resolveSecrets(body, r.port, declared);
        if (byteLength(body, "utf8") > MAX_LOCAL_BYTES) throw new Error(`Request body is larger than ${MAX_LOCAL_BYTES} bytes`);
      }
      await r.record("http.request", { method, url: raw, headers: sent, ...(body !== undefined ? { body } : {}) });
      return null;
    },
  ),
  "files.read": verb(z.tuple([str, encoding.optional()]), async (r, [path, o]) => {
    r.require("file:read");
    // The host refuses files over MAX_LOCAL_BYTES.
    return hostOp(r.port.fileRead?.bind(r.port), "files.read")(checkLocalPath(path), { encoding: o?.encoding ?? "utf8" });
  }),
  "files.list": verb(z.tuple([str.optional()]), async (r, [dir]) => {
    r.require("file:read");
    return hostOp(r.port.fileList?.bind(r.port), "files.list")(checkLocalPath(dir ?? "."));
  }),
  "files.write": verb(z.tuple([str, z.string(), encoding.optional()]), async (r, [raw, content, o]) => {
    r.require("file:write");
    const path = checkLocalPath(raw);
    if (path === ".") throw new Error("files.write needs a file name");
    const enc = o?.encoding ?? "utf8";
    if (byteLength(content, enc) > MAX_LOCAL_BYTES) throw new Error(`${path}: content is larger than ${MAX_LOCAL_BYTES} bytes`);
    if (r.filePaths.has(path)) throw new Error(`${path} is already written by this plan`);
    r.filePaths.add(path);
    const read = r.port.fileRead?.bind(r.port);
    const current = read ? await read(path, { encoding: enc }).catch(() => undefined) : undefined;
    if (current === content) {
      r.skipped.push({ verb: "files.write", target: path, reason: "unchanged" });
      return { path };
    }
    await r.record("files.write", { path, content, encoding: enc });
    return { path };
  }),
  // Not a write: output files are results like stdout, written while the script runs (also in a dry run).
  output: verb(
    z.union([
      z.tuple([z.literal("open"), str]),
      z.tuple([z.literal("write"), str, z.string()]),
      z.tuple([z.literal("render"), str, z.string(), z.record(z.string(), z.unknown()).optional(), renderToFile.optional()]),
      z.tuple([z.literal("close"), str]),
    ]),
    async (r, args) => {
      if (r.noOutput) throw new ScriptError("permission-denied", `atlcli.output: ${r.noOutput}`);
      r.require("file:output");
      switch (args[0]) {
        case "open": {
          const path = checkLocalPath(args[1]);
          if (path === ".") throw new Error("atlcli.output needs a file name");
          return hostOp(r.port.outputOpen?.bind(r.port), "output")(path);
        }
        case "write":
          await hostOp(r.port.outputWrite?.bind(r.port), "output")(args[1], args[2]);
          return null;
        case "render": {
          const [, handle, template, vars, o] = args;
          r.rendered = true;
          const warnings = await hostOp(r.port.outputRender?.bind(r.port), "output.render")(handle, template, {
            vars: { ...r.templating.vars, ...(vars ?? {}) },
            now: r.templating.now,
            strict: r.templating.strict,
            lines: o?.lines ?? true,
            templates: o?.templates ?? {},
          });
          r.renderWarnings.push(...warnings);
          return null;
        }
        case "close":
          return hostOp(r.port.outputClose?.bind(r.port), "output")(args[1]);
      }
    },
  ),
  "state.get": verb(z.tuple([stateKey]), async (r, [key]) => (await hostOp(r.port.stateGet?.bind(r.port), "state.get")(r.store, key)) ?? null),
  "state.set": verb(z.tuple([stateKey, z.unknown()]), async (r, [key, value]) => stateWrite(r, key, jsonValue(value ?? undefined, `state.set("${key}")`))),
  "state.delete": verb(z.tuple([stateKey]), async (r, [key]) => stateWrite(r, key, undefined)),
};

/** `atlcli.secret` is synchronous in the guest; the host function only exists for the wrapper. */
export const LOCAL_WRAPPERS: Record<string, string> = {
  // A writer that collects text in the guest and hands it to the host in 64 KB chunks.
  output: `(raw) => {
  const CHUNK = 65536, BACKLOG = 16 * 1024 * 1024;
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\\r\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return async (path) => {
    if (typeof path !== "string") throw new TypeError("atlcli.output(path): path must be a string");
    const handle = await raw("open", path);
    let buf = "", backlog = 0, chain = Promise.resolve(), failure, closed = false;
    const send = () => {
      if (buf) {
        const chunk = buf;
        buf = "";
        backlog += chunk.length;
        chain = chain.then(() => raw("write", handle, chunk)).then(() => { backlog -= chunk.length; }, (e) => { failure ??= e; throw e; });
      }
      return chain;
    };
    const add = (text) => {
      if (closed) throw new Error("atlcli.output: " + path + " is closed");
      if (failure) throw failure;
      buf += text;
      if (buf.length < CHUNK) return Promise.resolve();
      if (backlog > BACKLOG) throw new Error("atlcli.output: more than 16 MB of " + path + " waits to be written; await the writes in long loops");
      return send();
    };
    return Object.freeze({
      path,
      write: (text) => add(String(text)),
      line: (text = "") => add(String(text) + "\\n"),
      row: (cells) => {
        if (!Array.isArray(cells)) throw new TypeError("atlcli.output: row(cells) takes an array");
        return add(cells.map(cell).join(",") + "\\r\\n");
      },
      json: (value) => add(JSON.stringify(value) + "\\n"),
      render: async (template, vars, options) => {
        if (closed) throw new Error("atlcli.output: " + path + " is closed");
        await send();
        await raw("render", handle, template, vars ?? null, options ?? null);
      },
      close: async () => {
        if (closed) throw new Error("atlcli.output: " + path + " is closed");
        await send();
        closed = true;
        return raw("close", handle);
      },
    });
  };
}`,
  secret: `(raw) => (name) => {
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new TypeError("atlcli.secret: names are upper case letters, digits and _");
  return "{secret:" + name + "}";
}`,
};

/** Applies a planned `http.request`: secrets resolved now, redirects not followed, non-2xx fails. */
export async function applyHttpRequest(port: ScriptPort, args: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number }> {
  const { url, values } = checkHttpUrl(args.url, port);
  const sent = resolveHeaders(args.headers ?? {}, port, undefined, values);
  const body = args.body === undefined ? undefined : resolveSecrets(args.body, port).text;
  const send = hostOp(port.httpFetch?.bind(port), "http.request");
  const response = await send({ method: args.method as never, url: url.href, headers: sent, ...(body !== undefined ? { body } : {}) }, {});
  if (response.status >= 300) {
    const detail = redact(response.text, values).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${args.method} ${url.origin}${url.pathname} answered ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return { status: response.status };
}
